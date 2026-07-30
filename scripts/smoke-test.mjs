// End-to-end smoke test: spawns the built server over stdio and exercises every tool
// against the real Fatture in Cloud API. Credentials come from the gitignored .mcp.json
// (or from FIC_ACCESS_TOKEN / FIC_COMPANY_ID already present in the environment).
// Usage: npm run build && npm run smoke
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

let failures = 0;
function report(name, res) {
  const rpcError = res.error && JSON.stringify(res.error);
  const text = res.result?.content?.[0]?.text ?? "";
  if (rpcError || res.result?.isError) {
    failures++;
    console.log(`FAIL ${name}: ${rpcError ?? text.slice(0, 300)}`);
  } else {
    console.log(`ok   ${name}: ${text.replace(/\s+/g, " ").slice(0, 120)}...`);
  }
  return text;
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.1" },
});
console.log("initialize ->", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
notify("notifications/initialized", {});

const tools = await request("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

report("list_companies", await request("tools/call", { name: "list_companies", arguments: {} }));

report(
  "list_issued_documents",
  await request("tools/call", {
    name: "list_issued_documents",
    arguments: { type: "self_supplier_invoice", per_page: 5, sort: "-date" },
  })
);

const expensesText = report(
  "list_received_documents",
  await request("tools/call", {
    name: "list_received_documents",
    arguments: { per_page: 5, sort: "-date" },
  })
);

const firstExpense = JSON.parse(expensesText || "{}").data?.[0];
if (firstExpense) {
  report(
    "get_received_document",
    await request("tools/call", {
      name: "get_received_document",
      arguments: { document_id: firstExpense.id },
    })
  );
}

child.kill();
console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
