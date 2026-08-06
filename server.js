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
const client = new WebTorrent();
const torrents = new Map();

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, "cache"));
const MAX_CACHE_BYTES = Math.max(1, Number(process.env.MAX_CACHE_GB || 20)) * 1024 ** 3;
const CACHE_TTL_MS = Math.max(5, Number(process.env.CACHE_TTL_MINUTES || 120)) * 60_000;
const CLEANUP_INTERVAL_MS = Math.max(1, Number(process.env.CLEANUP_INTERVAL_MINUTES || 5)) * 60_000;
const MAX_TORRENT_FILE_BYTES = Math.max(1, Number(process.env.MAX_TORRENT_FILE_MB || 20)) * 1024 ** 2;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".flv", ".ogv"]);
const DIRECT_PLAY_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
let ffmpegAvailable = false;

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

async function addTorrent(source, sourceType) {
  const id = crypto.randomUUID();
  const item = {
    id,
    source: sourceType === "magnet" ? "磁力链接" : "种子文件",
    name: "正在读取种子…",
    status: "metadata",
    createdAt: new Date().toISOString(),
    lastAccessedAt: Date.now(),
    activeStreams: 0,
    selectedFileIndex: null,
    torrent: null
  };
  torrents.set(id, item);

  const torrentPath = path.join(CACHE_DIR, id);
  try {
    const torrent = client.add(source, { path: torrentPath });
    item.torrent = torrent;
    torrent.on("ready", () => {
      item.name = torrent.name || "未命名种子";
      item.status = "downloading";
      const candidates = videoFiles(torrent);
      if (candidates.length) {
        torrent.files.forEach((file) => file.deselect());
        item.selectedFileIndex = candidates[0].index;
        candidates[0].file.select();
      }
    });
    torrent.on("done", () => {
      item.status = "ready";
    });
    torrent.on("error", (error) => {
      item.status = "error";
      item.error = error.message;
    });
    torrent.on("download", () => {
      if (item.status !== "ready") item.status = "downloading";
    });
    await waitForReady(torrent);
    return publicTorrent(item);
  } catch (error) {
    item.status = "error";
    item.error = error.message;
    throw Object.assign(new Error(error.message), { item });
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
    res.status(201).json(await addTorrent(magnet.trim(), "magnet"));
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
  item.torrent.files.forEach((candidate) => candidate.deselect());
  file.select();
  item.selectedFileIndex = fileIndex;
  item.status = item.torrent.done ? "ready" : "downloading";
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
