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
const QBT_URL = process.env.QBT_URL || "http://qbittorrent:8080";
const QBT_USERNAME = process.env.QBT_USERNAME || "";
const QBT_PASSWORD = process.env.QBT_PASSWORD || "";
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = Math.max(1, Number(process.env.MAX_CACHE_GB || 20)) * 1024 ** 3;
const MAX_TORRENT_FILE_BYTES = Math.max(1, Number(process.env.MAX_TORRENT_FILE_MB || 20)) * 1024 ** 2;
const STREAM_PREFETCH_BYTES = Math.max(64 * 1024, Number(process.env.STREAM_PREFETCH_KB || 256) * 1024);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts", ".m2ts", ".flv", ".ogv"]);
const DIRECT_PLAY_EXTENSIONS = new Set([".mp4", ".webm", ".m4v", ".ogv"]);
let ffmpegAvailable = false;
let qbtCookie = "";
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

async function qbtRequest(endpoint, options = {}, retry = true) {
  const headers = { ...(options.headers || {}) };
  if (qbtCookie) headers.cookie = qbtCookie;
  const response = await fetch(`${QBT_URL}${endpoint}`, { ...options, headers });
  if (response.status === 403 && retry && QBT_USERNAME && QBT_PASSWORD) {
    await qbtLogin();
    return qbtRequest(endpoint, options, false);
  }
  if (!response.ok) throw new Error(`qBittorrent API ${response.status}`);
  return response;
}

