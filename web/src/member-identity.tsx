import { useEffect, useMemo, useState } from "react";

import { getMemberIdentity } from "./api";
import type { Member, MemberIdentity } from "./types";
import "./member-identity.css";

export type MemberIdentityMap = Record<string, MemberIdentity>;
const IDENTITY_REFRESH_MS = 15_000;

export function useMemberIdentities(members: Member[]): MemberIdentityMap {
  const [visuals, setVisuals] = useState<Record<string, Pick<MemberIdentity, "avatarUrl" | "emoji">>>({});
  const memberKey = members.map((member) => `${member.id}:${member.name}:${member.title}`).join("|");

  useEffect(() => {
    let canceled = false;
    const memberIds = members.map((member) => member.id);
    const refresh = () => {
      void Promise.all(memberIds.map(async (id) => {
        try {
          return await getMemberIdentity(id);
        } catch {
          return null;
        }
      })).then((loaded) => {
        if (canceled) return;
        setVisuals(Object.fromEntries(loaded.filter((item): item is MemberIdentity => Boolean(item)).map((item) => [item.id, { avatarUrl: item.avatarUrl, emoji: item.emoji }])));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, IDENTITY_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      canceled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [memberKey]);

  return useMemo(() => Object.fromEntries(members.map((member) => [member.id, {
    id: member.id,
    name: member.name,
    title: member.title,
    avatarUrl: visuals[member.id]?.avatarUrl ?? null,
    emoji: visuals[member.id]?.emoji ?? null,
  }])), [memberKey, visuals]);
}

export function memberIdentity(identities: MemberIdentityMap, id: string, fallbackName?: string): MemberIdentity {
  return identities[id] ?? { id, name: fallbackName || id, title: "", avatarUrl: null, emoji: null };
}

export function memberName(identities: MemberIdentityMap, id: string, fallbackName?: string) {
  return memberIdentity(identities, id, fallbackName).name;
}

export function AgentAvatar({ identity, className = "", fallback }: { identity: MemberIdentity; className?: string; fallback?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [identity.avatarUrl]);
  const text = fallback ?? identity.emoji ?? identity.name.slice(0, 1).toUpperCase() ?? "?";
  return <span className={`agent-avatar ${className}`.trim()} aria-label={`${identity.name}的头像`}>
    {identity.avatarUrl && !failed ? <img src={identity.avatarUrl} alt="" onError={() => setFailed(true)} /> : text}
  </span>;
}
