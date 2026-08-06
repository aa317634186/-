const state = {
  torrents: [],
  cache: { usedBytes: 0, maxBytes: 0 },
  history: JSON.parse(localStorage.getItem("cloud-player-history") || "[]"),
  pendingHistoryKey: null,
  lastHistorySaveAt: 0,
  selectedId: null,
  config: { maxCacheGb: 20, cacheTtlMinutes: 120, ffmpegAvailable: false },
  token: localStorage.getItem("cloud-player-token") || ""
};

const $ = (selector) => document.querySelector(selector);
const tokenInput = $("#tokenInput");
tokenInput.value = state.token;
tokenInput.addEventListener("change", () => {
  state.token = tokenInput.value.trim();
  localStorage.setItem("cloud-player-token", state.token);
  refresh();
});

function headers(extra = {}) {
  return { "Content-Type": "application/json", ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...extra };
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: headers(options.headers || {}) });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatSpeed(bytes) { return bytes > 0 ? `${formatBytes(bytes)}/s` : "等待连接"; }
function formatDate(iso) { return new Date(iso).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }

function setConnection(ok, text) {
  $("#connectionText").textContent = text;
  $("#connectionDot").parentElement.className = `connection ${ok ? "ok" : "error"}`;
}

async function loadConfig() {
  state.config = await api("/api/config");
  $("#cacheLimit").textContent = `${state.config.maxCacheGb} GB`;
  $("#cacheReadingLimit").textContent = `/ ${state.config.maxCacheGb} GB`;
  $("#ttlReading").textContent = `${state.config.cacheTtlMinutes} 分钟`;
  $("#serverMode").textContent = state.config.authEnabled ? "受保护服务" : "本地服务";
}

async function refresh() {
  try {
    const [torrents, cache] = await Promise.all([api("/api/torrents"), api("/api/cache")]);
    state.torrents = torrents;
    state.cache = cache;
    setConnection(true, "已连接");
    if (!state.selectedId || !state.torrents.some((item) => item.id === state.selectedId)) {
      state.selectedId = state.torrents[0]?.id || null;
    }
    render();
  } catch (error) {
    setConnection(false, error.message.includes("令牌") ? "令牌无效" : "服务离线");
  }
}

function render() {
  const selected = state.torrents.find((item) => item.id === state.selectedId) || null;
  $("#taskCount").textContent = state.torrents.length;
  $("#queueCount").textContent = state.torrents.length;
  $("#activeReading").textContent = state.torrents.filter((item) => item.activeStreams > 0).length;
  const cachePercent = state.cache.maxBytes ? Math.min(100, state.cache.usedBytes / state.cache.maxBytes * 100) : 0;
  $("#cacheMeterBar").style.width = `${cachePercent}%`;
  $("#cacheReading").textContent = formatBytes(state.cache.usedBytes);
  renderQueue();
  renderFiles(selected);
  renderHistory();
  if (selected) renderSelected(selected);
  else resetPlayer();
}

