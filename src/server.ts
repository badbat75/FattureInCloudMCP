import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AttachmentFile,
  MAX_ATTACHMENT_BYTES,
  RECOMMENDED_BASE64_BYTES,
  decodeBase64,
  downloadFile,
  readServerFile,
} from "./attachment.js";
import { ficGet, ficRequest, ficUploadAttachment, resolveCompanyId, trimListResponse } from "./fic.js";

const INSTRUCTIONS = `Fatture in Cloud API v2 (Italian invoicing): issued documents (invoices, credit notes...), received documents (expenses...), the SDI inbox, clients/suppliers, attachments, config lookups.

- company_id: omit it to use the session default; without one, get it from list_companies.
- Lists are paginated (current_page/last_page/total) and take one document type per call. Keep fieldset "basic" unless you need line items.
- q filter: field op value, operators = != > < >= <= like (% wildcard) "is null" "is not null", joined by and/or and parentheses; dates 'YYYY-MM-DD'. Example: date >= '2026-01-01' and entity.name like '%acme%'.
- Amounts are in the document currency (EUR unless stated).
- Creating any document, expenses included, requires a payments_list summing to the total. Issued documents: send items_list (FIC computes totals) with VAT, payment method and account IDs from get_company_info. Expenses: send amount_net/amount_vat/amount_gross and a category from get_company_info.
- update_* tools change only the fields you pass; delete_* tools are irreversible.
- Every document stores its own copy of the client/supplier data: update_entity changes the registry (future documents), data.entity in update_*_document changes that one document.
- E-invoices received from SDI wait in list_pending_received_documents, not in list_received_documents, until registered with create_received_document + pending_id.
- Attachments: upload_attachment returns an attachment_token; set it as data.attachment_token in a create/update.`;

const companyIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Omit to use the session default.");

const pageSchema = z.number().int().min(1).default(1).describe("1-based.");
const perPageSchema = z.number().int().min(5).max(100).default(50).describe("5-100 (the API rejects < 5).");
const sortSchema = z.string().optional().describe('Comma-separated fields, "-" prefix for descending, e.g. "-date".');
const qSchema = z
  .string()
  .optional()
  .describe("Filter, e.g. \"date >= '2026-01-01'\". Write operators literally: HTML entities (&gt;) are rejected with 422.");
const fieldsetSchema = z
  .enum(["basic", "detailed"])
  .default("basic")
  .describe('"detailed" adds line items and full data.');
const detailFieldsetSchema = z.enum(["basic", "detailed"]).default("detailed");

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
  ]);

const receivedTypeSchema = z.enum(["expense", "passive_credit_note", "passive_delivery_note", "self_invoice"]);

const pendingTypeSchema = z
  .enum(["agyo", "mail", "browser"])
  .default("agyo")
  .describe("Arrival channel (agyo = SDI). Required by the API, but every value currently returns the same list.");

const entitySchema = z
  .object({
    id: z.number().int().optional().describe("Existing client/supplier ID (preferred)."),
    name: z.string().optional(),
    vat_number: z.string().optional(),
    tax_code: z.string().optional(),
  })
  .passthrough()
  .describe("Client (issued) or supplier (received): {id}, or at least {name}.");

const idRefSchema = z.object({ id: z.number().int() }).passthrough();

const paymentSchema = z
  .object({
    amount: z.number(),
    due_date: z.string().describe("YYYY-MM-DD."),
    status: z.enum(["not_paid", "paid", "reversed"]).default("not_paid"),
    paid_date: z.string().optional().describe("YYYY-MM-DD, required when paid."),
    payment_account: idRefSchema.optional().describe("Required when paid."),
  })
  .passthrough();

const issuedItemSchema = z
  .object({
    name: z.string(),
    qty: z.number().default(1),
    net_price: z.number().optional().describe("Unit price; or gross_price."),
    gross_price: z.number().optional(),
    vat: idRefSchema.optional().describe("VAT type, get_company_info vat_types."),
    description: z.string().optional(),
    product_id: z.number().int().optional(),
  })
  .passthrough();

const passthroughNote = "Other Fatture in Cloud fields pass through as-is.";
const attachmentTokenSchema = z.string().optional().describe("From upload_attachment.");

const issuedDataSchema = z
  .object({
    type: issuedTypeSchema.default("invoice"),
    entity: entitySchema.optional().describe("Required on create."),
    date: z.string().optional().describe("YYYY-MM-DD, default today."),
    number: z.number().int().optional().describe("Auto-assigned if omitted."),
    numeration: z.string().optional().describe('Sezionale, e.g. "/A".'),
    subject: z.string().optional().describe("Internal."),
    visible_subject: z.string().optional(),
    items_list: z.array(issuedItemSchema).optional(),
    payments_list: z.array(paymentSchema).optional().describe("Must sum to the total."),
    payment_method: idRefSchema.optional(),
    e_invoice: z.boolean().optional().describe("true for an SDI e-invoice."),
    notes: z.string().optional(),
    attachment_token: attachmentTokenSchema,
  })
  .passthrough()
  .describe(passthroughNote);

