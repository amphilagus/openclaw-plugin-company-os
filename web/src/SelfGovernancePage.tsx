import { useMemo, useState } from "react";

import { AgentAvatar, memberIdentity, useMemberIdentities } from "./member-identity";
import type {
  DailyAgentDispatch,
  DailyAgentDispatchStatus,
  DailyAgentKind,
  DailyAgentRunSummary,
  Snapshot,
} from "./types";

type KindFilter = "all" | DailyAgentKind;
type StatusFilter = "all" | DailyAgentDispatchStatus;

export function SelfGovernancePage({ snapshot }: { snapshot: Snapshot }) {
  const summary = snapshot.dailySelfGovernance;
  const identities = useMemberIdentities(snapshot.organization);
  const members = new Map(snapshot.organization.map((member) => [member.id, member]));
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [agent, setAgent] = useState("all");
  const todayDispatches = [
    ...(summary.mechanisms.selfImprovement.today?.dispatches ?? []),
    ...(summary.mechanisms.personaAudit.today?.dispatches ?? []),
  ].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.kind.localeCompare(b.kind));
  const filteredHistory = useMemo(() => summary.history.flatMap((run) => {
    if (kind !== "all" && run.kind !== kind) return [];
    const dispatches = run.dispatches.filter((dispatch) =>
      (status === "all" || dispatch.status === status)
      && (agent === "all" || dispatch.targetMemberId === agent));
    if ((status !== "all" || agent !== "all") && dispatches.length === 0) return [];
    return [{ ...run, dispatches }];
  }), [summary.history, kind, status, agent]);

  return <>
    <div className="page-header self-governance-header">
      <div>
        <div className="eyebrow">DAILY SELF-GOVERNANCE</div>
        <h1>自省治理</h1>
        <p>每日沉淀经验、同步人设文件，并在每个 Agent 固定的 <code>self-audit</code> session 中保留治理上下文。</p>
      </div>
      <div className="governance-header-facts">
        <span>北京时间</span>
        <strong>积压 {summary.backlog}</strong>
      </div>
    </div>

    <section className="governance-mechanisms">
      <MechanismCard
        title="每日经验沉淀"
        eyebrow="SELF IMPROVEMENT"
        mechanism={summary.mechanisms.selfImprovement}
      />
      <MechanismCard
        title="每日人设治理"
        eyebrow="PERSONA AUDIT"
        mechanism={summary.mechanisms.personaAudit}
      />
    </section>

    <section className="panel governance-today">
      <div className="panel-title">
        <span>今日 Agent 队列</span>
        <span>{todayDispatches.length} 个计划</span>
      </div>
      {todayDispatches.length === 0
        ? <GovernanceEmpty title="今日尚未建立自省任务" body="到达配置时间后，系统会按组织层级冻结当日队列。" />
        : <DispatchTable dispatches={todayDispatches} members={members} identities={identities} />}
    </section>

    <section className="governance-history-section">
      <div className="governance-history-heading">
        <div><span className="eyebrow">LAST 7 SHANGHAI DAYS</span><h2>最近 7 天</h2></div>
        <div className="governance-filters panel" aria-label="历史筛选">
          <label>任务类型<select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
            <option value="all">全部</option>
            <option value="daily_self_improvement">经验沉淀</option>
            <option value="daily_persona_audit">人设治理</option>
          </select></label>
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="all">全部</option>
            <option value="pending">等待</option>
            <option value="running">运行中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="canceled">取消</option>
          </select></label>
          <label>Agent<select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="all">全部</option>
            {snapshot.organization.filter((member) => member.kind === "agent").map((member) =>
              <option value={member.id} key={member.id}>{member.name} · {member.id}</option>)}
          </select></label>
        </div>
      </div>
      {filteredHistory.length === 0
        ? <section className="panel"><GovernanceEmpty title="没有符合条件的历史" body="调整筛选条件，或等待首轮任务执行。" /></section>
        : <div className="governance-history-list">{filteredHistory.map((run) =>
          <HistoryRun key={run.id} run={run} members={members} identities={identities} />)}</div>}
    </section>
  </>;
}