function renderQueue() {
  const list = $("#queueList");
  if (!state.torrents.length) {
    list.className = "queue-list empty-list";
    list.innerHTML = "<span>还没有播放任务</span>";
    return;
  }
  list.className = "queue-list";
  list.innerHTML = state.torrents.map((item) => {
    const progress = Math.round(item.progress * 100);
    const status = item.status === "ready" ? "已完成" : item.status === "error" ? "错误" : `${progress}% · ${formatSpeed(item.downloadSpeed)}`;
    return `<div class="queue-item ${item.id === state.selectedId ? "selected" : ""}" data-id="${item.id}">
      <div class="queue-item-head"><span class="queue-icon">▶</span><span class="queue-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><button class="queue-delete" data-delete="${item.id}" title="删除临时任务" aria-label="删除临时任务">×</button></div>
      <div class="queue-meta"><span>${status}</span><span>${item.peers} 个连接</span></div>
      <div class="progress-track"><span style="width:${progress}%"></span></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".queue-item").forEach((row) => row.addEventListener("click", () => { state.selectedId = row.dataset.id; render(); }));
  list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try { await api(`/api/torrents/${button.dataset.delete}`, { method: "DELETE" }); toast("临时任务已删除"); await refresh(); }
    catch (error) { toast(error.message, true); }
  }));
}

function renderSelected(item) {
  $("#nowPlayingTitle").textContent = item.name;
  const status = $("#playerStatus");
  status.textContent = item.status === "ready" ? "已就绪" : item.status === "error" ? "发生错误" : `${Math.round(item.progress * 100)}% 下载中`;
  status.className = `status-pill ${item.status === "error" ? "warn" : ""}`;
  const selectedFile = item.files.find((file) => file.index === item.selectedFileIndex) || item.files.find((file) => file.isVideo);
  if (selectedFile && !selectedFile.directPlayable && !state.config.ffmpegAvailable) {
    status.textContent = "需要 FFmpeg";
    status.className = "status-pill warn";
  }
  const details = $("#selectedDetails");
  if (selectedFile) {
    details.className = "selected-details";
    details.innerHTML = `<strong title="${escapeHtml(selectedFile.name)}">${escapeHtml(selectedFile.name)}</strong><span>${formatBytes(selectedFile.length)} · ${formatSpeed(item.downloadSpeed)} · ${item.peers} 个连接</span>`;
    const player = $("#videoPlayer");
    const endpoint = selectedFile.directPlayable ? "stream" : "transcode";
    const streamUrl = `/api/torrents/${item.id}/files/${selectedFile.index}/${endpoint}${state.token ? `?token=${encodeURIComponent(state.token)}` : ""}`;
    if (player.dataset.src !== streamUrl) {
      player.dataset.src = streamUrl;
      player.dataset.historyKey = historyKey(item.id, selectedFile.index);
      delete player.dataset.restored;
      player.src = streamUrl;
      player.load();
    }
    if (state.pendingHistoryKey === historyKey(item.id, selectedFile.index)) {
      player.dataset.restoreHistory = "1";
    }
    $("#playerEmpty").classList.add("hidden");
  }
}

function resetPlayer() {
  $("#nowPlayingTitle").textContent = "尚未选择视频";
  $("#playerStatus").textContent = "等待播放";
  $("#playerStatus").className = "status-pill muted";
  $("#selectedDetails").className = "selected-details hidden";
  $("#playerEmpty").classList.remove("hidden");
  const player = $("#videoPlayer");
  player.removeAttribute("src");
  player.dataset.src = "";
  player.load();
}

function renderFiles(item) {
  const list = $("#fileList");
  const files = item?.files.filter((file) => file.isVideo) || [];
  if (!files.length) {
    list.className = "file-list empty-list";
    list.innerHTML = `<span>${item ? "这个任务还没有发现视频文件" : "添加任务后，视频文件会显示在这里"}</span>`;
    return;
  }
  list.className = "file-list";
  list.innerHTML = files.map((file) => `<div class="file-row ${file.index === item.selectedFileIndex ? "active" : ""}">
    <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><span class="file-size">${formatBytes(file.length)}</span>
    <button class="file-action" data-file="${file.index}">${file.index === item.selectedFileIndex ? "正在播放" : "播放"}</button>
  </div>`).join("");
  list.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/torrents/${item.id}/select`, { method: "POST", body: JSON.stringify({ fileIndex: Number(button.dataset.file) }) }); state.selectedId = item.id; await refresh(); }
    catch (error) { toast(error.message, true); }
  }));
}

function historyKey(torrentId, fileIndex) { return `${torrentId}:${fileIndex}`; }

function historyRecord(key) { return state.history.find((record) => record.key === key); }

function saveHistory(item, file, position, duration) {
  const key = historyKey(item.id, file.index);
  const record = {
    key,
    torrentId: item.id,
    fileIndex: file.index,
    torrentName: item.name,
    fileName: file.name,
    position: Number(position || 0),
    duration: Number(duration || file.length || 0),
    lastPlayedAt: new Date().toISOString()
  };
  state.history = [record, ...state.history.filter((entry) => entry.key !== key)].slice(0, 20);
  localStorage.setItem("cloud-player-history", JSON.stringify(state.history));
}

