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
  "company_meeting_yield_to_boss",
  "company_meeting_submit_summary",
  "company_meeting_end",
  "company_meeting_cancel",
  "company_task_list",
  "company_task_read",
  "company_task_create",
  "company_task_flow_update",
  "company_task_start",
  "company_task_progress",
  "company_task_revise",
  "company_task_block",
  "company_task_unblock",
  "company_task_submit",
  "company_task_review",
  "company_task_reassign",
  "company_task_cancel",
  "company_task_correct",
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
const TaskFlowStage = Type.Object({
  name: Id,
  objective: Id,
  tasks: Type.Array(TaskDraft, { minItems: 1 }),
}, { additionalProperties: false });
const Evidence = Type.Union([
  Type.Object({
    type: Type.Literal("proof"),
    label: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String({ minLength: 1 })),
    command: Type.Optional(Type.String({ minLength: 1 })),
    url: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("artifact"),
    label: Type.String({ minLength: 1 }),
    path: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
]);
const GitLocation = Type.Object({
  remoteUrl: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
  commit: Type.String({ pattern: "^[0-9A-Fa-f]{40}$" }),
}, { additionalProperties: false });
const ReviewHandoff = Type.Object({
  functionalVerification: Type.Object({
    workingDirectory: Id,
    command: Id,
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const ReviewReport = Type.Object({
  checks: Type.Array(Type.Object({
    criterion: Id,
    outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    evidenceIndexes: Type.Array(Type.Integer({ minimum: 0 })),
    finding: Id,
    remediation: Type.Optional(Id),
  }, { additionalProperties: false }), { minItems: 1 }),
  conclusion: Id,
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

    tool("company_meeting_request", "申请会议", "申请任务会议或普通讨论会；bossParticipates=true 时会议进入会议室后必须等待 Boss 从 WebUI 开始，且只有 Boss 可以结束。", Type.Object({
      type: Type.Union([Type.Literal("task"), Type.Literal("discussion")]),
      title: Id,
      agenda: Id,
      parentTaskId: Type.Optional(Id),
      participants: Type.Optional(Type.Array(Participant)),
      bossParticipates: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p, toolCallId) => {
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
    terminatingTool("company_meeting_speak", "会议发言", "在当前活动会议中提交结论先行、聚焦当前问题的简练发言；默认使用结论、最多三条关键依据和明确下一步，系统自动识别会议和当前轮次。", Type.Object({
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
    terminatingTool("company_meeting_delegate", "会议点名", "在当前活动会议中点名下一位发言者；一次只提出一个需要决策或核验的明确问题，避免宽泛发挥，系统自动识别会议。", Type.Object({
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
    tool("company_meeting_set_task_drafts", "会议任务流草案", "为当前任务会议整体替换分阶段任务流草案；阶段内并行、阶段间顺序执行，每个 worker 结束前必须至少得到一项。", Type.Object({
      stages: Type.Array(TaskFlowStage, { minItems: 1 }),
    }, { additionalProperties: false }), async (p, toolCallId) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      const meeting = store.setMeetingTaskDrafts(actor, meetingId, p.stages, meetingToolSession(options.toolContext, toolCallId));
      store.acknowledgeHostContext(meetingId, actor);
      return meeting;
    }),
    terminatingTool("company_meeting_yield_to_boss", "让渡给 Boss", "Boss 参会且主持人没有更多内容需要推进时，将会议稳定交给 Boss 决策；会议不会自动结束。", Empty,
      async (_p, toolCallId) => {
        const actor = actorId();
        const meetingId = store.activeMeetingId(actor);
        store.yieldMeetingToBoss(actor, meetingId, meetingToolSession(options.toolContext, toolCallId));
        return { accepted: true, receipt: "控制权已交给 Boss，会议保持等待" };
      }),
    terminatingTool("company_meeting_submit_summary", "提交主持人总结", "仅在 Boss 要求总结时提交一版主持人总结；提交后控制权回到 Boss，但会议不会结束。", Type.Object({
      summary: Id,
    }, { additionalProperties: false }), async (p, toolCallId) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      store.submitMeetingSummary(actor, meetingId, p.summary, meetingToolSession(options.toolContext, toolCallId));
      return { accepted: true, receipt: "主持人总结已提交，会议等待 Boss 决策" };
    }),
    tool("company_meeting_end", "结束普通会议", "仅用于 Boss 未参会的活动会议；Boss 直接参会时只有 Boss WebUI 可以结束，主持人不能申请。", Type.Object({
      summary: Id,
      publishNotice: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), async (p, toolCallId) => {
      const actor = actorId();
      const meetingId = store.activeMeetingId(actor);
      const result = store.endMeeting(actor, meetingId, p.summary, Boolean(p.publishNotice), meetingToolSession(options.toolContext, toolCallId));
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
    tool("company_task_read", "读取任务", "读取任务详情、版本、进度、proof、冻结的 Git 远端定位和审计，并确认已看到当前版本。", TaskId,
      async (p) => store.readTask(actorId(), p.taskId)),
    tool("company_task_create", "创建任务流", "父任务负责人向直属下属原子创建完整分阶段任务流；阶段内并行、阶段间顺序激活。", Type.Object({
      parentId: Id,
      stages: Type.Array(TaskFlowStage, { minItems: 1 }),
    }, { additionalProperties: false }), async (p) => store.createTaskFlow(actorId(), p as any)),
    tool("company_task_flow_update", "更新任务流", "按 revision 追加未来阶段，或原子替换所有从未激活的等待阶段；活动、冻结和完成阶段不可改结构。", Type.Object({
      parentId: Id,
      expectedRevision: Type.Integer({ minimum: 1 }),
      operation: Type.Union([Type.Literal("append"), Type.Literal("replace_waiting")]),
      stages: Type.Array(TaskFlowStage),
      reason: Reason,
    }, { additionalProperties: false }), async (p) => store.updateTaskFlow(actorId(), p as any)),
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
    }, { additionalProperties: false }), async (p) => service.blockTask(actorId(), p.taskId, p.reason)),
    tool("company_task_unblock", "解除阻塞", "负责人或派发者解除阻塞并回到 in_progress。", Type.Object({
      taskId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => service.unblockTask(actorId(), p.taskId, p.reason)),
    tool("company_task_submit", "提交验收", "负责人完成本人可执行交付后，提交摘要、至少一项 proof/artifact 和已推送且通过远端校验的 Git 分支定位。每个 artifact.path 必须指向本人 workspace 内的真实文件，系统会自动冻结并随根任务 Boss 邮件发送，或投递到子任务派发者 workspace；相对路径按 workspace 解析，例如 projects/<repo>/docs/report.md。最多 5 个文件、合计 15 MB，更多文件或目录请先打包。可选 reviewHandoff 仅用于生成一行功能验收命令。不得仅在摘要中声称已附材料。", Type.Object({
      taskId: Id,
      summary: Id,
      evidence: Type.Array(Evidence, { minItems: 1 }),
      gitLocation: GitLocation,
      reviewHandoff: Type.Optional(ReviewHandoff),
    }, { additionalProperties: false }), async (p) => service.submitTask(actorId(), p.taskId, p.summary, p.evidence, p.gitLocation, p.reviewHandoff)),
    tool("company_task_review", "任务验收", "派发者读取当前提交后逐项核验证据，并用结构化报告批准或驳回任务。", Type.Object({
      taskId: Id,
      decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
      feedback: Type.Optional(Type.String()),
      reviewReport: ReviewReport,
    }, { additionalProperties: false }), async (p) => service.reviewTask(actorId(), p.taskId, p.decision, p.feedback, p.reviewReport)),
    tool("company_task_reassign", "重派任务", "派发者带原因重派给自己的另一名直属下属。", Type.Object({
      taskId: Id, assigneeId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => store.reassignTask(actorId(), p.taskId, p.assigneeId, p.reason)),
    tool("company_task_cancel", "取消任务", "派发者带原因取消任务；blocked 任务会创建 Boss 审批申请，其他任务直接取消；存在活动子任务时拒绝。", Type.Object({
      taskId: Id, reason: Reason,
    }, { additionalProperties: false }), async (p) => service.cancelTask(actorId(), p.taskId, p.reason)),
    tool("company_task_correct", "任务终态纠错", "原验收人可二次审查不通过自己的已关闭任务，原取消人可恢复自己的已取消任务；Boss 可纠正任意层级。", Type.Object({
      taskId: Id,
      action: Type.Union([Type.Literal("revoke_acceptance"), Type.Literal("restore_cancellation")]),
      reason: Reason,
      reviewReport: Type.Optional(ReviewReport),
    }, { additionalProperties: false }), async (p) => service.correctTaskTerminalDecision(
      actorId(), p.taskId, p.action, p.reason, p.reviewReport,
    )),
  ];
  return tools;
}

function tool(name: ToolName, label: string, description: string, parameters: TSchema, execute: (params: Params, toolCallId: string) => Promise<unknown> | unknown): AnyAgentTool {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (toolCallId: string, rawParams: unknown) => jsonResult(await execute((rawParams ?? {}) as Params, toolCallId)),
  };
}

function terminatingTool(
  name: "company_meeting_speak" | "company_meeting_delegate" | "company_meeting_yield_to_boss" | "company_meeting_submit_summary",
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
  if (!sessionKey || !sessionId) throw new Error("meeting write tools require a trusted OpenClaw session identity");
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
