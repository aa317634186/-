#!/bin/sh
set -eu

conf=/config/qBittorrent/qBittorrent.conf
[ -f "$conf" ] || exit 0

set_setting() {
  key=$1
  value=$2
  if grep -Fq "${key}=" "$conf"; then
    awk -v key="$key" -v value="$value" 'index($0, key "=") == 1 {$0 = key "=" value} {print}' "$conf" > "${conf}.tmp"
    mv "${conf}.tmp" "$conf"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$conf"
  fi
}

set_setting 'WebUI\\AuthenticationEnabled' 'false'
set_setting 'WebUI\\CSRFProtection' 'false'
set_setting 'WebUI\\HostHeaderValidation' 'false'
set_setting 'WebUI\\OriginHeaderValidation' 'false'
set_setting 'WebUI\\AuthenticationSubnetWhitelistEnabled' 'false'
