import { describe, expect, it, vi } from "vitest";

import { findControlUiGatewayClient } from "../web/src/gateway-bridge";

describe("Control UI Gateway bridge", () => {
  it.each(["openclaw-app", "openclaw-app-shell"])("reuses the 2026.9 authenticated client from %s", async (tag) => {
    const request = vi.fn().mockResolvedValue({ organization: [] });
    const context = { gateway: { snapshot: { phase: "connected", client: { request } } } };
    const app = tag === "openclaw-app" ? { runtime: { context } } : { context };
    const client = findControlUiGatewayClient({ querySelector: (selector) => selector === tag ? app : null });
    expect(client).not.toBeNull();
    await expect(client!.request("companyOs.api", { method: "GET", path: "/snapshot" })).resolves.toEqual({ organization: [] });
  });

  it.each(["connecting", "disconnected", "error"])("does not use a stale client in phase %s", (phase) => {
    const app = { context: { gateway: { snapshot: { phase, connected: true, client: { request: vi.fn() } } } } };
    expect(findControlUiGatewayClient({ querySelector: () => app })).toBeNull();
  });

  it("reuses the authenticated client exposed by the parent openclaw-app", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const app = { context: { gateway: { snapshot: { connected: true, client: { request } } } } };
    const client = findControlUiGatewayClient({ querySelector: (selector) => selector === "openclaw-app" ? app : null });

    expect(client).not.toBeNull();
    await expect(client!.request("companyOs.api", { method: "GET", path: "/snapshot" })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("companyOs.api", { method: "GET", path: "/snapshot" });
  });

  it("does not use a disconnected or malformed parent client", () => {
    const disconnected = { context: { gateway: { snapshot: { connected: false, client: { request: vi.fn() } } } } };
    expect(findControlUiGatewayClient({ querySelector: () => disconnected })).toBeNull();
    expect(findControlUiGatewayClient({ querySelector: () => null })).toBeNull();
  });
});
