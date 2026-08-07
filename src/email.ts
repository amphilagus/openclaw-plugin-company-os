import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import nodemailer, { type Transporter } from "nodemailer";

import type { EvidenceInput, ResolvedCompanyOsConfig, VerifiedGitLocation } from "./types.js";

export type MeetingEmailKind = "created" | "room_entered";

export type MeetingEmailNotification = {
  id: string;
  meetingId: string;
  kind: MeetingEmailKind;
  title: string;
  agenda: string;
  type: "task" | "discussion";
  hostId: string;
  hostName: string;
  createdAt: string;
  startedAt: string | null;
};

export type TaskCheckinEmailItem = {
  taskId: string;
  title: string;
  assigneeId: string;
  assigneeName: string;
  status: string;
  submittedAt: string | null;
  lastActivityAt: string;
  blocked: boolean;
  stale: boolean;
  blockedDescendants: number;
  staleDescendants: number;
};

export type TaskCheckinEmailNotification = {
  id: string;
  kind: "task_checkin";
  runId: string;
  scheduledAt: string;
  reviews: TaskCheckinEmailItem[];
  anomalies: TaskCheckinEmailItem[];
};

export type TaskReviewEmailNotification = {
  id: string;
  kind: "task_review_requested";
  taskId: string;
  submissionId: string;
  title: string;
  acceptanceCriteria: string;
  assigneeId: string;
  assigneeName: string;
  submittedAt: string;
  summary: string;
  evidence: EvidenceInput[];
  gitLocation: VerifiedGitLocation;
};

export type BossTaskActionEmailNotification = {
  id: string;
  kind: "task_block_escalated" | "task_cancel_requested";
  taskId: string;
  title: string;
  assigneeId: string;
  assigneeName: string;
  issuerId: string;
  createdAt: string;
  reason: string;
  blockedReason: string | null;
  sourceId: string;
  requesterId?: string;
  parentTaskId?: string | null;
  parentTitle?: string | null;
};

export type BossEmailNotification = MeetingEmailNotification | TaskCheckinEmailNotification | TaskReviewEmailNotification | BossTaskActionEmailNotification;

export type MeetingEmailSender = {
  send(notification: BossEmailNotification): Promise<void>;
};

type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
  user: string;
  password: string;
  from: string;
  recipient: string;
};

const SMTP_PRESETS: Record<string, Pick<SmtpSettings, "host" | "port" | "secure">> = {
  qq: { host: "smtp.qq.com", port: 587, secure: false },
  "exmail.qq": { host: "smtp.exmail.qq.com", port: 465, secure: true },
};

export class SmtpMeetingEmailSender implements MeetingEmailSender {
  private readonly notificationConfig: ResolvedCompanyOsConfig["bossEmailNotifications"];
  private transporter?: Transporter;
  private settings?: SmtpSettings;

  constructor(config: ResolvedCompanyOsConfig["bossEmailNotifications"]) {
    this.notificationConfig = config;
  }

