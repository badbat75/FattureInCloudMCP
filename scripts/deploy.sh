#!/usr/bin/env bash
# Deploy the Streamable HTTP entrypoint to a remote Linux host as a systemd service.
# Bash twin of deploy.ps1: same steps, same defaults, same unit file.
#
# Builds locally, ships dist/ plus the lockfile, installs production dependencies on
# the target, and installs/restarts a systemd unit running as a dedicated service
# user. The unit file is kept under <remote-path>/systemd and only symlinked into
# /etc/systemd/system. The service holds NO Fatture in Cloud credentials: clients
# send them per request in the X-FIC-Token and X-FIC-Company headers.
#
# Requires: ssh/scp/tar on this machine, passwordless sudo and node/npm on the target.
# Exposing the service publicly (TLS, authentication) is the reverse proxy's job,
# see docs/deploy.md.
#
# Usage: scripts/deploy.sh [options] user@host
#   --remote-path PATH   default /opt/mcp-servers/FattureInCloudMCP
#   --service-user USER  default mcps (created as a system user if missing)
#   --service-name NAME  default fattureincloud-mcp
#   --port PORT          default 3010
#   --bind ADDRESS       default 127.0.0.1
#   --skip-build
set -euo pipefail

REMOTE_PATH=/opt/mcp-servers/FattureInCloudMCP
SERVICE_USER=mcps
SERVICE_NAME=fattureincloud-mcp
PORT=3010
BIND_ADDRESS=127.0.0.1
SKIP_BUILD=0
REMOTE_HOST=

usage() { sed -n '15,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --remote-path) REMOTE_PATH=$2; shift 2 ;;
        --service-user) SERVICE_USER=$2; shift 2 ;;
        --service-name) SERVICE_NAME=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --bind) BIND_ADDRESS=$2; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        -h|--help) usage 0 ;;
        -*) echo "unknown option: $1" >&2; usage ;;
        *) REMOTE_HOST=$1; shift ;;
    esac
done
[ -n "$REMOTE_HOST" ] || usage

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }

cd "$(dirname "$0")/.."

if [ "$SKIP_BUILD" = 1 ]; then
    step "Skipping build (--skip-build)"
else
    step "Building"
    npm run build
fi
for required in dist/http.js dist/server.js package.json package-lock.json; do
    [ -e "$required" ] || { echo "$required is missing, build first" >&2; exit 1; }
done

# One tarball beats scp'ing a directory tree: fewer round trips, and the remote
# side installs its own dependencies for its own architecture.
step "Packing dist/, package.json, package-lock.json"
tarball=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$tarball"' EXIT
tar -czf "$tarball" dist package.json package-lock.json

step "Copying $(( $(stat -c %s "$tarball") / 1024 )) KB to $REMOTE_HOST:/tmp"
scp -q "$tarball" "$REMOTE_HOST:/tmp/$SERVICE_NAME-deploy.tar.gz"

step "Installing on $REMOTE_HOST as $SERVICE_USER"
# The remote script is a quoted heredoc fed to bash on stdin; settings travel as
# positional arguments, so nothing in it needs escaping.
# shellcheck disable=SC2087
ssh "$REMOTE_HOST" sudo bash -s -- \
    "$(printf %q "$REMOTE_PATH")" "$(printf %q "$SERVICE_USER")" "$(printf %q "$SERVICE_NAME")" \
    "$(printf %q "$PORT")" "$(printf %q "$BIND_ADDRESS")" <<'REMOTE'
set -euo pipefail

APP_DIR=$1
SVC_USER=$2
SVC_NAME=$3
PORT=$4
BIND=$5
TARBALL="/tmp/${SVC_NAME}-deploy.tar.gz"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "node is not installed on this host" >&2
    exit 1
fi
echo "node: $NODE_BIN ($($NODE_BIN --version))"

if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    echo "creating service user $SVC_USER"
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/dist"
tar -xzf "$TARBALL" -C "$APP_DIR"
rm -f "$TARBALL"

# tar carries the modes from the build machine: normalise to 755/644 so no local
# account can rewrite the code this service executes.
chmod -R u=rwX,go=rX "$APP_DIR"

cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"

# The unit ships with the deployment; /etc/systemd/system only holds a symlink to it.
UNIT_DIR="$APP_DIR/systemd"
UNIT_FILE="$UNIT_DIR/${SVC_NAME}.service"
UNIT_LINK="/etc/systemd/system/${SVC_NAME}.service"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Fatture in Cloud MCP server (Streamable HTTP, per-request credentials)
Documentation=https://developers.fattureincloud.it/api-reference/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
Environment=HOST=$BIND
Environment=PORT=$PORT
ExecStart=$NODE_BIN $APP_DIR/dist/http.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT

# Root-owned on purpose: the chown above gave the app dir to the service user, and
# a unit writable by the service user would let it grant itself User=root.
chown root:root "$UNIT_DIR" "$UNIT_FILE"
chmod 755 "$UNIT_DIR"
chmod 644 "$UNIT_FILE"

rm -f "$UNIT_LINK"
ln -s "$UNIT_FILE" "$UNIT_LINK"
echo "unit: $UNIT_FILE -> $UNIT_LINK"

systemctl daemon-reload
systemctl enable "$SVC_NAME" >/dev/null
systemctl restart "$SVC_NAME"

for _ in $(seq 1 20); do
    if curl -sf "http://$BIND:$PORT/healthz" >/dev/null; then
        echo "health: $(curl -s "http://$BIND:$PORT/healthz")"
        exit 0
    fi
    sleep 0.5
done

echo "service did not answer on http://$BIND:$PORT/healthz" >&2
systemctl status --no-pager --lines=20 "$SVC_NAME" >&2
exit 1
REMOTE

step "Verifying the MCP handshake over HTTP"
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy.sh","version":"1"}}}'
probe=$(ssh "$REMOTE_HOST" "curl -sf -X POST http://$BIND_ADDRESS:$PORT/ -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '$initialize'")
case "$probe" in
    *'"serverInfo"'*) ;;
    *) echo "unexpected initialize response: $probe" >&2; exit 1 ;;
esac

printf '\n\033[32mDeployed: %s on %s -> http://%s:%s\033[0m\n' "$SERVICE_NAME" "$REMOTE_HOST" "$BIND_ADDRESS" "$PORT"
echo "  logs:    ssh $REMOTE_HOST 'sudo journalctl -u $SERVICE_NAME -f'"
echo "  restart: ssh $REMOTE_HOST 'sudo systemctl restart $SERVICE_NAME'"
echo "  clients must send X-FIC-Token and X-FIC-Company; the host stores no credentials."
