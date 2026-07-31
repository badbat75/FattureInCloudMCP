# Client configuration templates

Copy one of these, replace the placeholders, and keep the real values in your
environment rather than in the file.

| Template | Client | Transport |
| --- | --- | --- |
| `claude-code.stdio.mcp.json` | Claude Code | local stdio |
| `claude-code.http.mcp.json` | Claude Code | remote Streamable HTTP |
| `opencode.stdio.json` | opencode | local stdio |
| `opencode.http.json` | opencode | remote Streamable HTTP |

## Where they go

- **Claude Code**: `.mcp.json` in the project root (shared, project scope), or merge
  the `mcpServers` entry into `~/.claude.json` for user scope. `claude mcp add`
  writes the same structure.
- **opencode**: `opencode.json` in the project root, or
  `~/.config/opencode/opencode.json` for every project.

## Placeholders

| Placeholder | Value |
| --- | --- |
| `<path-to-repo>` | absolute path to this repository; on Windows use forward slashes or escape backslashes (`C:\\...`) |
| `https://host.example/fic/` | public URL of the deployed HTTP entrypoint, see [../docs/deploy.md](../docs/deploy.md) |
| `MCP_GATEWAY_TOKEN` | credential your reverse proxy expects, if any — drop the whole `Authorization` header when it authenticates differently |

## Variable substitution differs between the two clients

Claude Code expands `${VAR}` (and `${VAR:-default}`) in `command`, `args`, `env`,
`url` and `headers`. opencode expands `{env:VAR}`, and substitutes an empty string
when the variable is unset. Either way the variables must exist in the environment
of the process that launches the client, so a token never has to be written to disk.

## stdio or HTTP

The two transports serve the same 14 tools. stdio runs the server as a local child
process and reads the credentials from `env`; HTTP talks to a deployed instance that
stores no credential and takes them from the `X-FIC-Token` and `X-FIC-Company`
headers on every request.

One behavioural difference: `upload_attachment` reads a file from the filesystem
where the server runs, so over HTTP it sees the remote host's disk, not yours.
