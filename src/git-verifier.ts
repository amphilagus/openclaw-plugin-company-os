import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { GitLocationInput, VerifiedGitLocation } from "./types.js";

type GitExecResult = { stdout: string; stderr: string };
export type GitExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
) => Promise<GitExecResult>;

export interface GitRemoteVerifier {
  verify(input: GitLocationInput): Promise<VerifiedGitLocation>;
}

const defaultExecFile = promisify(execFileCallback) as unknown as GitExecFile;

export class GitCliRemoteVerifier implements GitRemoteVerifier {
  private readonly execFile: GitExecFile;
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(options: { execFile?: GitExecFile; timeoutMs?: number; now?: () => string } = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async verify(input: GitLocationInput): Promise<VerifiedGitLocation> {
    const normalized = normalizeGitLocation(input);
    const ref = `refs/heads/${normalized.branch}`;
    let output: GitExecResult;
    try {
      output = await this.execFile("git", ["ls-remote", "--exit-code", normalized.remoteUrl, ref], {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
        },
      });
    } catch (error) {
      const detail = errorDetails(error);
      if (detail.code === "ENOENT" || detail.code === "EACCES") {
        throw new Error(`Git remote verification could not start: ${detail.code}`);
      }
      if (detail.killed || detail.signal === "SIGTERM" || detail.code === "ETIMEDOUT") {
        throw new Error(`Git remote verification timed out after ${this.timeoutMs}ms`);
      }
      const stderr = detail.stderr?.trim();
      if (detail.code === 2 && !stderr) throw new Error(`Git remote branch not found: ${normalized.branch}`);
      throw new Error(stderr ? `Git remote verification failed: ${stderr}` : `Git remote verification failed: ${detail.message}`);
    }

    const remoteCommit = parseRemoteBranchTip(output.stdout, ref);
    if (!remoteCommit) throw new Error(`Git remote branch not found: ${normalized.branch}`);
    if (remoteCommit !== normalized.commit) {
      throw new Error(`Git commit does not match remote branch tip: expected ${remoteCommit}, received ${normalized.commit}`);
    }
    return { ...normalized, verifiedAt: this.now() };
  }
}

export function normalizeGitLocation(input: GitLocationInput): GitLocationInput {
  if (!input || typeof input !== "object") throw new Error("gitLocation is required");
  const remoteUrl = requiredString(input.remoteUrl, "gitLocation.remoteUrl");
  const branch = requiredString(input.branch, "gitLocation.branch");
  const commit = requiredString(input.commit, "gitLocation.commit").toLowerCase();
  validateRemoteUrl(remoteUrl);
  validateBranch(branch);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("gitLocation.commit must be a full 40-character commit SHA");
  return { remoteUrl, branch, commit };
}

export function parseRemoteBranchTip(stdout: string, expectedRef: string) {
  for (const line of stdout.split(/\r?\n/)) {
    const [commit, ref] = line.trim().split(/\s+/, 2);
    if (ref === expectedRef && commit && /^[0-9a-fA-F]{40}$/.test(commit)) return commit.toLowerCase();
  }
  return null;
}

function validateRemoteUrl(value: string) {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("gitLocation.remoteUrl must be an HTTPS or SSH Git remote URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error("gitLocation.remoteUrl must use HTTPS or SSH");
  }
  if (!parsed.hostname) throw new Error("gitLocation.remoteUrl must include a host");
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw new Error("gitLocation.remoteUrl must not contain embedded credentials");
  }
}

function validateBranch(value: string) {
  const invalid = value === "HEAD"
    || value === "@"
    || value.startsWith("-")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)
    || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"));
  if (invalid || value.startsWith("refs/heads/")) {
    throw new Error("gitLocation.branch must be a valid branch name relative to refs/heads/");
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function errorDetails(error: unknown) {
  const value = error as {
    message?: string;
    code?: string | number;
    signal?: string;
    killed?: boolean;
    stderr?: string;
  };
  return {
    message: value?.message ?? String(error),
    code: value?.code,
    signal: value?.signal,
    killed: value?.killed,
    stderr: value?.stderr,
  };
}
