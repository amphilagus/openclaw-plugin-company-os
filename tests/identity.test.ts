import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAgentVisualIdentity, resolveStandaloneAvatar } from "../src/identity.js";
import { CompanyOsService } from "../src/service.js";
import { resolveConfig } from "../src/types.js";

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

  it("loads the Boss avatar from its explicit non-Agent path", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "company-os-boss-avatar-"));
    directories.push(workspace);
    const avatar = path.join(workspace, "avatar.png");
    writeFileSync(avatar, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(resolveStandaloneAvatar(avatar)).toBe("data:image/png;base64,iVBORw==");
  });

  it("returns the standalone Boss avatar through the member identity service", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "company-os-boss-identity-"));
    directories.push(workspace);
    const avatar = path.join(workspace, "avatar.png");
    writeFileSync(avatar, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const service = new CompanyOsService({
      databasePath: path.join(workspace, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossAvatarPath: avatar, bossEmailNotifications: { enabled: false } }),
      runtimeConfig: { agents: { list: [{ id: "main", default: true }] } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    expect(service.memberIdentity("boss")).toMatchObject({
      id: "boss",
      name: "Boss",
      avatarUrl: "data:image/png;base64,iVBORw==",
    });
    await service.stop();
  });

  it("reloads an Agent avatar when the configured file is replaced in place", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "company-os-live-avatar-"));
    directories.push(workspace);
    mkdirSync(path.join(workspace, "assets"));
    const avatar = path.join(workspace, "assets", "avatar.png");
    writeFileSync(avatar, Buffer.from([1, 2, 3]));
    const service = new CompanyOsService({
      databasePath: path.join(workspace, "company-os.sqlite"),
      allowedAgentIds: ["main"],
      config: resolveConfig({ bossEmailNotifications: { enabled: false } }),
      runtimeConfig: { agents: { list: [{ id: "main", default: true, workspace, identity: { avatar: "assets/avatar.png" } }] } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    expect(service.memberIdentity("main").avatarUrl).toBe("data:image/png;base64,AQID");
    writeFileSync(avatar, Buffer.from([4, 5, 6]));
    expect(service.memberIdentity("main").avatarUrl).toBe("data:image/png;base64,BAUG");
    await service.stop();
  });
});
