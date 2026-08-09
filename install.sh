#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="cloud-player"
APP_DIR="/opt/${APP_NAME}"
REPO_URL="https://github.com/aa317634186/-.git"
RAW_URL="https://github.com/aa317634186/-"
COMPOSE_FILE="${APP_DIR}/docker-compose.yml"
ENV_FILE="${APP_DIR}/.env"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[1;33m'
reset='\033[0m'

log() { printf "${green}%s${reset}\n" "$*"; }
warn() { printf "${yellow}%s${reset}\n" "$*"; }
die() { printf "${red}%s${reset}\n" "$*" >&2; exit 1; }

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "请使用 root 用户执行此脚本。"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    (cd "$APP_DIR" && docker compose --env-file "$ENV_FILE" "$@")
  elif command -v docker-compose >/dev/null 2>&1; then
    (cd "$APP_DIR" && docker-compose --env-file "$ENV_FILE" "$@")
  else
    die "未找到 Docker Compose，请先安装 Docker。"
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && (docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1); then
    systemctl enable --now docker >/dev/null 2>&1 || true
    return
  fi

  warn "未检测到 Docker，尝试自动安装。"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y docker.io docker-compose-plugin git curl openssl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y docker docker-compose-plugin git curl openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker git curl openssl
    curl -fsSL https://get.docker.com | sh
  else
    die "当前系统不支持自动安装 Docker，请手动安装后重试。"
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
}

ensure_repo() {
  mkdir -p "$(dirname "$APP_DIR")"
  if [[ -d "${APP_DIR}/.git" ]]; then
    git -C "$APP_DIR" fetch --all --prune
    git -C "$APP_DIR" reset --hard origin/master
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  fi
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    local token
    token="$(openssl rand -hex 24 2>/dev/null || date +%s%N)"
    cat > "$ENV_FILE" <<EOF
PORT=3000
BIND_IP=0.0.0.0
CACHE_DIR=/data/cache
MAX_CACHE_GB=20
CACHE_TTL_MINUTES=120
CLEANUP_INTERVAL_MINUTES=5
MAX_TORRENT_FILE_MB=20
FFMPEG_PATH=ffmpeg
PEER_PORT=6881
DHT_PORT=6881
MAX_PEERS=200
UPLOAD_LIMIT_KBPS=32
AUTH_TOKEN=${token}
EOF
    chmod 600 "$ENV_FILE"
    log "已生成访问令牌，保存在 ${ENV_FILE}。"
  fi
}

install_app() {
  require_root
  ensure_docker
  ensure_repo
  ensure_env
  compose -f "$COMPOSE_FILE" up -d --build
  log "云播放器安装完成。"
  echo "访问地址: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-3000}"
  echo "配置文件: ${ENV_FILE}"
}

update_app() {
  require_root
  [[ -d "${APP_DIR}/.git" ]] || { warn "云播放器尚未安装。"; install_app; return; }
  ensure_docker
  ensure_repo
  ensure_env
  compose -f "$COMPOSE_FILE" up -d --build
  log "云播放器更新完成。"
}

uninstall_app() {
  require_root
  [[ -d "$APP_DIR" ]] || { warn "云播放器尚未安装。"; return; }
  read -r -p "确认卸载容器和程序？缓存目录也会删除 [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "已取消。"; return; }
  compose -f "$COMPOSE_FILE" --profile proxy down -v || true
  rm -rf "$APP_DIR"
  log "云播放器已卸载。"
}

