export const COMPANY_OS_GATEWAY_METHOD = "companyOs.api";

export type ControlUiGatewayClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

type GatewayHost = {
  context?: unknown;
  runtime?: { context?: unknown };
};

type DocumentLike = {
  querySelector(selector: string): unknown;
};

export function findControlUiGatewayClient(documentLike: DocumentLike): ControlUiGatewayClient | null {
  const hosts = [
    documentLike.querySelector("openclaw-app"),
    documentLike.querySelector("openclaw-app-shell"),
  ] as GatewayHost[];

  for (const host of hosts) {
    const client = clientFromContext(host?.context) ?? clientFromContext(host?.runtime?.context);
    if (client) return client;
  }
  return null;
}

export function getControlUiGatewayClient(): ControlUiGatewayClient | null {
  try {
    if (window.parent === window) return null;
    return findControlUiGatewayClient(window.parent.document);
  } catch {
    return null;
  }
}

function clientFromContext(value: unknown): ControlUiGatewayClient | null {
  if (!isRecord(value)) return null;
  const gateway = value.gateway;
  if (!isRecord(gateway)) return null;
  const snapshot = gateway.snapshot;
  if (!isRecord(snapshot) || snapshot.connected !== true) return null;
  const client = snapshot.client;
  return isRecord(client) && typeof client.request === "function"
    ? client as ControlUiGatewayClient
    : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}
