import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ficGet, ficRequest, ficUploadAttachment, resolveCompanyId, trimListResponse } from "./fic.js";

const INSTRUCTIONS = `Bridge to the Fatture in Cloud API v2 (Italian invoicing platform). Read and write (CRUD) on issued documents (invoices, credit notes...) and received documents (expenses...), plus config lookups and the e-invoice (SDI) XML download via get_e_invoice_xml.

If a default company is configured (FIC_COMPANY_ID env var under stdio, X-FIC-Company header over HTTP), tools use it automatically; otherwise call list_companies first to discover the company_id.
List tools accept the Fatture in Cloud filter language in the "q" parameter. Examples:
  q: "date >= '2026-01-01' and date <= '2026-06-30'"
  q: "entity.name like '%acme%'"
  q: "amount_gross > 1000"
Supported operators: =, !=, >, <, >=, <=, like, is null, is not null, combined with and/or and parentheses.
Always write comparison operators as literal characters — HTML entities (&gt;, &lt;) are passed through unchanged and rejected with 422 "Invalid query syntax".
Dates are ISO strings (YYYY-MM-DD); amounts are in the document currency (EUR unless specified).
Lists are paginated: check current_page/last_page/total and fetch further pages if needed.

Writing documents:
- Before creating an invoice, look up VAT type IDs, payment methods and payment accounts with get_company_info.
- For issued documents, provide items_list and FIC computes the totals; payments_list must cover the total.
- For expenses, provide amount_net/amount_vat/amount_gross explicitly; category should match an existing one (get_company_info received_document_categories).
- payments_list covering the total is REQUIRED when creating any document, expenses included (the API rejects a mismatch between payments and total).
- update tools send only the fields you pass (plus the API-required type); delete tools are irreversible.
- Attachments: upload_attachment reads a LOCAL file and returns an attachment_token; pass it as data.attachment_token in create/update to bind it to a document. The attachment URL then appears in the document detail (attachment_url).`;

const companyIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Fatture in Cloud company ID. Omit to use the default company configured for the session; discover IDs with list_companies."
  );

const pageSchema = z.number().int().min(1).default(1).describe("Page number to retrieve (1-based).");
const perPageSchema = z
  .number()
  .int()
  .min(5)
  .max(100)
  .default(50)
  .describe("Results per page (min 5, max 100 — the API rejects smaller values).");
const sortSchema = z
  .string()
  .optional()
  .describe('Comma-separated sort fields, prefix with "-" for descending. E.g. "-date" or "-date,number".');
const qSchema = z
  .string()
  .optional()
  .describe(
    "Filter query, e.g. \"date >= '2026-01-01' and date <= '2026-06-30'\" or \"entity.name like '%acme%'\". " +
      "Write the operators literally (>, <, >=, <=): the string is sent verbatim, so HTML entities " +
      "like &gt; or &lt; reach the API and are rejected with 422 \"Invalid query syntax\"."
  );
const fieldsetSchema = z
  .enum(["basic", "detailed"])
  .default("basic")
  .describe('"basic" for compact rows (default), "detailed" for full documents including line items.');

const issuedTypeSchema = z
  .enum([
    "invoice",
    "quote",
    "proforma",
    "receipt",
    "delivery_note",
    "credit_note",
    "order",
    "work_report",
    "supplier_order",
    "self_own_invoice",
    "self_supplier_invoice",
  ])
  .describe("The issued document type.");

const receivedTypeSchema = z
  .enum(["expense", "passive_credit_note", "passive_delivery_note", "self_invoice"])
  .describe("The received document type.");

const entitySchema = z
  .object({
    id: z.number().int().optional().describe("ID of an existing client/supplier (preferred when known)."),
    name: z.string().optional().describe("Entity name; used to match or create if no id is given."),
    vat_number: z.string().optional(),
    tax_code: z.string().optional(),
  })
  .passthrough()
  .describe(
    "The counterpart: client for issued documents, supplier for received ones. Pass {id} for an existing entity or at least {name}."
  );

