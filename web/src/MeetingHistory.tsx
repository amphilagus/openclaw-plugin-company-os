import { useEffect, useState } from "react";

import { getMeeting } from "./api";
import { AgentAvatar, memberIdentity, memberName, type MemberIdentityMap } from "./member-identity";
import { CompanyOsSystemAvatar } from "./CompanyOsSystemAvatar";
import type { MeetingDetail, MeetingSummary } from "./types";
import "./meeting-history.css";
import "./history-identity.css";

export function MeetingHistory({ history, identities = {} }: { history: MeetingSummary[]; identities?: MemberIdentityMap }) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detail]);

  if (history.length === 0) return null;

  const openMeeting = async (meeting: MeetingSummary) => {
    setLoadingId(meeting.id);
    try {
      setDetail(await getMeeting(meeting.id));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingId(null);
    }
  };

  return <>
    <details className="history">
      <summary>查看会议历史（{history.length}）</summary>
      <div className="history-list">
        {history.map((item) => <button
          type="button"
          className="history-row"
          key={item.id}
          aria-label={`查看会议：${item.title}`}
          disabled={loadingId === item.id}
          onClick={() => void openMeeting(item)}
        >
          <span className={`badge tone-${item.status}`}>{meetingStatus(item.status)}</span>
          <span className="history-title"><b>{item.title}</b><small>{item.type === "task" ? "任务会议" : "普通讨论"}</small></span>
          <span>{memberName(identities, item.hostId)}</span>
          <time>{formatTime(item.endedAt ?? item.createdAt)}</time>
          <span className="history-open">{loadingId === item.id ? "载入中…" : "查看档案 →"}</span>
        </button>)}
      </div>
    </details>
    {detail ? <MeetingHistoryDetail meeting={detail} identities={identities} close={() => setDetail(null)} /> : null}
  </>;
}

export function MeetingHistoryDetail({ meeting, identities = {}, close }: { meeting: MeetingDetail; identities?: MemberIdentityMap; close: () => void }) {
  return <div className="history-overlay" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) close();
  }}>
    <section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title">
      <header className="history-dialog-header">
        <div>
          <div className="history-dialog-kicker"><span className={`badge tone-${meeting.status}`}>{meetingStatus(meeting.status)}</span><span>{meeting.type === "task" ? "任务会议" : "普通讨论"}</span><code>{meeting.id.slice(0, 8)}</code></div>
          <h2 id="history-dialog-title">{meeting.title}</h2>
          <p>{meeting.agenda}</p>
        </div>
        <button type="button" className="history-close" onClick={close} aria-label="关闭会议档案">×</button>
      </header>

      <div className="history-facts">
        <span>主持人 <b>{memberName(identities, meeting.hostId)}</b></span>
        <span>申请人 <b>{memberName(identities, meeting.requestedBy)}</b></span>
        {meeting.bossParticipates ? <span><b>Boss 直接参会</b></span> : null}
        <span>开始 <b>{formatTime(meeting.bossStartedAt ?? meeting.startedAt ?? meeting.createdAt)}</b></span>
        <span>结束 <b>{formatTime(meeting.endedAt)}</b></span>
        {meeting.parentTaskId ? <span>父任务 <code>{meeting.parentTaskId}</code></span> : null}
      </div>

      {(meeting.summary || meeting.canceledReason || meeting.status === "timed_out") ? <section className="history-outcome">
        <h3>{meeting.status === "completed" ? "会议总结" : meeting.status === "canceled" ? "取消原因" : "结束说明"}</h3>
        <p>{meeting.summary ?? meeting.canceledReason ?? "主持人超时，系统已释放会议室；本次会议未生成任务或正常会议汇报。"}</p>
      </section> : null}

      <div className="history-dialog-grid">
        <section className="history-transcript">
          <h3>会议记录 <span>{meeting.messages.length}</span></h3>
          <div className="history-messages">
            {meeting.messages.length ? meeting.messages.map((message) => {
              const id = message.authorKind === "boss" ? "boss" : message.authorId ?? "system";
              const identity = message.authorKind === "system" ? { id: "system", name: "系统", title: "", avatarUrl: null, emoji: null } : memberIdentity(identities, id);
              return <article className={`history-message ${message.authorKind}`} key={message.id}>
                {message.authorKind === "system"
                  ? <CompanyOsSystemAvatar className="history-avatar" />
                  : <AgentAvatar identity={identity} className="history-avatar" />}
                <div><div className="history-message-meta"><b>{identity.name}</b>{message.authorKind === "member" ? <small className="speaker-id">{id}</small> : null}{message.targetId ? <span>@{memberName(identities, message.targetId)}</span> : null}<time>{formatTime(message.createdAt)}</time></div><p>{message.body}</p></div>
              </article>;
            }) : <p className="history-empty">这场会议没有留下发言记录。</p>}
          </div>
        </section>

        <aside className="history-sidebar">
          <section><h3>参会角色</h3><HistoryPerson id={meeting.hostId} role="主持人" identities={identities} />{meeting.participants.map((participant) => <HistoryPerson id={participant.agentId} role={participant.role === "worker" ? "执行者" : "顾问"} identities={identities} fallbackName={participant.name} key={participant.agentId} />)}</section>
          <section><h3>分阶段任务流 <span>{meeting.taskDraftStages.length}</span></h3>{meeting.taskDraftStages.length ? meeting.taskDraftStages.map((stage) => <div className="history-draft-stage" key={stage.id}><b>阶段 {stage.position + 1} · {stage.name}</b><p>{stage.objective}</p>{stage.tasks.map((draft) => <div className="history-draft" key={draft.id}><b>{draft.title}</b><span>负责人 {memberName(identities, draft.assigneeId)}</span><p>{draft.description}</p><small>验收：{draft.acceptanceCriteria}</small></div>)}</div>) : <p className="history-empty">本次会议没有任务草案。</p>}</section>
        </aside>
      </div>
    </section>
  </div>;
}

function HistoryPerson({ id, role, identities, fallbackName }: { id: string; role: string; identities: MemberIdentityMap; fallbackName?: string }) {
  const identity = memberIdentity(identities, id, fallbackName);
  return <div className="history-person"><AgentAvatar identity={identity} /><div><b>{identity.name}</b><span>{role} · {identity.title || id}<small className="speaker-id">{id}</small></span></div></div>;
}

function meetingStatus(status: MeetingSummary["status"]) {
  return { queued: "排队", active: "进行中", completed: "完成", canceled: "取消", timed_out: "超时" }[status];
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
