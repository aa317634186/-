#!/bin/sh
set -eu

mkdir -p /config/qBittorrent
if [ ! -f /config/qBittorrent/qBittorrent.conf ]; then
  cp /defaults/qBittorrent.conf /config/qBittorrent/qBittorrent.conf
fi

exec /init