const receivedDataSchema = z
  .object({
    type: receivedTypeSchema.default("expense"),
    description: z.string().optional().describe("Required on create."),
    entity: entitySchema.optional().describe("Required on create."),
    date: z.string().optional().describe("YYYY-MM-DD."),
    category: z.string().optional(),
    invoice_number: z.string().optional().describe("The supplier's number."),
    amount_net: z.number().optional(),
    amount_vat: z.number().optional(),
    amount_gross: z.number().optional(),
    tax_deductibility: z.number().optional().describe("Percent."),
    vat_deductibility: z.number().optional().describe("Percent."),
    payments_list: z.array(paymentSchema).optional().describe("Must sum to amount_gross."),
    attachment_token: attachmentTokenSchema,
  })
  .passthrough()
  .describe(passthroughNote);

const entityKindSchema = z.enum(["client", "supplier"]);
const entityPath = (cid: number, kind: "client" | "supplier") =>
  `/c/${cid}/entities/${kind === "client" ? "clients" : "suppliers"}`;

const entityDataSchema = z
  .object({
    name: z.string().optional(),
    vat_number: z.string().optional(),
    tax_code: z.string().optional(),
    address_street: z.string().optional(),
    address_postal_code: z.string().optional(),
    address_city: z.string().optional(),
    address_province: z.string().optional(),
    country: z.string().optional().describe('Italian name, e.g. "Regno Unito".'),
    email: z.string().optional(),
    certified_email: z.string().optional(),
    ei_code: z.string().optional().describe("SDI recipient code."),
  })
  .passthrough()
  .describe(passthroughNote);

const documentIdSchema = z.number().int().positive();

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/**
 * Build a fully configured MCP server instance.
 *
 * A fresh instance per HTTP request keeps concurrent clients (each with their own
 * credentials) from sharing state; the stdio entrypoint just builds one and keeps it.
 */
/**
 * allowFilePath: whether upload_attachment may read the server's own disk. The
 * HTTP entrypoint turns it off: a remote caller's path is meaningless there, and
 * honoring it would let any caller copy server files into their FIC account.
 */
