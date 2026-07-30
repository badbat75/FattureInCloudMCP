// CRUD roundtrip test: creates a clearly-marked TEST expense on the real account,
// verifies it, updates it, deletes it, and verifies it is gone. Leaves no trace,
// but do NOT run against an account where a stray test document would be a problem.
// Usage: npm run build && node scripts/crud-test.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
if (!env.FIC_ACCESS_TOKEN) {
  const mcpConfig = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
  Object.assign(env, mcpConfig.mcpServers?.fattureincloud?.env ?? {});
}

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [serverPath], { env, stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function call(name, args) {
  return request("tools/call", { name, arguments: args });
}
function textOf(res) {
  return res.result?.content?.[0]?.text ?? "";
}
function assertOk(name, res) {
  if (res.error || res.result?.isError) {
    console.log(`FAIL ${name}: ${res.error ? JSON.stringify(res.error) : textOf(res).slice(0, 400)}`);
    child.kill();
    process.exit(1);
  }
  console.log(`ok   ${name}`);
  return JSON.parse(textOf(res));
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "crud-test", version: "0.0.1" },
});
notify("notifications/initialized", {});

const today = new Date().toISOString().slice(0, 10);

// Lookup tools
const categories = assertOk(
  "get_company_info received_document_categories",
  await call("get_company_info", { resource: "received_document_categories" })
);
console.log("     categories sample:", JSON.stringify(categories).slice(0, 120));

// UPLOAD ATTACHMENT — minimal valid PDF written to a temp file
const pdfPath = join(tmpdir(), "fic-mcp-test-attachment.pdf");
writeFileSync(
  pdfPath,
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n"
);
const uploaded = assertOk(
  "upload_attachment",
  await call("upload_attachment", { target: "received", file_path: pdfPath })
);
const attachmentToken = uploaded.attachment_token;
if (!attachmentToken) throw new Error("no attachment_token returned");
console.log("     attachment_token received");

// CREATE — supplier entity by id (HP Italy, already in the register) so no new supplier is created
const created = assertOk(
  "create_received_document",
  await call("create_received_document", {
    data: {
      type: "expense",
      description: "TEST MCP CRUD — documento di prova, eliminare",
      entity: { id: 50471558, name: "HP Italy S.r.l." },
      date: today,
      amount_net: 1,
      amount_vat: 0,
      amount_gross: 1,
      tax_deductibility: 0,
      vat_deductibility: 0,
      payments_list: [{ amount: 1, due_date: today, status: "not_paid" }],
      attachment_token: attachmentToken,
    },
  })
);
const docId = created.id;
console.log(`     created expense id=${docId} (with attachment)`);

// READ back
const fetched = assertOk("get_received_document", await call("get_received_document", { document_id: docId }));
if (!fetched.description.startsWith("TEST MCP CRUD")) throw new Error("readback mismatch");
if (!fetched.attachment_url) throw new Error("attachment_url missing on document detail");
console.log("     attachment_url present on detail");

// DELETE ATTACHMENT — non-fatal: the endpoint intermittently returns 500 on FIC's side;
// deleting the document afterwards removes the attachment anyway.
const attDeleted = await call("delete_document_attachment", { target: "received", document_id: docId });
if (attDeleted.result?.isError) {
  console.log(`warn delete_document_attachment: ${textOf(attDeleted).slice(0, 200)}`);
} else {
  console.log("ok   delete_document_attachment");
}
rmSync(pdfPath, { force: true });

// UPDATE
const updated = assertOk(
  "update_received_document",
  await call("update_received_document", {
    document_id: docId,
    data: { type: "expense", description: "TEST MCP CRUD — modificato" },
  })
);
if (updated.description !== "TEST MCP CRUD — modificato") throw new Error("update not applied");
console.log("     description updated");

// DELETE
assertOk("delete_received_document", await call("delete_received_document", { document_id: docId }));

// Verify it is gone (expect an error result)
const gone = await call("get_received_document", { document_id: docId });
if (gone.result?.isError) {
  console.log("ok   document no longer exists after delete");
} else {
  console.log("FAIL document still exists after delete");
  child.kill();
  process.exit(1);
}

child.kill();
console.log("CRUD roundtrip passed — no test data left behind");
process.exit(0);
