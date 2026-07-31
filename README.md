# FattureInCloud MCP

MCP (Model Context Protocol) server for the [Fatture in Cloud API v2](https://developers.fattureincloud.it/api-reference/).
Lets Claude (Code / Desktop / any MCP client) read and manage (CRUD) issued documents (invoices, credit notes, quotes...) and received documents (expenses, passive credit notes...).

Two transports over the same tools: **stdio** as a local child process, and **Streamable HTTP** for a shared deployment that keeps no credentials of its own.

## Tools

| Tool | Description |
| --- | --- |
| `list_companies` | Companies accessible with the token (source of `company_id`) |
| `get_company_info` | Config lookups: VAT types, payment methods/accounts, expense categories |
| `list_issued_documents` | Paginated list of issued documents, one type per call (default `invoice`) |
| `get_issued_document` | Full detail of a single issued document |
| `list_received_documents` | Paginated list of received documents (default `expense`) |
| `get_received_document` | Full detail of a single received document |
| `create_issued_document` | Create an invoice, credit note, quote... |
| `update_issued_document` | Update an issued document (partial: only the fields passed) |
| `delete_issued_document` | Delete an issued document (irreversible) |
| `create_received_document` | Create an expense or other received document |
| `update_received_document` | Update a received document (partial) |
| `delete_received_document` | Delete a received document (irreversible) |
| `upload_attachment` | Upload a local file, returns an `attachment_token` to bind via create/update |
| `delete_document_attachment` | Remove a document's attachment (FIC API currently 500s here, see docs) |

See [`docs/api.md`](docs/api.md) for parameters, payload shapes and API quirks. List tools support:

- `q` — Fatture in Cloud filter language, e.g. `date >= '2026-01-01' and date <= '2026-06-30'`, `entity.name like '%acme%'`, `amount_gross > 1000`
- `sort` — e.g. `-date` (descending)
- `page` / `per_page` (min 5, max 100) — responses include `current_page`, `last_page`, `total`
- `fieldset` — `basic` (compact, default for lists) or `detailed` (includes line items)

## Setup

```sh
npm install
npm run build
```

### Authentication

Two values, wherever they come from:

- `FIC_ACCESS_TOKEN` (required) — a [manual access token](https://developers.fattureincloud.it/docs/authentication/manual-authentication/): generate it from the Fatture in Cloud developer area selecting the read scopes for issued and received documents. Manual tokens never expire (revocable from the same page).
- `FIC_COMPANY_ID` (optional) — default company ID; if unset, tools require an explicit `company_id` argument (discover it with `list_companies`).

Over stdio they are environment variables of the server process. Over HTTP they are the `X-FIC-Token` and `X-FIC-Company` headers of each request, so the deployed instance stores neither.

Configuration templates for Claude Code, Claude Desktop and opencode, local stdio and remote HTTP, are in [examples/](examples/).

### Claude Code

A project-scoped `.mcp.json` (gitignored) holds the credentials. From any other directory:

```sh
claude mcp add --scope user fattureincloud -e FIC_ACCESS_TOKEN=<token> -e FIC_COMPANY_ID=<id> -- node <repo>\dist\index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fattureincloud": {
      "command": "node",
      "args": ["<repo>\\dist\\index.js"],
      "env": {
        "FIC_ACCESS_TOKEN": "<token>",
        "FIC_COMPANY_ID": "<id>"
      }
    }
  }
}
```

### Remote (Streamable HTTP)

`dist/http.js` serves the same tools over HTTP and takes the credentials from the `X-FIC-Token` and `X-FIC-Company` request headers instead of the environment, so the host running it stores no secret. `./scripts/deploy.ps1` installs it as a systemd service on a remote machine — see [docs/deploy.md](docs/deploy.md).

## Extending

The API surface is small on purpose. To add endpoints (clients, suppliers, products, receipts, taxes, cashbook...), follow the pattern in `src/server.ts`: one `registerTool` per action calling `ficGet` from `src/fic.ts`. The full OpenAPI spec lives at [fattureincloud/openapi-fattureincloud](https://github.com/fattureincloud/openapi-fattureincloud).
