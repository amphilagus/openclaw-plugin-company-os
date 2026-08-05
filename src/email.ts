import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import nodemailer, { type Transporter } from "nodemailer";

import type { ResolvedCompanyOsConfig } from "./types.js";

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

export type MeetingEmailSender = {
  send(notification: MeetingEmailNotification): Promise<void>;
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

  async send(notification: MeetingEmailNotification) {
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
