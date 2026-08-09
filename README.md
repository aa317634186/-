# 云播放器

一个面向 Linux 服务器的临时 Torrent 视频播放器。它使用 WebTorrent 在服务端建立下载会话，通过 HTTP Range 把视频直接交给浏览器播放，不把内容加入长期媒体库。

请只播放你有权访问或分发的内容。

## 功能

- 支持 `magnet:` 磁力链接和 `.torrent` 文件
- 多文件种子中自动筛选视频，可手动切换
- 支持浏览器拖动进度条所需的 HTTP Range 请求
- MP4、WebM 等格式直接播放；MKV、AVI、MOV、FLV、TS、M2TS 等格式由 FFmpeg 转码为浏览器可播放流
- 浏览器端保存播放历史和播放进度；临时任务清理后历史会标记为不可用
- WebTorrent 同时使用 Tracker、DHT 和局域网发现，并支持多 Peer 并发下载
- 独立临时缓存目录，默认 20 GB 上限
- 任务空闲 120 分钟后自动清理，超出容量时按最久未访问顺序清理
- 服务启动或定时检查时会移除没有对应活动任务的残留缓存目录
- 播放中的任务不会被清理；手动删除会同时终止下载会话和移除缓存
- 可用 `AUTH_TOKEN` 增加简单访问令牌保护

## Docker 部署

### 一键菜单部署

在 Linux 服务器使用 root 执行下面一条命令即可进入安装菜单：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/aa317634186/-/master/install.sh)
```

菜单支持安装、更新、卸载、域名访问和 IP+端口访问控制。选择“添加域名访问”后，填写已经解析到服务器的域名，Caddy 会自动申请 HTTPS 证书。

服务器需要 Docker 和 Compose 插件。将项目上传到服务器后执行：

```bash
cp .env.example .env
mkdir -p data/cache
docker compose up -d --build
docker compose logs -f cloud-player
```

浏览器访问 `http://服务器IP:3000`。缓存会写入项目下的 `data/cache`，建议把 `data` 放在容量充足的磁盘或单独挂载的目录。

生产环境至少应当：

1. 在 `docker-compose.yml` 设置一个足够长的随机 `AUTH_TOKEN`。
2. 通过 Nginx/Caddy 配置 HTTPS，并只开放反向代理端口。
3. 用防火墙限制服务端口，避免直接暴露 WebTorrent 管理界面以外的系统服务。

## 不使用 Docker

需要 Node.js 20 或更高版本：

```bash
npm install
cp .env.example .env
npm start
```

主要环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `CACHE_DIR` | `./cache` | 临时缓存位置 |
| `MAX_CACHE_GB` | `20` | 缓存容量上限 |
| `CACHE_TTL_MINUTES` | `180` | 固定 3 小时后清理无活动缓存 |
| `CLEANUP_INTERVAL_MINUTES` | `180` | 固定每 3 小时运行清理 |
| `MAX_TORRENT_FILE_MB` | `20` | 上传的 `.torrent` 文件大小上限 |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径 |
| `PEER_PORT` | `6881` | Torrent TCP/UDP Peer 端口 |
| `DHT_PORT` | `6881` | DHT UDP 端口 |
| `MAX_PEERS` | `80` | 单个客户端最大 Peer 连接数 |
| `AUTH_TOKEN` | 空 | 非空时 API 需要 Bearer 令牌 |

兼容格式需要服务器安装 FFmpeg。Docker 镜像会自动安装；直接运行时可执行 `sudo apt-get update && sudo apt-get install -y ffmpeg`。

多 Peer 下载还需要在云服务器安全组和系统防火墙开放 `6881/TCP`、`6881/UDP`。如果任务显示 `0 个连接`，也可能是磁力链接没有活跃做种、Tracker/DHT 不可达，或者服务器网络限制了 BitTorrent 流量；这不是缓存容量限制。

## 运行边界

这是一个单机 MVP：任务状态保存在内存中，进程重启后不会恢复下载会话。这样可以避免意外把下载任务变成长期保存队列；如果服务器重启，重新添加磁力链即可。视频是否能流畅播放取决于种子健康度、服务器带宽和目标视频编码，浏览器无法解码的格式需要先转换为浏览器支持的格式。