export function buildServer({ allowFilePath = true }: { allowFilePath?: boolean } = {}): McpServer {
  const server = new McpServer(
    { name: "fattureincloud", version: "0.5.0" },
    { instructions: INSTRUCTIONS }
  );

  // ---------------------------------------------------------------------------
  // Read tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description: "List the companies the token can access: id (the company_id of the other tools), name, type.",
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
      description: "Get a configuration list needed to build documents (VAT types, payment methods/accounts, expense categories).",
      inputSchema: {
        company_id: companyIdSchema,
        resource: z.enum(["vat_types", "payment_methods", "payment_accounts", "received_document_categories"]),
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
      description: "List issued documents (invoices, credit notes, quotes...) of one type.",
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
      description: "Get an issued document: entity, line items, payments, amounts, e-invoice status.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        fieldset: detailFieldsetSchema,
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
      description: "Get the raw SDI XML of an issued document that has e_invoice: true (drafts included).",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        include_attachment: z.boolean().optional().describe("Embed the document attachment in the XML."),
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
      description: "List registered received documents (expenses, passive credit notes...) of one type.",
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
      description: "Get a received document (expense, passive credit note...).",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        fieldset: detailFieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, document_id, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/received_documents/${document_id}`, { fieldset });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "list_pending_received_documents",
    {
      title: "List pending received documents (SDI inbox)",
      description:
        "List the 'documenti da registrare' queue: SDI e-invoices and uploads not yet registered. Rows carry the " +
        "parsed data (supplier_name, ei_number, emission_date, amounts, payments_list, category, document_type); " +
        "date is the arrival time.",
      inputSchema: {
        company_id: companyIdSchema,
        type: pendingTypeSchema,
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
      const body = await ficGet(`/c/${cid}/received_documents/pending`, {
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
    "get_pending_received_document",
    {
      title: "Get pending received document (SDI inbox)",
      description: "Get one item of the 'documenti da registrare' queue, same shape as a list row.",
      inputSchema: {
        company_id: companyIdSchema,
        document_id: documentIdSchema,
        fieldset: detailFieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, document_id, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`/c/${cid}/received_documents/pending/${document_id}`, { fieldset });
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
      description: "Create an issued document from entity, items_list and payments_list. Returns it.",
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
      description: "Update an issued document (only the fields passed). Returns it.",
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
      description: "Delete an issued document. Irreversible.",
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
        "Create a received document (needs description, entity, date, the three amounts, payments_list). Returns it. " +
        "With pending_id it registers that queue item: build data from it as type = document_type, " +
        "entity {name: supplier_name}, invoice_number = ei_number, date = emission_date, amounts, category, " +
        "payments_list; the XML stays attached.",
      inputSchema: {
        company_id: companyIdSchema,
        pending_id: z.number().int().positive().optional().describe("Item ID from list_pending_received_documents."),
        data: receivedDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ company_id, pending_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("POST", `/c/${cid}/received_documents`, {
        body: pending_id === undefined ? { data } : { pending_id, data },
      });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "update_received_document",
    {
      title: "Update received document (expense)",
      description: "Update a received document (only the fields passed). Returns it.",
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
      description: "Delete a received document. Irreversible.",
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
  // Clients / suppliers (anagrafica)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "list_entities",
    {
      title: "List clients or suppliers",
      description: "List clients or suppliers from the registry (anagrafica), e.g. q: \"name like '%acme%'\".",
      inputSchema: {
        company_id: companyIdSchema,
        kind: entityKindSchema,
        page: pageSchema,
        per_page: perPageSchema,
        sort: sortSchema,
        q: qSchema,
        fieldset: fieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, kind, page, per_page, sort, q, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(entityPath(cid, kind), { page, per_page, sort, q, fieldset });
      return jsonResult(trimListResponse(body));
    }
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get client or supplier",
      description: "Get a client or supplier from the registry. A document's entity.id is its ID.",
      inputSchema: {
        company_id: companyIdSchema,
        kind: entityKindSchema,
        entity_id: z.number().int().positive(),
        fieldset: detailFieldsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company_id, kind, entity_id, fieldset }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficGet(`${entityPath(cid, kind)}/${entity_id}`, { fieldset });
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "update_entity",
    {
      title: "Update client or supplier",
      description:
        "Update a client or supplier in the registry (only the fields passed). Existing documents keep their own " +
        "copy: change those with data.entity in update_*_document. Returns the entity.",
      inputSchema: {
        company_id: companyIdSchema,
        kind: entityKindSchema,
        entity_id: z.number().int().positive(),
        data: entityDataSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ company_id, kind, entity_id, data }) => {
      const cid = resolveCompanyId(company_id);
      const body = await ficRequest("PUT", `${entityPath(cid, kind)}/${entity_id}`, { body: { data } });
      return jsonResult(body?.data ?? body);
    }
  );

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  const attachmentTargetSchema = z.enum(["issued", "received"]).describe("Document family.");

  server.registerTool(
    "upload_attachment",
    {
      title: "Upload document attachment",
      description:
        "Upload a file (PDF, image, XML, zip...) and get an attachment_token for data.attachment_token in a " +
        "create/update; tokens expire, so upload right before. Give exactly one source: url (preferred), " +
        "content_base64, or file_path.",
      inputSchema: {
        company_id: companyIdSchema,
        target: attachmentTargetSchema,
        url: z
          .string()
          .optional()
          .describe(`https link the server downloads (same-host redirects only, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB).`),
        content_base64: z
          .string()
          .optional()
          .describe(
            `Small files only (< ~${RECOMMENDED_BASE64_BYTES / 1024} KB decoded: base64 costs tool-call text). Needs filename.`
          ),
        file_path: z
          .string()
          .optional()
          .describe(
            allowFilePath
              ? "Path on the MCP SERVER's disk, not the client's."
              : "Disabled on this remote server: use url or content_base64."
          ),
        filename: z.string().optional().describe("With extension. Defaults to the source's name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ company_id, target, url, content_base64, file_path, filename }) => {
      const given = [url, content_base64, file_path].filter((source) => source !== undefined && source !== "");
      if (given.length !== 1) {
        throw new Error(
          `upload_attachment needs exactly one of url, content_base64, file_path (got ${given.length}). ` +
            "From a remote client use url (preferred) or content_base64."
        );
      }
      if (file_path && !allowFilePath) {
        throw new Error(
          "file_path is disabled on this server: it runs remotely (HTTP transport), so the path would be resolved " +
            "on the server's disk, not on yours. Pass the file as url (preferred) or content_base64 instead."
        );
      }
      if (content_base64 && !filename) {
        throw new Error("filename (with extension) is required when uploading content_base64.");
      }

      const cid = resolveCompanyId(company_id);
      const file: AttachmentFile = url
        ? await downloadFile(url)
        : content_base64
          ? decodeBase64(content_base64)
          : await readServerFile(file_path!);
      const name = filename ?? file.filename ?? "attachment";
      const resource = target === "issued" ? "issued_documents" : "received_documents";
      const body = await ficUploadAttachment(resource, cid, file.bytes, name, file.contentType);
      return jsonResult(body?.data ?? body);
    }
  );

  server.registerTool(
    "delete_document_attachment",
    {
      title: "Delete document attachment",
      description:
        "Remove a document's attachment (the document stays). Irreversible. FIC often answers 500 here: replacing " +
        "the attachment via update (new attachment_token) is the workaround.",
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
