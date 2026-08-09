import "dotenv/config";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const torrents = new Map();
const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, "cache"));
const TASKS_FILE = path.join(CACHE_DIR, "tasks.json");
const RPC_URL = process.env.ARIA2_RPC_URL || "http://aria2:6800/jsonrpc";
const RPC_SECRET = process.env.ARIA2_SECRET || "cloud-player-secret";
const MAX_CACHE_BYTES = Math.max(1, Number(process.env.MAX_CACHE_GB || 20)) * 1024 ** 3;
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_TORRENT_FILE_BYTES = Math.max(1, Number(process.env.MAX_TORRENT_FILE_MB || 20)) * 1024 ** 2;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".flv", ".ogv"]);
const DIRECT_PLAY_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
let ffmpegAvailable = false;
let saveChain = Promise.resolve();

await fsp.mkdir(CACHE_DIR, { recursive: true });
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function authGuard(req, res, next) {
  const expected = process.env.AUTH_TOKEN?.trim();
  const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") || req.query.token;
  if (expected && supplied !== expected) return res.status(401).json({ error: "Invalid access token" });
  next();
}
app.use("/api", authGuard);

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params: [`token:${RPC_SECRET}`, ...params] })
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || `aria2 RPC ${response.status}`);
  return data.result;
}

function taskDir(id) { return path.join(CACHE_DIR, id); }
function fileName(filePath, id) { return path.relative(taskDir(id), filePath).replaceAll(path.sep, "/"); }
function isVideo(name) { return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()); }

