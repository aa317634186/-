FROM lscr.io/linuxserver/qbittorrent:latest

COPY qBittorrent.conf /defaults/qBittorrent.conf
COPY entrypoint.sh /entrypoint-cloud-player.sh
RUN mkdir -p /custom-cont-init.d
COPY configure.sh /custom-cont-init.d/99-cloud-player-config
RUN chmod +x /entrypoint-cloud-player.sh /custom-cont-init.d/99-cloud-player-config

ENTRYPOINT ["/entrypoint-cloud-player.sh"]
