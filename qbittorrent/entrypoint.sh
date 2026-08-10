#!/bin/sh
set -eu

mkdir -p /config/qBittorrent
if [ ! -f /config/qBittorrent/qBittorrent.conf ]; then
  cp /defaults/qBittorrent.conf /config/qBittorrent/qBittorrent.conf
fi

conf=/config/qBittorrent/qBittorrent.conf
for setting in 'WebUI\\HostHeaderValidation=false' 'WebUI\\OriginHeaderValidation=false' 'WebUI\\AuthenticationSubnetWhitelistEnabled=false'; do
  key=${setting%%=*}
  grep -Fq "${key}=" "$conf" || printf '\n%s\n' "$setting" >> "$conf"
done

exec /init
