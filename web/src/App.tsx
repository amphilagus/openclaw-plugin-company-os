import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { deleteNotice, getMeeting, getSnapshot, getTask, post, put, subscribeToChanges } from "./api";
import { BossMeetingGate } from "./BossMeetingGate";
import { AgentAvatar, memberIdentity, memberName, useMemberIdentities, type MemberIdentityMap } from "./member-identity";
import { MeetingHistory } from "./MeetingHistory";
import { SelfGovernancePage } from "./SelfGovernancePage";
import type { MeetingDetail, MeetingSummary, Notice, Snapshot, Task, TaskDetail, TaskHourlyCheckinSummary } from "./types";

type Route = "notices" | "meeting-room" | "tasks" | "self-governance";

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
      <span className={`room-state ${meeting ? "occupied" : "free"}`}>{closing ? "散会同步中" : meeting?.awaitingBossStart ? "等待你开始" : meeting?.endRequestedAt ? meeting.bossParticipates ? "等待你决定结束" : "结束倒计时" : meeting ? "会议进行中" : "会议室空闲"}</span>
    </PageHeader>
    {!meeting ? <Empty title="会议室现在是空的" body={snapshot.meetings.queue.length ? "排队会议即将由系统启动。" : "员工可通过 company_meeting_request 申请会议。"} /> :
      <div className="meeting-grid">
        <section className="meeting-stage panel">
          <div className="meeting-head">
            <div><div className="eyebrow">{meeting.type === "task" ? "任务会议" : "普通讨论"}</div><h2>{meeting.title}</h2><p>{meeting.agenda}</p></div>
            <div className="meeting-facts"><span>主持人 <b>{memberName(identities, meeting.hostId)}</b> <code>{meeting.hostId}</code></span>{meeting.bossParticipates ? <span className="boss-required">Boss 直接参会</span> : null}{meeting.parentTaskId ? <span>父任务 <code>{shortId(meeting.parentTaskId)}</code></span> : null}</div>
          </div>
          <div className="transcript">
            {meeting.messages.map((message) => <MeetingMessageRow message={message} identities={identities} key={message.id} />)}
            {!closing && !meeting.awaitingBossStart && meeting.hostDispatchStatus && ["pending", "running", "failed"].includes(meeting.hostDispatchStatus.status)
              ? <HostDispatchState dispatch={meeting.hostDispatchStatus} hostName={memberName(identities, meeting.hostId)} />
              : null}
            {closing
              ? <MeetingCloseoutState meeting={meeting} />
              : meeting.awaitingBossStart || meeting.endRequestedAt
              ? <BossMeetingGate meeting={meeting} busy={busy} start={() => void startMeeting()} rejectMeeting={(reason) => void rejectMeeting(reason)} approveEnd={() => void approveEnd()} rejectEnd={(fb) => void rejectEnd(fb)} />
              : meeting.currentTurn ? <div className="speaking"><i />等待 <b>{memberName(identities, meeting.currentTurn.speakerId)}</b> 发言：{meeting.currentTurn.prompt}</div> : <div className="host-control">控制权在主持人 {memberName(identities, meeting.hostId)}</div>}
          </div>
          {!closing && !meeting.awaitingBossStart && !meeting.endRequestedAt ? <form className="boss-composer" onSubmit={interject}>
            <div className="boss-label">BOSS 插话</div>
            <select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">共享记录（交给主持人）</option><option value={meeting.hostId}>@{memberName(identities, meeting.hostId)} · 主持人</option>{meeting.participants.map((p) => <option value={p.agentId} key={p.agentId}>@{memberName(identities, p.agentId, p.name)} · {p.role === "worker" ? "执行者" : "顾问"}</option>)}</select>
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="输入你的判断、追问或方向修正……" required />
            <button className="primary" disabled={busy}>{busy ? "排队中…" : target ? `在当前发言后 @${target}` : "加入会议记录"}</button>
          </form> : null}
        </section>
        <aside className="meeting-side">
          <section className="panel compact"><div className="panel-title">参会角色</div><div className="people-list">{meeting.bossParticipates ? <Person id="boss" role={meeting.awaitingBossStart ? "待入场 · 最终决策者" : "直接参会 · 最终决策者"} identities={identities} /> : null}<Person id={meeting.hostId} role="主持人" identities={identities} />{meeting.participants.map((p) => <Person key={p.agentId} id={p.agentId} role={p.role === "worker" ? "执行者" : "顾问"} identities={identities} fallbackName={p.name} />)}</div></section>
          {closing ? <MeetingCloseoutMemberList meeting={meeting} /> : null}
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

function MeetingMessageRow({ message, identities }: { message: MeetingDetail["messages"][number]; identities: MemberIdentityMap }) {
  const id = message.authorKind === "boss" ? "boss" : message.authorId ?? "system";
  const identity = message.authorKind === "system"
    ? { id: "system", name: "系统", title: "", avatarUrl: null, emoji: null }
    : memberIdentity(identities, id);
  return <div className={`message ${message.authorKind}`}>
    <AgentAvatar identity={identity} className="avatar" fallback={message.authorKind === "system" ? "·" : undefined} />
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
  const [search, setSearch] = useState("");
  const roots = snapshot.tasks.filter((task) => !task.parentId);
  useEffect(() => { if (selectedId) void getTask(selectedId).then(setDetail).catch((error) => window.alert(messageOf(error))); }, [selectedId, snapshot.generatedAt]);
  const visible = (task: Task) => (status === "all" || task.status === status) && (assignee === "all" || task.assigneeId === assignee) && (!search || `${task.title} ${task.description}`.toLowerCase().includes(search.toLowerCase()));
  const createRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const values = Object.fromEntries(data);
    try { const task = await post<Task>("/tasks", { ...values, requireTaskMeeting: data.get("requireTaskMeeting") === "true" }); form.reset(); await reload(true); setSelectedId(task.id); } catch (error) { window.alert(messageOf(error)); }
  };
  return <>
    <PageHeader eyebrow="STRICT HIERARCHY · BOTTOM-UP CLOSURE" title="多级任务系统" summary="每个任务只有一名负责人。子任务全部终结后，上一级才有资格提交验收。" />
    <TaskRollingPoolPanel summary={snapshot.taskPromptPool} reload={reload} />
    <div className="task-toolbar panel"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务标题或说明" /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option>{["assigned", "in_progress", "review", "blocked", "closed", "canceled"].map((value) => <option key={value}>{value}</option>)}</select><select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="all">全部负责人</option>{snapshot.organization.filter((m) => m.active && m.kind === "agent").map((m) => <option value={m.id} key={m.id}>{m.name} · {m.id}</option>)}</select></div>
    <div className="tasks-layout">
      <section className="task-tree panel">
        <div className="panel-title">任务树 <span>{snapshot.tasks.length}</span></div>
        {roots.length ? roots.map((root) => <TaskNode key={root.id} task={root} all={snapshot.tasks} visible={visible} selectedId={selectedId} select={setSelectedId} depth={0} />) : <Empty title="还没有根任务" body="Boss 可在右侧创建第一个战略根任务。" />}
      </section>
      <aside className="task-detail panel">{detail ? <TaskDetailView detail={detail} members={snapshot.organization.filter((m) => m.active)} reload={reload} /> : <RootTaskForm members={snapshot.organization.filter((m) => m.active && m.managerId === "boss")} submit={createRoot} />}</aside>
    </div>
    <section className="new-root panel"><div><span className="eyebrow">BOSS ONLY</span><h3>创建新的战略根任务</h3><p>根任务只能派给 Boss 的一级直属员工。</p></div><RootTaskForm members={snapshot.organization.filter((m) => m.active && m.managerId === "boss")} submit={createRoot} compact /></section>
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

export function TaskRollingPoolPanel({ summary, reload }: { summary: Snapshot["taskPromptPool"]; reload?: (quiet?: boolean) => Promise<void> }) {
  const busySkips = summary.queues.filter((queue) => queue.lastDispatch?.status === "skipped_busy").length;
  const failures = summary.queues.filter((queue) => queue.lastDispatch?.status === "failed").length;
  return <section className="task-checkin-panel panel">
    <div className="task-checkin-heading">
      <div><span className="eyebrow">ROLLING TASK PROMPT POOL</span><h2>任务回转提示池</h2></div>
      <Badge tone={summary.enabled ? "completed" : "canceled"}>{summary.enabled ? `${String(summary.startHour).padStart(2, "0")}:00–${String((summary.endHour + 1) % 24).padStart(2, "0")}:00 · 个人倒计时` : "已关闭"}</Badge>
    </div>
    <div className="task-checkin-stats">
      <TaskCheckinMetric label="队列员工" value={String(summary.totals.employees)} />
      <TaskCheckinMetric label="池内事项" value={String(summary.totals.items)} />
      <TaskCheckinMetric label="执行" value={String(summary.totals.execution)} />
      <TaskCheckinMetric label="待验收" value={String(summary.totals.review)} />
      <TaskCheckinMetric label="阻塞审查" value={String(summary.totals.blockedReview)} />
      <TaskCheckinMetric label="忙碌跳过 / 失败" value={`${busySkips} / ${failures}`} tone={failures ? "danger" : busySkips ? "warning" : undefined} />
    </div>
    <div className="task-checkin-footer">
      <span>全员最近到期：{formatTime(summary.nextDueAt)}</span>
      {summary.queues.filter((queue) => queue.count > 0).map((queue) => <span key={queue.memberId}>
        {queue.memberName}：{queue.count} 项 · {queue.intervalMinutes ?? queue.defaultIntervalMinutes ?? 20} 分钟 · 剩余 {formatRemainingMinutes(queue.remainingWorkMinutes)} · 池首 {queue.head ? `${taskPromptKind(queue.head.kind)}「${queue.head.title}」` : "—"}
        {queue.lastDispatch ? ` · 最近 ${taskPromptStatus(queue.lastDispatch.status)}` : ""}
      </span>)}
    </div>
    {summary.queues.length ? <div className="task-prompt-queue-details">
      {summary.queues.map((queue) => <section key={queue.memberId}>
        <div className="task-prompt-queue-heading"><b>{queue.memberName} · FIFO 队列</b><span>层级默认 {queue.defaultIntervalMinutes ?? queue.intervalMinutes ?? 20} 分钟{queue.intervalOverrideMinutes != null ? ` · Boss 覆盖 ${queue.intervalOverrideMinutes} 分钟` : ""}</span>{reload ? <TaskPromptIntervalControl queue={queue} reload={reload} /> : null}</div>
        {queue.items.map((item, index) => <div className={`task-prompt-queue-item is-${item.kind}`} key={`${item.kind}:${item.taskId}`}>
          <span>{index + 1}</span><Badge tone={item.kind === "blocked_review" ? "blocked" : item.kind === "review" ? "review" : "in_progress"}>{taskPromptKind(item.kind)}</Badge>
          <strong>{item.title}</strong>{item.parentTitle ? <small>父任务：{item.parentTitle}</small> : null}
        </div>)}{queue.items.length === 0 ? <small className="task-prompt-empty">当前队列为空，倒计时已停止。</small> : null}
      </section>)}
    </div> : null}
  </section>;
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

function TaskNode({ task, all, visible, selectedId, select, depth }: { task: Task; all: Task[]; visible: (t: Task) => boolean; selectedId: string; select: (id: string) => void; depth: number }) {
  const children = all.filter((item) => item.parentId === task.id);
  const subtreeVisible = taskSubtreeContainsVisible(task, all, visible);
  if (!subtreeVisible) return null;
  return <div className="task-branch">
    <button className={`task-row ${selectedId === task.id ? "selected" : ""}`} style={{ paddingLeft: 14 + depth * 22 }} onClick={() => select(task.id)}>
      <span className="tree-joint">{depth ? "└" : "◆"}</span><span className="task-main"><b>{task.title}</b><small>{task.assigneeId} · v{task.revision} · {shortId(task.id)}{task.flowStage ? ` · 阶段 ${task.flowStage.position + 1}` : ""}</small></span><Badge tone={task.status}>{taskStatus(task.status)}</Badge>{task.availability !== "active" ? <Badge tone="waiting">{taskAvailability(task.availability)}</Badge> : null}
      {task.risks.blockedDescendants ? <span className="risk blocked">阻塞 {task.risks.blockedDescendants}</span> : null}{task.risks.stale || task.risks.staleDescendants ? <span className="risk stale">停滞 {Number(task.risks.stale) + task.risks.staleDescendants}</span> : null}{task.childCounts.canceled ? <span className="risk canceled">取消 {task.childCounts.canceled}</span> : null}
    </button>
    {children.map((child) => <TaskNode key={child.id} task={child} all={all} visible={visible} selectedId={selectedId} select={select} depth={depth + 1} />)}
  </div>;
}

function taskSubtreeContainsVisible(task: Task, all: Task[], visible: (task: Task) => boolean): boolean {
  return visible(task) || all.filter((item) => item.parentId === task.id)
    .some((child) => taskSubtreeContainsVisible(child, all, visible));
}

export function TaskDetailView({ detail, members, reload }: { detail: TaskDetail; members: Snapshot["organization"]; reload: (quiet?: boolean) => Promise<void> }) {
  const [reminding, setReminding] = useState(false);
  const [reviewMode, setReviewMode] = useState<"accept" | "reject" | null>(null);
  const [reviewFeedback, setReviewFeedback] = useState("");
  const [reviewing, setReviewing] = useState(false);
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
    if (!reviewMode || (reviewMode === "reject" && !reviewFeedback.trim())) return;
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
  const review = detail.status === "review" && detail.parentId === null;
  const remindReviewer = detail.parentId !== null && (detail.status === "review" || detail.status === "blocked");
  const canRemind = (["assigned", "in_progress"] as string[]).includes(detail.status) || remindReviewer;
  const reminderActive = detail.reminderDispatch?.status === "pending" || detail.reminderDispatch?.status === "running";
  return <div>
    <div className="detail-head"><Badge tone={detail.status}>{taskStatus(detail.status)}</Badge><code>{detail.id}</code></div>
    <h2>{detail.title}</h2><div className="detail-meta"><span>负责人 <b>{detail.assigneeId}</b></span><span>派发者 <b>{detail.issuerId}</b></span><span>版本 <b>v{detail.revision}</b></span></div>
    {detail.taskMeetingRequirement ? <div className={`task-meeting-requirement is-${detail.taskMeetingRequirement.status}`}><b>任务拆解会要求：{taskMeetingRequirementStatus(detail.taskMeetingRequirement.status)}</b><span>{detail.taskMeetingRequirement.meetingId ? `关联会议 ${shortId(detail.taskMeetingRequirement.meetingId)}` : "等待任务轮转到负责人池首"}</span><small>会议必须由负责人主持、全体在职直属下属参与，Boss 参与；成功形成任务流后才算完成。</small></div> : null}
    {detail.flowStage ? <div className="task-flow-context"><b>所属阶段 {detail.flowStage.position + 1} · {detail.flowStage.name}</b><span>{detail.flowStage.objective}</span><Badge tone={detail.flowStage.status}>{taskFlowStageStatus(detail.flowStage.status)}</Badge></div> : null}
    {detail.childFlow ? <DetailBlock title={`分阶段任务流 · 修订 ${detail.childFlow.revision}`}><div className="task-flow-stages">{detail.childFlow.stages.map((stage) => <div className={`task-flow-stage is-${stage.status}`} key={stage.id}><div><Badge tone={stage.status}>{taskFlowStageStatus(stage.status)}</Badge><b>阶段 {stage.position + 1} · {stage.name}</b><span>{stage.closedTaskCount}/{stage.requiredTaskCount} 个必需任务已关闭</span></div><p>{stage.objective}</p></div>)}</div></DetailBlock> : null}
    {detail.childCounts.canceled ? <div className="warning">该任务包含 {detail.childCounts.canceled} 个已取消直接子任务。验收前请检查取消原因。</div> : null}
    <DetailBlock title="任务说明">{detail.description}</DetailBlock><DetailBlock title="验收标准">{detail.acceptanceCriteria}</DetailBlock>
    {detail.blockedReason ? <DetailBlock title="阻塞原因">{detail.blockedReason}</DetailBlock> : null}
    {detail.submissions[0] ? <DetailBlock title="最近提交"><b>{detail.submissions[0].summary}</b>{detail.submissions[0].gitLocation ? <><div className="evidence"><Badge tone="artifact">Git</Badge><span>远端</span><code>{detail.submissions[0].gitLocation.remoteUrl}</code></div><div className="evidence"><Badge tone="artifact">Git</Badge><span>分支</span><code>{detail.submissions[0].gitLocation.branch}</code></div><div className="evidence"><Badge tone="artifact">Git</Badge><span>冻结 commit</span><code>{detail.submissions[0].gitLocation.commit}</code></div><small>远端验证于 {formatTime(detail.submissions[0].gitLocation.verifiedAt)}</small></> : <div className="warning">该历史提交没有 Git 远端定位。</div>}{detail.submissions[0].evidence.map((item, i) => <div className="evidence" key={i}><Badge tone={item.type}>{item.type}</Badge><span>{item.label}</span><code>{item.path ?? item.url ?? item.command ?? item.note}</code></div>)}</DetailBlock> : null}
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
    {!(["closed", "canceled"] as string[]).includes(detail.status) ? <div className="fallback-actions">{canRemind ? <button className="remind-button" disabled={reminding || reminderActive} onClick={() => void remind()}>{reminding || reminderActive ? `正在通知${remindReviewer ? "审核人" : "负责人"}…` : `催促${remindReviewer ? "审核人" : "负责人"}`}</button> : null}<button onClick={() => { const reason = window.prompt("取消原因："); if (reason) void action("cancel", { reason }); }}>带审计取消</button><button onClick={() => { const assigneeId = window.prompt(`新负责人（必须是 ${detail.issuerId} 的直属下属）：`, detail.assigneeId); const reason = assigneeId && window.prompt("重派原因："); if (assigneeId && reason) void action("reassign", { assigneeId, reason }); }}>全局重派</button></div> : null}
    {detail.status === "closed" ? <div className="fallback-actions"><button className="danger-button" onClick={() => void correctTerminal("revoke_acceptance")}>二次审查不通过</button></div> : null}
    {detail.status === "canceled" ? <div className="fallback-actions"><button onClick={() => void correctTerminal("restore_cancellation")}>恢复已取消任务</button></div> : null}
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
  mode: "accept" | "reject" | null;
  feedback: string;
  busy: boolean;
  choose: (mode: "accept" | "reject") => void;
  changeFeedback: (feedback: string) => void;
  submit: () => void;
  cancel: () => void;
}) {
  if (!mode) {
    return <div className="review-actions">
      <button type="button" className="primary" disabled={busy} onClick={() => choose("accept")}>验收并关闭</button>
      <button type="button" className="danger-button" disabled={busy} onClick={() => choose("reject")}>驳回</button>
    </div>;
  }
  const rejecting = mode === "reject";
  return <div className={`task-review-form ${rejecting ? "is-reject" : "is-accept"}`}>
    <span>{rejecting ? "驳回任务" : "完成验收"}</span>
    <h3>{rejecting ? "说明需要负责人整改的内容" : "确认任务已经达到验收标准"}</h3>
    <label>{rejecting ? "驳回原因（必填）" : "验收意见（可选）"}
      <textarea
        rows={3}
        value={feedback}
        disabled={busy}
        placeholder={rejecting ? "具体说明未通过项和整改方向……" : "可以补充验收结论……"}
        onChange={(event) => changeFeedback(event.target.value)}
      />
    </label>
    <div className="task-review-form-actions">
      <button type="button" className={rejecting ? "danger-button" : "primary"} disabled={busy || (rejecting && !feedback.trim())} onClick={submit}>{busy ? "提交中…" : rejecting ? "确认驳回" : "确认验收并关闭"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={cancel}>取消</button>
    </div>
  </div>;
}

function RootTaskForm({ members, submit, compact = false }: { members: Snapshot["organization"]; submit: (e: FormEvent<HTMLFormElement>) => void; compact?: boolean }) {
  return <form className={compact ? "root-form compact-form" : "root-form"} onSubmit={submit}><label>任务标题<input name="title" required placeholder="明确可验收的战略目标" /></label><label>负责人<select name="assigneeId" required><option value="">选择一级员工</option>{members.map((m) => <option value={m.id} key={m.id}>{m.name} · {m.title}</option>)}</select></label><label className="wide">任务说明<textarea name="description" rows={compact ? 2 : 5} required /></label><label className="wide">验收标准<textarea name="acceptanceCriteria" rows={compact ? 2 : 4} required /></label><label className="wide checkbox-label"><input type="checkbox" name="requireTaskMeeting" value="true" />要求负责人通过任务会完成拆解（Boss 参与）</label><button className="primary">创建根任务</button></form>;
}

function PageHeader({ eyebrow, title, summary, children }: { eyebrow: string; title: string; summary: string; children?: React.ReactNode }) { return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{summary}</p></div><div>{children}</div></div>; }
function Badge({ children, tone }: { children: React.ReactNode; tone: string }) { return <span className={`badge tone-${tone}`}>{children}</span>; }
function Person({ id, role, identities, fallbackName }: { id: string; role: string; identities: MemberIdentityMap; fallbackName?: string }) { const identity = memberIdentity(identities, id, fallbackName); return <div className="person"><AgentAvatar identity={identity} /><div><b>{identity.name}</b><small>{role} · {identity.title || id}<span className="speaker-id">{id}</span></small></div></div>; }
function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) { return <section className="detail-block"><h3>{title}</h3><div>{children}</div></section>; }
function Empty({ title, body }: { title: string; body: string }) { return <div className="empty"><span>◎</span><h2>{title}</h2><p>{body}</p></div>; }
function Loading() { return <div className="loading"><i /><span>正在载入公司运行状态…</span></div>; }
export function routeFromPath(pathname = location.pathname): Route { const part = pathname.split("/").filter(Boolean).at(-1); return part === "notices" || part === "tasks" || part === "self-governance" ? part : "meeting-room"; }
function formatTime(value?: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRemainingMinutes(value?: number | null) { if (value === null || value === undefined) return "—"; return value < 1 ? "不足 1 分钟" : `${Math.ceil(value)} 分钟`; }
function shortId(id: string) { return id.slice(0, 8); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function noticeKind(kind: Notice["kind"]) { return ({ manual: "管理公告", meeting_report: "会议汇报", correction: "更正公告" })[kind]; }
function meetingStatus(status: MeetingSummary["status"]) { return ({ queued: "排队", active: "进行中", completed: "完成", canceled: "取消", timed_out: "超时" })[status]; }
function taskStatus(status: Task["status"]) { return ({ assigned: "已派发", in_progress: "进行中", review: "待验收", blocked: "阻塞", closed: "已关闭", canceled: "已取消" })[status]; }
function taskAvailability(status: Task["availability"]) { return ({ active: "可执行", waiting_stage: "等待阶段", suspended_stage: "阶段冻结", retired: "已退役" })[status]; }
function taskFlowStageStatus(status: NonNullable<Task["flowStage"]>["status"]) { return ({ waiting: "等待", active: "进行中", suspended: "已冻结", completed: "已完成", retired: "已退役" })[status]; }
function taskMeetingRequirementStatus(status: NonNullable<TaskDetail["taskMeetingRequirement"]>["status"]) { return ({ required: "等待轮转发起", scheduled: "会议已排队", active: "会议进行中", fulfilled: "已完成" })[status]; }
function taskReminderStatus(status: NonNullable<TaskDetail["reminderDispatch"]>["status"]) { return ({ pending: "等待发送", running: "正在通知负责人", succeeded: "已送达", failed: "发送失败", canceled: "已取消" })[status]; }
function taskReviewNotificationKind(kind: NonNullable<TaskDetail["reviewNotificationDispatch"]>["kind"]) { return ({ boss_reminder: "催办", review_accepted: "验收通过", review_rejected: "验收驳回", block_escalated: "阻塞上报", block_guidance: "阻塞建议", cancel_request_accepted: "取消获批", cancel_request_rejected: "取消被驳回", acceptance_revoked: "二次审查不通过", cancellation_restored: "取消恢复", submission_git_required: "需补 Git 定位" })[kind]; }
function taskPromptKind(kind: "execution" | "review" | "blocked_review") { return ({ execution: "执行", review: "验收", blocked_review: "阻塞审查" })[kind]; }
function taskPromptStatus(status: "running" | "succeeded" | "failed" | "skipped_busy" | "skipped_empty" | "skipped_offline" | "canceled") { return ({ running: "发送中", succeeded: "已送达", failed: "失败", skipped_busy: "会话忙碌跳过", skipped_empty: "空池跳过", skipped_offline: "离线错过", canceled: "已取消" })[status]; }
function taskCheckinStatus(status: TaskHourlyCheckinSummary["boss"]["emailStatus"]) { return status ? ({ pending: "等待发送", running: "发送中", succeeded: "已送达", failed: "失败", skipped: "已跳过", canceled: "已取消" })[status] : "无待办"; }
function taskCheckinAction(kind: "review" | "execute" | "boss_digest" | null) { return kind ? ({ review: "验收", execute: "执行", boss_digest: "Boss 汇总" })[kind] : "待递补"; }
function closeoutDispatchStatus(status: MeetingDetail["closeoutDispatches"][number]["status"]) { return ({ pending: "等待同步", running: "正在同步", succeeded: "已送达" })[status]; }
