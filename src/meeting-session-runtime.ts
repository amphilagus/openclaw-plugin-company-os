import { appendAssistantMirrorMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";

export type MeetingSessionEnsureInput = {
  agentId: string;
  sessionKey: string;
  label: string;
  category: string;
};

export interface MeetingSessionRuntime {
  ensureSession(input: MeetingSessionEnsureInput): Promise<{ sessionId: string; sessionKey?: string }>;
  appendMainSystemMessage(input: {
    agentId: string;
    sessionKey: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; messageId: string }>;
  releaseSession(input: { agentId: string; sessionKey: string }): Promise<void>;
}

type SessionEntry = {
  sessionId?: string;
  label?: string;
  displayName?: string;
  archivedAt?: number;
};
type SessionEntryReader = (input: { agentId: string; sessionKey: string }) => SessionEntry | undefined;
type SessionEntryLister = (input: { agentId: string }) => Array<{ sessionKey: string; entry: SessionEntry }>;

export class OpenClawMeetingSessionRuntime implements MeetingSessionRuntime {
  constructor(
    private readonly config: unknown,
    private readonly readSessionEntry: SessionEntryReader,
    private readonly listSessionEntries: SessionEntryLister,
  ) {}

  async ensureSession(input: MeetingSessionEnsureInput) {
    const exact = this.readSessionEntry(input);
    const exactSessionId = exact?.sessionId?.trim();
    if (exactSessionId && !exact?.archivedAt) return { sessionId: exactSessionId, sessionKey: input.sessionKey };

    const expectedName = input.label.trim().toLocaleLowerCase();
    const matches = this.listSessionEntries({ agentId: input.agentId }).filter(({ entry }) => {
      if (!entry.sessionId?.trim() || entry.archivedAt) return false;
      return [entry.label, entry.displayName]
        .some((name) => name?.trim().toLocaleLowerCase() === expectedName);
    });
    if (matches.length === 0) {
      throw new Error(`pre-created session named "${input.label}" is missing for Agent ${input.agentId}`);
    }
    if (matches.length > 1) {
      throw new Error(`multiple active sessions named "${input.label}" exist for Agent ${input.agentId}`);
    }
    return { sessionId: matches[0]!.entry.sessionId!.trim(), sessionKey: matches[0]!.sessionKey };
  }

  async appendMainSystemMessage(input: {
    agentId: string;
    sessionKey: string;
    text: string;
    idempotencyKey: string;
  }) {
    const sessionId = this.readSessionEntry(input)?.sessionId?.trim();
    if (!sessionId) throw new Error(`pre-created main session is missing for Agent ${input.agentId}`);
    const result = await appendAssistantMirrorMessageByIdentity({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      sessionId,
      config: this.config as never,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      updateMode: "inline",
    });
    if (!result.ok) throw new Error(`OpenClaw rejected main-session notification: ${result.reason}`);
    return { sessionId, messageId: result.messageId };
  }

  async releaseSession() {}
}

export class InMemoryMeetingSessionRuntime implements MeetingSessionRuntime {
  async ensureSession(input: MeetingSessionEnsureInput) {
    return { sessionId: `company-os:${input.sessionKey}` };
  }

  async appendMainSystemMessage(input: { agentId: string; sessionKey: string; text: string; idempotencyKey: string }) {
    return { sessionId: `company-os:${input.sessionKey}`, messageId: input.idempotencyKey };
  }

  async releaseSession() {}
}
