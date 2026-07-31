# FattureInCloudMCP

MCP server (stdio and Streamable HTTP transports, official TypeScript SDK) bridging the
[Fatture in Cloud API v2](https://developers.fattureincloud.it/api-reference/).
Exposes CRUD on issued documents (invoices, credit notes, self invoices...) and
received documents (expenses...), plus config lookups. See `docs/api.md` for the implemented surface.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint (flat config, typescript-eslint)
- `npm run smoke` — read-only end-to-end test against the real API (needs `dist/` built and credentials, see below); safe to run anytime
- `node scripts/crud-test.mjs` — full CRUD roundtrip on the REAL account (creates, updates and deletes a test expense; leaves no trace but run deliberately)
- `npm run start:http` — run the Streamable HTTP entrypoint locally (`HOST`/`PORT`, defaults `127.0.0.1:3010`)
- `./scripts/deploy.ps1` — build and install the HTTP entrypoint as a systemd service on a remote host, see `docs/deploy.md`

## Architecture

- `src/server.ts` — `buildServer()`: one `registerTool` per action, plus the shared zod schemas for pagination/sort/filter params. A factory, not a singleton, because the HTTP entrypoint builds one instance per request.
- `src/index.ts` — stdio entrypoint (the `bin`): builds a server and connects `StdioServerTransport`.
- `src/http.ts` — Streamable HTTP entrypoint: stateless, one server + transport per request, credentials taken from the request headers.
- `src/fic.ts` — thin API client: `ficGet(path, params)` (Bearer auth, error mapping), `resolveCompanyId`, `trimListResponse` (strips `*_url` pagination noise before returning lists to the model), and the `credentials` `AsyncLocalStorage` holding the current request's token/company.

To add an endpoint: one `registerTool` in `src/server.ts` calling `ficGet`, then document it in `docs/api.md`. Full OpenAPI spec: [fattureincloud/openapi-fattureincloud](https://github.com/fattureincloud/openapi-fattureincloud).

## Configuration and secrets

- stdio: `FIC_ACCESS_TOKEN` (required) — manual access token (never expires). `FIC_COMPANY_ID` (optional) — default company.
- HTTP: the same two values arrive per request as the `X-FIC-Token` and `X-FIC-Company` headers, and take precedence over the env vars. A remote deployment therefore stores no credential of its own; see `docs/deploy.md`.
- Real credentials live in the **gitignored** `.mcp.json` in the repo root. Never commit them; never print the token in output.
- `examples/` holds client config templates (Claude Code and opencode, stdio and HTTP) with the credentials left as environment placeholders — keep them free of real values and of any host-specific detail.

## Fatture in Cloud API quirks (learned the hard way)

- `per_page` must be **≥ 5**: the published OpenAPI spec says minimum 1, but the live API returns 422 below 5.
- Creating any document — plain expenses included — requires a `payments_list` whose amounts cover the total, or the API returns 422 "Il totale dei pagamenti non corrisponde al totale da pagare".
- Attachments: upload (multipart, fields `filename` + `attachment`) → `attachment_token` → bind via `data.attachment_token` on create/update; works end-to-end. `DELETE .../{id}/attachment` instead consistently returns 500 (FIC-side bug, observed 2026-07-30); replace the attachment or delete the document as workarounds.
- List endpoints require a `type` query param — one document type per call.
- Token scopes are per document type: a missing scope yields `NO_PERMISSION` (as of 2026-07-30 the configured token cannot read regular issued invoices, only self invoices and received documents).
- The `q` filter language: `field op value` with `=, !=, >, <, >=, <=, like, is null`, combined with `and`/`or` and parentheses. Dates as `'YYYY-MM-DD'` strings.