function persistTasks() {
  const records = [...torrents.values()].map((item) => ({ id: item.id, gid: item.gid, sourceType: item.sourceType, sourceValue: item.sourceValue, name: item.name, createdAt: item.createdAt, lastAccessedAt: item.lastAccessedAt, selectedFileIndex: item.selectedFileIndex }));
  saveChain = saveChain.then(async () => {
    const tmp = `${TASKS_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(records, null, 2));
    await fsp.rename(tmp, TASKS_FILE);
  }).catch((error) => console.error("task persistence failed:", error.message));
  return saveChain;
}

function publicTorrent(item) {
  const files = item.files || [];
  return { id: item.id, name: item.name, source: item.source, status: item.status, error: item.error || null, progress: item.totalLength ? item.completedLength / item.totalLength : 0, downloadSpeed: item.downloadSpeed || 0, uploadSpeed: item.uploadSpeed || 0, peers: item.connections || 0, done: item.status === "complete", size: item.totalLength || 0, lastAccessedAt: item.lastAccessedAt, createdAt: item.createdAt, activeStreams: item.activeStreams, caching: Boolean(item.caching), files: files.map((file, index) => ({ index, name: file.name, length: file.length, extension: path.extname(file.name).toLowerCase(), isVideo: isVideo(file.name), directPlayable: DIRECT_PLAY_EXTENSIONS.has(path.extname(file.name).toLowerCase()), selected: index === item.selectedFileIndex })) };
}

async function syncItem(item) {
  if (!item.gid) return item;
  let status;
  try {
    status = await rpc("aria2.tellStatus", [item.gid, ["status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "connections", "numSeeders", "errorCode", "errorMessage", "files"]]);
  } catch (error) { item.error = error.message; item.status = "error"; return item; }
  item.ariaStatus = status.status;
  item.totalLength = Number(status.totalLength || 0);
  item.completedLength = Number(status.completedLength || 0);
  item.downloadSpeed = Number(status.downloadSpeed || 0);
  item.uploadSpeed = Number(status.uploadSpeed || 0);
  item.connections = Number(status.connections || 0);
  item.seeders = Number(status.numSeeders || 0);
  item.error = status.errorMessage || null;
  item.status = status.status === "complete" ? "ready" : status.status === "error" ? "error" : item.caching ? "downloading" : "paused";
  item.files = (status.files || []).map((file) => ({ path: file.path, name: fileName(file.path, item.id), length: Number(file.length || 0), completedLength: Number(file.completedLength || 0), selected: file.selected === "true" }));
  if (item.files.length && item.selectedFileIndex == null) {
    const candidates = item.files.map((file, index) => ({ file, index })).filter(({ file }) => isVideo(file.name)).sort((a, b) => b.file.length - a.file.length);
    if (candidates.length) item.selectedFileIndex = candidates[0].index;
  }
  if (item.files.length && item.selectedFileIndex != null && !item.selectionConfigured) {
    await rpc("aria2.changeOption", [item.gid, { "select-file": String(item.selectedFileIndex + 1), "bt-sequential-download": "true", "bt-prioritize-piece": "head" }]);
    item.selectionConfigured = true;
    if (!item.caching) await rpc("aria2.pause", [item.gid]).catch(() => {});
    await persistTasks();
  }
  return item;
}

async function syncAll() { await Promise.all([...torrents.values()].map(syncItem)); }
function getItem(req, res) { const item = torrents.get(req.params.id); if (!item) { res.status(404).json({ error: "Task not found" }); return null; } item.lastAccessedAt = Date.now(); return item; }
function addOptions(id) { return { dir: taskDir(id), "bt-sequential-download": "true", "bt-prioritize-piece": "head", "bt-max-peers": String(process.env.MAX_PEERS || 200), "max-upload-limit": `${process.env.UPLOAD_LIMIT_KBPS || 32}K`, "seed-time": "0", "enable-dht": "true", "bt-enable-lpd": "true", "bt-tracker-connect": "true" }; }

async function addTask(source, sourceType, restored = null) {
  const id = restored?.id || crypto.randomUUID();
  await fsp.mkdir(taskDir(id), { recursive: true });
  let gid;
  let sourceValue = source;
  if (sourceType === "file" && Buffer.isBuffer(source)) { sourceValue = path.join(taskDir(id), "source.torrent"); await fsp.writeFile(sourceValue, source); }
  const options = addOptions(id);
  gid = sourceType === "magnet" ? await rpc("aria2.addUri", [[source], options]) : await rpc("aria2.addTorrent", [source.toString("base64"), options]);
  const item = { id, gid, source: sourceType === "magnet" ? "Magnet" : "Torrent file", sourceType, sourceValue, name: restored?.name || "Reading torrent...", status: "metadata", createdAt: restored?.createdAt || new Date().toISOString(), lastAccessedAt: Date.now(), selectedFileIndex: restored?.selectedFileIndex ?? null, files: [], activeStreams: 0, caching: false, selectionConfigured: false };
  torrents.set(id, item);
  await persistTasks();
  await syncItem(item);
  return publicTorrent(item);
}

async function waitMetadata(item) { for (let i = 0; i < 120; i++) { await syncItem(item); if (item.files.length || item.status === "error") return; await new Promise((resolve) => setTimeout(resolve, 500)); } }
function selectedFile(item, index = item.selectedFileIndex) { const file = item.files[index]; return file && isVideo(file.name) ? file : null; }

async function setCaching(item, enabled, index = item.selectedFileIndex) {
  await syncItem(item);
  const file = selectedFile(item, index);
  if (!file) return false;
  item.selectedFileIndex = index;
  if (!item.selectionConfigured) { await rpc("aria2.changeOption", [item.gid, { "select-file": String(index + 1), "bt-sequential-download": "true", "bt-prioritize-piece": "head" }]); item.selectionConfigured = true; }
  await rpc(enabled ? "aria2.unpause" : "aria2.pause", [item.gid]);
  item.caching = enabled;
  item.status = enabled ? "downloading" : "paused";
  await persistTasks();
  return true;
}

async function waitBytes(item, file, end) { for (let i = 0; i < 600; i++) { await syncItem(item); const current = item.files.find((candidate) => candidate.path === file.path); if (current && current.completedLength >= end + 1) return current; if (item.status === "error") throw new Error(item.error || "Download failed"); await new Promise((resolve) => setTimeout(resolve, 500)); } throw new Error("Waiting for torrent data timed out"); }
async function growingStream(item, file, start, end) {
  async function* chunks() { let position = start; while (position <= end) { await syncItem(item); const current = item.files.find((candidate) => candidate.path === file.path); const available = current?.completedLength || 0; if (available > position) { const handle = await fsp.open(file.path, "r"); const size = Math.min(1024 * 1024, end - position + 1, available - position); const buffer = Buffer.alloc(size); const read = await handle.read(buffer, 0, size, position); await handle.close(); if (!read.bytesRead) continue; position += read.bytesRead; yield buffer.subarray(0, read.bytesRead); } else if (item.status === "error") throw new Error(item.error || "Download failed"); else await new Promise((resolve) => setTimeout(resolve, 500)); } }
  return Readable.from(chunks());
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TORRENT_FILE_BYTES, files: 1 } });
app.get("/api/config", (_req, res) => res.json({ maxCacheGb: Number(process.env.MAX_CACHE_GB || 20), cacheTtlMinutes: 180, ffmpegAvailable, authEnabled: Boolean(process.env.AUTH_TOKEN?.trim()) }));
app.get("/api/torrents", async (_req, res) => { await syncAll(); res.json([...torrents.values()].map(publicTorrent)); });
app.get("/api/cache", async (_req, res) => res.json({ usedBytes: await directorySize(CACHE_DIR), maxBytes: MAX_CACHE_BYTES }));
app.post("/api/torrents", async (req, res) => { try { const magnet = String(req.body?.magnet || "").trim(); if (!/^magnet:\?/i.test(magnet)) throw new Error("Invalid magnet link"); res.status(201).json(await addTask(magnet, "magnet")); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post("/api/torrents/upload", upload.single("torrent"), async (req, res) => { try { if (!req.file) throw new Error("Select a torrent file"); res.status(201).json(await addTask(req.file.buffer, "file")); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post("/api/torrents/:id/select", async (req, res) => { const item = getItem(req, res); if (!item) return; await waitMetadata(item); const index = Number(req.body?.fileIndex); if (!selectedFile(item, index)) return res.status(400).json({ error: "Video file not found" }); item.selectedFileIndex = index; item.selectionConfigured = false; await setCaching(item, false, index); res.json(publicTorrent(item)); });
app.post("/api/torrents/:id/cache", async (req, res) => { const item = getItem(req, res); if (!item) return; await waitMetadata(item); if (!await setCaching(item, req.body?.enabled !== false, Number(req.body?.fileIndex ?? item.selectedFileIndex))) return res.status(400).json({ error: "Video file not ready" }); res.json(publicTorrent(item)); });

app.get("/api/torrents/:id/files/:index/stream", async (req, res) => { const item = getItem(req, res); if (!item) return; try { await waitMetadata(item); const index = Number(req.params.index); const file = selectedFile(item, index); if (!file) return res.status(404).json({ error: "Video file not found" }); await setCaching(item, true, index); const total = file.length; let start = 0; let end = total - 1; const range = req.headers.range; if (range) { const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return res.status(416).end(); if (match[1]) start = Number(match[1]); if (match[2]) end = Number(match[2]); else end = total - 1; if (!match[1] && match[2]) start = Math.max(0, total - Number(match[2])); if (start > end || start >= total || end >= total) return res.status(416).end(); res.status(206); res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`); } await waitBytes(item, file, Math.min(end, start + 1024 * 1024 - 1)); res.setHeader("Content-Type", mimeFor(file.name)); res.setHeader("Content-Length", end - start + 1); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Cache-Control", "no-store"); item.activeStreams++; const stream = await growingStream(item, file, start, end); stream.once("close", () => { item.activeStreams = Math.max(0, item.activeStreams - 1); item.lastAccessedAt = Date.now(); }); stream.pipe(res); } catch (error) { if (!res.headersSent) res.status(500); res.end(error.message); } });

app.get("/api/torrents/:id/files/:index/transcode", async (req, res) => { const item = getItem(req, res); if (!item) return; if (!ffmpegAvailable) return res.status(503).json({ error: "FFmpeg unavailable" }); try { await waitMetadata(item); const index = Number(req.params.index); const file = selectedFile(item, index); if (!file) return res.status(404).json({ error: "Video file not found" }); await setCaching(item, true, index); await waitBytes(item, file, Math.min(file.length - 1, 4 * 1024 * 1024)); const source = await growingStream(item, file, 0, file.length - 1); const ffmpeg = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]); res.setHeader("Content-Type", "video/mp4"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Accept-Ranges", "none"); ffmpeg.once("error", (error) => res.destroy(error)); res.once("close", () => { source.destroy(); ffmpeg.kill("SIGKILL"); }); source.pipe(ffmpeg.stdin); ffmpeg.stdout.pipe(res); } catch (error) { if (!res.headersSent) res.status(500); res.end(error.message); } });

app.post("/api/torrents/:id/retry", async (req, res) => { const item = getItem(req, res); if (!item) return; try { await rpc("aria2.forceRemove", [item.gid]); item.gid = await (item.sourceType === "magnet" ? rpc("aria2.addUri", [[item.sourceValue], addOptions(item.id)]) : rpc("aria2.addTorrent", [(await fsp.readFile(item.sourceValue)).toString("base64"), addOptions(item.id)])); item.status = "metadata"; item.error = null; item.files = []; item.selectionConfigured = false; await persistTasks(); res.json(publicTorrent(item)); } catch (error) { res.status(400).json({ error: error.message }); } });
app.delete("/api/torrents/:id", async (req, res) => { const item = getItem(req, res); if (!item) return; await rpc("aria2.forceRemove", [item.gid]).catch(() => {}); torrents.delete(item.id); await persistTasks(); await fsp.rm(taskDir(item.id), { recursive: true, force: true }); res.status(204).end(); });

async function directorySize(dir) { let total = 0; let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; } for (const entry of entries) { const target = path.join(dir, entry.name); total += entry.isDirectory() ? await directorySize(target) : (await fsp.stat(target)).size; } return total; }
async function restoreTasks() { let records; try { records = JSON.parse(await fsp.readFile(TASKS_FILE, "utf8")); } catch { return; } for (const record of records || []) { try { const source = record.sourceType === "file" ? await fsp.readFile(record.sourceValue) : record.sourceValue; const item = await addTask(source, record.sourceType, record); item.caching = false; } catch (error) { console.error("restore task failed:", error.message); } } await persistTasks(); }
async function waitForAria2() { for (let attempt = 0; attempt < 60; attempt++) { try { await rpc("aria2.getVersion"); return; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); } } throw new Error("aria2 is unavailable"); }
async function cleanup() { const now = Date.now(); for (const item of [...torrents.values()]) if (!item.activeStreams && now - item.lastAccessedAt > CACHE_TTL_MS) { await rpc("aria2.forceRemove", [item.gid]).catch(() => {}); torrents.delete(item.id); await fsp.rm(taskDir(item.id), { recursive: true, force: true }); } await persistTasks(); }
function mimeFor(name) { return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".m4v": "video/mp4", ".ogv": "video/ogg" })[path.extname(name).toLowerCase()] || "video/mp4"; }
function checkFfmpeg() { return new Promise((resolve) => { const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" }); child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); }); }

await waitForAria2();
await restoreTasks();
ffmpegAvailable = await checkFfmpeg();
setInterval(() => cleanup().catch((error) => console.error("cleanup failed:", error.message)), CACHE_TTL_MS).unref();
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Cloud Torrent Player listening on http://0.0.0.0:${PORT}`));
