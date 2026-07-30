const BASE_URL = "https://api-v2.fattureincloud.it";

export type QueryParams = Record<string, string | number | undefined>;
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Perform an authenticated request against the Fatture in Cloud API v2.
 * Auth uses a manual access token (never expires) from the FIC_ACCESS_TOKEN env var.
 */
export async function ficRequest(
  method: HttpMethod,
  path: string,
  opts: { params?: QueryParams; body?: unknown } = {}
): Promise<any> {
  const token = process.env.FIC_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "FIC_ACCESS_TOKEN is not set. Generate a manual access token from the Fatture in Cloud " +
        "developer area (https://developers.fattureincloud.it/docs/authentication/manual-authentication/) " +
        "and set it in the MCP server environment."
    );
  }

  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail =
        parsed?.error?.description ??
        parsed?.error?.message ??
        (parsed?.error?.validation_result ? JSON.stringify(parsed.error.validation_result) : raw);
      if (parsed?.error?.message && parsed?.error?.validation_result) {
        detail = `${parsed.error.message} ${JSON.stringify(parsed.error.validation_result)}`;
      }
    } catch {
      // keep raw body as detail
    }
    const noPermission = raw.includes("NO_PERMISSION");
    const hint = noPermission
      ? ` (the access token lacks the ${method === "GET" ? "read" : "write"} scope for this resource — regenerate it in the ` +
        "Fatture in Cloud developer area including the missing scopes)"
      : res.status === 401
        ? " (token invalid or revoked)"
        : res.status === 429
          ? " (rate limited — wait a moment and retry)"
          : "";
    throw new Error(`Fatture in Cloud API ${res.status} on ${method} ${path}${hint}: ${detail}`);
  }

  return raw ? JSON.parse(raw) : {};
}

export const ficGet = (path: string, params: QueryParams = {}) =>
  ficRequest("GET", path, { params });

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain",
  xml: "text/xml",
  p7m: "application/pkcs7-mime",
  zip: "application/zip",
};

/**
 * Upload a file as a document attachment (multipart/form-data).
 * Returns the FIC response containing the attachment_token to set on the document.
 */
export async function ficUploadAttachment(
  resource: "issued_documents" | "received_documents",
  companyId: number,
  fileBytes: Uint8Array,
  fileName: string
): Promise<any> {
  const token = process.env.FIC_ACCESS_TOKEN;
  if (!token) {
    throw new Error("FIC_ACCESS_TOKEN is not set.");
  }

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const blob = new Blob([fileBytes as BlobPart], {
    type: MIME_BY_EXT[ext] ?? "application/octet-stream",
  });
  const form = new FormData();
  form.set("filename", fileName);
  form.set("attachment", blob, fileName);

  const res = await fetch(`${BASE_URL}/c/${companyId}/${resource}/attachment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    body: form,
  });

  const raw = await res.text();
  if (!res.ok) {
    const hint = raw.includes("NO_PERMISSION")
      ? " (the access token lacks the write scope for this resource)"
      : "";
    throw new Error(
      `Fatture in Cloud API ${res.status} on POST /c/${companyId}/${resource}/attachment${hint}: ${raw}`
    );
  }
  return raw ? JSON.parse(raw) : {};
}

/** Resolve the company ID from the tool argument or the FIC_COMPANY_ID env var. */
export function resolveCompanyId(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(process.env.FIC_COMPANY_ID);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  throw new Error(
    "No company_id available: pass the company_id argument or set the FIC_COMPANY_ID env var. " +
      "Use the list_companies tool to discover the ID."
  );
}

/** Keep only the useful parts of a FIC paginated list response (drop the *_url noise). */
export function trimListResponse(body: any): any {
  return {
    current_page: body?.current_page,
    last_page: body?.last_page,
    per_page: body?.per_page,
    total: body?.total,
    data: body?.data ?? [],
  };
}