async function qbtLogin() {
  const body = new URLSearchParams({ username: QBT_USERNAME, password: QBT_PASSWORD });
  const response = await fetch(`${QBT_URL}/api/v2/auth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`qBittorrent login ${response.status}`);
  qbtCookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function qbtJson(endpoint) { return (await qbtRequest(endpoint)).json(); }
async function qbtPost(endpoint, body) { return qbtRequest(endpoint, { method: "POST", body }); }
function form(fields) { const body = new URLSearchParams(); for (const [key, value] of Object.entries(fields)) body.set(key, String(value)); return body; }
function taskDir(id) { return path.join(CACHE_DIR, id); }
function taskTag(id) { return `cloud-player-${id}`; }
function isVideo(name) { return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()); }
function fileName(filePath, id) { return path.relative(taskDir(id), filePath).replaceAll(path.sep, "/"); }
function safeFilePath(item, name) { const target = path.resolve(taskDir(item.id), name); const root = `${path.resolve(taskDir(item.id))}${path.sep}`; return target === path.resolve(taskDir(item.id)) || target.startsWith(root) ? target : null; }
function sourceKey(source, type) { if (type === "magnet") { const match = String(source).match(/[?&]xt=urn:btih:([^&]+)/i); if (match) return `magnet:${decodeURIComponent(match[1]).toLowerCase()}`; } return `${type}:${String(source)}`; }

function persistTasks() {
  const records = [...torrents.values()].map((item) => ({ id: item.id, hash: item.hash, sourceType: item.sourceType, sourceValue: item.sourceValue, name: item.name, createdAt: item.createdAt, lastAccessedAt: item.lastAccessedAt, selectedFileIndex: item.selectedFileIndex, caching: Boolean(item.caching) }));
  saveChain = saveChain.then(async () => { const temp = `${TASKS_FILE}.tmp`; await fsp.writeFile(temp, JSON.stringify(records, null, 2)); await fsp.rename(temp, TASKS_FILE); }).catch((error) => console.error("task persistence failed:", error.message));
  return saveChain;
}

async function infoByHash(hash) {
  if (!hash) return null;
  const list = await qbtJson(`/api/v2/torrents/info?hashes=${encodeURIComponent(hash)}`);
  return list[0] || null;
}

async function findInfo(item) {
  if (item.hash) { const info = await infoByHash(item.hash); if (info) return info; }
  const tagged = await qbtJson(`/api/v2/torrents/info?tag=${encodeURIComponent(taskTag(item.id))}`);
  const info = tagged.find((candidate) => candidate.save_path === `${taskDir(item.id)}${path.sep}` || candidate.save_path === taskDir(item.id)) || tagged[0];
  if (info) item.hash = info.hash;
  return info || null;
}

async function addToQbt(item, torrentBuffer = null) {
  const fields = { savepath: taskDir(item.id), category: "cloud-player", tags: taskTag(item.id), sequentialDownload: "true", firstLastPiecePrio: "true", upLimit: Number(process.env.UPLOAD_LIMIT_KBPS || 32) * 1024 };
  if (item.sourceType === "magnet") {
    fields.urls = item.sourceValue;
    await qbtPost("/api/v2/torrents/add", form(fields));
  } else {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
    body.append("torrents", new Blob([torrentBuffer || await fsp.readFile(item.sourceValue)]), "source.torrent");
    await qbtPost("/api/v2/torrents/add", body);
  }
}

async function ensureInfo(item) {
  const info = await findInfo(item);
  if (info) { item.hash = info.hash; item.name = info.name || item.name; }
  return info;
}

async function qbtFiles(item) {
  if (!item.hash) return [];
  const files = await qbtJson(`/api/v2/torrents/files?hash=${encodeURIComponent(item.hash)}`);
  return files.map((file, index) => ({ path: safeFilePath(item, file.name), name: file.name, length: Number(file.size || 0), completedLength: Math.floor(Number(file.size || 0) * Number(file.progress || 0)), selected: Number(file.priority || 0) > 0, index }));
}

function publicTorrent(item) {
  return { id: item.id, name: item.name, source: item.source, status: item.status, error: item.error || null, progress: item.totalLength ? item.completedLength / item.totalLength : 0, downloadSpeed: item.downloadSpeed || 0, uploadSpeed: item.uploadSpeed || 0, peers: item.peers || 0, seeders: item.seeders || 0, done: item.status === "ready", size: item.totalLength || 0, lastAccessedAt: item.lastAccessedAt, createdAt: item.createdAt, activeStreams: item.activeStreams, caching: Boolean(item.caching), files: (item.files || []).map((file, index) => ({ index, name: file.name, length: file.length, extension: path.extname(file.name).toLowerCase(), isVideo: isVideo(file.name), directPlayable: DIRECT_PLAY_EXTENSIONS.has(path.extname(file.name).toLowerCase()), selected: index === item.selectedFileIndex })) };
}

async function applySelection(item) {
  if (!item.hash || !item.files.length || item.selectedFileIndex == null || item.selectionConfigured) return;
  const selected = item.files[item.selectedFileIndex];
  if (!selected) return;
  for (const file of item.files) await qbtPost("/api/v2/torrents/filePrio", form({ hash: item.hash, id: file.index, priority: 0 }));
  await qbtPost("/api/v2/torrents/filePrio", form({ hash: item.hash, id: selected.index, priority: 7 }));
  item.selectionConfigured = true;
}

async function syncItem(item) {
  try {
    const info = await ensureInfo(item);
    if (!info) { item.status = item.caching ? "downloading" : "paused"; item.files = []; return item; }
    item.totalLength = Number(info.size || 0); item.completedLength = Number(info.completed || 0); item.downloadSpeed = Number(info.dlspeed || 0); item.uploadSpeed = Number(info.upspeed || 0); item.peers = Number(info.num_leechs || 0) + Number(info.num_seeds || 0); item.seeders = Number(info.num_seeds || 0); item.error = info.state === "error" ? (info.eta === 8640000 ? "qBittorrent task error" : "Torrent error") : null;
    item.files = await qbtFiles(item);
    if (item.files.length && item.selectedFileIndex == null) { const candidates = item.files.filter((file) => isVideo(file.name)).sort((a, b) => b.length - a.length); if (candidates[0]) item.selectedFileIndex = candidates[0].index; }
    await applySelection(item);
    const complete = Number(info.progress || 0) >= 1 || info.state === "uploading" || info.state === "stalledup";
    item.status = item.error ? "error" : complete ? "ready" : item.caching ? "downloading" : "paused";
  } catch (error) { item.error = error.message; item.status = "error"; }
  return item;
}

async function addTask(source, sourceType, restored = null) {
  const id = restored?.id || crypto.randomUUID();
  const key = sourceKey(source, sourceType);
  const existing = [...torrents.values()].find((item) => item.sourceKey === key && item.id !== id);
  if (existing) return publicTorrent(existing);
  const sourceValue = sourceType === "file" && Buffer.isBuffer(source) ? path.join(taskDir(id), "source.torrent") : source;
  await fsp.mkdir(taskDir(id), { recursive: true });
  if (sourceType === "file" && Buffer.isBuffer(source)) await fsp.writeFile(sourceValue, source);
  const item = { id, hash: restored?.hash || null, source: sourceType === "magnet" ? "Magnet" : "Torrent file", sourceType, sourceValue, sourceKey: key, name: restored?.name || "Reading torrent...", status: "metadata", createdAt: restored?.createdAt || new Date().toISOString(), lastAccessedAt: Date.now(), selectedFileIndex: restored?.selectedFileIndex ?? null, files: [], activeStreams: 0, caching: restored ? restored.caching === true : true, selectionConfigured: false };
  torrents.set(id, item);
  if (!await ensureInfo(item)) await addToQbt(item, sourceType === "file" ? source : null);
  await persistTasks(); await syncItem(item); return publicTorrent(item);
}

async function setCaching(item, enabled, index = item.selectedFileIndex) {
  await syncItem(item); if (index != null && selectedFile(item, index)) { item.selectedFileIndex = index; item.selectionConfigured = false; await applySelection(item); }
  if (item.hash) await qbtPost(`/api/v2/torrents/${enabled ? "resume" : "pause"}`, form({ hashes: item.hash }));
  item.caching = enabled; item.status = enabled ? "downloading" : "paused"; await persistTasks(); return true;
}

function selectedFile(item, index = item.selectedFileIndex) { const file = item.files[index]; return file && isVideo(file.name) ? file : null; }
async function waitMetadata(item) { for (let i = 0; i < 120; i++) { await syncItem(item); if (item.files.length || item.status === "error") return; await new Promise((resolve) => setTimeout(resolve, 500)); } }
async function waitBytes(item, file, end) { for (let i = 0; i < 600; i++) { await syncItem(item); const current = item.files.find((candidate) => candidate.path === file.path); if (current && current.completedLength >= end + 1) return current; if (item.status === "error") throw new Error(item.error || "Download failed"); await new Promise((resolve) => setTimeout(resolve, 500)); } throw new Error("Waiting for torrent data timed out"); }
async function growingStream(item, file, start, end) { async function* chunks() { let position = start; while (position <= end) { await syncItem(item); const current = item.files.find((candidate) => candidate.path === file.path); const available = current?.completedLength || 0; if (available > position) { const handle = await fsp.open(file.path, "r"); const size = Math.min(1024 * 1024, end - position + 1, available - position); const buffer = Buffer.alloc(size); const read = await handle.read(buffer, 0, size, position); await handle.close(); if (!read.bytesRead) continue; position += read.bytesRead; yield buffer.subarray(0, read.bytesRead); } else if (item.status === "error") throw new Error(item.error || "Download failed"); else await new Promise((resolve) => setTimeout(resolve, 500)); } } return Readable.from(chunks()); }

function mimeFor(name) { return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".m4v": "video/mp4", ".ogv": "video/ogg" })[path.extname(name).toLowerCase()] || "video/mp4"; }
async function directorySize(dir) { let total = 0; let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; } for (const entry of entries) { const target = path.join(dir, entry.name); total += entry.isDirectory() ? await directorySize(target) : (await fsp.stat(target)).size; } return total; }
async function cleanup() { const now = Date.now(); for (const item of [...torrents.values()]) if (!item.activeStreams && now - item.lastAccessedAt > CACHE_TTL_MS) { if (item.hash) await qbtPost("/api/v2/torrents/delete", form({ hashes: item.hash, deleteFiles: "false" })).catch(() => {}); torrents.delete(item.id); await fsp.rm(taskDir(item.id), { recursive: true, force: true }); } await persistTasks(); }
async function restoreTasks() { let records; try { records = JSON.parse(await fsp.readFile(TASKS_FILE, "utf8")); } catch { return; } const seen = new Set(); for (const record of records || []) { try { const source = record.sourceType === "file" ? await fsp.readFile(record.sourceValue) : record.sourceValue; const key = sourceKey(source, record.sourceType); if (seen.has(key)) continue; seen.add(key); await addTask(source, record.sourceType, record); } catch (error) { console.error("restore task failed:", error.message); } } await persistTasks(); }
async function waitForQbt() { for (let i = 0; i < 180; i++) { try { await qbtJson("/api/v2/app/version"); return; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); } } throw new Error("qBittorrent is unavailable after 180 seconds"); }

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TORRENT_FILE_BYTES, files: 1 } });
app.get("/api/config", (_req, res) => res.json({ maxCacheGb: Number(process.env.MAX_CACHE_GB || 20), cacheTtlMinutes: 180, ffmpegAvailable, authEnabled: Boolean(process.env.AUTH_TOKEN?.trim()) }));
app.get("/api/torrents", async (_req, res) => { await Promise.allSettled([...torrents.values()].map(syncItem)); res.json([...torrents.values()].map(publicTorrent)); });
app.get("/api/cache", async (_req, res) => res.json({ usedBytes: await directorySize(CACHE_DIR), maxBytes: MAX_CACHE_BYTES }));
app.post("/api/torrents", async (req, res) => { try { const magnet = String(req.body?.magnet || "").trim(); if (!/^magnet:\?/i.test(magnet)) throw new Error("Invalid magnet link"); res.status(201).json(await addTask(magnet, "magnet")); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post("/api/torrents/upload", upload.single("torrent"), async (req, res) => { try { if (!req.file) throw new Error("Select a torrent file"); res.status(201).json(await addTask(req.file.buffer, "file")); } catch (error) { res.status(400).json({ error: error.message }); } });
app.post("/api/torrents/:id/select", async (req, res) => { const item = torrents.get(req.params.id); if (!item) return res.status(404).json({ error: "Task not found" }); item.lastAccessedAt = Date.now(); await waitMetadata(item); const index = Number(req.body?.fileIndex); if (!selectedFile(item, index)) return res.status(400).json({ error: "Video file not found" }); item.selectedFileIndex = index; item.selectionConfigured = false; await setCaching(item, false, index); res.json(publicTorrent(item)); });
app.post("/api/torrents/:id/cache", async (req, res) => { const item = torrents.get(req.params.id); if (!item) return res.status(404).json({ error: "Task not found" }); item.lastAccessedAt = Date.now(); await waitMetadata(item); await setCaching(item, req.body?.enabled !== false, Number(req.body?.fileIndex ?? item.selectedFileIndex)); res.json(publicTorrent(item)); });
app.get("/api/torrents/:id/files/:index/stream", async (req, res) => { const item = torrents.get(req.params.id); if (!item) return res.status(404).json({ error: "Task not found" }); try { await waitMetadata(item); const file = selectedFile(item, Number(req.params.index)); if (!file) return res.status(404).json({ error: "Video file not found" }); await setCaching(item, true, Number(req.params.index)); let start = 0; let end = file.length - 1; const range = req.headers.range; if (range) { const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return res.status(416).end(); if (match[1]) start = Number(match[1]); if (match[2]) end = Number(match[2]); if (!match[1] && match[2]) start = Math.max(0, file.length - Number(match[2])); if (start > end || start >= file.length || end >= file.length) return res.status(416).end(); res.status(206); res.setHeader("Content-Range", `bytes ${start}-${end}/${file.length}`); } await waitBytes(item, file, Math.min(end, start + STREAM_PREFETCH_BYTES - 1)); res.setHeader("Content-Type", mimeFor(file.name)); res.setHeader("Content-Length", end - start + 1); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Cache-Control", "no-store"); item.activeStreams++; const stream = await growingStream(item, file, start, end); stream.once("close", () => { item.activeStreams = Math.max(0, item.activeStreams - 1); item.lastAccessedAt = Date.now(); }); stream.pipe(res); } catch (error) { if (!res.headersSent) res.status(500); res.end(error.message); } });
app.delete("/api/torrents/:id", async (req, res) => { const item = torrents.get(req.params.id); if (!item) return res.status(404).json({ error: "Task not found" }); if (item.hash) await qbtPost("/api/v2/torrents/delete", form({ hashes: item.hash, deleteFiles: "false" })).catch(() => {}); torrents.delete(item.id); await persistTasks(); await fsp.rm(taskDir(item.id), { recursive: true, force: true }); res.status(204).end(); });

await waitForQbt();
await restoreTasks();
ffmpegAvailable = await new Promise((resolve) => { const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" }); child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); });
setInterval(() => cleanup().catch((error) => console.error("cleanup failed:", error.message)), CACHE_TTL_MS).unref();
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Cloud Torrent Player (qBittorrent) listening on http://0.0.0.0:${PORT}`));
