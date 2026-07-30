# FattureInCloudMCP

MCP server (stdio transport, official TypeScript SDK) bridging the
[Fatture in Cloud API v2](https://developers.fattureincloud.it/api-reference/).
Exposes CRUD on issued documents (invoices, credit notes, self invoices...) and
received documents (expenses...), plus config lookups. See `docs/api.md` for the implemented surface.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint (flat config, typescript-eslint)
- `npm run smoke` — read-only end-to-end test against the real API (needs `dist/` built and credentials, see below); safe to run anytime
- `node scripts/crud-test.mjs` — full CRUD roundtrip on the REAL account (creates, updates and deletes a test expense; leaves no trace but run deliberately)

## Architecture

- `src/index.ts` — MCP server: one `registerTool` per action, all with `readOnlyHint: true`. Shared zod schemas for pagination/sort/filter params.
- `src/fic.ts` — thin API client: `ficGet(path, params)` (Bearer auth, error mapping), `resolveCompanyId`, `trimListResponse` (strips `*_url` pagination noise before returning lists to the model).

To add an endpoint: one `registerTool` in `src/index.ts` calling `ficGet`, then document it in `docs/api.md`. Full OpenAPI spec: [fattureincloud/openapi-fattureincloud](https://github.com/fattureincloud/openapi-fattureincloud).

## Configuration and secrets

- `FIC_ACCESS_TOKEN` (required) — manual access token (never expires). `FIC_COMPANY_ID` (optional) — default company.
- Real credentials live in the **gitignored** `.mcp.json` in the repo root (and originally in `C:\Users\emili\git\GestioneAutofatturazione\.env`). Never commit them; never print the token in output.

## Fatture in Cloud API quirks (learned the hard way)

- `per_page` must be **≥ 5**: the published OpenAPI spec says minimum 1, but the live API returns 422 below 5.
- Creating any document — plain expenses included — requires a `payments_list` whose amounts cover the total, or the API returns 422 "Il totale dei pagamenti non corrisponde al totale da pagare".
- Attachments: upload (multipart, fields `filename` + `attachment`) → `attachment_token` → bind via `data.attachment_token` on create/update; works end-to-end. `DELETE .../{id}/attachment` instead consistently returns 500 (FIC-side bug, observed 2026-07-30); replace the attachment or delete the document as workarounds.
- List endpoints require a `type` query param — one document type per call.
- Token scopes are per document type: a missing scope yields `NO_PERMISSION` (as of 2026-07-30 the configured token cannot read regular issued invoices, only self invoices and received documents).
- The `q` filter language: `field op value` with `=, !=, >, <, >=, <=, like, is null`, combined with `and`/`or` and parentheses. Dates as `'YYYY-MM-DD'` strings.
