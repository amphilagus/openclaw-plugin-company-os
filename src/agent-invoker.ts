import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type AgentInvocationResult =
  | { ok: true; text: string; raw: unknown; attempts: number }
  | {
      ok: false;
      code: "aborted" | "timeout" | "in_flight" | "launch_failed" | "exit" | "invalid_json" | "empty_reply";
      error: string;
      attempts: number;
      completed?: boolean;
      raw?: unknown;
    };

export type AgentInvocation = {
  agentId: string;
  prompt: string;
  sessionKey?: string;
  timeoutSeconds: number;
  maxInFlightRetries?: number;
  maxErrorRetries?: number;
  signal?: AbortSignal;
};

export interface AgentInvoker {
  invoke(input: AgentInvocation): Promise<AgentInvocationResult>;
}

export type AgentExecFileResult = { stdout: string; stderr: string };
export type AgentExecFile = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<AgentExecFileResult>;

const defaultExecFile = promisify(execFileCallback) as unknown as AgentExecFile;

export class OpenClawCliAgentInvoker implements AgentInvoker {
  private readonly execFile: AgentExecFile;
  private readonly retryDelayMs: number;
  private readonly maxInFlightRetries: number;
  private readonly maxErrorRetries: number;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: {
    execFile?: AgentExecFile;
    retryDelayMs?: number;
    maxInFlightRetries?: number;
    maxErrorRetries?: number;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.retryDelayMs = options.retryDelayMs ?? 10_000;
    this.maxInFlightRetries = options.maxInFlightRetries ?? 3;
    this.maxErrorRetries = options.maxErrorRetries ?? 0;
    this.wait = options.wait ?? abortableWait;
  }

  async invoke(input: AgentInvocation): Promise<AgentInvocationResult> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "company-os-agent-"));
    const promptFile = path.join(directory, "prompt.txt");
    const maxInFlightRetries = input.maxInFlightRetries ?? this.maxInFlightRetries;
    const maxErrorRetries = input.maxErrorRetries ?? this.maxErrorRetries;
    const retryableErrorCodes = new Set<string>([
      "invalid_json",
      "exit",
      "timeout",
      "in_flight",
    ]);
    try {
      await writeFile(promptFile, input.prompt, { encoding: "utf8", mode: 0o600 });
      let attempt = 1;
      let errorRetriesUsed = 0;
      let inFlightRetriesUsed = 0;
      while (true) {
        const result = await this.invokeOnce(input, promptFile, attempt);
        if (result.ok) return result;

        // in_flight 有独立的重试预算（短间隔，等其它会话释放）
        if (result.code === "in_flight" && inFlightRetriesUsed < maxInFlightRetries) {
          inFlightRetriesUsed += 1;
          attempt += 1;
          try {
            await this.wait(this.retryDelayMs, input.signal);
          } catch {
            return { ok: false, code: "aborted", error: "agent invocation aborted", attempts: attempt - 1 };
          }
          continue;
        }

        // 其它可重试错误走指数退避的错误重试预算
        if (retryableErrorCodes.has(result.code) && errorRetriesUsed < maxErrorRetries) {
          errorRetriesUsed += 1;
          attempt += 1;
          const backoffMs = this.retryDelayMs * 2 ** (errorRetriesUsed - 1);
          try {
            await this.wait(backoffMs, input.signal);
          } catch {
            return { ok: false, code: "aborted", error: "agent invocation aborted", attempts: attempt - 1 };
          }
          continue;
        }

        return result;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async invokeOnce(input: AgentInvocation, promptFile: string, attempt: number): Promise<AgentInvocationResult> {
    if (input.signal?.aborted) return { ok: false, code: "aborted", error: "agent invocation aborted", attempts: attempt };
    let output: AgentExecFileResult;
    try {
      output = await this.execFile("openclaw", [
        "agent",
        "--agent", input.agentId,
        ...(input.sessionKey ? ["--session-key", input.sessionKey] : []),
        "--message-file", promptFile,
        "--json",
        "--timeout", String(input.timeoutSeconds),
      ], {
        encoding: "utf8",
        timeout: (input.timeoutSeconds * 1000) + 5_000,
        maxBuffer: 10 * 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      const detail = errorDetails(error);
      if (input.signal?.aborted || detail.name === "AbortError" || detail.code === "ABORT_ERR") {
        return { ok: false, code: "aborted", error: "agent invocation aborted", attempts: attempt };
      }
      if (detail.killed || detail.signal === "SIGTERM" || detail.code === "ETIMEDOUT") {
        return { ok: false, code: "timeout", error: `agent invocation timed out after ${input.timeoutSeconds}s`, attempts: attempt };
      }
      if (detail.code === "ENOENT" || detail.code === "EACCES") {
        return { ok: false, code: "launch_failed", error: `openclaw CLI launch failed: ${detail.code}`, attempts: attempt };
      }
      const stderr = detail.stderr?.trim();
      return { ok: false, code: "exit", error: stderr ? `openclaw CLI failed: ${stderr}` : `openclaw CLI failed: ${detail.message}`, attempts: attempt };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      return { ok: false, code: "invalid_json", error: "openclaw CLI returned invalid JSON", attempts: attempt };
    }
    if (parsed?.status === "in_flight") {
      return { ok: false, code: "in_flight", error: "agent session is already in flight", attempts: attempt };
    }
    const text = Array.isArray(parsed?.payloads)
      ? parsed.payloads.find((payload: unknown) => typeof (payload as { text?: unknown })?.text === "string")?.text?.trim()
      : "";
    if (!text) {
      return {
        ok: false,
        code: "empty_reply",
        error: "agent returned no text payload",
        attempts: attempt,
        completed: ["ok", "completed", "success"].includes(parsed?.status),
        raw: parsed,
      };
    }
    return { ok: true, text, raw: parsed, attempts: attempt };
  }
}

function errorDetails(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, any> : {};
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : String(error),
    code: typeof value.code === "string" ? value.code : undefined,
    killed: Boolean(value.killed),
    signal: typeof value.signal === "string" ? value.signal : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
  };
}

function abortableWait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
