import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { credentials, type FicCredentials } from "./fic.js";
import { buildServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3010);
const HOST = process.env.HOST ?? "127.0.0.1";

/**
 * Credentials travel with every request, so this deployment stores no Fatture in
 * Cloud secret of its own. Missing headers are left undefined and the tools fall
 * back to the FIC_* env vars, the way the stdio entrypoint works.
 */
function credentialsFrom(req: IncomingMessage): FicCredentials {
  const header = (name: string) => {
    const value = req.headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    return first?.trim() || undefined;
  };
  const company = Number(header("x-fic-company"));
  return {
    token: header("x-fic-token"),
    companyId: Number.isInteger(company) && company > 0 ? company : undefined,
  };
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url?.startsWith("/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // A server and transport per request: stateless, so concurrent callers never
  // share credentials and request ids cannot collide across clients.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await credentials.run(credentialsFrom(req), () => transport.handleRequest(req, res));
  } catch (err) {
    console.error("[fattureincloud-mcp] request failed:", err);
    if (!res.headersSent) jsonError(res, 500, "Internal server error");
  }
}

createServer((req, res) => void handle(req, res)).listen(PORT, HOST, () => {
  console.error(
    `[fattureincloud-mcp] Streamable HTTP on http://${HOST}:${PORT} — ` +
      "credentials read from the X-FIC-Token and X-FIC-Company request headers"
  );
});
