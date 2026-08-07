import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCompanyOsApiHttpHandler,
  createCompanyOsWebHttpHandler,
} from "../src/http.js";
import type { CompanyOsService } from "../src/service.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Company OS HTTP route isolation", () => {
  it("serves the WebUI shell without touching the protected API namespace", async () => {
    const staticDir = mkdtempSync(path.join(os.tmpdir(), "company-os-web-"));
    tempDirs.push(staticDir);
    mkdirSync(path.join(staticDir, "assets"));
    writeFileSync(path.join(staticDir, "index.html"), "<main>company-os-shell</main>");
    writeFileSync(path.join(staticDir, "assets", "app.js"), "globalThis.companyOsLoaded = true;");

    const handler = createCompanyOsWebHttpHandler({ staticDir });
    const baseUrl = await listen(async (req, res) => {
      if (await handler(req, res)) return;
      res.statusCode = 404;
      res.end("not found");
    });

    const page = await fetch(`${baseUrl}/plugins/company-os-ui/meeting-room`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("company-os-shell");

    const asset = await fetch(`${baseUrl}/plugins/company-os-ui/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const api = await fetch(`${baseUrl}/plugins/company-os/api/v1/snapshot`);
    expect(api.status).toBe(404);
  });

  it("handles API requests only inside the gateway-authenticated namespace", async () => {
    const service = {
      store: {
        bossSnapshot: () => ({ source: "protected-api" }),
      },
      setTaskPromptInterval: (memberId: string, intervalMinutes: number | null) => ({ memberId, intervalMinutes }),
    } as unknown as CompanyOsService;
    const handler = createCompanyOsApiHttpHandler({ getService: () => service });
    const baseUrl = await listen(async (req, res) => {
      if (await handler(req, res)) return;
      res.statusCode = 404;
      res.end("not found");
    });

    const api = await fetch(`${baseUrl}/plugins/company-os/api/v1/snapshot`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ source: "protected-api" });

    const updated = await fetch(`${baseUrl}/plugins/company-os/api/v1/task-prompt-settings/cto`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalMinutes: 15 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ memberId: "cto", intervalMinutes: 15 });

    const page = await fetch(`${baseUrl}/plugins/company-os-ui/meeting-room`);
    expect(page.status).toBe(404);
  });
});

async function listen(listener: RequestListener) {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}