function formatPosition(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = String(value % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function renderHistory() {
  const list = $("#historyList");
  if (!state.history.length) {
    list.className = "history-list empty-list";
    list.innerHTML = "<span>播放后会显示最近记录</span>";
    return;
  }
  list.className = "history-list";
  list.innerHTML = state.history.map((record) => {
    const active = state.torrents.some((item) => item.id === record.torrentId);
    const progress = record.duration ? Math.round(record.position / record.duration * 100) : 0;
    return `<button class="history-item ${active ? "" : "unavailable"}" data-history="${escapeHtml(record.key)}">
      <span class="history-name" title="${escapeHtml(record.fileName)}">${escapeHtml(record.fileName)}</span>
      <span class="history-meta"><span>${active ? `${progress}% · ${formatPosition(record.position)}` : "任务已清理"}</span><span>${formatDate(record.lastPlayedAt)}</span></span>
    </button>`;
  }).join("");
  list.querySelectorAll("[data-history]").forEach((button) => button.addEventListener("click", async () => {
    const record = historyRecord(button.dataset.history);
    const item = state.torrents.find((torrent) => torrent.id === record?.torrentId);
    if (!item) return toast("这个任务的临时缓存已经清理", true);
    try {
      if (item.selectedFileIndex !== record.fileIndex) {
        await api(`/api/torrents/${item.id}/select`, { method: "POST", body: JSON.stringify({ fileIndex: record.fileIndex }) });
      }
      state.selectedId = item.id;
      state.pendingHistoryKey = record.key;
      await refresh();
    } catch (error) { toast(error.message, true); }
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.style.background = error ? "var(--danger)" : "var(--accent)";
  element.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove("show"), 2800);
}

const player = $("#videoPlayer");
player.addEventListener("loadedmetadata", () => {
  const record = historyRecord(player.dataset.historyKey);
  if (player.dataset.restoreHistory === "1" && record && !player.dataset.restored) {
    player.currentTime = Math.min(record.position, Math.max(0, player.duration - 1));
    player.dataset.restored = "1";
    state.pendingHistoryKey = null;
  }
});
player.addEventListener("timeupdate", () => {
  if (Date.now() - state.lastHistorySaveAt < 5000) return;
  const item = state.torrents.find((torrent) => torrent.id === state.selectedId);
  const file = item?.files.find((candidate) => candidate.index === item.selectedFileIndex);
  if (!item || !file || !Number.isFinite(player.currentTime)) return;
  state.lastHistorySaveAt = Date.now();
  saveHistory(item, file, player.currentTime, player.duration);
  renderHistory();
});
player.addEventListener("ended", () => {
  const item = state.torrents.find((torrent) => torrent.id === state.selectedId);
  const file = item?.files.find((candidate) => candidate.index === item.selectedFileIndex);
  if (item && file) saveHistory(item, file, 0, player.duration);
  renderHistory();
});

$("#clearHistory").addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("cloud-player-history");
  renderHistory();
});

document.querySelectorAll(".source-tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".source-tab").forEach((item) => item.classList.toggle("active", item === tab));
  $("#magnetForm").classList.toggle("hidden", tab.dataset.tab !== "magnet");
  $("#fileForm").classList.toggle("hidden", tab.dataset.tab !== "file");
  $("#formMessage").textContent = "";
}));

$("#torrentFile").addEventListener("change", (event) => {
  $("#fileName").textContent = event.target.files[0]?.name || "选择 .torrent 文件";
});

$("#magnetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#magnetInput");
  const message = $("#formMessage");
  message.textContent = "正在连接节点并读取元数据…";
  try { const item = await api("/api/torrents", { method: "POST", body: JSON.stringify({ magnet: input.value }) }); state.selectedId = item.id; input.value = ""; message.textContent = ""; toast("任务已加入"); await refresh(); }
  catch (error) { message.textContent = error.message; }
});

$("#fileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#torrentFile").files[0];
  if (!file) return;
  const message = $("#formMessage");
  message.textContent = "正在读取种子元数据…";
  const form = new FormData();
  form.append("torrent", file);
  try {
    const response = await fetch("/api/torrents/upload", { method: "POST", body: form, headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
    const item = await response.json();
    if (!response.ok) throw new Error(item.error || "上传失败");
    state.selectedId = item.id; $("#torrentFile").value = ""; $("#fileName").textContent = "选择 .torrent 文件"; message.textContent = ""; toast("任务已加入"); await refresh();
  } catch (error) { message.textContent = error.message; }
});

await loadConfig().catch(() => {});
await refresh();
window.setInterval(refresh, 2500);