const paymentSchema = z
  .object({
    amount: z.number().describe("Payment amount."),
    due_date: z.string().describe("Due date, YYYY-MM-DD."),
    status: z.enum(["not_paid", "paid", "reversed"]).default("not_paid"),
    paid_date: z.string().optional().describe("YYYY-MM-DD, required when status is paid."),
    payment_account: z
      .object({ id: z.number().int() })
      .passthrough()
      .optional()
      .describe("Payment account {id}, see get_company_info payment_accounts. Required when status is paid."),
  })
  .passthrough();

const issuedItemSchema = z
  .object({
    name: z.string().describe("Line item name."),
    qty: z.number().default(1),
    net_price: z.number().optional().describe("Unit net price. Provide net_price or gross_price."),
    gross_price: z.number().optional(),
    vat: z
      .object({ id: z.number().int() })
      .passthrough()
      .optional()
      .describe("VAT type {id}, see get_company_info vat_types."),
    description: z.string().optional(),
    product_id: z.number().int().optional(),
  })
  .passthrough();

const issuedDataSchema = z
  .object({
    type: issuedTypeSchema.default("invoice"),
    entity: entitySchema.optional().describe("Required on create."),
    date: z.string().optional().describe("Document date, YYYY-MM-DD (defaults to today)."),
    number: z.number().int().optional().describe("Document number (auto-assigned if omitted)."),
    numeration: z.string().optional().describe('Numeration/sezionale, e.g. "/A" (empty for default).'),
    subject: z.string().optional().describe("Internal subject."),
    visible_subject: z.string().optional().describe("Subject visible to the client."),
    items_list: z.array(issuedItemSchema).optional().describe("Line items; FIC computes totals from them."),
    payments_list: z.array(paymentSchema).optional().describe("Payments; must cover the document total."),
    payment_method: z.object({ id: z.number().int() }).passthrough().optional().describe("See get_company_info payment_methods."),
    e_invoice: z.boolean().optional().describe("Set true to mark as electronic invoice (SDI)."),
    notes: z.string().optional(),
    attachment_token: z.string().optional().describe("Token from upload_attachment to bind a file to this document."),
  })
  .passthrough()
  .describe("The document payload. Extra Fatture in Cloud fields beyond the ones listed are passed through as-is.");

const receivedDataSchema = z
  .object({
    type: receivedTypeSchema.default("expense"),
    description: z.string().optional().describe("Expense description. Required on create."),
    entity: entitySchema.optional().describe("Supplier. Required on create."),
    date: z.string().optional().describe("Document date, YYYY-MM-DD."),
    category: z.string().optional().describe("Expense category, see get_company_info received_document_categories."),
    invoice_number: z.string().optional().describe("The supplier's invoice number."),
    amount_net: z.number().optional(),
    amount_vat: z.number().optional(),
    amount_gross: z.number().optional(),
    tax_deductibility: z.number().optional().describe("Percent 0-100."),
    vat_deductibility: z.number().optional().describe("Percent 0-100."),
    payments_list: z.array(paymentSchema).optional(),
    attachment_token: z.string().optional().describe("Token from upload_attachment to bind a file to this document."),
  })
  .passthrough()
  .describe("The document payload. Extra Fatture in Cloud fields beyond the ones listed are passed through as-is.");

const documentIdSchema = z.number().int().positive().describe("The ID of the document.");

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

