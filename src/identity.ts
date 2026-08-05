import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type AgentVisualIdentity = {
  agentId: string;
  configuredName: string | null;
  emoji: string | null;
  avatarUrl: string | null;
};

export function resolveAgentVisualIdentity(runtimeConfig: unknown, agentId: string): AgentVisualIdentity {
  const agents = (runtimeConfig as { agents?: { list?: unknown[] } } | undefined)?.agents?.list ?? [];
  const agent = agents.find((candidate) => isRecord(candidate) && candidate.id === agentId);
  if (!isRecord(agent)) return { agentId, configuredName: null, emoji: null, avatarUrl: null };
  const identity = isRecord(agent.identity) ? agent.identity : {};
  const configuredName = optionalString(identity.name) ?? optionalString(agent.name) ?? null;
  const emoji = optionalString(identity.emoji) ?? null;
  const avatar = optionalString(identity.avatar);
  if (!avatar) return { agentId, configuredName, emoji, avatarUrl: null };

  if (/^data:image\/(?:gif|jpeg|png|webp|x-icon);/i.test(avatar)) {
    return { agentId, configuredName, emoji, avatarUrl: avatar.length <= MAX_AVATAR_BYTES * 1.5 ? avatar : null };
  }
  if (/^https?:\/\//i.test(avatar)) return { agentId, configuredName, emoji, avatarUrl: avatar };

  const workspace = optionalString(agent.workspace);
  if (!workspace) return { agentId, configuredName, emoji, avatarUrl: null };
  const avatarUrl = readWorkspaceAvatar(workspace, avatar);
  return { agentId, configuredName, emoji, avatarUrl };
}

export function resolveStandaloneAvatar(avatarPath: string) {
  try {
    return readAvatarFile(realpathSync(expandHome(avatarPath)));
  } catch {
    return null;
  }
}

function readWorkspaceAvatar(workspace: string, avatar: string) {
  try {
    const workspaceRoot = realpathSync(expandHome(workspace));
    const candidate = avatar.startsWith("~/")
      ? path.join(os.homedir(), avatar.slice(2))
      : path.isAbsolute(avatar) ? avatar : path.resolve(workspaceRoot, avatar);
    const resolved = realpathSync(candidate);
    if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) return null;
    return readAvatarFile(resolved);
  } catch {
    return null;
  }
}

function readAvatarFile(resolved: string) {
  const mime = MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (!mime) return null;
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AVATAR_BYTES) return null;
  return `data:${mime};base64,${readFileSync(resolved).toString("base64")}`;
}

function expandHome(value: string) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
