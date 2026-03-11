#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="${APP_NAME:-xox-model}"
SITE_NAME="${SITE_NAME:-$APP_NAME}"
APP_ROOT="${APP_ROOT:-/var/www/$APP_NAME}"
DOMAIN="${1:-_}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo APP_NAME="$APP_NAME" SITE_NAME="$SITE_NAME" APP_ROOT="$APP_ROOT" bash "$0" "$@"
fi

log() {
  printf '\n[%s] %s\n' "$APP_NAME" "$1"
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
  log "安装 Nginx 和基础工具"
  apt-get update
  apt-get install -y nginx rsync
}

build_project() {
  log "安装依赖并构建前端"
  cd "$REPO_DIR"
  npm ci
  npm run build
}

publish_dist() {
  log "发布 dist 到 $APP_ROOT"
  install -d "$APP_ROOT"
  rsync -a --delete "$REPO_DIR/dist/" "$APP_ROOT/"
  chown -R www-data:www-data "$APP_ROOT"
}

write_nginx_site() {
  log "写入 Nginx 站点配置"
  cat >"/etc/nginx/sites-available/$SITE_NAME" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  root $APP_ROOT;
  index index.html;

  location / {
    try_files \$uri \$uri/ /index.html;
  }

  location /assets/ {
    try_files \$uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
}
EOF

  ln -sfn "/etc/nginx/sites-available/$SITE_NAME" "/etc/nginx/sites-enabled/$SITE_NAME"
  rm -f /etc/nginx/sites-enabled/default
}

restart_nginx() {
  log "校验并重启 Nginx"
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

print_summary() {
  log "部署完成"
  echo "访问地址: http://$DOMAIN"
  echo "站点目录: $APP_ROOT"
  echo "站点配置: /etc/nginx/sites-available/$SITE_NAME"
  echo
  echo "后续更新同样执行："
  echo "  sudo bash scripts/deploy-ubuntu-nginx.sh $DOMAIN"
}

ensure_node
install_packages
build_project
publish_dist
write_nginx_site
restart_nginx
print_summary
