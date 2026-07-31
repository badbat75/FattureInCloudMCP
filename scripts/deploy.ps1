<#
.SYNOPSIS
    Deploy the Streamable HTTP entrypoint to a remote Linux host as a systemd service.

.DESCRIPTION
    Builds locally, ships dist/ plus the lockfile, installs production dependencies
    on the target, and installs/restarts a systemd unit running as a dedicated
    service user. The unit file is kept under <RemotePath>/systemd and only
    symlinked into /etc/systemd/system. The service holds NO Fatture in Cloud
    credentials: clients send them per request in the X-FIC-Token and
    X-FIC-Company headers.

    Requires: ssh/scp/tar on this machine, passwordless sudo and node/npm on the target.
    Exposing the service publicly (TLS, authentication) is the reverse proxy's job —
    see docs/deploy.md for the nginx location block.

.EXAMPLE
    ./scripts/deploy.ps1 -RemoteHost user@host
    Deploys with the defaults below.

.EXAMPLE
    ./scripts/deploy.ps1 -RemoteHost user@host -RemotePath /srv/fic-mcp -Port 3011
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RemoteHost,
    [string]$RemotePath = "/opt/mcp-servers/FattureInCloudMCP",
    [string]$ServiceUser = "mcps",
    [string]$ServiceName = "fattureincloud-mcp",
    [int]$Port = 3010,
    [string]$BindAddress = "127.0.0.1",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    if (-not (Test-Path "package.json")) {
        throw "package.json not found in $repoRoot — run this from the repository."
    }

    if ($SkipBuild) {
        Write-Step "Skipping build (-SkipBuild)"
    } else {
        Write-Step "Building"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    }
    foreach ($required in @("dist/http.js", "dist/server.js", "package.json", "package-lock.json")) {
        if (-not (Test-Path $required)) { throw "$required is missing — build first" }
    }

    # One tarball beats scp'ing a directory tree: fewer round trips, and the remote
    # side installs its own dependencies for its own architecture.
    Write-Step "Packing dist/, package.json, package-lock.json"
    $tarball = Join-Path ([System.IO.Path]::GetTempPath()) "$ServiceName-deploy.tar.gz"
    tar -czf $tarball dist package.json package-lock.json
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }
    $sizeKb = [math]::Round((Get-Item $tarball).Length / 1KB)

    Write-Step "Copying $sizeKb KB to ${RemoteHost}:/tmp"
    scp -q $tarball "${RemoteHost}:/tmp/$ServiceName-deploy.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "scp to $RemoteHost failed" }
    Remove-Item $tarball -Force

    $remoteScript = @"
set -euo pipefail

APP_DIR='$RemotePath'
SVC_USER='$ServiceUser'
SVC_NAME='$ServiceName'
PORT='$Port'
BIND='$BindAddress'
TARBALL="/tmp/`${SVC_NAME}-deploy.tar.gz"

NODE_BIN="`$(command -v node || true)"
if [ -z "`$NODE_BIN" ]; then
    echo "node is not installed on this host" >&2
    exit 1
fi
echo "node: `$NODE_BIN (`$(`$NODE_BIN --version))"

if ! id -u "`$SVC_USER" >/dev/null 2>&1; then
    echo "creating service user `$SVC_USER"
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "`$SVC_USER"
fi

mkdir -p "`$APP_DIR"
rm -rf "`$APP_DIR/dist"
tar -xzf "`$TARBALL" -C "`$APP_DIR"
rm -f "`$TARBALL"

# tar carries the modes from the build machine, and a Windows-created archive
# unpacks world-writable: anyone with a local account could then rewrite the code
# this service executes. Normalise to 755/644 before anything runs.
chmod -R u=rwX,go=rX "`$APP_DIR"

cd "`$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
chown -R "`$SVC_USER":"`$SVC_USER" "`$APP_DIR"

# The unit ships with the deployment; /etc/systemd/system only holds a symlink to it.
UNIT_DIR="`$APP_DIR/systemd"
UNIT_FILE="`$UNIT_DIR/`${SVC_NAME}.service"
UNIT_LINK="/etc/systemd/system/`${SVC_NAME}.service"
mkdir -p "`$UNIT_DIR"

cat > "`$UNIT_FILE" <<UNIT
[Unit]
Description=Fatture in Cloud MCP server (Streamable HTTP, per-request credentials)
Documentation=https://developers.fattureincloud.it/api-reference/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=`$SVC_USER
Group=`$SVC_USER
WorkingDirectory=`$APP_DIR
Environment=HOST=`$BIND
Environment=PORT=`$PORT
ExecStart=`$NODE_BIN `$APP_DIR/dist/http.js
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
chown root:root "`$UNIT_DIR" "`$UNIT_FILE"
chmod 755 "`$UNIT_DIR"
chmod 644 "`$UNIT_FILE"

rm -f "`$UNIT_LINK"
ln -s "`$UNIT_FILE" "`$UNIT_LINK"
echo "unit: `$UNIT_FILE -> `$UNIT_LINK"

systemctl daemon-reload
systemctl enable "`$SVC_NAME" >/dev/null
systemctl restart "`$SVC_NAME"

for _ in `$(seq 1 20); do
    if curl -sf "http://`$BIND:`$PORT/healthz" >/dev/null; then
        echo "health: `$(curl -s http://`$BIND:`$PORT/healthz)"
        exit 0
    fi
    sleep 0.5
done

echo "service did not answer on http://`$BIND:`$PORT/healthz" >&2
systemctl status --no-pager --lines=20 "`$SVC_NAME" >&2
exit 1
"@

    Write-Step "Installing on $RemoteHost as $ServiceUser"
    # base64 keeps the script intact across the PowerShell/ssh/bash boundary: no
    # quoting games, no CRLF sneaking into a bash heredoc.
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteScript.Replace("`r`n", "`n")))
    ssh $RemoteHost "echo $encoded | base64 -d | sudo bash -s"
    if ($LASTEXITCODE -ne 0) { throw "remote install failed" }

    Write-Step "Verifying the MCP handshake over HTTP"
    $initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy.ps1","version":"1"}}}'
    $probe = ssh $RemoteHost "curl -sf -X POST http://${BindAddress}:${Port}/ -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '$initialize'"
    if ($LASTEXITCODE -ne 0) { throw "the server did not answer initialize" }
    if ($probe -notmatch '"serverInfo"') { throw "unexpected initialize response: $probe" }

    Write-Host ""
    Write-Host "Deployed: $ServiceName on $RemoteHost -> http://${BindAddress}:${Port}" -ForegroundColor Green
    Write-Host "  logs:    ssh $RemoteHost 'sudo journalctl -u $ServiceName -f'"
    Write-Host "  restart: ssh $RemoteHost 'sudo systemctl restart $ServiceName'"
    Write-Host "  clients must send X-FIC-Token and X-FIC-Company; the host stores no credentials."
}
finally {
    Pop-Location
}
