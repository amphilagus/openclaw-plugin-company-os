import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentVisualIdentity } from "../src/identity.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agent visual identity", () => {
  it("loads a configured workspace avatar as an embeddable data URL", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "company-os-avatar-"));
    directories.push(workspace);
    mkdirSync(path.join(workspace, "assets"));
    writeFileSync(path.join(workspace, "assets", "avatar.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const config = { agents: { list: [{ id: "main", name: "架构师", workspace, identity: { emoji: "⚙️", avatar: "assets/avatar.png" } }] } };

    expect(resolveAgentVisualIdentity(config, "main")).toEqual({
      agentId: "main",
      configuredName: "架构师",
      emoji: "⚙️",
      avatarUrl: "data:image/png;base64,iVBORw==",
    });
  });

  it("rejects local avatar paths outside the agent workspace", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "company-os-avatar-root-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "company-os-avatar-outside-"));
    directories.push(workspace, outside);
    writeFileSync(path.join(outside, "avatar.png"), Buffer.from([1, 2, 3]));
    const config = { agents: { list: [{ id: "main", workspace, identity: { avatar: path.join(outside, "avatar.png") } }] } };

    expect(resolveAgentVisualIdentity(config, "main").avatarUrl).toBeNull();
  });
});
