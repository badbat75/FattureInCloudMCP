import { lookup as dnsLookup } from "node:dns";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { basename } from "node:path";

/** Hard cap on an attachment's size, whatever its source. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Advisory cap for content_base64: beyond this an LLM-generated payload is costly and fragile. */
export const RECOMMENDED_BASE64_BYTES = 100 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export type AttachmentFile = { bytes: Uint8Array; filename?: string; contentType?: string };

/** Read a file from the filesystem of the machine running this server. */
export async function readServerFile(filePath: string): Promise<AttachmentFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new Error(
      `Cannot read file_path "${filePath}" (${code}): the path is resolved on the filesystem of the MCP ` +
        "server, not on the client. When the server runs remotely (HTTP transport) a client-side path does " +
        "not exist there, so this is not a client permission problem: pass the file as url (preferred) or " +
        "content_base64 instead.",
      { cause: err }
    );
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`File is ${bytes.length} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`);
  }
  return { bytes, filename: basename(filePath) };
}

/** Decode a base64 payload (a data: URL prefix is tolerated). */
export function decodeBase64(content: string): AttachmentFile {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(content);
  const payload = (match ? content.slice(match[0].length) : content).replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
    throw new Error("content_base64 is not valid base64.");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Decoded content is ${bytes.length} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`);
  }
  return { bytes, contentType: match?.[1] };
}

/**
 * Non-public address ranges. The server fetches a caller-chosen URL, so without
 * this a client could read LAN-only services (router UI, internal hosts) by
 * having them uploaded into its own Fatture in Cloud account.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1], "ipv4");
  const family = isIP(address);
  return family === 0 || BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * DNS lookup that refuses non-public addresses. It runs on every connection,
 * redirect hops included, and vets the address actually connected to, so DNS
 * rebinding cannot slip past it.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address as string, family);
    const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
    const blocked = addresses.find(isBlockedAddress);
    if (blocked) {
      return callback(
        Object.assign(new Error(`${hostname} resolves to non-public address ${blocked}`), { code: "EBLOCKED" }),
        address as string,
        family
      );
    }
    callback(null, address as string, family);
  });
};

/**
 * Download a file over https. Only public addresses are reachable, redirects are
 * followed only within the same host, non-2xx responses are rejected, and the
 * body is capped at MAX_ATTACHMENT_BYTES.
 */
export async function downloadFile(rawUrl: string): Promise<AttachmentFile> {
  let url = parseHttpsUrl(rawUrl);
  const originHost = url.host;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  for (let hops = 0; ; hops++) {
    const res = await get(url, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      res.resume();
      const location = res.headers.location;
      if (!location) throw new Error(`Download returned HTTP ${status} without a Location header.`);
      if (hops >= MAX_REDIRECTS) throw new Error(`Download exceeded ${MAX_REDIRECTS} redirects.`);
      const next = parseHttpsUrl(new URL(location, url).href);
      if (next.host !== originHost) {
        throw new Error(`Download redirected to a different host (${next.host}); refusing to follow it.`);
      }
      url = next;
      continue;
    }

    if (status < 200 || status >= 300) {
      res.resume();
      const text = res.statusMessage ? ` ${res.statusMessage}` : "";
      throw new Error(`Download of ${url.origin}${url.pathname} returned HTTP ${status}${text}.`);
    }
    const declared = Number(res.headers["content-length"]);
    if (declared > MAX_ATTACHMENT_BYTES) {
      res.destroy();
      throw new Error(`Remote file is ${declared} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`);
    }

    const bytes = await readCapped(res, signal);
    const contentType = res.headers["content-type"]?.split(";")[0].trim() || undefined;
    const filename = filenameFromContentDisposition(res.headers["content-disposition"]) ?? filenameFromUrl(url);
    return { bytes, filename, contentType };
  }
}

function parseHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`url must use https (got ${url.protocol}).`);
  // IP literals never reach the lookup hook, so vet them here.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw new Error(`url points to non-public address ${literal}; refusing to fetch it.`);
  }
  return url;
}

function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", lookup: publicOnlyLookup, signal }, resolve);
    req.on("error", (err: NodeJS.ErrnoException) => {
      const reason = signal.aborted
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`
        : err.code === "EBLOCKED"
          ? `${err.message}; refusing to fetch it`
          : (err.code ?? err.message);
      reject(new Error(`Download of ${url.origin}${url.pathname} failed: ${reason}`, { cause: err }));
    });
    req.end();
  });
}

async function readCapped(res: IncomingMessage, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res) {
      total += (chunk as Buffer).length;
      if (total > MAX_ATTACHMENT_BYTES) {
        res.destroy();
        throw new Error(`Remote file exceeds the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`);
      }
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (signal.aborted) throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s.`, { cause: err });
    throw err;
  }
  return Buffer.concat(chunks);
}

export function filenameFromContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return sanitizeFilename(decodeURIComponent(extended[2].trim().replace(/^"|"$/g, "")));
    } catch {
      // malformed percent-encoding: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const value = plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2]?.trim();
  return value ? sanitizeFilename(value) : undefined;
}

function filenameFromUrl(url: URL): string | undefined {
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return sanitizeFilename(decodeURIComponent(last));
  } catch {
    return sanitizeFilename(last);
  }
}

/** Keep only the last path segment, so a hostile header cannot smuggle a path. */
function sanitizeFilename(name: string): string | undefined {
  const cleaned = name.split(/[/\\]/).pop()?.trim();
  return cleaned || undefined;
}