function MechanismCard({
  title,
  eyebrow,
  mechanism,
}: {
  title: string;
  eyebrow: string;
  mechanism: Snapshot["dailySelfGovernance"]["mechanisms"]["selfImprovement"];
}) {
  const run = mechanism.today;
  return <article className="panel governance-mechanism-card">
    <header>
      <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
      <StatusBadge status={mechanism.enabled ? "succeeded" : "canceled"}>{mechanism.enabled ? scheduleLabel(mechanism.hour, mechanism.minute) : "已关闭"}</StatusBadge>
    </header>
    <div className="governance-mechanism-metrics">
      <Metric label="今日计划" value={String(run?.planned ?? 0)} />
      <Metric label="已成功" value={String(run?.succeeded ?? 0)} tone={(run?.succeeded ?? 0) > 0 ? "success" : undefined} />
      <Metric label="运行 / 等待" value={`${run?.running ?? 0} / ${run?.pending ?? 0}`} />
      <Metric label="失败 / 取消" value={`${run?.failed ?? 0} / ${run?.canceled ?? 0}`} tone={(run?.failed ?? 0) > 0 ? "danger" : undefined} />
    </div>
    <footer><span>下一轮：{formatTime(mechanism.nextRunAt)}</span><span>今日：{run ? formatTime(run.scheduledAt) : "尚未运行"}</span></footer>
  </article>;
}

function HistoryRun({
  run,
  members,
  identities,
}: {
  run: DailyAgentRunSummary;
  members: Map<string, Snapshot["organization"][number]>;
  identities: ReturnType<typeof useMemberIdentities>;
}) {
  const successRate = run.planned === 0 ? 0 : Math.round(run.succeeded / run.planned * 100);
  return <details className="panel governance-history-run">
    <summary>
      <div><strong>{run.localDate}</strong><span>{kindLabel(run.kind)}</span></div>
      <div className="governance-run-counts">
        <b>{successRate}%</b>
        <span>计划 {run.planned}</span>
        <span className="is-success">成功 {run.succeeded}</span>
        <span className={run.failed ? "is-danger" : ""}>失败 {run.failed}</span>
        <span>运行 {run.running} · 等待 {run.pending} · 取消 {run.canceled}</span>
      </div>
    </summary>
    {run.dispatches.length
      ? <DispatchTable dispatches={run.dispatches} members={members} identities={identities} />
      : <GovernanceEmpty title="本轮没有符合筛选条件的 Agent" body="本轮可能为空，或 Agent dispatch 已被筛选掉。" />}
  </details>;
}

function DispatchTable({
  dispatches,
  members,
  identities,
}: {
  dispatches: DailyAgentDispatch[];
  members: Map<string, Snapshot["organization"][number]>;
  identities: ReturnType<typeof useMemberIdentities>;
}) {
  return <div className="governance-dispatch-table" role="table">
    <div className="governance-dispatch-head" role="row">
      <span>计划</span><span>任务</span><span>Agent</span><span>Session</span><span>状态</span><span>执行时间 / 错误</span>
    </div>
    {dispatches.map((dispatch) => {
      const member = members.get(dispatch.targetMemberId);
      const identity = memberIdentity(identities, dispatch.targetMemberId, member?.name);
      return <div className={`governance-dispatch-row is-${dispatch.status}`} role="row" key={dispatch.id}>
        <time data-label="计划">{formatTime(dispatch.scheduledAt)}</time>
        <span data-label="任务"><b>{kindLabel(dispatch.kind)}</b><small>顺位 {dispatch.position + 1}</small></span>
        <span className="governance-agent" data-label="Agent"><AgentAvatar identity={identity} /><span><b>{identity.name}</b><small>L{member?.level ?? "—"} · {dispatch.targetMemberId}</small></span></span>
        <code data-label="Session">{dispatch.sessionKey}</code>
        <span data-label="状态"><StatusBadge status={dispatch.status}>{statusLabel(dispatch.status)}</StatusBadge></span>
        <span className="governance-dispatch-result" data-label="执行时间 / 错误">
          <small>{dispatch.startedAt ? `${formatTime(dispatch.startedAt)} → ${formatTime(dispatch.completedAt)}` : "尚未开始"}</small>
          {dispatch.lastError ? <em title={dispatch.lastError}>{dispatch.lastError}</em> : null}
        </span>
      </div>;
    })}
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  return <div className={tone ? `governance-metric is-${tone}` : "governance-metric"}><small>{label}</small><strong>{value}</strong></div>;
}

function StatusBadge({ status, children }: { status: DailyAgentDispatchStatus; children: string }) {
  return <span className={`governance-status is-${status}`}>{children}</span>;
}

function GovernanceEmpty({ title, body }: { title: string; body: string }) {
  return <div className="governance-empty"><span>↻</span><h3>{title}</h3><p>{body}</p></div>;
}

function kindLabel(kind: DailyAgentKind) {
  return kind === "daily_self_improvement" ? "经验沉淀" : "人设治理";
}

function statusLabel(status: DailyAgentDispatchStatus) {
  return ({ pending: "等待", running: "运行中", succeeded: "成功", failed: "失败", canceled: "取消" })[status];
}

function scheduleLabel(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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
