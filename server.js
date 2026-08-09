import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import WebTorrent from "webtorrent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new WebTorrent({
  torrentPort: Math.max(1, Number(process.env.PEER_PORT || 6881)),
  dhtPort: Math.max(1, Number(process.env.DHT_PORT || 6881)),
  utp: false,
  dht: true,
  tracker: true,
  lsd: true,
  natUpnp: true,
  natPmp: true,
  maxConns: Math.max(8, Number(process.env.MAX_PEERS || 80))
});
client.on("error", (error) => {
  console.error("WebTorrent client error:", error);
});
const torrents = new Map();

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, "cache"));
const TASKS_FILE = path.join(CACHE_DIR, "tasks.json");
const MAX_CACHE_BYTES = Math.max(1, Number(process.env.MAX_CACHE_GB || 20)) * 1024 ** 3;
const CACHE_TTL_MS = Math.max(5, Number(process.env.CACHE_TTL_MINUTES || 120)) * 60_000;
const CLEANUP_INTERVAL_MS = Math.max(1, Number(process.env.CLEANUP_INTERVAL_MINUTES || 5)) * 60_000;
const MAX_TORRENT_FILE_BYTES = Math.max(1, Number(process.env.MAX_TORRENT_FILE_MB || 20)) * 1024 ** 2;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".flv", ".ogv"]);
const DIRECT_PLAY_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
let ffmpegAvailable = false;
let saveTasksChain = Promise.resolve();

await fsp.mkdir(CACHE_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function authGuard(req, res, next) {
  const expected = process.env.AUTH_TOKEN?.trim();
  if (!expected) return next();
  const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") || req.query.token;
  if (supplied !== expected) return res.status(401).json({ error: "需要有效的访问令牌" });
  next();
}

app.use("/api", authGuard);

function publicTorrent(item) {
  const files = item.torrent?.files || item.files || [];
  return {
    id: item.id,
    name: item.name,
    source: item.source,
    status: item.status,
    error: item.error || null,
    progress: Number(item.torrent?.progress || item.progress || 0),
    downloadSpeed: Number(item.torrent?.downloadSpeed || 0),
    uploadSpeed: Number(item.torrent?.uploadSpeed || 0),
    peers: Number(item.torrent?.numPeers || 0),
    done: Boolean(item.torrent?.done || item.done),
    size: files.reduce((sum, file) => sum + Number(file.length || 0), 0),
    lastAccessedAt: item.lastAccessedAt,
    createdAt: item.createdAt,
    activeStreams: item.activeStreams,
    caching: Boolean(item.caching),
    files: files.map((file, index) => ({
      index,
      name: file.name,
      length: Number(file.length || 0),
      extension: path.extname(file.name).toLowerCase(),
      isVideo: VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()),
      directPlayable: DIRECT_PLAY_EXTENSIONS.has(path.extname(file.name).toLowerCase()),
      selected: index === item.selectedFileIndex
    }))
  };
}

function waitForReady(torrent) {
  if (torrent.ready) return Promise.resolve(torrent);
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve(torrent);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      torrent.off("ready", onReady);
      torrent.off("error", onError);
    };
    torrent.once("ready", onReady);
    torrent.once("error", onError);
  });
}

function videoFiles(torrent) {
  return torrent.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    .sort((a, b) => b.file.length - a.file.length);
}

function checkFfmpeg() {
  return new Promise((resolve) => {
    const process = spawn(FFMPEG_PATH, ["-version"], { stdio: "ignore" });
    process.once("error", () => resolve(false));
    process.once("exit", (code) => resolve(code === 0));
  });
}

