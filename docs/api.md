# Implemented API surface

MCP tools exposed by this server and the [Fatture in Cloud API v2](https://developers.fattureincloud.it/api-reference/) endpoints they wrap. Every request is authenticated with `Authorization: Bearer $FIC_ACCESS_TOKEN` against `https://api-v2.fattureincloud.it`.

## Overview

### Read tools (`readOnlyHint: true`)

| MCP tool | FIC endpoint | Required token scopes (read) |
| --- | --- | --- |
| `list_companies` | `GET /user/companies` | — (any valid token) |
| `get_company_info` | `GET /c/{company_id}/info/{resource}` | — |
| `list_issued_documents` | `GET /c/{company_id}/issued_documents` | `issued_documents.<type>:r` per document type |
| `get_issued_document` | `GET /c/{company_id}/issued_documents/{document_id}` | same as above |
| `list_received_documents` | `GET /c/{company_id}/received_documents` | `received_documents:r` |
| `get_received_document` | `GET /c/{company_id}/received_documents/{document_id}` | `received_documents:r` |

### Write tools

| MCP tool | FIC endpoint | Required token scopes (write) |
| --- | --- | --- |
| `create_issued_document` | `POST /c/{company_id}/issued_documents` | `issued_documents.<type>:a` |
| `update_issued_document` | `PUT /c/{company_id}/issued_documents/{document_id}` | `issued_documents.<type>:a` |
| `delete_issued_document` | `DELETE /c/{company_id}/issued_documents/{document_id}` | `issued_documents.<type>:a` |
| `create_received_document` | `POST /c/{company_id}/received_documents` | `received_documents:a` |
| `update_received_document` | `PUT /c/{company_id}/received_documents/{document_id}` | `received_documents:a` |
| `delete_received_document` | `DELETE /c/{company_id}/received_documents/{document_id}` | `received_documents:a` |
| `upload_attachment` | `POST /c/{company_id}/{issued\|received}_documents/attachment` | write scope of the target resource |
| `delete_document_attachment` | `DELETE /c/{company_id}/{issued\|received}_documents/{document_id}/attachment` | write scope of the target resource |

Update/delete tools carry `destructiveHint: true`; deletes are irreversible.

`company_id` can be omitted on every tool: the server falls back to the `FIC_COMPANY_ID` env var and errors with a hint to call `list_companies` if neither is available.

## Tools

### `list_companies`

No parameters. Returns a trimmed array of the companies accessible with the token:

```json
[{ "id": 12345, "name": "...", "type": "company" }]
```

The `id` is the `company_id` accepted by all other tools.

### `list_issued_documents`

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `company_id` | int | `FIC_COMPANY_ID` | |
| `type` | enum | `invoice` | One per call: `invoice`, `quote`, `proforma`, `receipt`, `delivery_note`, `credit_note`, `order`, `work_report`, `supplier_order`, `self_own_invoice`, `self_supplier_invoice` |
| `page` | int ≥ 1 | 1 | |
| `per_page` | int 5–100 | 50 | **API rejects values below 5** (spec claims min 1 — wrong) |
| `sort` | string | — | Comma-separated fields, `-` prefix for descending, e.g. `-date,number` |
| `q` | string | — | Filter query, see below |
| `fieldset` | enum | `basic` | `basic` (compact rows) or `detailed` (includes line items) |

### `get_issued_document`

`company_id?`, `document_id` (required), `fieldset` (default `detailed`). Returns the full document: entity, line items (`items_list`), payments (`payments_list`), amounts, e-invoice status, attachment URL.

### `list_received_documents`

Same parameters as `list_issued_documents`, but `type` is one of `expense` (default), `passive_credit_note`, `passive_delivery_note`, `self_invoice`.

### `get_received_document`

`company_id?`, `document_id` (required), `fieldset` (default `detailed`). Returns the full document including `category`, `tax_deductibility`, `vat_deductibility`, `currency`, `payments_list`.

### `get_company_info`

`company_id?`, `resource` (required): one of `vat_types`, `payment_methods`, `payment_accounts`, `received_document_categories`. Returns the raw configuration list. Use it before creating documents: `items_list[].vat.id` must be a valid VAT type ID, `payment_method.id` / `payments_list[].payment_account.id` must exist, and expense `category` should match an existing category.

### `create_issued_document` / `update_issued_document`

`company_id?`, `data` (required; update also takes `document_id`). `data` mirrors the FIC `IssuedDocument` model — the schema types the common fields and passes everything else through unchanged:

- `type` (default `invoice`), `entity` (`{id}` of an existing client, or `{name, vat_number, ...}`), `date`, `number`/`numeration` (auto-assigned if omitted)
- `items_list`: `[{ name, qty, net_price, vat: {id}, ... }]` — FIC computes document totals from the items
- `payments_list`: `[{ amount, due_date, status, payment_account? }]` — **must cover the document total**
- `payment_method: {id}`, `e_invoice`, `subject`, `visible_subject`, `notes`, ...

Update sends a `PUT` with only the provided fields. Both return the resulting document.

### `create_received_document` / `update_received_document`

Same shape with the received-document fields: `type` (default `expense`), `description`, `entity` (supplier), `date`, `category`, `invoice_number`, `amount_net`/`amount_vat`/`amount_gross`, `tax_deductibility`/`vat_deductibility`, `payments_list`.

**Quirk (verified live): `payments_list` covering `amount_gross` is required on create even for plain expenses** — otherwise the API returns 422 "Il totale dei pagamenti non corrisponde al totale da pagare".

### `delete_issued_document` / `delete_received_document`

`company_id?`, `document_id`. Permanent, irreversible. Returns `{ deleted: true, document_id }`. Deleting a document also removes its attachment.

## Attachments

Flow (verified live on expenses):

1. `upload_attachment` — `company_id?`, `target` (`issued` | `received`), `file_path` (local absolute path; PDF, images, XML, p7m, zip...), `filename?`. Sends `multipart/form-data` and returns `{ attachment_token }`. Unbound tokens expire, so upload right before the next step.
2. Pass the token as `data.attachment_token` in `create_*` or `update_*` — passing a new token on update replaces the current attachment.
3. The document detail then exposes `attachment_url`.

`delete_document_attachment` (`company_id?`, `target`, `document_id`) maps to the spec's DELETE endpoint, **but the live API consistently returned 500 on it during testing (2026-07-30)** — as alternatives, replace the attachment via update or delete the whole document.

## Filter language (`q`)

`field op value` expressions combined with `and` / `or` and parentheses. Operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `like`, `is null`, `is not null`. Dates are `'YYYY-MM-DD'` strings; `like` uses `%` wildcards.

```text
date >= '2026-01-01' and date <= '2026-06-30'
entity.name like '%acme%'
amount_gross > 1000
```

## Pagination

List responses are trimmed to `{ current_page, last_page, per_page, total, data }` (the raw API's `*_url`/`links` fields are dropped to save context). Fetch subsequent pages by incrementing `page` until `current_page == last_page`.

## Errors

API failures surface as MCP tool errors with the HTTP status, path, FIC error detail, and a hint when recognizable:

- `NO_PERMISSION` → the token lacks the read scope for that document type (regenerate it in the [developer area](https://developers.fattureincloud.it/docs/authentication/manual-authentication/) with the missing scopes)
- `401` → token invalid or revoked
- `429` → rate limited, retry later
- `422` with `validation_result` → invalid parameters (e.g. `per_page` < 5, missing `type`)

## Not yet implemented

Everything else in the [OpenAPI spec](https://github.com/fattureincloud/openapi-fattureincloud): clients/suppliers CRUD, products, receipts (corrispettivi), taxes, cashbook, archive, e-invoice XML/SDI send endpoints, issued/received document totals, attachments.
