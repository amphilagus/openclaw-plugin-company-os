import type { MeetingDetail, Snapshot, TaskDetail } from "./types";

const API = "/plugins/company-os/api/v1";

export async function getSnapshot() {
  return request<Snapshot>("/snapshot");
}

export async function getMeeting(id: string) {
  return request<MeetingDetail>(`/meetings/${encodeURIComponent(id)}`);
}

export async function getTask(id: string) {
  return request<TaskDetail>(`/tasks/${encodeURIComponent(id)}`);
}

export async function post<T = unknown>(path: string, body: unknown) {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function subscribeToChanges(onChange: () => void, onConnection: (live: boolean) => void) {
  const controller = new AbortController();
  void stream(controller.signal, onChange, onConnection);
  return () => controller.abort();
}

async function stream(signal: AbortSignal, onChange: () => void, onConnection: (live: boolean) => void) {
  let lastEventId = "";
  while (!signal.aborted) {
    try {
      const response = await fetch(`${API}/events`, {
        headers: { ...authHeaders(), ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
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
          if (id) lastEventId = id;
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

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...authHeaders(), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function authHeaders() {
  const token = readControlUiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readControlUiToken() {
  const scopedPrefix = "openclaw.control.token.v1:";
  const matchingKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(scopedPrefix)));
  const scopedKey = matchingKeys.find((key) => key.includes(window.location.host))
    ?? (matchingKeys.length === 1 ? matchingKeys[0] : undefined);
  const raw = (scopedKey ? window.localStorage.getItem(scopedKey) : null)
    ?? window.localStorage.getItem("openclaw.control.token.v1");
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