  async send(notification: BossEmailNotification) {
    if (!this.notificationConfig.enabled) return;
    const settings = this.settings ??= loadSmtpSettings(this.notificationConfig);
    const transporter = this.transporter ??= nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      tls: { rejectUnauthorized: settings.rejectUnauthorized },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    if (notification.kind === "task_checkin") {
      await transporter.sendMail({
        from: settings.from,
        to: settings.recipient,
        subject: `[Company OS] 任务整点巡检：待验收 ${notification.reviews.length} · 异常 ${notification.anomalies.length}`,
        text: buildTaskCheckinEmailText(notification),
      });
      return;
    }
    if (notification.kind === "task_review_requested") {
      await transporter.sendMail({
        from: settings.from,
        to: settings.recipient,
        subject: `[Company OS] 根任务待验收：${notification.title}`,
        text: buildTaskReviewEmailText(notification),
      });
      return;
    }
    if (notification.kind === "task_block_escalated" || notification.kind === "task_cancel_requested") {
      const block = notification.kind === "task_block_escalated";
      await transporter.sendMail({
        from: settings.from,
        to: settings.recipient,
        subject: block
          ? `[Company OS] 根任务阻塞升级：${notification.title}`
          : `[Company OS] blocked 任务取消申请：${notification.title}`,
        text: buildBossTaskActionEmailText(notification),
      });
      return;
    }
    if (notification.kind !== "created" && notification.kind !== "room_entered") return;
    const entered = notification.kind === "room_entered";
    const eventTime = entered ? notification.startedAt ?? notification.createdAt : notification.createdAt;
    await transporter.sendMail({
      from: settings.from,
      to: settings.recipient,
      subject: entered
        ? `[Company OS] 会议已进入会议室：${notification.title}`
        : `[Company OS] 会议已创建：${notification.title}`,
      text: [
        entered
          ? "这场需要 Boss 直接参与的会议已经进入会议室，所有参会者正在等待你进入 WebUI 并点击“开始会议”。"
          : "一场需要 Boss 直接参与的会议已经创建。",
        "",
        `会议：${notification.title}`,
        `类型：${notification.type === "task" ? "任务会议" : "普通讨论会"}`,
        `主持人：${notification.hostName} (${notification.hostId})`,
        `会议 ID：${notification.meetingId}`,
        `时间：${formatShanghaiTime(eventTime)}`,
        "",
        "议程：",
        notification.agenda,
        "",
        entered ? "请打开 OpenClaw 的“公司 → 会议室”页面开始会议。" : "会议进入会议室时，你还会收到第二封提醒邮件。",
      ].join("\n"),
    });
  }
}

