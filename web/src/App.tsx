import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deleteNotice, getMeeting, getSnapshot, getTask, getTaskImageAttachment, post, put, subscribeToChanges } from "./api";
import { BossMeetingGate } from "./BossMeetingGate";
import { AgentAvatar, memberIdentity, memberName, useMemberIdentities, type MemberIdentityMap } from "./member-identity";
import { MeetingHistory } from "./MeetingHistory";
import { SelfGovernancePage } from "./SelfGovernancePage";
import type { MeetingDetail, MeetingSummary, Notice, Snapshot, Task, TaskAbortDraft, TaskDetail, TaskHourlyCheckinSummary } from "./types";
import { CompanyOsSystemAvatar } from "./CompanyOsSystemAvatar";

type TaskAbortResponse = { task: TaskDetail; affectedTaskIds: string[]; notice: Notice; draft: TaskAbortDraft };

type Route = "notices" | "meeting-room" | "tasks" | "self-governance";
const TASK_STATUS_FILTERS: Task["status"][] = ["assigned", "in_progress", "review", "blocked", "closed", "failed", "canceled", "aborted"];

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromPath());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setSnapshot(await getSnapshot());
      setError(null);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let timer = 0;
    return subscribeToChanges(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(true), 180);
    }, setLive);
  }, [load]);
  useEffect(() => {
    const onPop = () => setRoute(routeFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: Route) => {
    window.history.pushState({}, "", `/plugins/company-os-ui/${next}`);
    setRoute(next);
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">司</span><div><strong>Company OS</strong><small>公司治理控制台</small></div></div>
      <nav>
        <Nav active={route === "meeting-room"} onClick={() => navigate("meeting-room")} icon="◉">会议室</Nav>
        <Nav active={route === "tasks"} onClick={() => navigate("tasks")} icon="⌘">任务</Nav>
        <Nav active={route === "notices"} onClick={() => navigate("notices")} icon="◇">告示板</Nav>
        <Nav active={route === "self-governance"} onClick={() => navigate("self-governance")} icon="↻">自省治理</Nav>
      </nav>
      <div className={`live ${live ? "online" : ""}`}><i />{live ? "实时连接" : "重连中"}</div>
    </header>
    {error ? <div className="global-error">{error}<button onClick={() => void load()}>重试</button></div> : null}
    <main className="workspace">
      {loading && !snapshot ? <Loading /> : null}
      {snapshot && route === "notices" ? <NoticesPage snapshot={snapshot} reload={load} /> : null}
      {snapshot && route === "meeting-room" ? <MeetingRoomPage snapshot={snapshot} reload={load} /> : null}
      {snapshot && route === "tasks" ? <TasksPage snapshot={snapshot} reload={load} /> : null}
      {snapshot && route === "self-governance" ? <SelfGovernancePage snapshot={snapshot} /> : null}
    </main>
  </div>;
}

function Nav({ active, icon, children, onClick }: { active: boolean; icon: string; children: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{icon}</span>{children}</button>;
}

function NoticesPage({ snapshot, reload }: { snapshot: Snapshot; reload: (quiet?: boolean) => Promise<void> }) {
  const [history, setHistory] = useState(false);
  const [correcting, setCorrecting] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const notices = snapshot.notices.filter((notice) => history || notice.effective);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await post("/notices", { title: data.get("title"), body: data.get("body"), supersedesNoticeId: correcting?.id });
      event.currentTarget.reset();
      setCorrecting(null);
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  return <>
    <PageHeader eyebrow="CORPORATE CONSENSUS" title="公司告示板" summary="公告构成全体员工共同遵循的底层共识。公告不可编辑，修正通过新公告替代。">
      <button className="ghost" onClick={() => setHistory(!history)}>{history ? "只看当前共识" : "查看历史与更正"}</button>
    </PageHeader>
    <NoticeReminderPanel summary={snapshot.noticeUnreadReminder} />
    <div className="notices-layout">
      <section className="notice-feed">
        {notices.length === 0 ? <Empty title="还没有公告" body="会议汇报与管理公告会出现在这里。" /> : notices.map((notice) =>
          <article className={`notice-card ${notice.effective ? "" : "superseded"}`} key={notice.id}>
            <div className="notice-meta"><Badge tone={notice.kind}>{noticeKind(notice.kind)}</Badge><time>{formatTime(notice.createdAt)}</time><span>发布者 {notice.authorId}</span></div>
            <h2>{notice.title}</h2>
            <div className="notice-body">{notice.body}</div>
            <footer>
              <span>阅读覆盖 <b>{notice.readCount}/{notice.activeEmployeeCount}</b></span>
              <div className="coverage"><i style={{ width: `${notice.activeEmployeeCount ? notice.readCount / notice.activeEmployeeCount * 100 : 0}%` }} /></div>
              {notice.supersededById ? <span className="danger-text">已被后续公告替代</span> : null}
              {notice.effective ? <button className="text-button" onClick={() => setCorrecting(notice)}>发布更正</button> : null}
              {confirmDelete === notice.id ? <button className="text-button danger-text" onClick={async () => { try { await deleteNotice(`/notices/${notice.id}`); setConfirmDelete(null); await reload(true); } catch (error) { window.alert(messageOf(error)); setConfirmDelete(null); } }}>确认删除</button> : <button className="text-button danger-text" onClick={() => setConfirmDelete(notice.id)}>删除</button>}
            </footer>
          </article>)}
      </section>
      <aside className="compose-panel panel">
        <div className="panel-title"><span>{correcting ? "发布更正" : "发布公告"}</span>{correcting ? <button className="icon-button" onClick={() => setCorrecting(null)}>×</button> : null}</div>
        {correcting ? <div className="correction-target">替代：{correcting.title}</div> : null}
        <form onSubmit={submit}>
          <label>标题<input name="title" required placeholder="一句话说明新的公司共识" /></label>
          <label>正文<textarea name="body" required rows={10} placeholder="说明背景、决定、影响范围和执行要求……" /></label>
          <button className="primary" disabled={busy}>{busy ? "发布中…" : correcting ? "发布并替代旧公告" : "发布不可变公告"}</button>
        </form>
      </aside>
    </div>
  </>;
}

export function NoticeReminderPanel({ summary }: { summary: Snapshot["noticeUnreadReminder"] }) {
  const run = summary.today.latestRun;
  return <section className="notice-reminder-panel panel">
    <div className="notice-reminder-heading">
      <div><span className="eyebrow">HALF-PAST NOTICE CHECK</span><h2>公告半点提醒</h2></div>
      <Badge tone={summary.enabled ? "completed" : "canceled"}>{summary.enabled ? `半点 ${String(summary.startHour).padStart(2, "0")}:30–${String(summary.endHour).padStart(2, "0")}:30` : "已关闭"}</Badge>
    </div>
    <div className="notice-reminder-stats">
      <NoticeReminderMetric label="最新一轮" value={run ? formatTime(run.scheduledAt) : "今日尚未运行"} />
      <NoticeReminderMetric label="当前未读 Agent" value={String(summary.currentUnreadAgents)} />
      <NoticeReminderMetric label="当前未读人次" value={String(summary.currentUnreadEntries)} />
      <NoticeReminderMetric label="已送达" value={String(run?.delivered ?? 0)} />
      <NoticeReminderMetric label="失败 / 跳过" value={`${run?.failed ?? 0} / ${run?.skipped ?? 0}`} tone={(run?.failed ?? 0) > 0 ? "danger" : undefined} />
      <NoticeReminderMetric label="当前积压" value={String(summary.backlog)} tone={summary.backlog > 0 ? "warning" : undefined} />
    </div>
    <div className="notice-reminder-footer">
      <span>下一轮：{formatTime(summary.nextRunAt)}</span>
      <span>本轮候选：Agent {run?.candidateAgents ?? 0} · 未读人次 {run?.candidateUnreadEntries ?? 0}</span>
      <span>发送中：{run?.running ?? 0} · 等待：{run?.pending ?? 0} · 取消：{run?.canceled ?? 0}</span>
    </div>
  </section>;
}

function NoticeReminderMetric({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return <div className={tone ? `notice-reminder-metric is-${tone}` : "notice-reminder-metric"}><small>{label}</small><strong>{value}</strong></div>;
}

function MeetingRoomPage({ snapshot, reload }: { snapshot: Snapshot; reload: (quiet?: boolean) => Promise<void> }) {
  const activeId = (snapshot.meetings.active ?? snapshot.meetings.closing)?.id;
  const identities = useMemberIdentities(snapshot.organization);
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [target, setTarget] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const bossComposerRef = useRef<HTMLTextAreaElement>(null);
  const closing = Boolean(meeting?.closeoutStatus?.blocksRoom && meeting.closeoutStatus.state === "syncing");
  useEffect(() => {
    if (!activeId) { setMeeting(null); return; }
    void getMeeting(activeId).then(setMeeting).catch((error) => window.console.error(error));
  }, [activeId, snapshot.generatedAt]);
  const interject = async (event: FormEvent) => {
    event.preventDefault();
    if (!meeting || !body.trim()) return;
    setBusy(true);
    try {
      setMeeting(await post<MeetingDetail>(`/meetings/${meeting.id}/interject`, { body, targetId: target || undefined }));
      setBody(""); setTarget(""); await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const reorder = async (item: MeetingSummary, delta: number) => {
    await post(`/meetings/${item.id}/reorder`, { targetPosition: item.queuePosition + delta });
    await reload(true);
  };
  const cancel = async (item: MeetingSummary) => {
    const reason = window.prompt("取消这场排队会议的原因：");
    if (!reason) return;
    await post(`/meetings/${item.id}/cancel`, { reason });
    await reload(true);
  };
  const startMeeting = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      setMeeting(await post<MeetingDetail>(`/meetings/${meeting.id}/start`, {}));
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const rejectMeeting = async (reason: string) => {
    if (!meeting || !reason.trim()) return;
    setBusy(true);
    try {
      await post(`/meetings/${meeting.id}/reject`, { reason });
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const retryEntry = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      setMeeting(await post<MeetingDetail>(`/meetings/${meeting.id}/entry/retry`, {}));
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const cancelEntry = async (reason: string) => {
    if (!meeting || !reason.trim()) return;
    setBusy(true);
    try {
      await post(`/meetings/${meeting.id}/cancel`, { reason });
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const requestSummary = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      setMeeting(await post<MeetingDetail>(`/meetings/${meeting.id}/request-summary`, {}));
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const endMeeting = async (summary: string, publishNotice: boolean) => {
    if (!meeting) return;
    setBusy(true);
    try {
      await post(`/meetings/${meeting.id}/end`, { summary, publishNotice });
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const approveEnd = async () => {
    if (!meeting) return;
    setBusy(true);
    try {
      await post(`/meetings/${meeting.id}/approve-end`, {});
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  const rejectEnd = async (feedback: string) => {
    if (!meeting || !feedback.trim()) return;
    setBusy(true);
    try {
      setMeeting(await post<MeetingDetail>(`/meetings/${meeting.id}/reject-end`, { feedback }));
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); } finally { setBusy(false); }
  };
  return <>
    <PageHeader eyebrow="SINGLE WORLDLINE · ONE ROOM" title="公司会议室" summary="所有公司会议严格串行。主持人控制发言权，Boss 插话排在当前发言之后。">
      <span className={`room-state ${meeting ? "occupied" : "free"}`}>{closing ? "散会同步中" : meeting?.awaitingBossStart ? "等待你开始" : meeting?.entryState !== "ready" ? "全员入会中" : meeting?.controlState === "waiting_boss" ? "等待你决策" : meeting?.endRequestedAt ? meeting.bossParticipates ? "等待你决定结束" : "结束倒计时" : meeting ? "会议进行中" : "会议室空闲"}</span>
    </PageHeader>
    {!meeting ? <Empty title="会议室现在是空的" body={snapshot.meetings.queue.length ? "排队会议即将由系统启动。" : "员工可通过 company_meeting_request 申请会议。"} /> :
      <div className="meeting-grid">
        <section className="meeting-stage panel">
          <div className="meeting-head">
            <div className="meeting-head-copy"><div className="eyebrow">{meeting.type === "task" ? "任务会议" : "普通讨论"}</div><h2>{meeting.title}</h2><p>{meeting.agenda}</p></div>
            <aside className="meeting-facts" aria-label="会议信息">
              <div className="meeting-host-card">
                <AgentAvatar identity={memberIdentity(identities, meeting.hostId)} className="meeting-host-avatar" />
                <div><small>主持人</small><b>{memberName(identities, meeting.hostId)}</b><code title={meeting.hostId}>{meeting.hostId}</code></div>
              </div>
              {meeting.bossParticipates || meeting.parentTaskId ? <div className="meeting-fact-tags">
                {meeting.bossParticipates ? <span className="boss-required"><i />Boss 直接参会</span> : null}
                {meeting.parentTaskId ? <span className="meeting-parent-task"><small>父任务</small><code title={meeting.parentTaskId}>{shortId(meeting.parentTaskId)}</code></span> : null}
              </div> : null}
            </aside>
          </div>
          <div className="transcript">
            {meeting.messages.map((message) => <MeetingMessageRow message={message} identities={identities} key={message.id} />)}
            {!closing && !meeting.awaitingBossStart && meeting.hostDispatchStatus && ["pending", "running", "failed"].includes(meeting.hostDispatchStatus.status)
              ? <HostDispatchState dispatch={meeting.hostDispatchStatus} hostName={memberName(identities, meeting.hostId)} />
              : null}
            {closing
              ? <MeetingCloseoutState meeting={meeting} />
              : meeting.awaitingBossStart || meeting.entryState !== "ready" || meeting.endRequestedAt || meeting.controlState === "waiting_boss"
              ? <BossMeetingGate
                  meeting={meeting}
                  busy={busy}
                  start={() => void startMeeting()}
                  rejectMeeting={(reason) => void rejectMeeting(reason)}
                  retryEntry={() => void retryEntry()}
                  cancelEntry={(reason) => void cancelEntry(reason)}
                  speak={() => { bossComposerRef.current?.focus(); bossComposerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                  requestSummary={() => void requestSummary()}
                  endMeeting={(summary, publish) => void endMeeting(summary, publish)}
                  approveEnd={() => void approveEnd()}
                  rejectEnd={(fb) => void rejectEnd(fb)}
                />
              : meeting.currentTurn ? <div className="speaking"><i />等待 <b>{memberName(identities, meeting.currentTurn.speakerId)}</b> 发言：{meeting.currentTurn.prompt}</div> : <div className="host-control">控制权在主持人 {memberName(identities, meeting.hostId)}</div>}
          </div>
          {!closing && !meeting.awaitingBossStart && meeting.entryState === "ready" && !meeting.endRequestedAt ? <form className="boss-composer" onSubmit={interject}>
            <div className="boss-label">BOSS 插话</div>
            <select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">共享记录（交给主持人）</option><option value={meeting.hostId}>@{memberName(identities, meeting.hostId)} · 主持人</option>{meeting.participants.map((p) => <option value={p.agentId} key={p.agentId}>@{memberName(identities, p.agentId, p.name)} · {p.role === "worker" ? "执行者" : "顾问"}</option>)}</select>
            <textarea ref={bossComposerRef} value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="输入你的判断、追问或方向修正……" required />
            <button className="primary" disabled={busy}>{busy ? "排队中…" : target ? `在当前发言后 @${target}` : "加入会议记录"}</button>
          </form> : null}
        </section>
        <aside className="meeting-side">
          <section className="panel compact"><div className="panel-title">参会角色</div><div className="people-list">{meeting.bossParticipates ? <Person id="boss" role={meeting.awaitingBossStart ? "待入场 · 最终决策者" : "直接参会 · 最终决策者"} identities={identities} /> : null}<Person id={meeting.hostId} role="主持人" identities={identities} />{meeting.participants.map((p) => <Person key={p.agentId} id={p.agentId} role={p.role === "worker" ? "执行者" : "顾问"} identities={identities} fallbackName={p.name} />)}</div></section>
          {closing ? <MeetingCloseoutMemberList meeting={meeting} /> : null}
          {!closing && meeting.sessionMode === "dedicated" ? <MeetingEntryMemberList meeting={meeting} /> : null}
          <section className="panel compact"><div className="panel-title">分阶段任务流 <span>{meeting.taskDraftStages.length}</span></div>{meeting.type === "discussion" ? <p className="muted">普通讨论会不能生成任务。</p> : meeting.taskDraftStages.length ? meeting.taskDraftStages.map((stage) => <div className="draft-stage" key={stage.id}><b>阶段 {stage.position + 1} · {stage.name}</b><p>{stage.objective}</p>{stage.tasks.map((draft) => <div className="draft" key={draft.id}><b>{draft.title}</b><span>→ {memberName(identities, draft.assigneeId)}</span><small>{draft.acceptanceCriteria}</small></div>)}</div>) : <p className="muted">主持人尚未提交分阶段任务草案。</p>}</section>
        </aside>
      </div>}
    <QueueSection queue={snapshot.meetings.queue} history={snapshot.meetings.history} reorder={reorder} cancel={cancel} identities={identities} />
  </>;
}

function HostDispatchState({ dispatch, hostName }: { dispatch: NonNullable<MeetingDetail["hostDispatchStatus"]>; hostName: string }) {
  const label = dispatch.status === "pending" ? "主持人启动任务已排队" : dispatch.status === "running" ? "正在唤醒主持人" : "主持人启动失败";
  return <div className={`host-dispatch ${dispatch.status}`}><i /><div><b>{label}</b><span>{hostName} · 第 {dispatch.attempts || 1} 次尝试</span>{dispatch.lastError ? <small>{dispatch.lastError}</small> : null}</div></div>;
}

export function MeetingCloseoutState({ meeting }: { meeting: MeetingDetail }) {
  const status = meeting.closeoutStatus!;
  return <div className="meeting-closeout"><span>会议讨论已经结束</span><h3>正在向全体参会者同步最终记录</h3><p>已送达 {status.delivered}/{status.total}。全部成员确认同步后，会议室才会启动下一场。</p><div className="closeout-progress"><i style={{ width: `${status.total ? status.delivered / status.total * 100 : 0}%` }} /></div>{status.currentMemberName ? <small>当前：{status.currentMemberName} · 第 {status.attempts || 1} 次尝试</small> : null}{status.lastError ? <em>{status.lastError}</em> : null}</div>;
}

export function MeetingCloseoutMemberList({ meeting }: { meeting: MeetingDetail }) {
  return <section className="panel compact closeout-members"><div className="panel-title">最终记录送达 <span>{meeting.closeoutStatus?.delivered}/{meeting.closeoutStatus?.total}</span></div>{meeting.closeoutDispatches.map((dispatch) => <div className={`closeout-member ${dispatch.status}`} key={dispatch.id}><i /><div><b>{dispatch.memberName}</b><small>{closeoutDispatchStatus(dispatch.status)} · 第 {dispatch.attempts || 1} 次尝试</small>{dispatch.lastError ? <span>{dispatch.lastError}</span> : null}</div></div>)}</section>;
}

function MeetingEntryMemberList({ meeting }: { meeting: MeetingDetail }) {
  const total = meeting.entryStatus.total;
  const arrived = meeting.entryState === "ready" ? total : meeting.entryStatus.notified;
  return <section className="panel compact meeting-entry-members">
    <div className="panel-title">固定 meeting Sessions <span>已到 {arrived}/{total}</span></div>
    <div className="entry-session-list">
      {meeting.memberSessions.map((session) => <div className={`entry-session ${session.status}`} key={session.id}>
        <i />
        <div><b>{session.memberName}</b><small>{session.status === "ready" ? "固定 meeting session 已绑定" : session.status === "archived" ? "本场绑定已释放，记录保留" : session.status === "failed" ? "绑定失败，等待重试" : "等待绑定"}</small>{session.lastError ? <span>{session.lastError}</span> : null}</div>
      </div>)}
    </div>
  </section>;
}

function MeetingMessageRow({ message, identities }: { message: MeetingDetail["messages"][number]; identities: MemberIdentityMap }) {
  const id = message.authorKind === "boss" ? "boss" : message.authorId ?? "system";
  const identity = message.authorKind === "system"
    ? { id: "system", name: "系统", title: "", avatarUrl: null, emoji: null }
    : memberIdentity(identities, id);
  return <div className={`message ${message.authorKind}`}>
    {message.authorKind === "system"
      ? <CompanyOsSystemAvatar className="avatar" />
      : <AgentAvatar identity={identity} className="avatar" />}
    <div><div className="message-meta"><b>{identity.name}</b>{message.authorKind === "member" ? <small className="speaker-id">{id}</small> : null}{message.targetId ? <span>@{memberName(identities, message.targetId)}</span> : null}<time>{formatTime(message.createdAt)}</time></div><p>{message.body}</p></div>
  </div>;
}

function QueueSection({ queue, history, reorder, cancel, identities }: { queue: MeetingSummary[]; history: MeetingSummary[]; reorder: (m: MeetingSummary, d: number) => void; cancel: (m: MeetingSummary) => void; identities: MemberIdentityMap }) {
  return <section className="queue-section"><div className="section-title"><div><span>WAITING LINE</span><h2>会议队列</h2></div><strong>{queue.length}</strong></div>
    <div className="queue-list">{queue.length ? queue.map((item, index) => <div className="queue-item" key={item.id}><span className="queue-number">{index + 1}</span><div><b>{item.title}</b><small>{item.type === "task" ? "任务会议" : "普通讨论"} · 主持人 {memberName(identities, item.hostId)} · {item.bossParticipates ? "Boss 直接参会 · " : ""}{formatTime(item.createdAt)}</small></div><div className="queue-actions"><button disabled={index === 0} onClick={() => void reorder(item, -1)}>↑</button><button disabled={index === queue.length - 1} onClick={() => void reorder(item, 1)}>↓</button><button className="danger" onClick={() => void cancel(item)}>取消</button></div></div>) : <p className="muted">当前没有排队会议。</p>}</div>
    <MeetingHistory history={history} identities={identities} />
  </section>;
}

function TasksPage({ snapshot, reload }: { snapshot: Snapshot; reload: (quiet?: boolean) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(location.search).get("task") ?? snapshot.tasks[0]?.id ?? "");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [status, setStatus] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [rootId, setRootId] = useState("all");
  const [rootStatus, setRootStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [abortDraft, setAbortDraft] = useState<TaskAbortDraft | null>(null);
  const roots = snapshot.tasks.filter((task) => !task.parentId);
  const filteredRoots = filterRootTasks(roots, rootId, rootStatus);
  const reviewRootCount = roots.filter((task) => task.status === "review").length;
  const expandForFilter = Boolean(search) || status !== "all" || assignee !== "all";
  useEffect(() => { if (selectedId) void getTask(selectedId).then(setDetail).catch((error) => window.alert(messageOf(error))); }, [selectedId, snapshot.generatedAt]);
  const visible = (task: Task) => (status === "all" || task.status === status) && (assignee === "all" || task.assigneeId === assignee) && (!search || `${task.title} ${task.description}`.toLowerCase().includes(search.toLowerCase()));
  const createRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const requireTaskMeeting = data.get("requireTaskMeeting") === "true";
    try {
      const files = data.getAll("attachments").filter((value): value is File => value instanceof File && value.size > 0);
      const attachments = await taskImageInputs(files);
      const task = await post<Task>("/tasks", {
      title: String(data.get("title") ?? ""),
      assigneeId: String(data.get("assigneeId") ?? ""),
      description: String(data.get("description") ?? ""),
      acceptanceCriteria: String(data.get("acceptanceCriteria") ?? ""),
      requireTaskMeeting,
      taskMeetingBossParticipates: requireTaskMeeting && data.get("taskMeetingBossParticipates") === "true",
      attachments,
    });
      form.reset(); setAbortDraft(null); await reload(true); setSelectedId(task.id);
    } catch (error) { window.alert(messageOf(error)); }
  };
  const taskAborted = async (result: TaskAbortResponse) => {
    setAbortDraft(result.draft);
    setDetail(result.task);
    await reload(true);
    requestAnimationFrame(() => document.getElementById("task-submission-registry")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  return <>
    <PageHeader eyebrow="STRICT HIERARCHY · BOTTOM-UP CLOSURE" title="多级任务系统" summary="每个任务只有一名负责人。子任务全部终结后，上一级才有资格提交验收。" />
    <TaskRollingPoolPanel summary={snapshot.taskPromptPool} organization={snapshot.organization} reload={reload} />
    <div className="task-toolbar panel">
      <div className="task-toolbar-summary"><span>根任务 <b>{roots.length}</b></span><span className={reviewRootCount ? "has-review" : ""}>待验收根任务 <b>{reviewRootCount}</b></span><small>分支默认折叠</small></div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务标题或说明" />
      <select aria-label="根任务" value={rootId} onChange={(e) => setRootId(e.target.value)}><option value="all">全部根任务（{roots.length}）</option>{roots.map((root) => <option value={root.id} key={root.id}>{root.title} · {taskStatus(root.status)}</option>)}</select>
      <select aria-label="根任务状态" value={rootStatus} onChange={(e) => setRootStatus(e.target.value)}><option value="all">全部根任务状态</option>{TASK_STATUS_FILTERS.map((value) => <option value={value} key={value}>{value === "review" ? "待验收根任务" : taskStatus(value)}</option>)}</select>
      <select aria-label="任务状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部任务状态</option>{TASK_STATUS_FILTERS.map((value) => <option value={value} key={value}>{taskStatus(value)}</option>)}</select>
      <select aria-label="任务负责人" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="all">全部负责人</option>{snapshot.organization.filter((m) => m.active && m.kind === "agent").map((m) => <option value={m.id} key={m.id}>{m.name} · {m.id}</option>)}</select>
    </div>
    <div className="tasks-layout">
      <section className="task-tree panel">
        <div className="panel-title">任务树 <span>{filteredRoots.length}/{roots.length} 个根任务 · {snapshot.tasks.length} 项任务</span></div>
        {filteredRoots.length ? filteredRoots.map((root) => <TaskNode key={root.id} task={root} all={snapshot.tasks} visible={visible} selectedId={selectedId} select={setSelectedId} depth={0} expandForFilter={expandForFilter} />) : roots.length ? <Empty title="没有符合筛选条件的根任务" body="调整根任务、根任务状态或任务条件后再查看。" /> : <Empty title="还没有根任务" body="Boss 可在右侧创建第一个战略根任务。" />}
      </section>
      <aside className="task-detail panel">{detail ? <TaskDetailView detail={detail} reload={reload} onAborted={taskAborted} /> : <RootTaskForm key={abortDraft?.sourceTaskId ?? "blank-side"} members={snapshot.organization.filter((m) => m.active && m.managerId === "boss")} submit={createRoot} draft={abortDraft} />}</aside>
    </div>
    <section className={`new-root panel ${abortDraft ? "has-abort-draft" : ""}`} id="task-submission-registry"><div><span className="eyebrow">BOSS ONLY · TASK REGISTRY</span><h3>任务提交注册表</h3><p>{abortDraft ? `已从中止任务「${abortDraft.title}」自动填入，可直接派发或修改后派发。` : "根任务只能派给 Boss 的一级直属员工。"}</p></div><RootTaskForm key={abortDraft?.sourceTaskId ?? "blank-compact"} members={snapshot.organization.filter((m) => m.active && m.managerId === "boss")} submit={createRoot} compact draft={abortDraft} /></section>
  </>;
}

export function TaskCheckinPanel({ summary }: { summary: TaskHourlyCheckinSummary }) {
  const run = summary.today.latestRun;
  return <section className="task-checkin-panel panel">
    <div className="task-checkin-heading">
      <div><span className="eyebrow">HOURLY TASK CHECK-IN</span><h2>今日任务整点巡检</h2></div>
      <Badge tone={summary.enabled ? "completed" : "canceled"}>{summary.enabled ? `整点 ${String(summary.startHour).padStart(2, "0")}:00–${String(summary.endHour).padStart(2, "0")}:00` : "已关闭"}</Badge>
    </div>
    <div className="task-checkin-stats">
      <TaskCheckinMetric label="最新一轮" value={run ? formatTime(run.scheduledAt) : "今日尚未运行"} />
      <TaskCheckinMetric label="候选员工" value={String(run?.candidateEmployees ?? 0)} />
      <TaskCheckinMetric label="计划提醒" value={String(run?.plannedReminders ?? 0)} />
      <TaskCheckinMetric label="已送达" value={String(run?.delivered ?? 0)} />
      <TaskCheckinMetric label="失败 / 跳过" value={`${run?.failed ?? 0} / ${run?.skipped ?? 0}`} tone={(run?.failed ?? 0) > 0 ? "danger" : undefined} />
      <TaskCheckinMetric label="当前积压" value={String(summary.backlog)} tone={summary.backlog > 0 ? "warning" : undefined} />
    </div>
    <div className="task-checkin-footer">
      <span>下一轮：{formatTime(summary.nextRunAt)}</span>
      <span>下一提醒：{summary.nextDispatch ? `${formatTime(summary.nextDispatch.scheduledAt)} · ${summary.nextDispatch.targetMemberId} · ${summary.nextDispatch.title}（${taskCheckinAction(summary.nextDispatch.actionKind)}）` : "—"}</span>
      <span>Boss：待验收 {summary.boss.reviewCount} · 异常 {summary.boss.anomalyCount} · 邮件 {taskCheckinStatus(summary.boss.emailStatus)}</span>
      {summary.boss.lastError ? <em>{summary.boss.lastError}</em> : null}
    </div>
  </section>;
}

export function TaskRollingPoolPanel({ summary, organization = [], reload }: {
  summary: Snapshot["taskPromptPool"];
  organization?: Snapshot["organization"];
  reload?: (quiet?: boolean) => Promise<void>;
}) {
  const [clockNow, setClockNow] = useState(() => Date.now());
  const identities = useMemberIdentities(organization);
  const minutesPerLevel = Number.isInteger(summary.minutesPerLevel) && Number(summary.minutesPerLevel) > 0
    ? Number(summary.minutesPerLevel)
    : 5;
  const paused = Boolean(summary.paused);
  const queues = summary.queues.map((queue) => normalizeTaskPromptQueue(queue, organization, minutesPerLevel));
  const busySkips = queues.filter((queue) => queue.lastDispatch?.status === "skipped_busy").length;
  const failures = queues.filter((queue) => queue.lastDispatch?.status === "failed").length;
  useEffect(() => {
    if (!summary.enabled || paused || !summary.queues.some((queue) => queue.nextDueAt)) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [summary.enabled, paused, summary.queues]);
  return <section className="task-checkin-panel panel">
    <div className="task-checkin-heading">
      <div><span className="eyebrow">ROLLING TASK PROMPT POOL</span><h2>任务回转提示池</h2></div>
      <Badge tone={!summary.enabled ? "canceled" : paused ? "blocked" : "completed"}>{!summary.enabled ? "已关闭" : paused ? "全公司回转已暂停" : `${String(summary.startHour).padStart(2, "0")}:00–${String(summary.endHour + 1).padStart(2, "0")}:00 · 个人倒计时`}</Badge>
    </div>
    {reload ? <TaskPromptWorkHoursControl summary={summary} reload={reload} /> : null}
    <div className="task-checkin-stats">
      <TaskCheckinMetric label="队列员工" value={String(summary.totals.employees)} />
      <TaskCheckinMetric label="池内事项" value={String(summary.totals.items)} />
      <TaskCheckinMetric label="执行" value={String(summary.totals.execution)} />
      <TaskCheckinMetric label="待验收" value={String(summary.totals.review)} />
      <TaskCheckinMetric label="阻塞审查" value={String(summary.totals.blockedReview)} />
      <TaskCheckinMetric label="忙碌跳过 / 失败" value={`${busySkips} / ${failures}`} tone={failures ? "danger" : busySkips ? "warning" : undefined} />
    </div>
    <div className="task-checkin-footer">
      <span>{paused ? `全公司暂停于：${formatTime(summary.pausedAt ?? null)}` : `全员最近到期：${formatTime(summary.nextDueAt)}`}</span>
      {queues.filter((queue) => queue.count > 0).map((queue) => <span key={queue.memberId}>
        {queue.memberName}：{queue.count} 项 · {queue.intervalMinutes} 分钟 · 剩余 {formatRemainingMinutes(queue.remainingWorkMinutes)} · 池首 {queue.head ? `${taskPromptKind(queue.head.kind)}「${queue.head.title}」` : "—"}
        {queue.lastDispatch ? ` · 最近 ${taskPromptStatus(queue.lastDispatch.status)}` : ""}
      </span>)}
    </div>
    {queues.length ? <div className="task-prompt-queue-details">
      {queues.map((queue) => <section key={queue.memberId}>
        <div className="task-prompt-queue-heading">
          <div className="task-prompt-queue-member">
            <AgentAvatar identity={memberIdentity(identities, queue.memberId, queue.memberName)} className="task-prompt-queue-avatar" />
            <b>{queue.memberName}</b>
            {queue.memberTitle ? <span className="task-prompt-member-title" title={queue.memberTitle}>{queue.memberTitle}</span> : null}
            <small>FIFO 队列</small>
          </div>
          <span>{queue.level} 级默认 {queue.defaultIntervalMinutes} 分钟{queue.intervalOverrideMinutes != null ? ` · Boss 覆盖 ${queue.intervalOverrideMinutes} 分钟` : ""}</span>
          {reload ? <TaskPromptIntervalControl queue={queue} reload={reload} /> : null}
        </div>
        <TaskPromptCountdown summary={summary} queue={queue} now={clockNow} />
        {queue.items.map((item, index) => <div className={`task-prompt-queue-item is-${item.kind}`} key={`${item.kind}:${item.taskId}`}>
          <span>{index + 1}</span><Badge tone={item.kind === "blocked_review" ? "blocked" : item.kind === "review" ? "review" : "in_progress"}>{taskPromptKind(item.kind)}</Badge>
          <strong>{item.title}</strong>{item.parentTitle ? <small>父任务：{item.parentTitle}</small> : null}
        </div>)}{queue.items.length === 0 ? <small className="task-prompt-empty">当前队列为空，倒计时已停止。</small> : null}
      </section>)}
    </div> : null}
  </section>;
}

function TaskPromptWorkHoursControl({ summary, reload }: {
  summary: Snapshot["taskPromptPool"];
  reload: (quiet?: boolean) => Promise<void>;
}) {
  const [startHour, setStartHour] = useState(String(summary.startHour));
  const [endExclusiveHour, setEndExclusiveHour] = useState(String(summary.endHour + 1));
  const [minutesPerLevel, setMinutesPerLevel] = useState(String(summary.minutesPerLevel ?? 5));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setStartHour(String(summary.startHour));
    setEndExclusiveHour(String(summary.endHour + 1));
    setMinutesPerLevel(String(summary.minutesPerLevel ?? 5));
  }, [summary.startHour, summary.endHour, summary.minutesPerLevel]);
  const saveHours = async (restore = false) => {
    setSaving(true);
    try {
      await put("/task-prompt-settings", restore
        ? { startHour: null, endHour: null }
        : { startHour: Number(startHour), endHour: Number(endExclusiveHour) - 1 });
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setSaving(false);
    }
  };
  const saveMinutesPerLevel = async (restore = false) => {
    setSaving(true);
    try {
      await put("/task-prompt-settings/global", { minutesPerLevel: restore ? null : Number(minutesPerLevel) });
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setSaving(false);
    }
  };
  const togglePaused = async () => {
    setSaving(true);
    try {
      await put("/task-prompt-settings/pause", { paused: !summary.paused });
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setSaving(false);
    }
  };
  const valid = Number(startHour) >= 0 && Number(endExclusiveHour) <= 24 && Number(startHour) < Number(endExclusiveHour);
  const validMinutesPerLevel = /^\d+$/.test(minutesPerLevel) && Number(minutesPerLevel) >= 1 && Number(minutesPerLevel) <= 600;
  return <div className="task-prompt-work-hours">
    <div><b>全公司回转节奏</b><small>上班时间内按层级 × 系数；暂停时保留队列和剩余倒计时</small></div>
    <label>开始<select value={startHour} disabled={saving} onChange={(event) => setStartHour(event.target.value)}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
    <label>结束<select value={endExclusiveHour} disabled={saving} onChange={(event) => setEndExclusiveHour(event.target.value)}>{Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></label>
    <button type="button" disabled={saving || !valid} onClick={() => void saveHours(false)}>应用时间</button>
    <button type="button" className="ghost" disabled={saving || summary.workHoursSource !== "boss_override"} onClick={() => void saveHours(true)}>恢复时间默认</button>
    <label>层级系数（分钟）<input type="number" min={1} max={600} value={minutesPerLevel} disabled={saving} onChange={(event) => setMinutesPerLevel(event.target.value)} /></label>
    <button type="button" disabled={saving || !validMinutesPerLevel} onClick={() => void saveMinutesPerLevel(false)}>应用系数</button>
    <button type="button" className="ghost" disabled={saving || summary.minutesPerLevelSource !== "boss_override"} onClick={() => void saveMinutesPerLevel(true)}>恢复系数默认</button>
    <button type="button" className={summary.paused ? "primary" : "danger-button"} disabled={saving || !summary.enabled} onClick={() => void togglePaused()}>{summary.paused ? "恢复任务回转" : "暂停任务回转"}</button>
    <Badge tone={summary.paused ? "blocked" : summary.minutesPerLevelSource === "boss_override" || summary.workHoursSource === "boss_override" ? "review" : "completed"}>{summary.paused ? "已暂停" : summary.minutesPerLevelSource === "boss_override" || summary.workHoursSource === "boss_override" ? "Boss 手动设置" : "配置默认"}</Badge>
  </div>;
}

function normalizeTaskPromptQueue(
  queue: Snapshot["taskPromptPool"]["queues"][number],
  organization: Snapshot["organization"],
  minutesPerLevel: number,
) {
  const organizationMember = organization.find((candidate) => candidate.id === queue.memberId);
  const organizationLevel = inferOrganizationLevel(queue.memberId, organization);
  const rawLevel = Number(queue.level);
  const level = Number.isInteger(rawLevel) && rawLevel > 0
    ? rawLevel
    : Number.isInteger(organizationLevel) && Number(organizationLevel) > 0 ? Number(organizationLevel) : 1;
  const rawDefault = Number(queue.defaultIntervalMinutes);
  const defaultIntervalMinutes = Number.isInteger(rawDefault) && rawDefault > 0 ? rawDefault : Math.min(600, level * minutesPerLevel);
  const rawOverride = queue.intervalOverrideMinutes == null ? null : Number(queue.intervalOverrideMinutes);
  const intervalOverrideMinutes = rawOverride !== null && Number.isInteger(rawOverride) && rawOverride > 0 ? rawOverride : null;
  const rawInterval = Number(queue.intervalMinutes);
  const intervalMinutes = Number.isInteger(rawInterval) && rawInterval > 0
    ? rawInterval
    : intervalOverrideMinutes ?? defaultIntervalMinutes;
  return {
    ...queue,
    memberTitle: organizationMember?.title?.trim() || null,
    level,
    defaultIntervalMinutes,
    intervalOverrideMinutes,
    intervalMinutes,
    intervalSource: intervalOverrideMinutes === null ? "level_default" as const : "boss_override" as const,
  };
}

function inferOrganizationLevel(memberId: string, organization: Snapshot["organization"]) {
  const member = organization.find((candidate) => candidate.id === memberId);
  if (!member) return undefined;
  const declared = Number(member.level);
  if (Number.isInteger(declared) && declared > 0) return declared;
  let level = 0;
  let current: typeof member | undefined = member;
  const visited = new Set<string>();
  while (current && current.kind !== "boss" && !visited.has(current.id)) {
    visited.add(current.id);
    level += 1;
    current = current.managerId ? organization.find((candidate) => candidate.id === current!.managerId) : undefined;
  }
  return level || undefined;
}

function TaskPromptCountdown({ summary, queue, now }: {
  summary: Snapshot["taskPromptPool"];
  queue: Snapshot["taskPromptPool"]["queues"][number];
  now: number;
}) {
  const due = queue.nextDueAt ? Date.parse(queue.nextDueAt) : null;
  const remainingMs = summary.paused
    ? queue.remainingWorkMinutes == null ? null : queue.remainingWorkMinutes * 60_000
    : due === null ? null : remainingShanghaiWorkMilliseconds(now, due, summary.startHour, summary.endHour);
  const inWorkWindow = isShanghaiWorkTime(now, summary.startHour, summary.endHour);
  const state = !summary.enabled
    ? { tone: "stopped", label: "调度已关闭", value: "已停止" }
    : summary.paused
      ? { tone: "paused", label: "Boss 已暂停全公司回转", value: remainingMs === null ? "已暂停" : formatCountdown(remainingMs) }
    : queue.count === 0
      ? { tone: "stopped", label: "队列为空", value: "已停止" }
      : remainingMs === null
        ? queue.head
          ? { tone: "due", label: "等待调度器建立倒计时", value: "待调度" }
          : { tone: "paused", label: "暂无可投递池首", value: "已暂停" }
        : remainingMs === 0
          ? { tone: "due", label: "已到期", value: "00:00:00" }
          : inWorkWindow
            ? { tone: "running", label: "倒计时进行中", value: formatCountdown(remainingMs) }
            : { tone: "paused", label: "非工作时间暂停", value: formatCountdown(remainingMs) };
  const progress = remainingMs === null
    ? 0
    : Math.max(0, Math.min(100, (1 - remainingMs / (queue.intervalMinutes * 60_000)) * 100));
  return <div className={`task-prompt-countdown is-${state.tone}`}>
    <div className="task-prompt-countdown-main">
      <div><small>个人倒计时</small><strong>{state.value}</strong></div>
      <Badge tone={state.tone}>{state.label}</Badge>
    </div>
    <div className="task-prompt-countdown-track" aria-label={`${queue.memberName} 倒计时进度`}><i style={{ width: `${progress}%` }} /></div>
    <div className="task-prompt-countdown-meta">
      <span>下次到期 <time>{formatTimeWithSeconds(queue.nextDueAt)}</time></span>
      <span>有效周期 {queue.intervalMinutes} 分钟 · {queue.intervalSource === "boss_override" ? "Boss 覆盖" : `${queue.level} 级默认`}</span>
      <span>当前池首 {queue.head ? `${taskPromptKind(queue.head.kind)}「${queue.head.title}」` : "—"}</span>
    </div>
    {queue.lastDispatch ? <div className="task-prompt-countdown-last">
      <span>最近调度：{taskPromptStatus(queue.lastDispatch.status)}</span>
      <time>{formatTimeWithSeconds(queue.lastDispatch.completedAt ?? queue.lastDispatch.scheduledAt)}</time>
      {queue.lastDispatch.lastError ? <small title={queue.lastDispatch.lastError}>{queue.lastDispatch.lastError}</small> : null}
    </div> : <div className="task-prompt-countdown-last"><span>最近调度：暂无记录</span></div>}
  </div>;
}

function TaskPromptIntervalControl({ queue, reload }: { queue: Snapshot["taskPromptPool"]["queues"][number]; reload: (quiet?: boolean) => Promise<void> }) {
  const [value, setValue] = useState(String(queue.intervalMinutes));
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(String(queue.intervalMinutes)), [queue.intervalMinutes]);
  const save = async (intervalMinutes: number | null) => {
    setSaving(true);
    try {
      await put(`/task-prompt-settings/${encodeURIComponent(queue.memberId)}`, { intervalMinutes });
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setSaving(false);
    }
  };
  return <div className="task-prompt-interval-control">
    <input type="number" min={1} max={600} value={value} disabled={saving} aria-label={`${queue.memberName} 提醒间隔（分钟）`} onChange={(event) => setValue(event.target.value)} />
    <button type="button" disabled={saving || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600} onClick={() => void save(Number(value))}>应用</button>
    <button type="button" className="ghost" disabled={saving || queue.intervalOverrideMinutes === null} onClick={() => void save(null)}>恢复层级默认</button>
  </div>;
}

function TaskCheckinMetric({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return <div className={tone ? `task-checkin-metric is-${tone}` : "task-checkin-metric"}><small>{label}</small><strong>{value}</strong></div>;
}

export function TaskNode({ task, all, visible, selectedId, select, depth, inStage = false, defaultExpanded = false, expandForFilter = false }: { task: Task; all: Task[]; visible: (t: Task) => boolean; selectedId: string; select: (id: string) => void; depth: number; inStage?: boolean; defaultExpanded?: boolean; expandForFilter?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded || expandForFilter);
  useEffect(() => setExpanded(defaultExpanded || expandForFilter), [defaultExpanded, expandForFilter]);
  const children = all.filter((item) => item.parentId === task.id);
  const subtreeVisible = taskSubtreeContainsVisible(task, all, visible);
  if (!subtreeVisible) return null;
  const visibleChildren = children.filter((child) => taskSubtreeContainsVisible(child, all, visible));
  const stageGroups = groupTasksByFlowStage(visibleChildren, children);
  const ungrouped = visibleChildren.filter((child) => !child.flowStage);
  const hasChildren = stageGroups.length > 0 || ungrouped.length > 0;
  const showChildren = hasChildren && expanded;
  return <div className="task-branch">
    <div className={`task-row ${selectedId === task.id ? "selected" : ""}`} style={{ paddingLeft: 8 + depth * 22 }}>
      {hasChildren ? <button type="button" className="task-disclosure" aria-label={`${expanded ? "折叠" : "展开"}${task.title}`} aria-expanded={showChildren} onClick={() => setExpanded((current) => !current)}>{showChildren ? "▾" : "▸"}</button> : <span className="task-disclosure-spacer" />}
      <button type="button" className="task-row-select" onClick={() => select(task.id)}>
        <span className="tree-joint">{inStage ? "●" : depth ? "└" : "◆"}</span><span className="task-main"><b>{task.title}</b><small>{task.assigneeId} · v{task.revision} · {shortId(task.id)}</small></span><Badge tone={task.status}>{taskStatus(task.status)}</Badge>{task.availability !== "active" ? <Badge tone="waiting">{taskAvailability(task.availability)}</Badge> : null}
        {task.risks.blockedDescendants ? <span className="risk blocked">阻塞 {task.risks.blockedDescendants}</span> : null}{task.risks.stale || task.risks.staleDescendants ? <span className="risk stale">停滞 {Number(task.risks.stale) + task.risks.staleDescendants}</span> : null}{task.childCounts.canceled ? <span className="risk canceled">取消 {task.childCounts.canceled}</span> : null}
      </button>
    </div>
    {showChildren && stageGroups.length ? <div className="task-stage-sequence">
      {stageGroups.map((group, index) => <TaskStageGroup
        key={group.stage.stageId}
        group={group}
        index={index}
        all={all}
        visible={visible}
        selectedId={selectedId}
        select={select}
        depth={depth}
        defaultExpanded={defaultExpanded}
        expandForFilter={expandForFilter}
      />)}
    </div> : null}
    {showChildren ? ungrouped.map((child) => <TaskNode key={child.id} task={child} all={all} visible={visible} selectedId={selectedId} select={select} depth={depth + 1} defaultExpanded={defaultExpanded} expandForFilter={expandForFilter} />) : null}
  </div>;
}

type TaskStageGroupData = {
  stage: NonNullable<Task["flowStage"]>;
  tasks: Task[];
  totalTasks: number;
  closedTasks: number;
};

function groupTasksByFlowStage(visibleChildren: Task[], allChildren: Task[]): TaskStageGroupData[] {
  const groups = new Map<string, TaskStageGroupData>();
  for (const child of allChildren) {
    if (!child.flowStage) continue;
    const current = groups.get(child.flowStage.stageId) ?? {
      stage: child.flowStage,
      tasks: [],
      totalTasks: 0,
      closedTasks: 0,
    };
    current.totalTasks += 1;
    if (child.status === "closed") current.closedTasks += 1;
    groups.set(child.flowStage.stageId, current);
  }
  for (const child of visibleChildren) {
    if (child.flowStage) groups.get(child.flowStage.stageId)?.tasks.push(child);
  }
  return [...groups.values()]
    .filter((group) => group.tasks.length > 0)
    .sort((left, right) => left.stage.position - right.stage.position);
}

function TaskStageGroup({ group, index, all, visible, selectedId, select, depth, defaultExpanded, expandForFilter }: {
  group: TaskStageGroupData;
  index: number;
  all: Task[];
  visible: (task: Task) => boolean;
  selectedId: string;
  select: (id: string) => void;
  depth: number;
  defaultExpanded: boolean;
  expandForFilter: boolean;
}) {
  const { stage, tasks, totalTasks, closedTasks } = group;
  return <>
    {index > 0 ? <div className="task-stage-transition"><i /><span>阶段屏障</span><i /></div> : null}
    <section className={`task-stage-group is-${stage.status}`} style={{ marginLeft: 18 + depth * 22 }}>
      <header>
        <div className="task-stage-index"><span>STAGE</span><strong>{String(stage.position + 1).padStart(2, "0")}</strong></div>
        <div className="task-stage-copy"><div><b>{stage.name}</b><Badge tone={stage.status}>{taskFlowTreeStageStatus(stage.status)}</Badge></div><p>{stage.objective}</p></div>
        <div className="task-stage-progress"><strong>{closedTasks}/{totalTasks}</strong><span>验收完成</span><small>同阶段并行 {totalTasks} 项</small></div>
      </header>
      <div className="task-stage-progress-track"><i style={{ width: `${totalTasks ? closedTasks / totalTasks * 100 : 0}%` }} /></div>
      <div className="task-stage-items">
        {tasks.map((child) => <TaskNode key={child.id} task={child} all={all} visible={visible} selectedId={selectedId} select={select} depth={depth + 1} inStage defaultExpanded={defaultExpanded} expandForFilter={expandForFilter} />)}
      </div>
    </section>
  </>;
}

function taskSubtreeContainsVisible(task: Task, all: Task[], visible: (task: Task) => boolean): boolean {
  return visible(task) || all.filter((item) => item.parentId === task.id)
    .some((child) => taskSubtreeContainsVisible(child, all, visible));
}

export function filterRootTasks(roots: Task[], rootId: string, rootStatus: string) {
  return roots.filter((root) => (rootId === "all" || root.id === rootId) && (rootStatus === "all" || root.status === rootStatus));
}

export function TaskDetailView({ detail, reload, onAborted }: { detail: TaskDetail; reload: (quiet?: boolean) => Promise<void>; onAborted?: (result: TaskAbortResponse) => void | Promise<void> }) {
  const [reminding, setReminding] = useState(false);
  const [reviewMode, setReviewMode] = useState<"accept" | "reject" | "fail" | null>(null);
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [abortOpen, setAbortOpen] = useState(false);
  const [abortReason, setAbortReason] = useState("");
  const [abortBusy, setAbortBusy] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  useEffect(() => {
    setAbortOpen(false);
    setAbortReason("");
    setAbortError(null);
  }, [detail.id]);
  const action = async (name: string, body: Record<string, unknown>) => {
    try { await post(`/tasks/${detail.id}/${name}`, body); await reload(true); } catch (error) { window.alert(messageOf(error)); }
  };
  const remind = async () => {
    setReminding(true);
    try {
      await post(`/tasks/${detail.id}/remind`, {});
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setReminding(false);
    }
  };
  const submitReview = async () => {
    if (!reviewMode || (reviewMode !== "accept" && !reviewFeedback.trim())) return;
    setReviewing(true);
    try {
      await post(`/tasks/${detail.id}/review`, { decision: reviewMode, feedback: reviewFeedback.trim() });
      setReviewMode(null);
      setReviewFeedback("");
      await reload(true);
    } catch (error) {
      window.alert(messageOf(error));
    } finally {
      setReviewing(false);
    }
  };
  const reviewCancellation = async (decision: "accept" | "reject") => {
    if (!detail.pendingCancelRequest) return;
    const feedback = decision === "reject"
      ? window.prompt("驳回取消申请的理由：")
      : window.prompt("批准取消的意见（可选）：", "") ?? "";
    if (decision === "reject" && !feedback) return;
    try {
      await post(`/tasks/${detail.id}/cancel-requests/${detail.pendingCancelRequest.id}/review`, { decision, feedback });
      await reload(true);
    } catch (error) { window.alert(messageOf(error)); }
  };
  const correctTerminal = async (actionName: "revoke_acceptance" | "restore_cancellation") => {
    const reason = window.prompt(actionName === "revoke_acceptance" ? "二次审查不通过的原因和整改方向：" : "恢复取消任务的原因：");
    if (!reason) return;
    await action("correct", { action: actionName, reason });
  };
  const submitAbort = async () => {
    if (!abortReason.trim()) return;
    setAbortBusy(true);
    setAbortError(null);
    try {
      const result = await post<TaskAbortResponse>("/tasks/" + detail.id + "/abort", { reason: abortReason.trim() });
      setAbortOpen(false);
      setAbortReason("");
      if (onAborted) await onAborted(result);
      else await reload(true);
    } catch (error) {
      setAbortError(messageOf(error));
    } finally {
      setAbortBusy(false);
    }
  };
  const review = detail.status === "review" && detail.parentId === null;
  const remindReviewer = detail.parentId !== null && (detail.status === "review" || detail.status === "blocked");
  const canRemind = (["assigned", "in_progress"] as string[]).includes(detail.status) || remindReviewer;
  const reminderActive = detail.reminderDispatch?.status === "pending" || detail.reminderDispatch?.status === "running";
  return <div>
    <div className="detail-head"><Badge tone={detail.status}>{taskStatus(detail.status)}</Badge><code>{detail.id}</code></div>
    <h2>{detail.title}</h2><div className="detail-meta"><span>负责人 <b>{detail.assigneeId}</b></span><span>派发者 <b>{detail.issuerId}</b></span><span>版本 <b>v{detail.revision}</b></span></div>
    {detail.taskMeetingRequirement ? <div className={`task-meeting-requirement is-${detail.taskMeetingRequirement.status}`}><b>任务拆解会要求：{taskMeetingRequirementStatus(detail.taskMeetingRequirement.status)}</b><span>{detail.taskMeetingRequirement.meetingId ? `关联会议 ${shortId(detail.taskMeetingRequirement.meetingId)}` : "等待任务轮转到负责人池首"}</span><small>会议必须由负责人主持，并至少选择一名与任务相关的在职直属下属作为 worker，{detail.taskMeetingRequirement.bossParticipates ? "Boss 必须参加" : "Boss 不参加"}；成功形成任务流后才算完成。</small></div> : null}
    {detail.flowStage ? <div className="task-flow-context"><b>所属阶段 {detail.flowStage.position + 1} · {detail.flowStage.name}</b><span>{detail.flowStage.objective}</span><Badge tone={detail.flowStage.status}>{taskFlowStageStatus(detail.flowStage.status)}</Badge></div> : null}
    {detail.childFlow ? <DetailBlock title={`分阶段任务流 · 修订 ${detail.childFlow.revision}`}><div className="task-flow-stages">{detail.childFlow.stages.map((stage) => <div className={`task-flow-stage is-${stage.status}`} key={stage.id}><div><Badge tone={stage.status}>{taskFlowStageStatus(stage.status)}</Badge><b>阶段 {stage.position + 1} · {stage.name}</b><span>{stage.closedTaskCount}/{stage.requiredTaskCount} 个必需任务已完成</span></div><p>{stage.objective}</p></div>)}</div></DetailBlock> : null}
    {detail.childCounts.canceled ? <div className="warning">该任务包含 {detail.childCounts.canceled} 个已取消直接子任务。验收前请检查取消原因。</div> : null}
    <DetailBlock title="任务说明">{detail.description}</DetailBlock>
    {detail.attachments?.length ? <DetailBlock title={`图片附件 · ${detail.attachments.length}`}><TaskImageAttachmentGallery taskId={detail.id} attachments={detail.attachments} /></DetailBlock> : null}
    <DetailBlock title="验收标准">{detail.acceptanceCriteria}</DetailBlock>
    {detail.blockedReason ? <DetailBlock title="阻塞原因">{detail.blockedReason}</DetailBlock> : null}
    {detail.failedReason ? <DetailBlock title="任务失败原因">{detail.failedReason}</DetailBlock> : null}
    {detail.submissions[0] ? <DetailBlock title="最近提交"><b>{detail.submissions[0].summary}</b>{detail.submissions[0].gitLocation ? <><div className="evidence"><Badge tone="artifact">Git</Badge><span>远端</span><code>{detail.submissions[0].gitLocation.remoteUrl}</code></div><div className="evidence"><Badge tone="artifact">Git</Badge><span>分支</span><code>{detail.submissions[0].gitLocation.branch}</code></div><div className="evidence"><Badge tone="artifact">Git</Badge><span>冻结 commit</span><code>{detail.submissions[0].gitLocation.commit}</code></div><small>远端验证于 {formatTime(detail.submissions[0].gitLocation.verifiedAt)}</small></> : <div className="warning">该历史提交没有 Git 远端定位。</div>}{detail.submissions[0].evidence.map((item, i) => <div className="evidence" key={i}><Badge tone={item.type}>{item.type}</Badge><span>{item.label}</span><code>{item.path ?? item.url ?? item.command ?? item.note}</code></div>)}{detail.submissions[0].reviewHandoff ? <ReviewHandoffDetail handoff={detail.submissions[0].reviewHandoff} /> : null}</DetailBlock> : null}
    {detail.progress.length ? <DetailBlock title="进度记录">{detail.progress.map((item) => <div className="progress-entry" key={item.id}><span>{formatTime(item.createdAt)} · {item.authorId}</span><p>{item.body}</p></div>)}</DetailBlock> : null}
    {detail.versions.length > 1 ? <DetailBlock title="版本历史">{detail.versions.map((version) => <div className="version-entry" key={version.revision}><b>v{version.revision}</b><span>{version.changedBy} · {version.reason}</span><time>{formatTime(version.createdAt)}</time></div>)}</DetailBlock> : null}
    {detail.pendingCancelRequest ? <div className="warning"><b>等待 Boss 审批取消</b><p>{detail.pendingCancelRequest.requesterId}：{detail.pendingCancelRequest.reason}</p><div className="review-actions"><button className="danger-button" onClick={() => void reviewCancellation("accept")}>批准取消</button><button onClick={() => void reviewCancellation("reject")}>驳回申请</button></div></div> : null}
    {review ? <TaskReviewActions
      mode={reviewMode}
      feedback={reviewFeedback}
      busy={reviewing}
      choose={(mode) => { setReviewMode(mode); setReviewFeedback(""); }}
      changeFeedback={setReviewFeedback}
      submit={() => void submitReview()}
      cancel={() => { setReviewMode(null); setReviewFeedback(""); }}
    /> : null}
    {detail.reminderDispatch ? <div className={`reminder-status ${detail.reminderDispatch.status}`}><span>最近催办{detail.reminderDispatch.targetMemberId === detail.issuerId ? "审核人" : "负责人"}：{taskReminderStatus(detail.reminderDispatch.status)}</span><time>{formatTime(detail.reminderDispatch.completedAt ?? detail.reminderDispatch.startedAt ?? detail.reminderDispatch.createdAt)}</time>{detail.reminderDispatch.lastError ? <small>{detail.reminderDispatch.lastError}</small> : null}</div> : null}
    {detail.reviewNotificationDispatch ? <div className={`reminder-status review-notification ${detail.reviewNotificationDispatch.status}`}><span>最近验收通知：{taskReviewNotificationKind(detail.reviewNotificationDispatch.kind)} · {taskReminderStatus(detail.reviewNotificationDispatch.status)}</span><time>{formatTime(detail.reviewNotificationDispatch.completedAt ?? detail.reviewNotificationDispatch.startedAt ?? detail.reviewNotificationDispatch.createdAt)}</time>{detail.reviewNotificationDispatch.lastError ? <small>{detail.reviewNotificationDispatch.lastError}</small> : null}</div> : null}
    <details><summary>版本、进度与审计时间线</summary><div className="timeline">{detail.audit.map((item) => <div key={item.id}><i /><span>{formatTime(item.createdAt)}</span><b>{item.actorId}</b><code>{item.action}</code>{item.reason ? <small>{item.reason}</small> : null}</div>)}</div></details>
    {detail.status !== "aborted" && detail.status !== "failed" ? <>
      <div className="fallback-actions">{canRemind ? <button className="remind-button" disabled={reminding || reminderActive} onClick={() => void remind()}>{reminding || reminderActive ? `正在通知${remindReviewer ? "审核人" : "负责人"}…` : `催促${remindReviewer ? "审核人" : "负责人"}`}</button> : null}<button className={`danger-button ${abortOpen ? "active" : ""}`} onClick={() => { setAbortOpen(true); setAbortReason(""); setAbortError(null); }}>中止任务</button></div>
      {abortOpen ? <TaskAbortActionForm
        reason={abortReason}
        busy={abortBusy}
        error={abortError}
        changeReason={setAbortReason}
        submit={() => void submitAbort()}
        cancel={() => { setAbortOpen(false); setAbortError(null); }}
      /> : null}
    </> : detail.status === "aborted" ? <div className="task-aborted-summary"><b>该任务树已被 Boss 中止并永久退役</b><span>{detail.abortedReason}</span><time>{formatTime(detail.abortedAt)}</time></div> : <div className="task-aborted-summary"><b>该根任务已被 Boss 判定失败并终结</b><span>{detail.failedReason}</span><time>{formatTime(detail.failedAt)}</time></div>}
    {detail.status === "closed" ? <div className="fallback-actions"><button className="danger-button" onClick={() => void correctTerminal("revoke_acceptance")}>二次审查不通过</button></div> : null}
    {detail.status === "canceled" ? <div className="fallback-actions"><button onClick={() => void correctTerminal("restore_cancellation")}>恢复已取消任务</button></div> : null}
  </div>;
}

function ReviewHandoffDetail({ handoff }: { handoff: NonNullable<TaskDetail["submissions"][number]["reviewHandoff"]> }) {
  const deliveryLabels = { pending: "等待投递", delivering: "投递中", delivered: "已送达", failed: "投递失败" } as const;
  return <div className={`review-handoff is-${handoff.delivery.status}`}>
    <div className="review-handoff-head"><b>验收材料</b><Badge tone={handoff.delivery.status}>{deliveryLabels[handoff.delivery.status]}</Badge><span>{handoff.delivery.channel === "boss_email" ? "Boss 邮件" : "验收人 workspace"}</span></div>
    {handoff.delivery.targetPath ? <div className="evidence"><Badge tone="artifact">README</Badge><code>{handoff.delivery.targetPath}</code></div> : null}
    {handoff.files.map((file) => <div className="evidence" key={file.id}><Badge tone="artifact">{file.evidenceIndex === null ? "历史文件" : `证据 #${file.evidenceIndex + 1}`}</Badge><span>{file.fileName} · {formatBytes(file.byteSize)}</span><code>{file.sha256}</code></div>)}
    {handoff.functionalVerification ? <div className="review-command"><code>{handoff.functionalVerification.oneLineCommand}</code><button onClick={() => void navigator.clipboard.writeText(handoff.functionalVerification!.oneLineCommand)}>复制验收命令</button></div> : null}
    {handoff.delivery.lastError ? <small className="error-text">{handoff.delivery.lastError}</small> : null}
  </div>;
}

function TaskImageAttachmentGallery({ taskId, attachments }: { taskId: string; attachments: TaskDetail["attachments"] }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    setImages({});
    setFailed(new Set());
    attachments.forEach((attachment) => {
      void getTaskImageAttachment(taskId, attachment.id).then(
        (content) => { if (active) setImages((current) => ({ ...current, [attachment.id]: content.dataUrl })); },
        () => { if (active) setFailed((current) => new Set(current).add(attachment.id)); },
      );
    });
    return () => { active = false; };
  }, [taskId, attachments.map((attachment) => attachment.id).join(",")]);
  return <div className="task-image-gallery">{attachments.map((attachment) => <figure key={attachment.id}>
    {images[attachment.id] ? <a href={images[attachment.id]} target="_blank" rel="noreferrer"><img src={images[attachment.id]} alt={attachment.fileName} /></a> : <div className={`task-image-loading ${failed.has(attachment.id) ? "is-failed" : ""}`}>{failed.has(attachment.id) ? "图片加载失败" : "正在加载图片…"}</div>}
    <figcaption><b>{attachment.fileName}</b><span>{formatBytes(attachment.byteSize)}</span><code>{attachment.localPath}</code></figcaption>
  </figure>)}</div>;
}

export function TaskAbortActionForm({
  reason,
  busy,
  error,
  changeReason,
  submit,
  cancel,
}: {
  reason: string;
  busy: boolean;
  error: string | null;
  changeReason: (value: string) => void;
  submit: () => void;
  cancel: () => void;
}) {
  const disabled = busy || !reason.trim();
  return <div className="task-management-form is-abort">
    <span>BOSS FORCE ABORT</span>
    <h3>中止并废除任务树</h3>
    <p>该操作不受子任务状态限制：选中任务及全部后代会永久退役，待验收提交失效，未发送提醒撤销，相关任务会议废止。系统只发布一条公司公告，不单独通知任何人。</p>
    <label>中止原因（必填）<textarea rows={3} value={reason} disabled={busy} onChange={(event) => changeReason(event.target.value)} placeholder="说明为什么整棵任务树不再有效" /></label>
    {error ? <div className="task-management-error">{error}</div> : null}
    <div className="task-review-form-actions">
      <button type="button" className="danger-button" disabled={disabled} onClick={submit}>{busy ? "正在中止…" : "确认中止并发布公告"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={cancel}>关闭</button>
    </div>
  </div>;
}

export function TaskReviewActions({
  mode,
  feedback,
  busy,
  choose,
  changeFeedback,
  submit,
  cancel,
}: {
  mode: "accept" | "reject" | "fail" | null;
  feedback: string;
  busy: boolean;
  choose: (mode: "accept" | "reject" | "fail") => void;
  changeFeedback: (feedback: string) => void;
  submit: () => void;
  cancel: () => void;
}) {
  if (!mode) {
    return <div className="review-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => choose("accept")}>验收并关闭</button>
      <button type="button" className="danger-button" disabled={busy} onClick={() => choose("reject")}>驳回</button>
      <button type="button" className="danger-button" disabled={busy} onClick={() => choose("fail")}>判定任务失败</button>
    </div>;
  }
  const rejecting = mode === "reject";
  const failing = mode === "fail";
  return <div className={`task-review-form ${rejecting || failing ? "is-reject" : "is-accept"}`}>
    <span>{failing ? "BOSS FINAL FAILURE" : rejecting ? "驳回任务" : "完成验收"}</span>
    <h3>{failing ? "永久终结这个无法完成的根任务" : rejecting ? "说明需要负责人整改的内容" : "确认任务已经达到验收标准"}</h3>
    {failing ? <p>任务将进入 failed 终态，不再退回执行池，也不能重新提交；原 submission、Git 与验收材料会永久保留。</p> : null}
    <label>{failing ? "失败原因（必填）" : rejecting ? "驳回原因（必填）" : "验收意见（可选）"}
      <textarea
        rows={3}
        value={feedback}
        disabled={busy}
        placeholder={failing ? "说明为什么继续整改已无意义，以及本次任务失败的关键原因……" : rejecting ? "具体说明未通过项和整改方向……" : "可以补充验收结论……"}
        onChange={(event) => changeFeedback(event.target.value)}
      />
    </label>
    <div className="task-review-form-actions">
      <button type="button" className={rejecting || failing ? "danger-button" : "primary"} disabled={busy || (mode !== "accept" && !feedback.trim())} onClick={submit}>{busy ? "提交中…" : failing ? "确认判定失败并终结" : rejecting ? "确认驳回" : "确认验收并关闭"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={cancel}>取消</button>
    </div>
  </div>;
}

export function RootTaskForm({ members, submit, compact = false, draft = null }: { members: Snapshot["organization"]; submit: (e: FormEvent<HTMLFormElement>) => void; compact?: boolean; draft?: TaskAbortDraft | null }) {
  const draftAssignee = members.some((member) => member.id === draft?.assigneeId) ? draft?.assigneeId : "";
  const defaultRequireTaskMeeting = draft?.requireTaskMeeting ?? true;
  const defaultBossParticipates = defaultRequireTaskMeeting && Boolean(draft?.taskMeetingBossParticipates);
  const [requireTaskMeeting, setRequireTaskMeeting] = useState(defaultRequireTaskMeeting);
  const [taskMeetingBossParticipates, setTaskMeetingBossParticipates] = useState(defaultBossParticipates);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachmentPreviews = useMemo(() => attachmentFiles.map((file) => ({ file, url: URL.createObjectURL(file) })), [attachmentFiles]);
  useEffect(() => () => attachmentPreviews.forEach((preview) => URL.revokeObjectURL(preview.url)), [attachmentPreviews]);
  const resetMeetingOptions = () => {
    setRequireTaskMeeting(defaultRequireTaskMeeting);
    setTaskMeetingBossParticipates(defaultBossParticipates);
    setAttachmentFiles([]);
  };
  const chooseAttachments = (files: File[]) => {
    const error = taskImageSelectionError(files);
    if (error) {
      window.alert(error);
      if (attachmentInput.current) attachmentInput.current.value = "";
      setAttachmentFiles([]);
      return;
    }
    setAttachmentFiles(files);
  };
  const removeAttachment = (index: number) => {
    const next = attachmentFiles.filter((_, current) => current !== index);
    const transfer = new DataTransfer();
    next.forEach((file) => transfer.items.add(file));
    if (attachmentInput.current) attachmentInput.current.files = transfer.files;
    setAttachmentFiles(next);
  };
  return <form className={compact ? "root-form compact-form" : "root-form"} onSubmit={submit} onReset={resetMeetingOptions}>
    <label>任务标题<input name="title" required placeholder="明确可验收的战略目标" defaultValue={draft?.title ?? ""} /></label>
    <label>负责人<select name="assigneeId" required defaultValue={draftAssignee}><option value="">选择一级员工</option>{members.map((m) => <option value={m.id} key={m.id}>{m.name} · {m.title}</option>)}</select></label>
    <label className="wide">任务说明<textarea name="description" rows={compact ? 2 : 5} required defaultValue={draft?.description ?? ""} /></label>
    <label className="wide">验收标准<textarea name="acceptanceCriteria" rows={compact ? 2 : 4} required defaultValue={draft?.acceptanceCriteria ?? ""} /></label>
    <div className="wide task-image-picker">
      <label>图片附件 <small>可选，最多 4 张；支持 PNG、JPG、WebP、GIF，单张不超过 5 MB</small><input ref={attachmentInput} name="attachments" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => chooseAttachments(Array.from(event.currentTarget.files ?? []))} /></label>
      {attachmentPreviews.length ? <div className="task-image-preview-list">{attachmentPreviews.map((preview, index) => <figure key={`${preview.file.name}-${preview.file.lastModified}-${index}`}><img src={preview.url} alt={preview.file.name} /><figcaption><span>{preview.file.name}</span><small>{formatBytes(preview.file.size)}</small></figcaption><button type="button" aria-label={`移除 ${preview.file.name}`} onClick={() => removeAttachment(index)}>×</button></figure>)}</div> : null}
    </div>
    <div className="wide task-meeting-options">
      <label className="checkbox-label"><input type="checkbox" name="requireTaskMeeting" value="true" checked={requireTaskMeeting} onChange={(event) => { setRequireTaskMeeting(event.target.checked); if (!event.target.checked) setTaskMeetingBossParticipates(false); }} />要求负责人通过任务会完成拆解</label>
      <label className={`checkbox-label task-meeting-boss-option ${requireTaskMeeting ? "" : "is-disabled"}`}><input type="checkbox" name="taskMeetingBossParticipates" value="true" checked={taskMeetingBossParticipates} disabled={!requireTaskMeeting} onChange={(event) => setTaskMeetingBossParticipates(event.target.checked)} />要求 Boss 参加任务会 <small>默认不参加</small></label>
    </div>
    <button className="primary">{draft ? "重新派发根任务" : "创建根任务"}</button>
  </form>;
}

const TASK_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function taskImageSelectionError(files: File[]) {
  if (files.length > 4) return "一个根任务最多添加 4 张图片。";
  const unsupported = files.find((file) => !TASK_IMAGE_MIME_TYPES.has(file.type));
  if (unsupported) return `不支持图片格式：${unsupported.name}`;
  const oversized = files.find((file) => file.size > 5_000_000);
  if (oversized) return `图片超过 5 MB：${oversized.name}`;
  if (files.reduce((total, file) => total + file.size, 0) > 12_000_000) return "图片附件总大小不能超过 12 MB。";
  return null;
}

async function taskImageInputs(files: File[]) {
  const error = taskImageSelectionError(files);
  if (error) throw new Error(error);
  return Promise.all(files.map(async (file) => ({
    fileName: file.name,
    mimeType: file.type,
    dataUrl: await fileDataUrl(file),
  })));
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`无法读取图片：${file.name}`));
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function PageHeader({ eyebrow, title, summary, children }: { eyebrow: string; title: string; summary: string; children?: React.ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{summary}</p></div><div>{children}</div></div>; }
function Badge({ children, tone }: { children: React.ReactNode; tone: string }) { return <span className={`badge tone-${tone}`}>{children}</span>; }
function Person({ id, role, identities, fallbackName }: { id: string; role: string; identities: MemberIdentityMap; fallbackName?: string }) { const identity = memberIdentity(identities, id, fallbackName); return <div className="person"><AgentAvatar identity={identity} /><div><b>{identity.name}</b><small>{role} · {identity.title || id}<span className="speaker-id">{id}</span></small></div></div>; }
function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) { return <section className="detail-block"><h3>{title}</h3><div>{children}</div></section>; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><span>◎</span><h2>{title}</h2><p>{body}</p></div>; }
function Loading() { return <div className="loading"><i /><span>正在载入公司运行状态…</span></div>; }
export function routeFromPath(pathname = location.pathname): Route { const part = pathname.split("/").filter(Boolean).at(-1); return part === "notices" || part === "tasks" || part === "self-governance" ? part : "meeting-room"; }
function formatTime(value?: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatTimeWithSeconds(value?: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function formatRemainingMinutes(value?: number | null) { if (value === null || value === undefined) return "—"; return value < 1 ? "不足 1 分钟" : `${Math.ceil(value)} 分钟`; }
function formatBytes(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(value / 1_000))} KB`; }
function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
function isShanghaiWorkTime(now: number, startHour: number, endHour: number) {
  const local = new Date(now + 8 * 60 * 60 * 1_000);
  const hour = local.getUTCHours();
  return hour >= startHour && hour < endHour + 1;
}
function remainingShanghaiWorkMilliseconds(now: number, due: number, startHour: number, endHour: number) {
  if (due <= now) return 0;
  const offset = 8 * 60 * 60 * 1_000;
  let cursor = now;
  let total = 0;
  while (cursor < due) {
    const local = new Date(cursor + offset);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), startHour) - offset;
    const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), endHour + 1) - offset;
    const from = Math.max(cursor, start);
    const to = Math.min(due, end);
    if (to > from) total += to - from;
    cursor = Math.max(cursor + 1, end);
    if (cursor < due) cursor = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, startHour) - offset;
  }
  return total;
}
function shortId(id: string) { return id.slice(0, 8); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function noticeKind(kind: Notice["kind"]) { return ({ manual: "管理公告", meeting_report: "会议汇报", correction: "更正公告" })[kind]; }
function meetingStatus(status: MeetingSummary["status"]) { return ({ queued: "排队", active: "进行中", completed: "完成", canceled: "取消", timed_out: "超时" })[status]; }
function taskStatus(status: Task["status"]) { return ({ assigned: "已派发", in_progress: "进行中", review: "待验收", blocked: "阻塞", closed: "已完成", failed: "任务失败", canceled: "已取消", aborted: "已中止" })[status]; }
function taskAvailability(status: Task["availability"]) { return ({ active: "可执行", waiting_stage: "等待阶段", suspended_stage: "阶段冻结", retired: "已退役" })[status]; }
function taskFlowStageStatus(status: NonNullable<Task["flowStage"]>["status"]) { return ({ waiting: "等待", active: "进行中", suspended: "已冻结", completed: "已完成", retired: "已退役" })[status]; }
function taskFlowTreeStageStatus(status: NonNullable<Task["flowStage"]>["status"]) { return ({ waiting: "等待前序", active: "当前阶段", suspended: "下游冻结", completed: "阶段完成", retired: "已退役" })[status]; }
function taskMeetingRequirementStatus(status: NonNullable<TaskDetail["taskMeetingRequirement"]>["status"]) { return ({ required: "等待轮转发起", scheduled: "会议已排队", active: "会议进行中", fulfilled: "已完成" })[status]; }
function taskReminderStatus(status: NonNullable<TaskDetail["reminderDispatch"]>["status"]) { return ({ pending: "等待发送", running: "正在通知负责人", succeeded: "已送达", failed: "发送失败", canceled: "已取消" })[status]; }
function taskReviewNotificationKind(kind: NonNullable<TaskDetail["reviewNotificationDispatch"]>["kind"]) { return ({ boss_reminder: "催办", review_accepted: "验收通过", review_rejected: "验收驳回", review_failed: "任务失败", block_escalated: "阻塞上报", block_guidance: "阻塞建议", cancel_request_accepted: "取消获批", cancel_request_rejected: "取消被驳回", acceptance_revoked: "二次审查不通过", cancellation_restored: "取消恢复", submission_git_required: "需补 Git 定位", submission_materials_required: "需补验收附件" })[kind]; }
function taskPromptKind(kind: "execution" | "review" | "blocked_review") { return ({ execution: "执行", review: "验收", blocked_review: "阻塞审查" })[kind]; }
function taskPromptStatus(status: "running" | "succeeded" | "failed" | "skipped_busy" | "skipped_empty" | "skipped_offline" | "canceled") { return ({ running: "发送中", succeeded: "已送达", failed: "失败", skipped_busy: "会话忙碌跳过", skipped_empty: "空池跳过", skipped_offline: "离线错过", canceled: "已取消" })[status]; }
function taskCheckinStatus(status: TaskHourlyCheckinSummary["boss"]["emailStatus"]) { return status ? ({ pending: "等待发送", running: "发送中", succeeded: "已送达", failed: "失败", skipped: "已跳过", canceled: "已取消" })[status] : "无待办"; }
function taskCheckinAction(kind: "review" | "execute" | "boss_digest" | null) { return kind ? ({ review: "验收", execute: "执行", boss_digest: "Boss 汇总" })[kind] : "待递补"; }
function closeoutDispatchStatus(status: MeetingDetail["closeoutDispatches"][number]["status"]) { return ({ pending: "等待同步", running: "正在同步", succeeded: "已送达" })[status]; }
