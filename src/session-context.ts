import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";

import type { MeetingSessionContextAppend } from "./types.js";

export type SessionContextAppendResult = {
  appended: boolean;
  messageId: string;
};

export interface SessionContextAppender {
  append(record: MeetingSessionContextAppend): Promise<SessionContextAppendResult>;
}

export class OpenClawSessionContextAppender implements SessionContextAppender {
  constructor(private readonly config: unknown) {}

  async append(record: MeetingSessionContextAppend): Promise<SessionContextAppendResult> {
    const message = {
      role: "user" as const,
      content: record.formattedText,
      timestamp: Date.now(),
      idempotencyKey: `company-os:meeting-context:${record.id}`,
    };
    const result = await appendSessionTranscriptMessageByIdentity({
      agentId: record.runtimeAgentId,
      sessionKey: record.sessionKey,
      sessionId: record.sessionId,
      config: this.config as never,
      idempotencyLookup: "scan",
      message,
    });
    if (!result) throw new Error("OpenClaw did not resolve the target session transcript");
    await publishSessionTranscriptUpdateByIdentity({
      agentId: record.runtimeAgentId,
      sessionKey: record.sessionKey,
      sessionId: record.sessionId,
      update: {
        agentId: record.runtimeAgentId,
        sessionKey: record.sessionKey,
        sessionId: record.sessionId,
        message: result.message,
        messageId: result.messageId,
      },
    });
    return { appended: result.appended, messageId: result.messageId };
  }
}
