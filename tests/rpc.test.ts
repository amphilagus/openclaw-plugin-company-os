import { describe, expect, it, vi } from "vitest";

import { executeBossApi } from "../src/boss-api.js";
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

  it("routes Boss start, meeting rejection, and final end approval through the authenticated API", async () => {
    const startAdvance = { schedule: { agentId: "cto" } };
    const rejection = { meeting: { status: "canceled" }, advance: { activatedMeetingId: "next-after-rejection" } };
    const completion = { meeting: { status: "completed" }, advance: { activatedMeetingId: "next" } };
    const store = {
      startMeetingByBoss: vi.fn(() => startAdvance),
      rejectMeetingByBoss: vi.fn(() => rejection),
      approveMeetingEndByBoss: vi.fn(() => completion),
      meetingView: vi.fn(() => ({ status: "active", awaitingBossStart: false })),
    };
    const dispatchAdvance = vi.fn(async () => undefined);
    const service = { store, dispatchAdvance } as any;

    const started = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-1/start", body: {} });
    const rejected = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-2/reject", body: { reason: "议题不成熟" } });
    const ended = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-1/approve-end", body: {} });

    expect(started.data).toMatchObject({ awaitingBossStart: false });
    expect(rejected.data).toBe(rejection.meeting);
    expect(ended.data).toBe(completion);
    expect(dispatchAdvance).toHaveBeenNthCalledWith(1, startAdvance);
    expect(dispatchAdvance).toHaveBeenNthCalledWith(2, rejection.advance);
    expect(dispatchAdvance).toHaveBeenNthCalledWith(3, completion.advance);
  });

  it("routes Boss task reminders through the persistent dispatcher", async () => {
    const response = { dispatch: { id: "dispatch-1", status: "pending" }, task: { id: "task-1" } };
    const remindTaskByBoss = vi.fn(() => response);

    const result = await executeBossApi({ remindTaskByBoss } as any, {
      method: "POST",
      path: "/tasks/task-1/remind",
      body: {},
    });

    expect(result).toEqual({ status: 202, data: response });
    expect(remindTaskByBoss).toHaveBeenCalledWith("task-1");
  });

  it("routes Boss root review through the service dispatcher", async () => {
    const task = { id: "task-1", status: "closed", reviewNotificationDispatch: { status: "pending" } };
    const reviewTask = vi.fn(() => task);

    const result = await executeBossApi({ store: {}, reviewTask } as any, {
      method: "POST",
      path: "/tasks/task-1/review",
      body: { decision: "accept", feedback: "验收通过" },
    });

    expect(result).toEqual({ status: 200, data: task });
    expect(reviewTask).toHaveBeenCalledWith("boss", "task-1", "accept", "验收通过");
  });
});
