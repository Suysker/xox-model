#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="${APP_NAME:-xox-model}"
SERVICE_PREFIX="${SERVICE_PREFIX:-$APP_NAME}"
WEB_SERVICE_NAME="${WEB_SERVICE_NAME:-${SERVICE_PREFIX}-web}"
API_SERVICE_NAME="${API_SERVICE_NAME:-${SERVICE_PREFIX}-api}"
APP_ROOT="${APP_ROOT:-/opt/$APP_NAME}"
SRC_ROOT="${SRC_ROOT:-$APP_ROOT/src}"
WEB_ROOT="${WEB_ROOT:-$APP_ROOT/web}"
VENV_ROOT="${VENV_ROOT:-$APP_ROOT/venv}"
DATA_ROOT="${DATA_ROOT:-$APP_ROOT/data}"
WEB_PORT="${WEB_PORT:-${APP_PORT:-4173}}"
WEB_HOST="${WEB_HOST:-${APP_HOST:-0.0.0.0}}"
API_PORT="${API_PORT:-8000}"
API_HOST="${API_HOST:-127.0.0.1}"
APP_USER="${APP_USER:-$APP_NAME}"
REPO_URL="${REPO_URL:-}"
REPO_REF="${REPO_REF:-}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://127.0.0.1:${WEB_PORT}}"
RUN_TESTS="${RUN_TESTS:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR=""
PYTHON_BIN="${PYTHON_BIN:-}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo \
    APP_NAME="$APP_NAME" \
    SERVICE_PREFIX="$SERVICE_PREFIX" \
    WEB_SERVICE_NAME="$WEB_SERVICE_NAME" \
    API_SERVICE_NAME="$API_SERVICE_NAME" \
    APP_ROOT="$APP_ROOT" \
    SRC_ROOT="$SRC_ROOT" \
    WEB_ROOT="$WEB_ROOT" \
    VENV_ROOT="$VENV_ROOT" \
    DATA_ROOT="$DATA_ROOT" \
    WEB_PORT="$WEB_PORT" \
    WEB_HOST="$WEB_HOST" \
    API_PORT="$API_PORT" \
    API_HOST="$API_HOST" \
    APP_USER="$APP_USER" \
    REPO_URL="$REPO_URL" \
    REPO_REF="$REPO_REF" \
    PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
    RUN_TESTS="$RUN_TESTS" \
    PYTHON_BIN="$PYTHON_BIN" \
    bash "$0" "$@"
fi

log() {
  printf '\n[%s] %s\n' "$APP_NAME" "$1"
}

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  sudo bash infra/scripts/deploy-linux.sh
  sudo REPO_URL=<git-url> bash ./deploy-linux.sh

Optional environment variables:
  REPO_URL         Git URL used when the script is not run from a local checkout
  REPO_REF         Branch or tag to deploy from REPO_URL
  APP_ROOT         Install root (default: /opt/$APP_NAME)
  WEB_PORT         Public web port (default: 4173)
  API_PORT         Internal API port (default: 8000)
  WEB_HOST         Public bind host for the web service (default: 0.0.0.0)
  API_HOST         Bind host for the API service (default: 127.0.0.1)
  PUBLIC_ORIGIN    Browser origin allowed by the API (default: http://127.0.0.1:$WEB_PORT)
  RUN_TESTS        Set to 1 to run web and API tests before restart
EOF
}

