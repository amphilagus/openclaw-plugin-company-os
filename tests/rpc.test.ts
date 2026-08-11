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

  it("returns root-task image content only through the authenticated attachment endpoint", async () => {
    const attachment = { id: "image-1", taskId: "task-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const readTaskImageAttachment = vi.fn(() => attachment);
    const handler = createCompanyOsGatewayHandler({
      getService: () => ({ store: { readTaskImageAttachment } }) as any,
    });
    const respond = vi.fn();

    await handler({ params: { method: "GET", path: "/tasks/task-1/attachments/image-1" }, respond } as any);

    expect(readTaskImageAttachment).toHaveBeenCalledWith("boss", "task-1", "image-1");
    expect(respond).toHaveBeenCalledWith(true, attachment);
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

  it("routes dedicated-entry retry, host summary request, and Boss direct end", async () => {
    const summaryAdvance = { hostDispatchId: "host-summary-1" };
    const completion = { meeting: { status: "completed", summary: "Boss 最终总结" }, advance: {} };
    const store = {
      retryMeetingEntry: vi.fn(() => ({ id: "meeting-1", entryState: "notifying" })),
      requestMeetingSummaryByBoss: vi.fn(() => summaryAdvance),
      endMeetingByBoss: vi.fn(() => completion),
      meetingView: vi.fn(() => ({ id: "meeting-1", controlState: "host_summary" })),
    };
    const service = { store, kickMeetingEntryRetry: vi.fn(), dispatchAdvance: vi.fn(async () => undefined) } as any;

    const retried = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-1/entry/retry", body: {} });
    const summary = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-1/request-summary", body: {} });
    const ended = await executeBossApi(service, { method: "POST", path: "/meetings/meeting-1/end", body: { summary: "Boss 最终总结", publishNotice: true } });

    expect(retried.data).toMatchObject({ entryState: "notifying" });
    expect(summary.data).toMatchObject({ controlState: "host_summary" });
    expect(ended.data).toBe(completion);
    expect(service.kickMeetingEntryRetry).toHaveBeenCalledOnce();
    expect(store.endMeetingByBoss).toHaveBeenCalledWith("meeting-1", "Boss 最终总结", true);
    expect(service.dispatchAdvance).toHaveBeenNthCalledWith(1, summaryAdvance);
    expect(service.dispatchAdvance).toHaveBeenNthCalledWith(2, completion.advance);
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

  it("routes the Boss root-task failure decision through the same review endpoint", async () => {
    const task = { id: "task-1", status: "failed", failedReason: "反复整改仍不合格" };
    const reviewTask = vi.fn(() => task);

    const result = await executeBossApi({ store: {}, reviewTask } as any, {
      method: "POST",
      path: "/tasks/task-1/review",
      body: { decision: "fail", feedback: "反复整改仍不合格" },
    });

    expect(result).toEqual({ status: 200, data: task });
    expect(reviewTask).toHaveBeenCalledWith("boss", "task-1", "fail", "反复整改仍不合格");
  });
});