function persistTasks() {
  const records = [...torrents.values()].map((item) => ({
    id: item.id,
    sourceType: item.sourceType,
    sourceValue: item.sourceValue,
    name: item.name,
    createdAt: item.createdAt,
    lastAccessedAt: item.lastAccessedAt,
    selectedFileIndex: item.selectedFileIndex
  }));
  saveTasksChain = saveTasksChain.then(async () => {
    const temporary = `${TASKS_FILE}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(records, null, 2));
    await fsp.rename(temporary, TASKS_FILE);
  }).catch((error) => console.error("task persistence failed:", error));
  return saveTasksChain;
}

function normalizeMagnet(value) {
  const input = value.trim();
  if (!/^magnet:\?/i.test(input)) throw new Error("Invalid magnet link");

  const query = new URLSearchParams(input.slice(input.indexOf("?") + 1));
  const xt = query.get("xt") || "";
  const match = xt.match(/^urn:btih:([a-z0-9]{40}|[a-z2-7]{32})$/i);
  if (!match) throw new Error("Magnet link is missing a valid btih hash");

  const normalized = new URLSearchParams();
  normalized.set("xt", `urn:btih:${match[1].toUpperCase()}`);
  for (const key of ["dn", "tr", "xl", "ws", "as", "xs", "kt", "mt", "so"]) {
    for (const value of query.getAll(key)) normalized.append(key, value);
  }
  return `magnet:?${normalized.toString()}`;
}

async function addTorrent(source, sourceType, restored = null) {
  const id = restored?.id || crypto.randomUUID();
  const torrentPath = path.join(CACHE_DIR, id);
  await fsp.mkdir(torrentPath, { recursive: true });
  let torrentSource = source;
  if (sourceType === "file" && Buffer.isBuffer(source)) {
    torrentSource = path.join(torrentPath, "source.torrent");
    await fsp.writeFile(torrentSource, source);
  }
  const item = {
    id,
    source: sourceType === "magnet" ? "磁力链接" : "种子文件",
    name: "正在读取种子…",
    status: "metadata",
    createdAt: restored?.createdAt || new Date().toISOString(),
    lastAccessedAt: restored?.lastAccessedAt || Date.now(),
    activeStreams: 0,
    selectedFileIndex: restored?.selectedFileIndex ?? null,
    sourceType,
    sourceValue: torrentSource,
    caching: false,
    torrent: null
  };
  torrents.set(id, item);

  try {
    const torrent = client.add(torrentSource, { path: torrentPath });
    item.torrent = torrent;
    torrent.on("ready", () => {
      item.name = torrent.name || "未命名种子";
      item.status = "paused";
      const candidates = videoFiles(torrent);
      if (candidates.length) {
        torrent.files.forEach((file) => file.deselect());
        if (!Number.isInteger(item.selectedFileIndex) || !torrent.files[item.selectedFileIndex]) item.selectedFileIndex = candidates[0].index;
      }
      persistTasks();
    });
    torrent.on("done", () => {
      item.status = "ready";
    });
    torrent.on("error", (error) => {
      item.status = "error";
      item.error = error.message;
    });
    torrent.on("download", () => {
      if (item.caching && item.status !== "ready") item.status = "downloading";
    });
    await persistTasks();
    return publicTorrent(item);
  } catch (error) {
    item.status = "error";
    item.error = error.message;
    throw Object.assign(new Error(error.message), { item });
  }
}

function setCaching(item, enabled, fileIndex = item.selectedFileIndex) {
  if (!item.torrent?.ready) return false;
  const file = item.torrent.files[fileIndex];
  if (enabled && (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()))) return false;
  item.torrent.files.forEach((candidate) => candidate.deselect());
  if (enabled) {
    file.select();
    item.selectedFileIndex = fileIndex;
    item.caching = true;
    item.status = item.torrent.done ? "ready" : "downloading";
  } else {
    item.caching = false;
    item.status = item.torrent.done ? "ready" : "paused";
  }
  persistTasks();
  return true;
}

async function restoreTasks() {
  let records;
  try {
    records = JSON.parse(await fsp.readFile(TASKS_FILE, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(records)) return;
  for (const record of records) {
    if (!record?.id || !record.sourceValue) continue;
    if (record.sourceType === "file" && !fs.existsSync(record.sourceValue)) continue;
    try {
      await addTorrent(record.sourceValue, record.sourceType, record);
    } catch (error) {
      console.error(`failed to restore torrent ${record.id}:`, error.message);
    }
  }
}

function getItem(req, res) {
  const item = torrents.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: "找不到这个播放任务" });
    return null;
  }
  item.lastAccessedAt = Date.now();
  return item;
}

app.get("/api/config", (_req, res) => {
  res.json({
    maxCacheGb: Number(process.env.MAX_CACHE_GB || 20),
    cacheTtlMinutes: Number(process.env.CACHE_TTL_MINUTES || 120),
    ffmpegAvailable,
    authEnabled: Boolean(process.env.AUTH_TOKEN?.trim())
  });
});

app.get("/api/torrents", (_req, res) => {
  res.json([...torrents.values()].map(publicTorrent));
});

app.get("/api/cache", async (_req, res) => {
  res.json({ usedBytes: await directorySize(CACHE_DIR), maxBytes: MAX_CACHE_BYTES });
});

app.post("/api/torrents", async (req, res) => {
  const { magnet } = req.body || {};
  if (typeof magnet !== "string" || !magnet.trim().startsWith("magnet:")) {
    return res.status(400).json({ error: "请输入有效的磁力链接" });
  }
  try {
    res.status(201).json(await addTorrent(normalizeMagnet(magnet), "magnet"));
  } catch (error) {
    res.status(400).json({ error: error.message, item: error.item ? publicTorrent(error.item) : null });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TORRENT_FILE_BYTES, files: 1 }
});

app.post("/api/torrents/upload", upload.single("torrent"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择 .torrent 文件" });
  try {
    res.status(201).json(await addTorrent(req.file.buffer, "file"));
  } catch (error) {
    res.status(400).json({ error: error.message, item: error.item ? publicTorrent(error.item) : null });
  }
});

app.post("/api/torrents/:id/select", async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const fileIndex = Number(req.body?.fileIndex);
  await waitForReady(item.torrent);
  const file = item.torrent.files[fileIndex];
  if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    return res.status(400).json({ error: "只能选择视频文件" });
  }
  item.selectedFileIndex = fileIndex;
  setCaching(item, false, fileIndex);
  await persistTasks();
  res.json(publicTorrent(item));
});

app.post("/api/torrents/:id/cache", async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  await waitForReady(item.torrent);
  const enabled = req.body?.enabled !== false;
  if (!setCaching(item, enabled, Number(req.body?.fileIndex ?? item.selectedFileIndex))) {
    return res.status(400).json({ error: "暂无可缓存的视频文件" });
  }
  res.json(publicTorrent(item));
});

app.get("/api/torrents/:id/files/:index/stream", async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  try {
    await waitForReady(item.torrent);
    const index = Number(req.params.index);
    const file = item.torrent.files[index];
    if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      return res.status(404).json({ error: "找不到视频文件" });
    }

    setCaching(item, true, index);
    const total = Number(file.length);
    const range = req.headers.range;
    let start = 0;
    let end = total - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) return res.status(416).end();
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      else end = total - 1;
      if (!match[1] && match[2]) start = Math.max(0, total - Number(match[2]));
      if (start > end || start >= total || end >= total) return res.status(416).end();
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    const length = end - start + 1;
    item.lastAccessedAt = Date.now();
    res.setHeader("Content-Type", mimeFor(file.name));
    res.setHeader("Content-Length", length);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") return res.end();
    item.activeStreams += 1;
    const stream = file.createReadStream({ start, end });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      item.activeStreams = Math.max(0, item.activeStreams - 1);
      item.lastAccessedAt = Date.now();
    };
    stream.once("close", release);
    stream.once("error", (error) => {
      if (!res.headersSent) res.status(500);
      res.end(error.message);
    });
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/torrents/:id/files/:index/transcode", async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  if (!ffmpegAvailable) return res.status(503).json({ error: "服务器未安装 FFmpeg，暂时无法转换此视频格式" });
  try {
    await waitForReady(item.torrent);
    const index = Number(req.params.index);
    const file = item.torrent.files[index];
    if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      return res.status(404).json({ error: "找不到视频文件" });
    }
    if (DIRECT_PLAY_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      return res.status(400).json({ error: "该视频格式无需转换" });
    }

    item.lastAccessedAt = Date.now();
    item.activeStreams += 1;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "none");

    const ffmpeg = spawn(FFMPEG_PATH, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags",
      "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"
    ]);
    const sourceStream = file.createReadStream();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      item.activeStreams = Math.max(0, item.activeStreams - 1);
      item.lastAccessedAt = Date.now();
    };
    sourceStream.on("error", (error) => ffmpeg.destroy(error));
    ffmpeg.stderr.on("data", (chunk) => console.error(`ffmpeg: ${chunk}`.trim()));
    ffmpeg.once("error", (error) => {
      release();
      if (!res.headersSent) res.status(500);
      res.end(error.message);
    });
    ffmpeg.once("close", release);
    res.once("close", () => {
      sourceStream.destroy();
      ffmpeg.kill("SIGKILL");
      release();
    });
    sourceStream.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/torrents/:id", async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  await destroyTorrent(item);
  res.status(204).end();
});

function mimeFor(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".m4v": "video/mp4", ".ogv": "video/ogg", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".flv": "video/x-flv" })[ext] || "application/octet-stream";
}

async function directorySize(directory) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await fsp.stat(target)).size;
  }
  return total;
}

async function removeOrphanedCache() {
  let entries;
  try {
    entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !torrents.has(entry.name)) {
      await fsp.rm(path.join(CACHE_DIR, entry.name), { recursive: true, force: true });
    }
  }
}

async function destroyTorrent(item) {
  torrents.delete(item.id);
  await persistTasks();
  await new Promise((resolve) => {
    if (!item.torrent) return resolve();
    item.torrent.destroy({ destroyStore: true }, () => resolve());
  });
  await fsp.rm(path.join(CACHE_DIR, item.id), { recursive: true, force: true });
}

async function cleanupCache() {
  await removeOrphanedCache();
  const now = Date.now();
  const candidates = [...torrents.values()]
    .filter((item) => item.activeStreams === 0)
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (const item of candidates) {
    if (now - item.lastAccessedAt > CACHE_TTL_MS) await destroyTorrent(item);
  }
  let total = await directorySize(CACHE_DIR);
  for (const item of candidates) {
    if (total <= MAX_CACHE_BYTES || !torrents.has(item.id)) continue;
    const before = await directorySize(path.join(CACHE_DIR, item.id));
    await destroyTorrent(item);
    total = Math.max(0, total - before);
  }
}

setInterval(() => cleanupCache().catch((error) => console.error("cache cleanup failed", error)), CLEANUP_INTERVAL_MS).unref();

await restoreTasks();
await removeOrphanedCache();

ffmpegAvailable = await checkFfmpeg();

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Cloud Torrent Player listening on http://0.0.0.0:${PORT}`);
  console.log(`Temporary cache: ${CACHE_DIR}`);
  console.log(`FFmpeg transcoding: ${ffmpegAvailable ? "available" : "unavailable"}`);
});

process.on("SIGTERM", () => client.destroy(() => process.exit(0)));
process.on("SIGINT", () => client.destroy(() => process.exit(0)));
