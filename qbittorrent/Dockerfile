FROM lscr.io/linuxserver/qbittorrent:latest

COPY qBittorrent.conf /defaults/qBittorrent.conf
COPY entrypoint.sh /entrypoint-cloud-player.sh
RUN chmod +x /entrypoint-cloud-player.sh

ENTRYPOINT ["/entrypoint-cloud-player.sh"]
