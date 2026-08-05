import type { CompanyOsService } from "./service.js";

export type BossApiRequest = {
  method: string;
  path: string;
  body?: unknown;
};

export type BossApiResult = {
  status: number;
  data: unknown;
};

export async function executeBossApi(service: CompanyOsService, request: BossApiRequest): Promise<BossApiResult> {
  const store = service.store;
  const method = request.method.toUpperCase();
  const route = request.path || "/";
  const body = asBody(request.body);

  if (method === "GET" && route === "/snapshot") {
    return { status: 200, data: store.bossSnapshot() };
  }

  const identityDetail = route.match(/^\/identities\/([^/]+)$/);
  if (method === "GET" && identityDetail) {
    return { status: 200, data: service.memberIdentity(decodeURIComponent(identityDetail[1]!)) };
  }

  const taskDetail = route.match(/^\/tasks\/([^/]+)$/);
  if (method === "GET" && taskDetail) {
    return { status: 200, data: store.readTask("boss", decodeURIComponent(taskDetail[1]!), false) };
  }

  const meetingDetail = route.match(/^\/meetings\/([^/]+)$/);
  if (method === "GET" && meetingDetail) {
    return { status: 200, data: store.meetingView(decodeURIComponent(meetingDetail[1]!)) };
  }

  if (method === "POST" && route === "/tasks") {
    return { status: 201, data: store.createRootTask(body as any) };
  }

  if (method === "POST" && route === "/notices") {
    return { status: 201, data: store.publishNotice("boss", body as any) };
  }

  const noticeAction = route.match(/^\/notices\/([^/]+)$/);
  if (method === "DELETE" && noticeAction) {
    store.deleteNotice("boss", decodeURIComponent(noticeAction[1]!));
    return { status: 200, data: { ok: true } };
  }

  if (method === "POST" && route === "/meetings") {
    const result = store.requestMeeting("boss", body as any);
    await service.dispatchAdvance(result.advance);
    return { status: 201, data: result.meeting };
  }

  const taskAction = route.match(/^\/tasks\/([^/]+)\/(review|revise|reassign|cancel|unblock)$/);
  if (method === "POST" && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]!);
    const action = taskAction[2]!;
    const data = action === "review"
      ? store.reviewTask("boss", taskId, body.decision, body.feedback)
      : action === "revise"
        ? store.reviseTask("boss", taskId, body, body.reason)
        : action === "reassign"
          ? store.reassignTask("boss", taskId, body.assigneeId, body.reason)
          : action === "cancel"
            ? store.cancelTask("boss", taskId, body.reason)
            : store.unblockTask("boss", taskId, body.reason);
    return { status: 200, data };
  }

  const meetingAction = route.match(/^\/meetings\/([^/]+)\/(interject|reorder|cancel|start|approve-end|reject-end)$/);
  if (method === "POST" && meetingAction) {
    const meetingId = decodeURIComponent(meetingAction[1]!);
    const action = meetingAction[2]!;
    if (action === "interject") {
      const advance = store.bossInterject(meetingId, body.body, body.targetId);
      await service.dispatchAdvance(advance);
      return { status: 200, data: store.meetingView(meetingId) };
    }
    if (action === "reorder") {
      return { status: 200, data: store.reorderMeeting(meetingId, Number(body.targetPosition)) };
    }
    if (action === "start") {
      const advance = store.startMeetingByBoss(meetingId);
      await service.dispatchAdvance(advance);
      return { status: 200, data: store.meetingView(meetingId) };
    }
    if (action === "approve-end") {
      const result = store.approveMeetingEndByBoss(meetingId);
      await service.dispatchAdvance(result.advance);
      return { status: 200, data: result };
    }
    if (action === "reject-end") {
      const advance = store.rejectMeetingEndByBoss(meetingId, body.feedback);
      await service.dispatchAdvance(advance);
      return { status: 200, data: store.meetingView(meetingId) };
    }
    return { status: 200, data: store.cancelMeeting("boss", meetingId, body.reason) };
  }

  throw new Error("Company OS API route not found");
}

function asBody(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