export function buildTaskCheckinEmailText(notification: TaskCheckinEmailNotification) {
  const lines = [
    "Company OS 已完成本时段任务巡检。以下事项需要 Boss 处理。",
    "",
    `巡检时间：${formatShanghaiTime(notification.scheduledAt)}`,
  ];
  if (notification.reviews.length > 0) {
    lines.push("", `待验收根任务（${notification.reviews.length}）：`);
    notification.reviews.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.title}`,
        `   任务 ID：${item.taskId}`,
        `   负责人：${item.assigneeName} (${item.assigneeId})`,
        `   提交时间：${formatShanghaiTime(item.submittedAt ?? item.lastActivityAt)}`,
      );
    });
  }
  if (notification.anomalies.length > 0) {
    lines.push("", `异常根任务（${notification.anomalies.length}）：`);
    notification.anomalies.forEach((item, index) => {
      const risks = [
        item.blocked ? "根任务阻塞" : null,
        item.stale ? "根任务停滞" : null,
        item.blockedDescendants ? `阻塞后代 ${item.blockedDescendants}` : null,
        item.staleDescendants ? `停滞后代 ${item.staleDescendants}` : null,
      ].filter(Boolean).join("、");
      lines.push(
        `${index + 1}. ${item.title}`,
        `   任务 ID：${item.taskId}`,
        `   负责人：${item.assigneeName} (${item.assigneeId})`,
        `   异常：${risks}`,
        `   最后活动：${formatShanghaiTime(item.lastActivityAt)}`,
      );
    });
  }
  lines.push("", "请打开 OpenClaw 的“公司 → 任务”页面完成验收或处理异常。");
  return lines.join("\n");
}

export function buildTaskReviewEmailText(notification: TaskReviewEmailNotification) {
  const lines = [
    "一级员工已提交根任务验收，请 Boss 及时审查。",
    "",
    `任务：${notification.title}`,
    `任务 ID：${notification.taskId}`,
    `负责人：${notification.assigneeName} (${notification.assigneeId})`,
    `提交时间：${formatShanghaiTime(notification.submittedAt)}`,
    "",
    "验收标准：",
    notification.acceptanceCriteria,
    "",
    "提交摘要：",
    notification.summary,
    "",
    "Git 远端定位（验收对象）：",
    `远端：${notification.gitLocation.remoteUrl}`,
    `分支：${notification.gitLocation.branch}`,
    `Commit：${notification.gitLocation.commit}`,
    `验证时间：${formatShanghaiTime(notification.gitLocation.verifiedAt)}`,
    "",
    "任务现已进入 review。验收标准中的 Boss 亲测、扫码、真机体验或人工确认，应由 Boss 在本验收阶段执行，不是负责人提交前的前置条件。",
    "",
    `证据（${notification.evidence.length}）：`,
  ];
  notification.evidence.forEach((item, index) => {
    const detail = item.command ?? item.url ?? item.path ?? item.note;
    lines.push(`${index + 1}. [${item.type}] ${item.label}${detail ? ` — ${detail}` : ""}`);
  });
  lines.push("", "请打开 OpenClaw 的“公司 → 任务”页面，批准或驳回该根任务。");
  return lines.join("\n");
}

export function buildBossTaskActionEmailText(notification: BossTaskActionEmailNotification) {
  const block = notification.kind === "task_block_escalated";
  const lines = [
    block ? "一级员工已将根任务阻塞向 Boss 升级。" : "员工已为 blocked 任务提交取消审批申请。",
    "",
    `任务：${notification.title}`,
    `任务 ID：${notification.taskId}`,
    `负责人：${notification.assigneeName} (${notification.assigneeId})`,
    `时间：${formatShanghaiTime(notification.createdAt)}`,
    `原因：${notification.reason}`,
  ];
  if (notification.blockedReason) lines.push(`当前阻塞：${notification.blockedReason}`);
  if (notification.requesterId) lines.push(`申请人：${notification.requesterId}`);
  if (notification.parentTaskId) lines.push(`来源父任务：${notification.parentTitle ?? notification.parentTaskId} (${notification.parentTaskId})`);
  lines.push("", block
    ? "请打开 OpenClaw 的“公司 → 任务”页面协调根任务阻塞。"
    : "请打开 OpenClaw 的“公司 → 任务”页面批准或驳回取消申请。");
  return lines.join("\n");
}

export function loadSmtpSettings(config: ResolvedCompanyOsConfig["bossEmailNotifications"]): SmtpSettings {
  const configPath = resolveConfigPath(config.configPath);
  const values = parseEnv(readFileSync(configPath, "utf8"));
  const prefix = config.account ? `${config.account.toUpperCase()}_` : "";
  const get = (key: string) => values[`${prefix}${key}`] ?? (!prefix ? values[key] : undefined);
  const legacy = !get("USERNAME") && !get("PASSWORD");
  const provider = (get("PROVIDER") ?? "custom").toLowerCase();
  const preset = SMTP_PRESETS[provider];
  const user = required(legacy ? values.SMTP_USER : get("USERNAME"), "SMTP username");
  const password = required(legacy ? values.SMTP_PASS : get("PASSWORD"), "SMTP password");
  const host = required(legacy ? values.SMTP_HOST : get("SMTP_HOST") ?? preset?.host, "SMTP host");
  const port = positiveInteger(legacy ? values.SMTP_PORT : get("SMTP_PORT"), preset?.port ?? 587);
  const secure = booleanValue(legacy ? values.SMTP_SECURE : get("SMTP_SECURE"), preset?.secure ?? false);
  const rejectUnauthorized = booleanValue(
    legacy ? values.SMTP_REJECT_UNAUTHORIZED : get("SMTP_REJECT_UNAUTHORIZED"),
    true,
  );
  const from = (legacy ? values.SMTP_FROM : get("SMTP_FROM"))?.trim() || user;
  const recipient = config.recipient?.trim() || user;
  return { host, port, secure, rejectUnauthorized, user, password, from, recipient };
}

function resolveConfigPath(configured: string | undefined) {
  if (configured?.trim()) {
    const expanded = configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
    if (!existsSync(expanded)) throw new Error(`Boss email config not found: ${expanded}`);
    return expanded;
  }
  const candidates = [
    path.join(os.homedir(), ".config", "mail-skills", ".env"),
    path.join(os.homedir(), ".config", "imap-smtp-email", ".env"),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Boss email config not found in ~/.config/mail-skills/.env");
  return found;
}

function parseEnv(source: string) {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]!] = value.replace(/\\n/g, "\n");
  }
  return result;
}

function required(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is missing from the configured mail account`);
  return normalized;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

function formatShanghaiTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
