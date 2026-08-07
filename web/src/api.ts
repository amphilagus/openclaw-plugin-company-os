import type { MeetingDetail, MemberIdentity, Snapshot, TaskDetail } from "./types";
import { COMPANY_OS_GATEWAY_METHOD, getControlUiGatewayClient } from "./gateway-bridge";

const API = "/plugins/company-os/api/v1";
const identityRequests = new Map<string, Promise<MemberIdentity>>();

export async function getSnapshot() {
  return request<Snapshot>("/snapshot");
}

export async function getMeeting(id: string) {
  return request<MeetingDetail>(`/meetings/${encodeURIComponent(id)}`);
}

export async function getTask(id: string) {
  return request<TaskDetail>(`/tasks/${encodeURIComponent(id)}`);
}

export function getMemberIdentity(id: string) {
  const cached = identityRequests.get(id);
  if (cached) return cached;
  const pending = request<MemberIdentity>(`/identities/${encodeURIComponent(id)}`);
  identityRequests.set(id, pending);
  void pending.catch(() => identityRequests.delete(id));
  return pending;
}

export async function post<T = unknown>(path: string, body: unknown) {
  return request<T>(path, { method: "POST", body });
}

export async function put<T = unknown>(path: string, body: unknown) {
  return request<T>(path, { method: "PUT", body });
}

export async function deleteNotice<T = unknown>(path: string) {
  return request<T>(path, { method: "DELETE" });
}

export function subscribeToChanges(onChange: () => void, onConnection: (live: boolean) => void) {
  const controller = new AbortController();
  void stream(controller.signal, onChange, onConnection);
  return () => controller.abort();
}

async function stream(signal: AbortSignal, onChange: () => void, onConnection: (live: boolean) => void) {
  let lastEventId: number | undefined;
  while (!signal.aborted) {
    try {
      const client = getControlUiGatewayClient();
      if (client) {
        const result = await client.request<{ changed: boolean; lastEventId: number }>(
          COMPANY_OS_GATEWAY_METHOD,
          { method: "GET", path: "/events", lastEventId },
        );
        if (signal.aborted) return;
        onConnection(true);
        if (lastEventId === undefined || result.changed) onChange();
        lastEventId = result.lastEventId;
        continue;
      }

      const response = await fetch(`${API}/events`, {
        headers: { ...authHeaders(), ...(lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {}) },
        credentials: "same-origin",
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
      onConnection(true);
      onChange();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const records = buffer.split("\n\n");
        buffer = records.pop() ?? "";
        for (const record of records) {
          const id = record.match(/^id:\s*(.+)$/m)?.[1]?.trim();
          if (id && Number.isSafeInteger(Number(id))) lastEventId = Number(id);
          if (record.includes("event: change")) onChange();
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      onConnection(false);
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  }
}

type RequestOptions = { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}) {
  const method = options.method ?? "GET";
  const client = getControlUiGatewayClient();
  if (client) {
    return client.request<T>(COMPANY_OS_GATEWAY_METHOD, {
      method,
      path,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  }

  const response = await fetch(`${API}${path}`, {
    method,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...authHeaders() },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as unknown;
    throw new Error(apiErrorMessage(body) || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function authHeaders(): Record<string, string> {
  const token = readControlUiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function readControlUiToken() {
  return readControlUiTokenFrom(
    [window.sessionStorage, window.localStorage],
    window.location.host,
  );
}

export function readControlUiTokenFrom(
  stores: Array<Pick<Storage, "length" | "key" | "getItem">>,
  host: string,
) {
  const scopedPrefix = "openclaw.control.token.v1:";
  for (const store of stores) {
    const matchingKeys = Array.from({ length: store.length }, (_, index) => store.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(scopedPrefix)));
    const scopedKey = matchingKeys.find((key) => key.includes(host))
      ?? (matchingKeys.length === 1 ? matchingKeys[0] : undefined);
    const raw = (scopedKey ? store.getItem(scopedKey) : null)
      ?? store.getItem("openclaw.control.token.v1");
    const token = parseStoredToken(raw);
    if (token) return token;
  }
  return "";
}

function parseStoredToken(raw: string | null) {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["token", "value", "gatewayToken"]) if (typeof record[key] === "string") return record[key] as string;
    }
  } catch {
    return raw;
  }
  return "";
}

function apiErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "";
}
