# Remote deployment (Streamable HTTP)

The server has two entrypoints over the same tools:

| Entrypoint | Transport | Credentials |
| --- | --- | --- |
| `dist/index.js` | stdio (default, `bin`) | `FIC_ACCESS_TOKEN` / `FIC_COMPANY_ID` env vars |
| `dist/http.js` | Streamable HTTP | `X-FIC-Token` / `X-FIC-Company` request headers |

The HTTP entrypoint exists so the server can run on a shared host **without holding
any Fatture in Cloud secret**: every caller brings its own token, scoped to that
request through an `AsyncLocalStorage` store (`src/fic.ts`). A fresh `McpServer` and
transport are built per request (stateless mode), so concurrent clients never share
credentials or request ids.

This is why the server cannot sit behind an MCP aggregator such as
[TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy): the aggregator spawns one
long-lived child from static config and never forwards caller headers. Aggregated
servers necessarily keep their credentials on the host.

## Deploy

```powershell
./scripts/deploy.ps1 -RemoteHost user@host
./scripts/deploy.ps1 -RemoteHost user@host -RemotePath /srv/fic-mcp -Port 3011
```

| Parameter | Default |
| --- | --- |
| `-RemoteHost` | required, `user@host` |
| `-RemotePath` | `/opt/mcp-servers/FattureInCloudMCP` |
| `-ServiceUser` | `mcps` (created as a system user if missing) |
| `-ServiceName` | `fattureincloud-mcp` |
| `-Port` / `-BindAddress` | `3010` / `127.0.0.1` |

The script builds, ships `dist/` plus the lockfile as a tarball, runs
`npm ci --omit=dev` on the target so dependencies match its architecture, installs a
hardened systemd unit running as the service user, restarts it and verifies both
`/healthz` and an MCP `initialize`. It needs `ssh`/`scp`/`tar` locally, and
passwordless `sudo` plus `node`/`npm` on the target.

The unit carries no `FIC_*` variable — that is the point of the design.

The unit file lives with the deployment and is only symlinked into the systemd
search path, so the whole service is described inside `-RemotePath`:

```
<RemotePath>/systemd/<ServiceName>.service      # the real file, root:root 0644
/etc/systemd/system/<ServiceName>.service       # symlink to it
```

It stays root-owned while the rest of the directory belongs to the service user: a
unit writable by that user would let it grant itself `User=root`. Editing the unit
by hand is therefore a `sudo` edit of the file under `<RemotePath>/systemd/`,
followed by `systemctl daemon-reload` — but note the next deploy regenerates it.

## Reverse proxy

The service binds to loopback and authenticates nobody: TLS and access control are
the reverse proxy's job. An nginx location that fronts it:

```nginx
location /fic/ {
    proxy_pass http://127.0.0.1:3010/;   # trailing slash strips /fic/
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection        "";   # upstream keep-alive, needed for SSE

    proxy_buffering         off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
}
```

Add the gateway's own authentication (`auth_request`, basic auth, mTLS...) to that
block: without it the endpoint offers full CRUD on the accounting data of whoever
sends a valid `X-FIC-Token`. If the gateway consumes an `Authorization` header of
its own, clear it with `proxy_set_header Authorization "";` so it never reaches the
backend.

`X-FIC-Token` and `X-FIC-Company` pass through untouched. Header names must use
hyphens: nginx drops headers containing underscores unless `underscores_in_headers`
is enabled.

## Client configuration

Ready-made templates for Claude Code, Claude Desktop and opencode, in both
transports, live in [../examples](../examples). Note that Claude Desktop cannot send
custom headers on its own and needs the `mcp-remote` bridge to reach this endpoint.
By hand:

```powershell
claude mcp add --transport http fattureincloud https://host.example/fic/ -s user `
  --header "X-FIC-Token: $env:FIC_ACCESS_TOKEN" `
  --header "X-FIC-Company: $env:FIC_COMPANY_ID"
```

Or in `.mcp.json`, which expands `${VAR}` from the client environment:

```json
{
  "mcpServers": {
    "fattureincloud": {
      "type": "http",
      "url": "https://host.example/fic/",
      "headers": {
        "X-FIC-Token": "${FIC_ACCESS_TOKEN}",
        "X-FIC-Company": "${FIC_COMPANY_ID}"
      }
    }
  }
}
```

Add the gateway's own `Authorization` header alongside these when the reverse proxy
requires one.

## Known limitation

`upload_attachment` reads a file from the filesystem **where the server runs**. Over
HTTP that is the remote host, so attaching a file that lives on the client machine
does not work — keep using the stdio entrypoint locally for that.
