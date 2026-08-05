import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSmtpSettings } from "../src/email.js";
import { resolveConfig } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Boss meeting email configuration", () => {
  it("reuses the shared QQ mail account and defaults delivery to the same mailbox", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-email-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, ".env");
    writeFileSync(configPath, "PROVIDER=qq\nUSERNAME=boss@qq.com\nPASSWORD=authorization-code\n");

    const config = resolveConfig({ bossEmailNotifications: { configPath } }).bossEmailNotifications;
    const settings = loadSmtpSettings(config);

    expect(settings).toMatchObject({
      host: "smtp.qq.com",
      port: 587,
      secure: false,
      user: "boss@qq.com",
      from: "boss@qq.com",
      recipient: "boss@qq.com",
    });
  });

  it("supports a named account and an explicit Boss recipient", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "company-os-email-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, ".env");
    writeFileSync(configPath, "WORK_PROVIDER=qq\nWORK_USERNAME=sender@qq.com\nWORK_PASSWORD=code\n");

    const config = resolveConfig({
      bossEmailNotifications: { configPath, account: "work", recipient: "boss@qq.com" },
    }).bossEmailNotifications;

    expect(loadSmtpSettings(config)).toMatchObject({ user: "sender@qq.com", recipient: "boss@qq.com" });
  });
});
