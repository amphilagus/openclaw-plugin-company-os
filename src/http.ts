import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { executeBossApi } from "./boss-api.js";
import type { CompanyOsService } from "./service.js";

export const COMPANY_OS_API_PREFIX = "/plugins/company-os/api/v1";
export const COMPANY_OS_WEB_PREFIX = "/plugins/company-os-ui";

export function createCompanyOsApiHttpHandler(options: {
  getService: () => CompanyOsService;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isPathWithin(url.pathname, COMPANY_OS_API_PREFIX)) return false;
    try {
      return await handleApi(options.getService(), req, res, url);
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}

export function createCompanyOsWebHttpHandler(options: { staticDir: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isPathWithin(url.pathname, COMPANY_OS_WEB_PREFIX)) return false;
    try {
      return serveWebAsset(options.staticDir, res, url.pathname.slice(COMPANY_OS_WEB_PREFIX.length));
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}

async function handleApi(service: CompanyOsService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = url.pathname.slice(COMPANY_OS_API_PREFIX.length) || "/";
  if (req.method === "GET" && route === "/events") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    const unsubscribe = service.subscribe((event) => res.write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`));
    const lastEventId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? 0);
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      for (const event of service.eventsAfter(lastEventId)) {
        res.write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
    const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 20_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.once("close", close);
    res.once("close", close);
    return true;
  }
  const result = await executeBossApi(service, {
    method: req.method ?? "GET",
    path: route,
    body: req.method === "POST" || req.method === "PUT" ? await readJson(req) : undefined,
  });
  sendJson(res, result.status, result.data);
  return true;
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const type = String(req.headers["content-type"] ?? "");
  if (!type.includes("application/json")) throw new Error("content-type must be application/json");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function serveWebAsset(staticDir: string, res: ServerResponse, requestPath: string) {
  const requested = decodeURIComponent(requestPath || "/");
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const candidate = path.resolve(staticDir, relative);
  const safeRoot = `${path.resolve(staticDir)}${path.sep}`;
  const asset = candidate.startsWith(safeRoot) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : path.join(staticDir, "index.html");
  if (!existsSync(asset)) {
    sendJson(res, 503, { ok: false, error: "Company OS WebUI has not been built" });
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeType(asset));
  res.setHeader("Cache-Control", path.basename(asset) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
  createReadStream(asset).pipe(res);
  return true;
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function statusForError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("permission") || message.includes("only ") || message.includes("outside the caller")) return 403;
  if (message.includes("not found")) return 404;
  return 400;
}

function mimeType(file: string) {
  switch (path.extname(file)) {
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "text/html; charset=utf-8";
  }
}

function isPathWithin(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
