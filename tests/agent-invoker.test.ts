import { access, readFile, stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { OpenClawCliAgentInvoker, type AgentExecFile } from "../src/agent-invoker.js";

describe("OpenClaw CLI agent invoker", () => {
  it("uses a private prompt file, retries in_flight, and parses the Agent reply", async () => {
    let promptPath = "";
    let promptMode = 0;
    const execFile: AgentExecFile = vi.fn(async (file, args) => {
      expect(file).toBe("openclaw");
      expect(args).toContain("--agent");
      expect(args).toContain("engineer");
      expect(args).not.toContain("秘密会议上下文");
      promptPath = args[args.indexOf("--message-file") + 1]!;
      promptMode = (await stat(promptPath)).mode & 0o777;
      expect(await readFile(promptPath, "utf8")).toBe("秘密会议上下文");
      const attempt = (execFile as ReturnType<typeof vi.fn>).mock.calls.length;
      return attempt === 1
        ? { stdout: JSON.stringify({ status: "in_flight" }), stderr: "" }
        : { stdout: JSON.stringify({ status: "ok", payloads: [{ text: "  已完成发言  " }] }), stderr: "" };
    });
    const wait = vi.fn(async () => undefined);
    const invoker = new OpenClawCliAgentInvoker({ execFile, wait, retryDelayMs: 10_000 });

    const result = await invoker.invoke({ agentId: "engineer", prompt: "秘密会议上下文", timeoutSeconds: 600 });

    expect(result).toMatchObject({ ok: true, text: "已完成发言", attempts: 2 });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(10_000, undefined);
    expect(promptMode).toBe(0o600);
    await expect(access(promptPath)).rejects.toThrow();
  });

  it("returns structured timeout and invalid JSON failures", async () => {
    const timedOut = new OpenClawCliAgentInvoker({
      execFile: async () => { throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" }); },
    });
    await expect(timedOut.invoke({ agentId: "engineer", prompt: "x", timeoutSeconds: 60 }))
      .resolves.toMatchObject({ ok: false, code: "timeout" });

    const invalid = new OpenClawCliAgentInvoker({ execFile: async () => ({ stdout: "not-json", stderr: "" }) });
    await expect(invalid.invoke({ agentId: "engineer", prompt: "x", timeoutSeconds: 60 }))
      .resolves.toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("exhausts three in_flight retries and removes the private prompt after failure", async () => {
    let promptPath = "";
    const execFile: AgentExecFile = vi.fn(async (_file, args) => {
      promptPath = args[args.indexOf("--message-file") + 1]!;
      return { stdout: JSON.stringify({ status: "in_flight" }), stderr: "" };
    });
    const wait = vi.fn(async () => undefined);
    const invoker = new OpenClawCliAgentInvoker({ execFile, wait });

    await expect(invoker.invoke({ agentId: "engineer", prompt: "x", timeoutSeconds: 60 }))
      .resolves.toMatchObject({ ok: false, code: "in_flight", attempts: 4 });
    expect(execFile).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
    await expect(access(promptPath)).rejects.toThrow();
  });

  it("supports disabling in_flight retries for single-injection patrol dispatches", async () => {
    const execFile: AgentExecFile = vi.fn(async () => ({
      stdout: JSON.stringify({ status: "in_flight" }),
      stderr: "",
    }));
    const wait = vi.fn(async () => undefined);
    const invoker = new OpenClawCliAgentInvoker({ execFile, wait });

    await expect(invoker.invoke({
      agentId: "engineer",
      prompt: "single patrol prompt",
      timeoutSeconds: 60,
      maxInFlightRetries: 0,
    })).resolves.toMatchObject({ ok: false, code: "in_flight", attempts: 1 });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("distinguishes empty replies from abnormal CLI exits", async () => {
    const empty = new OpenClawCliAgentInvoker({
      execFile: async () => ({ stdout: JSON.stringify({ status: "ok", payloads: [] }), stderr: "" }),
    });
    await expect(empty.invoke({ agentId: "engineer", prompt: "x", timeoutSeconds: 60 }))
      .resolves.toMatchObject({ ok: false, code: "empty_reply", completed: true });

    const exited = new OpenClawCliAgentInvoker({
      execFile: async () => { throw Object.assign(new Error("exit 2"), { code: 2, stderr: "agent command failed" }); },
    });
    await expect(exited.invoke({ agentId: "engineer", prompt: "x", timeoutSeconds: 60 }))
      .resolves.toMatchObject({ ok: false, code: "exit", error: "openclaw CLI failed: agent command failed" });
  });
});
