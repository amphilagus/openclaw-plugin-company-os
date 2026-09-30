// OpenClaw 2026.9.3 ships this documented runtime entrypoint without declarations.
// Keep the three contracts used here explicit; do not turn the SDK into `any`.
// Verified against its SQLite-backed session-transcript-runtime implementation.
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

  type SessionIdentity = { agentId: string; sessionKey: string; sessionId: string };
  type ContextMessage = {
    role: "user";
    content: string;
    timestamp: number;
    idempotencyKey: string;
  };

  export function appendAssistantMirrorMessageByIdentity(params: SessionIdentity & {
    config: OpenClawPluginApi["config"];
    text: string;
    idempotencyKey: string;
    updateMode: "inline";
  }): Promise<{ ok: true; messageId: string } | { ok: false; reason: string }>;

  export function appendSessionTranscriptMessageByIdentity(params: SessionIdentity & {
    config: OpenClawPluginApi["config"];
    idempotencyLookup: "scan";
    message: ContextMessage;
  }): Promise<{ appended: boolean; messageId: string; message: unknown } | null>;

  export function publishSessionTranscriptUpdateByIdentity(params: SessionIdentity & {
    update: SessionIdentity & { message: unknown; messageId: string };
  }): Promise<void>;
}
