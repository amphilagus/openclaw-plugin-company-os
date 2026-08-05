import { describe, expect, it } from "vitest";

import { readControlUiTokenFrom } from "../web/src/api.js";

describe("Control UI token reuse", () => {
  it("reads the current Gateway token from sessionStorage before localStorage", () => {
    const session = storage({
      "openclaw.control.token.v1:ws://127.0.0.1:18789": "session-token",
    });
    const local = storage({
      "openclaw.control.token.v1:ws://127.0.0.1:18789": "stale-local-token",
    });

    expect(readControlUiTokenFrom([session, local], "127.0.0.1:18789")).toBe("session-token");
  });

  it("supports the legacy unscoped key and structured token values", () => {
    const current = storage({
      "openclaw.control.token.v1": JSON.stringify({ token: "legacy-token" }),
    });

    expect(readControlUiTokenFrom([current], "127.0.0.1:18789")).toBe("legacy-token");
  });
});

function storage(values: Record<string, string>): Pick<Storage, "length" | "key" | "getItem"> {
  const entries = Object.entries(values);
  return {
    length: entries.length,
    key: (index) => entries[index]?.[0] ?? null,
    getItem: (key) => values[key] ?? null,
  };
}
