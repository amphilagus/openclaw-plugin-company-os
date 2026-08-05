import { describe, expect, it, vi } from "vitest";

import { createCompanyOsGatewayHandler } from "../src/rpc.js";

describe("Company OS Gateway bridge", () => {
  it("serves Boss API data through an authenticated Gateway method", async () => {
    const snapshot = { generatedAt: "now", tasks: [] };
    const handler = createCompanyOsGatewayHandler({
      getService: () => ({ store: { bossSnapshot: () => snapshot } }) as any,
    });
    const respond = vi.fn();

    await handler({ params: { method: "GET", path: "/snapshot" }, respond } as any);

    expect(respond).toHaveBeenCalledWith(true, snapshot);
  });

  it("initializes and advances the event cursor without exposing SSE auth", async () => {
    const waitForEventsAfter = vi.fn().mockResolvedValue([{ id: 13 }]);
    const service = { latestEventId: () => 11, waitForEventsAfter };
    const handler = createCompanyOsGatewayHandler({ getService: () => service as any });
    const initial = vi.fn();
    const changed = vi.fn();

    await handler({ params: { method: "GET", path: "/events" }, respond: initial } as any);
    await handler({ params: { method: "GET", path: "/events", lastEventId: 11 }, respond: changed } as any);

    expect(initial).toHaveBeenCalledWith(true, { changed: false, lastEventId: 11 });
    expect(waitForEventsAfter).toHaveBeenCalledWith(11, 20_000);
    expect(changed).toHaveBeenCalledWith(true, { changed: true, lastEventId: 13 });
  });

  it("returns a member avatar through the authenticated bridge", async () => {
    const identity = { id: "main", name: "架构师", title: "首席架构师", emoji: "⚙️", avatarUrl: "data:image/png;base64,aW1hZ2U=" };
    const handler = createCompanyOsGatewayHandler({
      getService: () => ({ store: {}, memberIdentity: () => identity }) as any,
    });
    const respond = vi.fn();

    await handler({ params: { method: "GET", path: "/identities/main" }, respond } as any);

    expect(respond).toHaveBeenCalledWith(true, identity);
  });
});