require_no_args() {
  if (( $# == 0 )); then
    return
  fi

  if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    usage
    exit 0
  fi

  usage
  fail "This script only accepts configuration through environment variables."
}

validate_ports() {
  for pair in "WEB_PORT:$WEB_PORT" "API_PORT:$API_PORT"; do
    local name="${pair%%:*}"
    local value="${pair#*:}"
    if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
      fail "$name must be a number between 1 and 65535. Current value: $value"
    fi
  done

  if [[ "$WEB_PORT" == "$API_PORT" ]]; then
    fail "WEB_PORT and API_PORT must be different."
  fi
}

install_base_packages() {
  log "Installing system packages"
  apt-get update
  apt-get install -y git rsync curl ca-certificates gnupg python3 python3-venv python3-pip
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      return
    fi
  fi

  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

python_version_ge_312() {
  local candidate="$1"
  "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'
}

ensure_python() {
  if [[ -n "$PYTHON_BIN" ]]; then
    if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
      fail "PYTHON_BIN points to a missing executable: $PYTHON_BIN"
    fi

    if python_version_ge_312 "$PYTHON_BIN"; then
      return
    fi

    fail "PYTHON_BIN must point to Python 3.12 or newer."
  fi

  if command -v python3.12 >/dev/null 2>&1 && python_version_ge_312 python3.12; then
    PYTHON_BIN="python3.12"
    return
  fi

  if python_version_ge_312 python3; then
    PYTHON_BIN="python3"
    return
  fi

  if apt-cache show python3.12 >/dev/null 2>&1; then
    log "Installing Python 3.12"
    apt-get install -y python3.12 python3.12-venv
  fi

  if command -v python3.12 >/dev/null 2>&1 && python_version_ge_312 python3.12; then
    PYTHON_BIN="python3.12"
    return
  fi

  fail "Python 3.12 or newer is required. Install it and rerun the script."
}

is_repo_root() {
  local candidate="$1"
  [[ -f "$candidate/package.json" && -f "$candidate/apps/api/pyproject.toml" && -f "$candidate/apps/web/package.json" ]]
}

clone_or_update_repo() {
  if [[ -z "$REPO_URL" ]]; then
    fail "REPO_URL is required when the script is not run from a local checkout."
  fi

  install -d -m 0755 "$(dirname "$SRC_ROOT")"

  if [[ -d "$SRC_ROOT/.git" ]]; then
    log "Updating source checkout in $SRC_ROOT"
    git -C "$SRC_ROOT" fetch --tags origin
  elif [[ -d "$SRC_ROOT" ]]; then
    fail "SRC_ROOT exists but is not a git checkout: $SRC_ROOT"
  else
    log "Cloning repository into $SRC_ROOT"
    if [[ -n "$REPO_REF" ]]; then
      git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_ROOT"
    else
      git clone --depth 1 "$REPO_URL" "$SRC_ROOT"
    fi
  fi

  if [[ -n "$REPO_REF" ]]; then
    git -C "$SRC_ROOT" checkout "$REPO_REF"
    if git -C "$SRC_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$REPO_REF" >/dev/null; then
      git -C "$SRC_ROOT" pull --ff-only origin "$REPO_REF"
    fi
  else
    local branch
    branch="$(git -C "$SRC_ROOT" rev-parse --abbrev-ref HEAD)"
    if [[ "$branch" == "HEAD" ]]; then
      branch="$(git -C "$SRC_ROOT" symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')"
      git -C "$SRC_ROOT" checkout "$branch"
    fi
    git -C "$SRC_ROOT" pull --ff-only origin "$branch"
  fi

  SOURCE_DIR="$SRC_ROOT"
}

resolve_source_dir() {
  if is_repo_root "$PWD"; then
    SOURCE_DIR="$PWD"
    log "Using current checkout at $SOURCE_DIR"
    return
  fi

  local script_repo_root
  script_repo_root="$(cd "$SCRIPT_DIR/../.." && pwd)"
  if is_repo_root "$script_repo_root"; then
    SOURCE_DIR="$script_repo_root"
    log "Using script checkout at $SOURCE_DIR"
    return
  fi

  clone_or_update_repo
}

validate_source_dir() {
  is_repo_root "$SOURCE_DIR" || fail "Missing package.json or app folders in source directory: $SOURCE_DIR"
  [[ -f "$SOURCE_DIR/infra/scripts/static-server.mjs" ]] || fail "Missing infra/scripts/static-server.mjs in $SOURCE_DIR"
}

run_web_build() {
  log "Installing Node dependencies and building the web app"
  cd "$SOURCE_DIR"
  npm ci
  npm run build:web
}

ensure_virtualenv() {
  if [[ ! -x "$VENV_ROOT/bin/python" ]]; then
    log "Creating Python virtual environment"
    "$PYTHON_BIN" -m venv "$VENV_ROOT"
  fi
}

install_api() {
  ensure_virtualenv

  log "Installing API dependencies"
  "$VENV_ROOT/bin/python" -m pip install --upgrade pip setuptools wheel
  "$VENV_ROOT/bin/python" -m pip install --upgrade "$SOURCE_DIR/apps/api"
}

run_optional_tests() {
  if [[ "$RUN_TESTS" != "1" ]]; then
    return
  fi

  log "Running web tests"
  (cd "$SOURCE_DIR" && npm run test:web)

  log "Installing API test dependencies"
  "$VENV_ROOT/bin/python" -m pip install --upgrade "$SOURCE_DIR/apps/api[dev]"

  log "Running API tests"
  "$VENV_ROOT/bin/python" -m pytest "$SOURCE_DIR/apps/api/tests"
}

ensure_app_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    return
  fi

  log "Creating service user $APP_USER"
  useradd \
    --system \
    --user-group \
    --home-dir "$APP_ROOT" \
    --create-home \
    --shell /usr/sbin/nologin \
    "$APP_USER"
}

publish_runtime_files() {
  log "Publishing runtime files into $APP_ROOT"
  install -d -m 0755 "$APP_ROOT" "$WEB_ROOT" "$DATA_ROOT"
  rsync -a --delete "$SOURCE_DIR/dist/" "$WEB_ROOT/"
  install -m 0755 "$SOURCE_DIR/infra/scripts/static-server.mjs" "$APP_ROOT/static-server.mjs"
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT"
}

write_api_service() {
  log "Writing systemd unit $API_SERVICE_NAME"
  cat >"/etc/systemd/system/$API_SERVICE_NAME.service" <<EOF
[Unit]
Description=$APP_NAME API service
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT
Environment=PATH=$VENV_ROOT/bin:/usr/bin:/bin
Environment=XOX_DATABASE_URL=sqlite:///$DATA_ROOT/xox.db
Environment=XOX_CORS_ORIGIN=$PUBLIC_ORIGIN
ExecStart=$VENV_ROOT/bin/python -m uvicorn app.main:app --host $API_HOST --port $API_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

write_web_service() {
  local node_bin
  node_bin="$(command -v node)"
  [[ -n "$node_bin" ]] || fail "node executable not found after installation."

  log "Writing systemd unit $WEB_SERVICE_NAME"
  cat >"/etc/systemd/system/$WEB_SERVICE_NAME.service" <<EOF
[Unit]
Description=$APP_NAME web service
After=network.target $API_SERVICE_NAME.service
Requires=$API_SERVICE_NAME.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT
Environment=NODE_ENV=production
Environment=HOST=$WEB_HOST
Environment=PORT=$WEB_PORT
Environment=STATIC_ROOT=$WEB_ROOT
Environment=API_UPSTREAM=http://127.0.0.1:$API_PORT
ExecStart=$node_bin $APP_ROOT/static-server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

disable_legacy_service() {
  local legacy_name="$SERVICE_PREFIX"
  local legacy_unit="/etc/systemd/system/$legacy_name.service"

  if [[ "$legacy_name" == "$WEB_SERVICE_NAME" || "$legacy_name" == "$API_SERVICE_NAME" ]]; then
    return
  fi

  if [[ ! -f "$legacy_unit" ]]; then
    return
  fi

  log "Stopping legacy unit $legacy_name"
  systemctl disable --now "$legacy_name" >/dev/null 2>&1 || true
  rm -f "$legacy_unit"
}

restart_services() {
  log "Reloading and restarting systemd services"
  systemctl daemon-reload
  systemctl enable "$API_SERVICE_NAME" "$WEB_SERVICE_NAME" >/dev/null
  systemctl restart "$API_SERVICE_NAME"
  systemctl restart "$WEB_SERVICE_NAME"
}

wait_for_http() {
  local url="$1"
  local expected="${2:-}"
  local body=""

  for _ in $(seq 1 30); do
    if body="$(curl -fsS "$url" 2>/dev/null)"; then
      if [[ -z "$expected" || "$body" == *"$expected"* ]]; then
        return 0
      fi
    fi

    sleep 1
  done

  fail "Health check failed for $url"
}

validate_services() {
  log "Validating service health"
  wait_for_http "http://127.0.0.1:$API_PORT/api/v1/health" '"status":"ok"'
  wait_for_http "http://127.0.0.1:$WEB_PORT/api/v1/health" '"status":"ok"'
  curl -fsSI "http://127.0.0.1:$WEB_PORT/" >/dev/null
}

print_summary() {
  log "Deployment completed"
  echo "Source directory: $SOURCE_DIR"
  echo "Install root: $APP_ROOT"
  echo "Web URL: http://<server-ip>:$WEB_PORT"
  echo "API health (direct): http://127.0.0.1:$API_PORT/api/v1/health"
  echo "API health (via web): http://127.0.0.1:$WEB_PORT/api/v1/health"
  echo "Web service: $WEB_SERVICE_NAME"
  echo "API service: $API_SERVICE_NAME"
  echo
  echo "Useful commands:"
  echo "  sudo systemctl status $WEB_SERVICE_NAME"
  echo "  sudo systemctl status $API_SERVICE_NAME"
  echo "  sudo journalctl -u $WEB_SERVICE_NAME -f"
  echo "  sudo journalctl -u $API_SERVICE_NAME -f"
}

require_no_args "$@"
validate_ports
install_base_packages
ensure_node
ensure_python
resolve_source_dir
validate_source_dir
run_web_build
install_api
run_optional_tests
ensure_app_user
publish_runtime_files
write_api_service
write_web_service
disable_legacy_service
restart_services
validate_services
print_summary
