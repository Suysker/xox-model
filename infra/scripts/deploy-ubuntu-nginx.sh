#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="${APP_NAME:-xox-model}"
SERVICE_NAME="${SERVICE_NAME:-$APP_NAME}"
APP_ROOT="${APP_ROOT:-/opt/$APP_NAME}"
APP_PORT="${APP_PORT:-4173}"
APP_HOST="${APP_HOST:-0.0.0.0}"
APP_USER="${APP_USER:-$APP_NAME}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo \
    APP_NAME="$APP_NAME" \
    SERVICE_NAME="$SERVICE_NAME" \
    APP_ROOT="$APP_ROOT" \
    APP_PORT="$APP_PORT" \
    APP_HOST="$APP_HOST" \
    APP_USER="$APP_USER" \
    bash "$0" "$@"
fi

log() {
  printf '\n[%s] %s\n' "$APP_NAME" "$1"
}

require_no_args() {
  if (( $# == 0 )); then
    return
  fi

  echo "这个脚本现在不再接收域名参数，也不会修改 nginx。"
  echo "如需改端口，请这样执行："
  echo "  sudo APP_PORT=4173 bash scripts/deploy-ubuntu-nginx.sh"
  exit 1
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      return
    fi
  fi

  log "安装 Node.js 20"
  apt-get update
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

install_packages() {
  log "安装基础工具"
  apt-get update
  apt-get install -y rsync
}

validate_port() {
  if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]] || (( APP_PORT < 1 || APP_PORT > 65535 )); then
    echo "APP_PORT 必须是 1-65535 之间的数字，当前值为: $APP_PORT"
    exit 1
  fi
}

build_project() {
  log "安装依赖并构建前端"
  cd "$REPO_DIR"
  npm ci
  npm run build
}

ensure_app_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    return
  fi

  log "创建服务用户 $APP_USER"
  useradd \
    --system \
    --user-group \
    --home-dir "$APP_ROOT" \
    --create-home \
    --shell /usr/sbin/nologin \
    "$APP_USER"
}

publish_bundle() {
  log "发布应用文件到 $APP_ROOT"
  install -d -m 0755 "$APP_ROOT"
  install -d -m 0755 "$APP_ROOT/dist"
  rsync -a --delete "$REPO_DIR/dist/" "$APP_ROOT/dist/"
  install -m 0755 "$REPO_DIR/scripts/static-server.mjs" "$APP_ROOT/static-server.mjs"
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT"
}

write_systemd_service() {
  local node_bin
  node_bin="$(command -v node)"

  if [[ -z "$node_bin" ]]; then
    echo "未找到 node 可执行文件。"
    exit 1
  fi

  log "写入 systemd 服务"
  cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=$APP_NAME static web service
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT
Environment=NODE_ENV=production
Environment=HOST=$APP_HOST
Environment=PORT=$APP_PORT
Environment=STATIC_ROOT=$APP_ROOT/dist
ExecStart=$node_bin $APP_ROOT/static-server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

restart_service() {
  log "重载并启动 systemd 服务"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --full status "$SERVICE_NAME"
}

print_summary() {
  log "部署完成"
  echo "服务名称: $SERVICE_NAME"
  echo "监听地址: http://<服务器IP>:$APP_PORT"
  echo "应用目录: $APP_ROOT"
  echo "服务配置: /etc/systemd/system/$SERVICE_NAME.service"
  echo
  echo "常用命令:"
  echo "  sudo systemctl status $SERVICE_NAME"
  echo "  sudo journalctl -u $SERVICE_NAME -f"
  echo
  echo "后续更新同样执行："
  echo "  sudo APP_PORT=$APP_PORT bash scripts/deploy-ubuntu-nginx.sh"
}

require_no_args "$@"
validate_port
ensure_node
install_packages
build_project
ensure_app_user
publish_bundle
write_systemd_service
restart_service
print_summary
