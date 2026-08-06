import { jsonResult, type AnyAgentTool, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type, type TSchema } from "typebox";

import type { CompanyOsService } from "./service.js";

export const COMPANY_TOOL_NAMES = [
  "company_inbox",
  "company_org_list",
  "company_org_add",
  "company_org_update",
  "company_org_deactivate",
  "company_notice_list",
  "company_notice_read",
  "company_notice_publish",
  "company_meeting_request",
  "company_meeting_list",
  "company_meeting_status",
  "company_meeting_speak",
  "company_meeting_delegate",
  "company_meeting_set_task_drafts",
  "company_meeting_end",
  "company_meeting_cancel",
  "company_task_list",
  "company_task_read",
  "company_task_create",
  "company_task_start",
  "company_task_progress",
  "company_task_revise",
  "company_task_block",
  "company_task_unblock",
  "company_task_submit",
  "company_task_review",
  "company_task_reassign",
  "company_task_cancel",
] as const;

type ToolName = (typeof COMPANY_TOOL_NAMES)[number];
type Params = Record<string, any>;

const Empty = Type.Object({}, { additionalProperties: false });
const Id = Type.String({ minLength: 1 });
const Reason = Type.String({ minLength: 1 });
const TaskId = Type.Object({ taskId: Id }, { additionalProperties: false });
const MeetingId = Type.Object({ meetingId: Id }, { additionalProperties: false });
const OptionalMeetingId = Type.Object({ meetingId: Type.Optional(Id) }, { additionalProperties: false });
const TaskFields = {
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  acceptanceCriteria: Type.String({ minLength: 1 }),
};
const Participant = Type.Object({
  agentId: Id,
  role: Type.Union([Type.Literal("worker"), Type.Literal("advisor")]),
}, { additionalProperties: false });
const TaskDraft = Type.Object({ ...TaskFields, assigneeId: Id }, { additionalProperties: false });
const Evidence = Type.Object({
  type: Type.Union([Type.Literal("proof"), Type.Literal("artifact")]),
  label: Type.String({ minLength: 1 }),
  note: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.Optional(Type.String({ minLength: 1 })),
  url: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export function createCompanyOsTools(options: {
  getService: () => CompanyOsService;
  toolContext: OpenClawPluginToolContext;
}): AnyAgentTool[] {
  const service = lazyObject(options.getService);
  const store = lazyObject(() => service.store);
  const actorId = () => store.requireAgentMember(requireAgentId(options.toolContext)).id as string;
  const tools: AnyAgentTool[] = [
    tool("company_inbox", "公司收件箱", "查看与你有关的新任务、验收、风险、未读公告和会议；读取不会自动标记已读。", Empty,
      async () => store.inbox(actorId())),
    tool("company_org_list", "组织架构", "查看公司成员、职位、直属上级、层级和在职状态。", Type.Object({
      includeInactive: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p) => store.listMembers(Boolean(p.includeInactive))),
    tool("company_org_add", "新增员工", "仅配置的组织架构师可新增员工；Agent ID 必须已存在于 OpenClaw 配置。", Type.Object({
      agentId: Id, name: Id, title: Id, managerId: Id,
    }, { additionalProperties: false }), async (p) => store.addMember(actorId(), p as any)),
    tool("company_org_update", "更新员工", "仅配置的组织架构师可更新姓名、职位或直属上级。", Type.Object({
      memberId: Id,
      name: Type.Optional(Id),
      title: Type.Optional(Id),
      managerId: Type.Optional(Id),
      reason: Reason,
    }, { additionalProperties: false }), async (p) => store.updateMember(actorId(), p.memberId, p, p.reason)),
    tool("company_org_deactivate", "停用员工", "仅配置的组织架构师可停用没有活动工作和直属下属的员工。", Type.Object({
      memberId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.deactivateMember(actorId(), p.memberId, p.reason)),

    tool("company_notice_list", "公告列表", "查看告示板公告、更正关系和自己的阅读状态。", Type.Object({
      effectiveOnly: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p) => store.listNotices(actorId(), { effectiveOnly: Boolean(p.effectiveOnly) })),
    tool("company_notice_read", "阅读公告", "读取公告并写入自己的 read mark。", Type.Object({ noticeId: Id }, { additionalProperties: false }),
      async (p) => store.readNotice(actorId(), p.noticeId)),
    tool("company_notice_publish", "发布公告", "Boss、组织架构师或当前拥有直属下属的管理者可发布不可变公告；更正需指向旧公告。", Type.Object({
      title: Id,
      body: Id,
      supersedesNoticeId: Type.Optional(Id),
    }, { additionalProperties: false }), async (p) => store.publishNotice(actorId(), p as any)),

    tool("company_meeting_request", "申请会议", "申请任务会议或普通讨论会；bossParticipates=true 时会议进入会议室后必须等待 Boss 从 WebUI 开始和批准结束。", Type.Object({
      type: Type.Union([Type.Literal("task"), Type.Literal("discussion")]),
      title: Id,
      agenda: Id,
      parentTaskId: Type.Optional(Id),
      participants: Type.Optional(Type.Array(Participant)),
      bossParticipates: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p) => {
      const result = store.requestMeeting(actorId(), p as any);
      await service.dispatchAdvance(result.advance);
      return result.meeting;
    }),
    tool("company_meeting_list", "会议列表", "查看与你有关的排队、活动和历史会议。", Empty,
      async () => store.listMeetings(actorId())),
    tool("company_meeting_status", "会议状态", "查看会议对话、当前发言者、参会角色和任务草案；省略 ID 时读取当前活动会议。", OptionalMeetingId,
      async (p) => {
        const actor = actorId();
        const meetingId = p.meetingId ?? store.activeMeetingId(actor);
        const meeting = store.meetingView(meetingId, actor);
        store.acknowledgeHostContext(meetingId, actor);
        return meeting;
      }),
    terminatingTool("company_meeting_speak", "会议发言", "在当前活动会议中提交发言；系统自动识别会议和当前轮次。", Type.Object({
      body: Id,
    }, { additionalProperties: false }), async (p, toolCallId) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      const turnId = store.meetingView(meetingId, actor).currentTurn?.id;
      const sessionIdentity = meetingToolSession(options.toolContext, toolCallId);
      store.speakMeeting(actor, meetingId, p.body, turnId, sessionIdentity);
      service.scheduleSessionContextAppendAfterTurn(sessionIdentity);
      return { accepted: true, receipt: "成功，本轮会话结束" };
    }),
    terminatingTool("company_meeting_delegate", "会议点名", "在当前活动会议中点名下一位发言者；系统自动识别会议。", Type.Object({
      speakerId: Id, prompt: Id,
    }, { additionalProperties: false }), async (p, toolCallId) => {
      const actor = actorId();
      const sessionIdentity = meetingToolSession(options.toolContext, toolCallId);
      await service.delegateMeeting(
        actor,
        store.activeMeetingId(actor),
        p.speakerId,
        p.prompt,
        sessionIdentity,
      );
      service.scheduleSessionContextAppendAfterTurn(sessionIdentity);
      return { accepted: true, receipt: "成功，本轮会话结束" };
    }),
    tool("company_meeting_set_task_drafts", "会议任务草案", "为当前任务会议整体替换子任务草案；每个 worker 结束前必须至少得到一项。", Type.Object({
      drafts: Type.Array(TaskDraft),
    }, { additionalProperties: false }), async (p) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      const meeting = store.setMeetingTaskDrafts(actor, meetingId, p.drafts);
      store.acknowledgeHostContext(meetingId, actor);
      return meeting;
    }),
    tool("company_meeting_end", "申请结束会议", "申请结束当前活动会议；未邀请 Boss 时倒计时自动结束，Boss 直接参会时由 Boss 在 WebUI 决定。", Type.Object({
      summary: Id,
      publishNotice: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      const result = store.endMeeting(actor, meetingId, p.summary, Boolean(p.publishNotice));
      store.acknowledgeHostContext(meetingId, actor);
      await service.dispatchAdvance(result.advance);
      return result;
    }),
    tool("company_meeting_cancel", "取消排队会议", "主持人或申请人可带原因取消自己的排队会议，不能中断活动会议。", Type.Object({
      meetingId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => {
      const meeting = store.cancelMeeting(actorId(), p.meetingId, p.reason);
      await service.dispatchAdvance({});
      return meeting;
    }),

    tool("company_task_list", "任务列表", "查看你的责任树中的多级任务、子任务计数和阻塞/停滞风险。", Empty,
      async () => store.listTasks(actorId())),
    tool("company_task_read", "读取任务", "读取任务详情、版本、进度、proof 和审计，并确认已看到当前版本。", TaskId,
      async (p) => store.readTask(actorId(), p.taskId)),
    tool("company_task_create", "创建子任务", "父任务负责人向自己的直属下属创建一个直接子任务；Agent 不能创建根任务。", Type.Object({
      parentId: Id, assigneeId: Id, ...TaskFields,
    }, { additionalProperties: false }), async (p) => store.createChildTask(actorId(), p as any)),
    tool("company_task_start", "开始任务", "负责人将 assigned 任务转为 in_progress。", TaskId,
      async (p) => store.startTask(actorId(), p.taskId)),
    tool("company_task_progress", "任务进度", "负责人记录进度并刷新任务活动时间。", Type.Object({
      taskId: Id, body: Id,
    }, { additionalProperties: false }), async (p) => store.addTaskProgress(actorId(), p.taskId, p.body)),
    tool("company_task_revise", "修订任务", "派发者带原因版本化修订未关闭、非 review 任务。", Type.Object({
      taskId: Id,
      title: Type.Optional(Id),
      description: Type.Optional(Id),
      acceptanceCriteria: Type.Optional(Id),
      reason: Reason,
    }, { additionalProperties: false }), async (p) => store.reviseTask(actorId(), p.taskId, p, p.reason)),
    tool("company_task_block", "报告阻塞", "负责人报告任务阻塞；父任务只显示风险，不自动变更状态。", Type.Object({
      taskId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.blockTask(actorId(), p.taskId, p.reason)),
    tool("company_task_unblock", "解除阻塞", "负责人或派发者解除阻塞并回到 in_progress。", Type.Object({
      taskId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.unblockTask(actorId(), p.taskId, p.reason)),
    tool("company_task_submit", "提交验收", "负责人提交摘要和至少一项 proof/artifact；所有直接子任务必须先终结。", Type.Object({
      taskId: Id, summary: Id, evidence: Type.Array(Evidence, { minItems: 1 }),
    }, { additionalProperties: false }), async (p) => store.submitTask(actorId(), p.taskId, p.summary, p.evidence)),
    tool("company_task_review", "任务验收", "派发者验收关闭或带反馈驳回任务。", Type.Object({
      taskId: Id,
      decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
      feedback: Type.Optional(Type.String()),
    }, { additionalProperties: false }), async (p) => service.reviewTask(actorId(), p.taskId, p.decision, p.feedback)),
    tool("company_task_reassign", "重派任务", "派发者带原因重派给自己的另一名直属下属。", Type.Object({
      taskId: Id, assigneeId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.reassignTask(actorId(), p.taskId, p.assigneeId, p.reason)),
    tool("company_task_cancel", "取消任务", "派发者带原因取消任务；存在活动子任务时拒绝，永不级联。", Type.Object({
      taskId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.cancelTask(actorId(), p.taskId, p.reason)),
  ];
  return tools;
}

function tool(name: ToolName, label: string, description: string, parameters: TSchema, execute: (params: Params) => Promise<unknown> | unknown): AnyAgentTool {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId: string, rawParams: unknown) => jsonResult(await execute((rawParams ?? {}) as Params)),
  };
}

function terminatingTool(
  name: "company_meeting_speak" | "company_meeting_delegate",
  label: string,
  description: string,
  parameters: TSchema,
  execute: (params: Params, toolCallId: string) => Promise<unknown> | unknown,
): AnyAgentTool {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: "sequential",
    execute: async (toolCallId: string, rawParams: unknown) => ({
      ...jsonResult(await execute((rawParams ?? {}) as Params, toolCallId)),
      terminate: true,
    }),
  };
}

function requireAgentId(context: OpenClawPluginToolContext) {
  const agentId = context.agentId?.trim();
  if (!agentId) throw new Error("OpenClaw toolContext.agentId is required");
  return agentId;
}

function meetingToolSession(context: OpenClawPluginToolContext, toolCallId: string) {
  const agentId = requireAgentId(context);
  const sessionKey = context.sessionKey?.trim();
  const sessionId = context.sessionId?.trim();
  if (!sessionKey || !sessionId) throw new Error("meeting tools require a trusted OpenClaw main-session identity");
  return { agentId, sessionKey, sessionId, toolCallId };
}

function lazyObject<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = resolve();
      const value = target[property as keyof T];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
