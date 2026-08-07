import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GitCliRemoteVerifier, normalizeGitLocation, parseRemoteBranchTip, type GitExecFile } from "../src/git-verifier.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const INPUT = {
  remoteUrl: "https://github.com/example/company-os.git",
  branch: "agents/cto/task-42",
  commit: COMMIT,
};

describe("Git remote submission verification", () => {
  it("accepts HTTPS, SSH, and scp-style remotes and normalizes the full SHA", () => {
    expect(normalizeGitLocation({ ...INPUT, commit: COMMIT.toUpperCase() })).toEqual(INPUT);
    expect(normalizeGitLocation({ ...INPUT, remoteUrl: "ssh://git@github.com/example/company-os.git" }).remoteUrl)
      .toBe("ssh://git@github.com/example/company-os.git");
    expect(normalizeGitLocation({ ...INPUT, remoteUrl: "git@github.com:example/company-os.git" }).remoteUrl)
      .toBe("git@github.com:example/company-os.git");
  });

  it.each([
    [{ ...INPUT, remoteUrl: "http://github.com/example/repo.git" }, /HTTPS or SSH|use HTTPS or SSH/],
    [{ ...INPUT, remoteUrl: "https://user:secret@github.com/example/repo.git" }, /embedded credentials/],
    [{ ...INPUT, remoteUrl: "https://user@github.com/example/repo.git" }, /embedded credentials/],
    [{ ...INPUT, branch: "refs/heads/main" }, /relative to refs\/heads/],
    [{ ...INPUT, branch: "feature..broken" }, /valid branch/],
    [{ ...INPUT, branch: "feature.lock" }, /valid branch/],
    [{ ...INPUT, commit: "0123456" }, /40-character/],
  ])("rejects invalid Git coordinates", (input, expected) => {
    expect(() => normalizeGitLocation(input)).toThrow(expected);
  });

  it("runs a non-shell, non-interactive ls-remote for the exact branch and freezes its tip", async () => {
    const execFile = vi.fn<GitExecFile>(async () => ({
      stdout: `${COMMIT}\trefs/heads/${INPUT.branch}\n`,
      stderr: "",
    }));
    const verifier = new GitCliRemoteVerifier({
      execFile,
      timeoutMs: 15_000,
      now: () => "2030-01-02T03:04:05.000Z",
    });

    await expect(verifier.verify(INPUT)).resolves.toEqual({ ...INPUT, verifiedAt: "2030-01-02T03:04:05.000Z" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--exit-code", INPUT.remoteUrl, `refs/heads/${INPUT.branch}`],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 15_000,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
    );
  });

  it("parses only the requested full branch ref", () => {
    expect(parseRemoteBranchTip(`${"b".repeat(40)}\trefs/tags/v1\n${COMMIT}\trefs/heads/main\n`, "refs/heads/main"))
      .toBe(COMMIT);
    expect(parseRemoteBranchTip(`${COMMIT}\trefs/heads/other\n`, "refs/heads/main")).toBeNull();
  });

  it("parses real git ls-remote output from a bare repository", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-git-cli-"));
    const bare = path.join(directory, "remote.git");
    const work = path.join(directory, "work");
    try {
      execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
      execFileSync("git", ["init", "-b", "agents/integration", work], { stdio: "ignore" });
      execFileSync("git", ["-C", work, "config", "user.name", "Company OS Test"]);
      execFileSync("git", ["-C", work, "config", "user.email", "company-os@example.test"]);
      writeFileSync(path.join(work, "result.txt"), "verified\n", "utf8");
      execFileSync("git", ["-C", work, "add", "result.txt"]);
      execFileSync("git", ["-C", work, "commit", "-m", "test remote tip"], { stdio: "ignore" });
      execFileSync("git", ["-C", work, "push", bare, "agents/integration"], { stdio: "ignore" });
      const commit = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const stdout = execFileSync("git", ["ls-remote", "--exit-code", bare, "refs/heads/agents/integration"], { encoding: "utf8" });

      expect(parseRemoteBranchTip(stdout, "refs/heads/agents/integration")).toBe(commit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a moved remote tip and a missing branch", async () => {
    const moved = new GitCliRemoteVerifier({ execFile: async () => ({ stdout: `${"b".repeat(40)}\trefs/heads/${INPUT.branch}\n`, stderr: "" }) });
    await expect(moved.verify(INPUT)).rejects.toThrow(/does not match remote branch tip/);

    const missing = new GitCliRemoteVerifier({ execFile: async () => ({ stdout: "", stderr: "" }) });
    await expect(missing.verify(INPUT)).rejects.toThrow(/branch not found/);
  });

  it.each([
    [{ code: 128, stderr: "fatal: Authentication failed" }, /Authentication failed/],
    [{ code: "ENOENT", message: "spawn git ENOENT" }, /could not start: ENOENT/],
    [{ killed: true, signal: "SIGTERM", message: "timed out" }, /timed out after 15000ms/],
    [{ code: 2, message: "exit 2", stderr: "" }, /branch not found/],
  ])("reports Git process failures without accepting the submission", async (failure, expected) => {
    const verifier = new GitCliRemoteVerifier({ execFile: async () => { throw failure; } });
    await expect(verifier.verify(INPUT)).rejects.toThrow(expected);
  });
});