add_domain() {
  require_root
  [[ -d "$APP_DIR" ]] || { warn "请先安装云播放器。"; return; }
  read -r -p "请输入域名，例如 player.example.com: " domain
  [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { warn "域名格式不正确。"; return; }
  cat > "${APP_DIR}/Caddyfile" <<EOF
${domain} {
    reverse_proxy cloud-player:3000
}
EOF
  compose -f "$COMPOSE_FILE" --profile proxy up -d
  log "域名访问已启用。请先将域名 A 记录解析到本服务器，Caddy 会自动申请 HTTPS。"
  echo "访问地址: https://${domain}"
}

remove_domain() {
  require_root
  [[ -d "$APP_DIR" ]] || { warn "请先安装云播放器。"; return; }
  compose -f "$COMPOSE_FILE" --profile proxy stop caddy >/dev/null 2>&1 || true
  compose -f "$COMPOSE_FILE" --profile proxy rm -f caddy >/dev/null 2>&1 || true
  rm -f "${APP_DIR}/Caddyfile"
  log "域名访问已删除，播放器容器仍保留。"
}

firewall_port() {
  local action="$1"
  require_root
  [[ -f "$ENV_FILE" ]] || { warn "请先安装云播放器。"; return; }
  local port peer_port
  port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 3000)"
  peer_port="$(grep -E '^PEER_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo 6881)"
  if grep -q '^BIND_IP=' "$ENV_FILE"; then
    sed -i "s/^BIND_IP=.*/BIND_IP=$([[ "$action" == "allow" ]] && echo 0.0.0.0 || echo 127.0.0.1)/" "$ENV_FILE"
  else
    echo "BIND_IP=$([[ "$action" == "allow" ]] && echo 0.0.0.0 || echo 127.0.0.1)" >> "$ENV_FILE"
  fi
  if command -v ufw >/dev/null 2>&1; then
    if [[ "$action" == "allow" ]]; then
      ufw allow "${port}/tcp"
      ufw allow "${peer_port}/tcp"
      ufw allow "${peer_port}/udp"
    else
      ufw delete allow "${port}/tcp" || true
      ufw delete allow "${peer_port}/tcp" || true
      ufw delete allow "${peer_port}/udp" || true
    fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if [[ "$action" == "allow" ]]; then
      firewall-cmd --permanent --add-port="${port}/tcp"
      firewall-cmd --permanent --add-port="${peer_port}/tcp"
      firewall-cmd --permanent --add-port="${peer_port}/udp"
    else
      firewall-cmd --permanent --remove-port="${port}/tcp" || true
      firewall-cmd --permanent --remove-port="${peer_port}/tcp" || true
      firewall-cmd --permanent --remove-port="${peer_port}/udp" || true
    fi
    firewall-cmd --reload >/dev/null 2>&1 || true
  else
    warn "未检测到 ufw/firewalld，未修改系统防火墙。"
  fi
  compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 || true
  if [[ "$action" == "allow" ]]; then
    log "$port/tcp IP+端口访问已允许。"
  else
    log "$port/tcp IP+端口访问已阻止，域名代理仍可继续使用。"
  fi
}

show_menu() {
  clear || true
  if [[ -f "$COMPOSE_FILE" ]]; then
    printf "${green}${APP_NAME} 已安装${reset}\n"
  else
    printf "${yellow}${APP_NAME} 未安装${reset}\n"
  fi
  echo "云播放器是一款支持 Torrent 临时缓存和在线播放的播放器"
  echo "官网: ${RAW_URL}"
  echo
  echo "------------------------"
  echo "1. 安装              2. 更新            3. 卸载"
  echo "------------------------"
  echo "5. 添加域名访问      6. 删除域名访问"
  echo "7. 允许IP+端口访问   8. 阻止IP+端口访问"
  echo "------------------------"
  echo "0. 返回上一级选单"
  echo "------------------------"
}

main() {
  require_root
  while true; do
    show_menu
    read -r -p "请输入你的选择: " choice
    case "$choice" in
      1) install_app ;;
      2) update_app ;;
      3) uninstall_app ;;
      5) add_domain ;;
      6) remove_domain ;;
      7) firewall_port allow ;;
      8) firewall_port block ;;
      0) exit 0 ;;
      *) warn "无效选择。" ;;
    esac
    echo
    read -r -p "按回车键返回菜单..." _
  done
}

main "$@"
