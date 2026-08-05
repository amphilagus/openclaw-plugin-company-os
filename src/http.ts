import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { CompanyOsService } from "./service.js";

const PREFIX = "/plugins/company-os";
const API_PREFIX = `${PREFIX}/api/v1`;

export function createCompanyOsHttpHandler(options: {
  getService: () => CompanyOsService;
  staticDir: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      if (url.pathname.startsWith(API_PREFIX)) {
        return await handleApi(options.getService(), req, res, url);
      }
      return serveWebAsset(options.staticDir, res, url.pathname.slice(PREFIX.length));
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  };
}

async function handleApi(service: CompanyOsService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const store = service.store;
  const route = url.pathname.slice(API_PREFIX.length) || "/";
  if (req.method === "GET" && route === "/snapshot") {
    sendJson(res, 200, store.bossSnapshot());
    return true;
  }
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
  const taskDetail = route.match(/^\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskDetail) {
    sendJson(res, 200, store.readTask("boss", decodeURIComponent(taskDetail[1]!), false));
    return true;
  }
  const meetingDetail = route.match(/^\/meetings\/([^/]+)$/);
  if (req.method === "GET" && meetingDetail) {
    sendJson(res, 200, store.meetingView(decodeURIComponent(meetingDetail[1]!)));
    return true;
  }
  if (req.method === "POST" && route === "/tasks") {
    sendJson(res, 201, store.createRootTask(await readJson(req) as any));
    return true;
  }
  if (req.method === "POST" && route === "/notices") {
    sendJson(res, 201, store.publishNotice("boss", await readJson(req) as any));
    return true;
  }
  if (req.method === "POST" && route === "/meetings") {
    const result = store.requestMeeting("boss", await readJson(req) as any);
    await service.dispatchAdvance(result.advance);
    sendJson(res, 201, result.meeting);
    return true;
  }
  const taskAction = route.match(/^\/tasks\/([^/]+)\/(review|revise|reassign|cancel|unblock)$/);
  if (req.method === "POST" && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]!);
    const action = taskAction[2]!;
    const body = await readJson(req) as Record<string, any>;
    const result = action === "review"
      ? store.reviewTask("boss", taskId, body.decision, body.feedback)
      : action === "revise"
        ? store.reviseTask("boss", taskId, body, body.reason)
        : action === "reassign"
          ? store.reassignTask("boss", taskId, body.assigneeId, body.reason)
          : action === "cancel"
            ? store.cancelTask("boss", taskId, body.reason)
            : store.unblockTask("boss", taskId, body.reason);
    sendJson(res, 200, result);
    return true;
  }
  const meetingAction = route.match(/^\/meetings\/([^/]+)\/(interject|reorder|cancel)$/);
  if (req.method === "POST" && meetingAction) {
    const meetingId = decodeURIComponent(meetingAction[1]!);
    const action = meetingAction[2]!;
    const body = await readJson(req) as Record<string, any>;
    if (action === "interject") {
      const advance = store.bossInterject(meetingId, body.body, body.targetId);
      await service.dispatchAdvance(advance);
      sendJson(res, 200, store.meetingView(meetingId));
    } else if (action === "reorder") {
      sendJson(res, 200, store.reorderMeeting(meetingId, Number(body.targetPosition)));
    } else {
      sendJson(res, 200, store.cancelMeeting("boss", meetingId, body.reason));
    }
    return true;
  }
  sendJson(res, 404, { ok: false, error: "API route not found" });
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
