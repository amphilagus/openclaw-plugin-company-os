import { describe, expect, it } from "vitest";

import { OpenClawMeetingSessionRuntime } from "../src/meeting-session-runtime.js";

describe("fixed meeting session runtime", () => {
  it("binds the exact fixed key without any Gateway request", async () => {
    const runtime = new OpenClawMeetingSessionRuntime(
      {},
      ({ agentId, sessionKey }) => agentId === "cto" && sessionKey === "agent:cto:meeting"
        ? { sessionId: "session-fixed" }
        : undefined,
      () => [],
    );

    await expect(runtime.ensureSession({
      agentId: "cto",
      sessionKey: "agent:cto:meeting",
      label: "meeting",
      category: "Company OS 会议",
    })).resolves.toEqual({ sessionId: "session-fixed", sessionKey: "agent:cto:meeting" });
  });

  it("discovers a uniquely named UI-created meeting session and returns its real key", async () => {
    const runtime = new OpenClawMeetingSessionRuntime(
      {},
      () => undefined,
      ({ agentId }) => agentId === "cto" ? [
        { sessionKey: "agent:cto:dashboard:generated", entry: { sessionId: "session-ui", label: "meeting" } },
        { sessionKey: "agent:cto:main", entry: { sessionId: "session-main" } },
      ] : [],
    );

    await expect(runtime.ensureSession({
      agentId: "cto",
      sessionKey: "agent:cto:meeting",
      label: "meeting",
      category: "Company OS 会议",
    })).resolves.toEqual({ sessionId: "session-ui", sessionKey: "agent:cto:dashboard:generated" });
  });

  it("rejects missing or ambiguous pre-created meeting sessions", async () => {
    const missing = new OpenClawMeetingSessionRuntime({}, () => undefined, () => []);
    await expect(missing.ensureSession({
      agentId: "cto",
      sessionKey: "agent:cto:meeting",
      label: "meeting",
      category: "Company OS 会议",
    })).rejects.toThrow(/pre-created session named "meeting" is missing/);

    const ambiguous = new OpenClawMeetingSessionRuntime({}, () => undefined, () => [
      { sessionKey: "agent:cto:one", entry: { sessionId: "one", label: "meeting" } },
      { sessionKey: "agent:cto:two", entry: { sessionId: "two", displayName: "MEETING" } },
    ]);
    await expect(ambiguous.ensureSession({
      agentId: "cto",
      sessionKey: "agent:cto:meeting",
      label: "meeting",
      category: "Company OS 会议",
    })).rejects.toThrow(/multiple active sessions named "meeting"/);
  });
});