/**
 * Build a fully configured MCP server instance.
 *
 * A fresh instance per HTTP request keeps concurrent clients (each with their own
 * credentials) from sharing state; the stdio entrypoint just builds one and keeps it.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "fattureincloud", version: "0.4.0" },
    { instructions: INSTRUCTIONS }
  );

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description:
        "List the Fatture in Cloud companies accessible with the configured token. " +
        "Returns id, name and type for each company; the id is the company_id used by the other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const body = await ficGet("/user/companies");
      const companies = (body?.data?.companies ?? []).map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
      }));
      return jsonResult(companies);
    }
  );

  server.registerTool(
    "get_company_info",
    {
      title: "Get company configuration lists",
      description:
        "Look up company configuration needed to build documents: VAT types (IDs for items_list), " +
        "payment methods, payment accounts, expense categories.",
      inputSchema: {
        company_id: companyIdSchema,
        resource: z
          .enum(["vat_types", "payment_methods", "payment_accounts", "received_document_categories"])
          .describe("Which configuration list to fetch."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, resource }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/info/${resource}`);
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "list_issued_documents",
    {
      title: "List issued documents",
      description:
        "List issued documents (invoices, credit notes, quotes, proformas, receipts...) for a company. " +
        "One document type per call; defaults to invoices. Paginated: check current_page/last_page/total.",
      inputSchema: {
        company_id: companyIdSchema,
        type: issuedTypeSchema.default("invoice"),
        page: pageSchema,
        per_page: perPageSchema,
        sort: sortSchema,
        q: qSchema,
        fieldset: fieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, type, page, per_page, sort, q, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/issued_documents`, {
        type,
        page,
        per_page,
        sort,
        q,
        fieldset,
      });
      return jsonResult(trimListResponse(body));
    }
  );

  server.registerTool(
    "get_issued_document",
    {
      title: "Get issued document",
      description:
        "Get a single issued document by ID with full details (entity, line items, payments, amounts).",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        fieldset: z.enum(["basic", "detailed"]).default("detailed").describe("Level of detail (default: detailed)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, document_id, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/issued_documents/${document_id}`, { fieldset });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "get_e_invoice_xml",
    {
      title: "Download e-invoice XML (SDI)",
      description:
        "Download the e-invoice (fattura elettronica SDI) XML for an issued document. " +
        "Only available when the document has an e-invoice in Fatture in Cloud (e_invoice documents, " +
        "e.g. self invoices); returns the raw XML text as-is.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        include_attachment: z
          .boolean()
          .optional()
          .describe("Include the document attachment inside the XML e-invoice."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, document_id, include_attachment }) => {
      const cid = resolveCompanyId(company_id);
      const xml = await ficRequest("GET", `/c/${cid}/issued_documents/${document_id}/e_invoice/xml`, {
        params: { include_attachment },
        accept: "text/xml",
        raw: true,
      });
      return { content: [{ type: "text" as const, text: xml }] };
    }
  );

  server.registerTool(
    "list_received_documents",
    {
      title: "List received documents (expenses)",
      description:
        "List received documents for a company: expenses (spese), passive credit notes, passive delivery notes, self invoices. " +
        "Defaults to expenses. Paginated: check current_page/last_page/total.",
      inputSchema: {
        company_id: companyIdSchema,
        type: receivedTypeSchema.default("expense"),
        page: pageSchema,
        per_page: perPageSchema,
        sort: sortSchema,
        q: qSchema,
        fieldset: fieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, type, page, per_page, sort, q, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/received_documents`, {
        type,
        page,
        per_page,
        sort,
        q,
        fieldset,
      });
      return jsonResult(trimListResponse(body));
    }
  );

  server.registerTool(
    "get_received_document",
    {
      title: "Get received document (expense)",
      description:
        "Get a single received document (expense, passive credit note...) by ID with full details.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        fieldset: z.enum(["basic", "detailed"]).default("detailed").describe("Level of detail (default: detailed)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, document_id, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/received_documents/${document_id}`, { fieldset });
      return jsonResult(body?.data ?? body);
    }
  );

  // ---------------------------------------------------------------------------
  // Write tools — issued documents
  // ---------------------------------------------------------------------------

  server.registerTool(
    "create_issued_document",
    {
      title: "Create issued document",
      description:
        "Create an issued document (invoice, credit note, quote...). Requires entity and items_list; " +
        "look up VAT type and payment method/account IDs with get_company_info first. Returns the created document.",
      inputSchema: {
        company_id: companyIdSchema,
        data: issuedDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ company_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("POST", `/c/${cid}/issued_documents`, { body: { data } });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "update_issued_document",
    {
      title: "Update issued document",
      description:
        "Update an existing issued document. Only the fields provided in data are changed. " +
        "Fetch the document first with get_issued_document to see its current state.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        data: issuedDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, document_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("PUT", `/c/${cid}/issued_documents/${document_id}`, {
        body: { data },
      });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "delete_issued_document",
    {
      title: "Delete issued document",
      description: "Permanently delete an issued document by ID. Irreversible.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, document_id }) => {
      const cid = resolveCompanyId(company_id);
      await ficRequest("DELETE", `/c/${cid}/issued_documents/${document_id}`);
      return jsonResult({ deleted: true, document_id });
    }
  );

  // ---------------------------------------------------------------------------
  // Write tools — received documents (expenses)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "create_received_document",
    {
      title: "Create received document (expense)",
      description:
        "Create a received document (expense, passive credit note...). Requires description, entity, date, amounts " +
        "(amount_net/amount_vat/amount_gross) and a payments_list covering the total. Returns the created document.",
      inputSchema: {
        company_id: companyIdSchema,
        data: receivedDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ company_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("POST", `/c/${cid}/received_documents`, { body: { data } });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "update_received_document",
    {
      title: "Update received document (expense)",
      description:
        "Update an existing received document. Only the fields provided in data are changed. " +
        "Fetch the document first with get_received_document to see its current state.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        data: receivedDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, document_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("PUT", `/c/${cid}/received_documents/${document_id}`, {
        body: { data },
      });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "delete_received_document",
    {
      title: "Delete received document (expense)",
      description: "Permanently delete a received document by ID. Irreversible.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, document_id }) => {
      const cid = resolveCompanyId(company_id);
      await ficRequest("DELETE", `/c/${cid}/received_documents/${document_id}`);
      return jsonResult({ deleted: true, document_id });
    }
  );

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  const attachmentTargetSchema = z
    .enum(["issued", "received"])
    .describe('"issued" for issued documents (invoices...), "received" for received documents (expenses...).');

  server.registerTool(
    "upload_attachment",
    {
      title: "Upload document attachment",
      description:
        "Upload a local file (PDF, image, XML, zip...) as an attachment for an issued or received document. " +
        "Returns an attachment_token: pass it as data.attachment_token in a create/update tool to bind it to a document. " +
        "Unbound tokens expire after a while, so upload right before creating/updating.",
      inputSchema: {
        company_id: companyIdSchema,
        target: attachmentTargetSchema,
        file_path: z.string().describe("Absolute path of the local file to upload."),
        filename: z.string().optional().describe("Display name for the attachment (defaults to the file's basename)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ company_id, target, file_path, filename }) => {
      const cid = resolveCompanyId(company_id);
      const bytes = await readFile(file_path);
      const name = filename ?? basename(file_path);
      const resource = target === "issued" ? "issued_documents" : "received_documents";
      const body = await ficUploadAttachment(resource, cid, bytes, name);
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "delete_document_attachment",
    {
      title: "Delete document attachment",
      description:
        "Remove the attachment from an issued or received document (the document itself is untouched). Irreversible. " +
        "Note: the FIC API has been observed returning 500 on this endpoint; deleting the document or replacing " +
        "the attachment via update (new attachment_token) are alternatives.",
      inputSchema: {
        company_id: companyIdSchema,
        target: attachmentTargetSchema,
        document_id: documentIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, target, document_id }) => {
      const cid = resolveCompanyId(company_id);
      const resource = target === "issued" ? "issued_documents" : "received_documents";
      await ficRequest("DELETE", `/c/${cid}/${resource}/${document_id}/attachment`);
      return jsonResult({ attachment_deleted: true, document_id });
    }
  );

  return server;
}
