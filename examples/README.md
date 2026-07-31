# Client configuration templates

Copy one of these, replace the placeholders, and keep the real values in your
environment rather than in the file wherever the client allows it.

| Template | Client | Transport |
| --- | --- | --- |
| `claude-code.stdio.mcp.json` | Claude Code | local stdio |
| `claude-code.http.mcp.json` | Claude Code | remote Streamable HTTP |
| `opencode.stdio.json` | opencode | local stdio |
| `opencode.http.json` | opencode | remote Streamable HTTP |
| `claude-desktop.stdio.json` | Claude Desktop | local stdio |
| `claude-desktop.http.json` | Claude Desktop | remote, through the `mcp-remote` bridge |

## Where they go

- **Claude Code**: `.mcp.json` in the project root (shared, project scope), or merge
  the `mcpServers` entry into `~/.claude.json` for user scope. `claude mcp add`
  writes the same structure.
- **opencode**: `opencode.json` in the project root, or
  `~/.config/opencode/opencode.json` for every project.
- **Claude Desktop**: `claude_desktop_config.json` —
  `%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS.
  Restart the app after editing.

## Placeholders

| Placeholder | Value |
| --- | --- |
| `<path-to-repo>` | absolute path to this repository; on Windows use forward slashes or escape backslashes (`C:\\...`) |
| `https://host.example/fic/` | public URL of the deployed HTTP entrypoint, see [../docs/deploy.md](../docs/deploy.md) |
| `<gateway-token>` | credential your reverse proxy expects, if any — drop the whole `Authorization` header when it authenticates differently |

## Variable substitution differs between the clients

| Client | Syntax | Where |
| --- | --- | --- |
| Claude Code | `${VAR}`, `${VAR:-default}` | `command`, `args`, `env`, `url`, `headers` |
| opencode | `{env:VAR}` (empty string when unset) | anywhere in the config |
| Claude Desktop | none | values are written literally |

Claude Desktop has no substitution of its own, so its templates spell the
credentials out and the file holds them in clear text. The `${AUTH_HEADER}` seen in
the remote template is expanded by `mcp-remote`, not by the app: it exists because
header values contain spaces (`Bearer …`) that get mangled when passed inline as
arguments, and it buys nothing in terms of secrecy.

## Why Claude Desktop needs a bridge

Claude Code and opencode speak Streamable HTTP natively and let you declare
arbitrary headers. Claude Desktop reaches remote servers through its Connectors UI,
which authenticates over OAuth and offers no field for a static header — and no auth
flow would carry `X-FIC-Token` anyway, since that is application data rather than a
protocol credential. `mcp-remote` closes the gap by running as a local stdio server
that forwards everything to the HTTP endpoint with the headers attached.

**On Windows** `npx` is a `.cmd`, which recent Node refuses to spawn without a
shell, so the command usually has to be wrapped:

```json
"command": "cmd",
"args": ["/c", "npx", "-y", "mcp-remote", "https://host.example/fic/", "..."]
```

## stdio or HTTP

The two transports serve the same 14 tools. stdio runs the server as a local child
process and reads the credentials from `env`; HTTP talks to a deployed instance that
stores no credential and takes them from the `X-FIC-Token` and `X-FIC-Company`
headers on every request.

One behavioural difference: `upload_attachment` reads a file from the filesystem
where the server runs, so over HTTP it sees the remote host's disk, not yours.
