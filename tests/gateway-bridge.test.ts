import { describe, expect, it, vi } from "vitest";

import { findControlUiGatewayClient } from "../web/src/gateway-bridge";

describe("Control UI Gateway bridge", () => {
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
