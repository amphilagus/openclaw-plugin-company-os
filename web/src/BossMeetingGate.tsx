import { useEffect, useState } from "react";
import type { MeetingDetail } from "./types";

export function BossMeetingGate({
  meeting,
  busy,
  start,
  rejectMeeting,
  retryEntry,
  cancelEntry,
  speak,
  requestSummary,
  endMeeting,
  approveEnd,
  rejectEnd,
}: {
  meeting: MeetingDetail;
  busy: boolean;
  start: () => void;
  rejectMeeting: (reason: string) => void;
  retryEntry?: () => void;
  cancelEntry?: (reason: string) => void;
  speak?: () => void;
  requestSummary?: () => void;
  endMeeting?: (summary: string, publishNotice: boolean) => void;
  approveEnd?: () => void;
  rejectEnd?: (feedback: string) => void;
}) {
  const [rejectingMeeting, setRejectingMeeting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [ending, setEnding] = useState(false);
  const [finalSummary, setFinalSummary] = useState("");
  const [publishNotice, setPublishNotice] = useState(false);

  if (meeting.awaitingBossStart) {
    if (rejectingMeeting) {
      return <div className="boss-gate meeting-rejection">
        <span>拒绝会议</span>
        <h3>确认不召开这场会议</h3>
        <p>会议将进入历史记录，会议室会立即释放，并自动推进下一场排队会议。</p>
        <textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} rows={3} placeholder="拒绝原因……" />
        <div className="boss-gate-actions">
          <button type="button" className="danger-button" disabled={busy || !rejectionReason.trim()} onClick={() => { rejectMeeting(rejectionReason); setRejectingMeeting(false); setRejectionReason(""); }}>{busy ? "处理中…" : "确认拒绝会议"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setRejectingMeeting(false); setRejectionReason(""); }}>返回</button>
        </div>
      </div>;
    }
    return <div className="boss-gate">
      <span>会议已就位</span>
      <h3>所有人正在等待你</h3>
      <p>主持人尚未被唤醒。你进入会议室后点击开始，讨论才会正式启动。</p>
      <div className="boss-gate-actions">
        <button type="button" className="primary" disabled={busy} onClick={start}>{busy ? "正在启动…" : "我已进入，开始会议"}</button>
        <button type="button" className="danger-button" disabled={busy} onClick={() => setRejectingMeeting(true)}>拒绝此次会议</button>
      </div>
    </div>;
  }
  if (meeting.sessionMode === "dedicated" && meeting.entryState !== "ready") {
    const delivered = meeting.entryStatus.notified;
    const total = meeting.entryStatus.total;
    const failed = meeting.entryStatus.waitingMembers.filter((member) => member.lastError);
    return <div className="boss-gate meeting-entry-gate">
      <span>ENTRY BARRIER</span>
      <h3>{meeting.entryState === "notifying" ? `正在通知全员 · 已到 ${delivered}/${total}` : `正在绑定固定 meeting Sessions · ${meeting.entryStatus.ready}/${total}`}</h3>
      <p>全员 main 通知和预建 meeting session 绑定全部成功前，主持人不会启动；任务与公告只对已收到入会通知的成员暂缓。</p>
      {meeting.entryStatus.waitingMembers.length ? <div className="entry-member-list">{meeting.entryStatus.waitingMembers.map((member) => <div key={`${member.memberId}:${member.status}`}><b>{member.memberName}</b><span>{member.lastError ?? member.status}</span>{member.nextRetryAt ? <time>下次重试 {new Date(member.nextRetryAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : null}</div>)}</div> : null}
      <div className="boss-gate-actions">
        <button type="button" className="primary" disabled={busy || !retryEntry || failed.length === 0} onClick={retryEntry}>立即重试</button>
        <button type="button" className="danger-button" disabled={busy || !cancelEntry} onClick={() => { const reason = window.prompt("取消会议的原因："); if (reason) cancelEntry?.(reason); }}>取消会议</button>
      </div>
    </div>;
  }
  if (meeting.endRequestedAt) {
    if (!meeting.bossParticipates) return <AutomaticEndCountdown meeting={meeting} />;
    if (rejecting) {
      return <div className="boss-gate end-approval">
        <span>暂不结束</span>
        <h3>告诉主持人为什么还不能结束</h3>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="驳回原因……" />
        <div>
          <button type="button" className="primary" disabled={busy || !feedback.trim() || !rejectEnd} onClick={() => { rejectEnd?.(feedback); setRejecting(false); setFeedback(""); }}>{busy ? "提交中…" : "发送驳回"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setRejecting(false); setFeedback(""); }}>取消</button>
        </div>
      </div>;
    }
    return <div className="boss-gate end-approval">
      <span>主持人申请结束</span>
      <h3>由你决定是否结束会议</h3>
      <p>{meeting.endRequestedSummary}</p>
      <div>
        <button type="button" className="primary" disabled={busy || !approveEnd} onClick={approveEnd}>批准并结束</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setRejecting(true)}>暂不结束</button>
      </div>
    </div>;
  }
  if (meeting.bossParticipates && meeting.controlState === "waiting_boss") {
    if (ending) {
      const summaryRequired = !meeting.latestHostSummary && !finalSummary.trim();
      return <div className="boss-gate end-approval boss-direct-end">
        <span>BOSS FINAL DECISION</span>
        <h3>确认结束会议</h3>
        <p>最新主持人总结已优先预填。你可以直接采用或修改；没有主持人总结时必须填写简短最终总结。</p>
        <textarea rows={5} value={finalSummary} onChange={(event) => setFinalSummary(event.target.value)} placeholder="最终总结……" />
        {meeting.type === "discussion" ? <label className="publish-choice"><input type="checkbox" checked={publishNotice} onChange={(event) => setPublishNotice(event.target.checked)} />发布为公司公告</label> : <p>任务会议将强制校验完整任务草案并生成会议汇报。</p>}
        <div className="boss-gate-actions">
          <button type="button" className="primary" disabled={busy || summaryRequired || Boolean(meeting.bossEndBlockedReason) || !endMeeting} onClick={() => endMeeting?.(finalSummary.trim(), publishNotice)}>{busy ? "正在散会…" : "确认结束会议"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => setEnding(false)}>返回</button>
        </div>
        {meeting.bossEndBlockedReason ? <small className="end-blocked-reason">暂时不能结束：{meeting.bossEndBlockedReason}</small> : null}
      </div>;
    }
    return <div className="boss-gate boss-decision-gate">
      <span>WAITING FOR BOSS</span>
      <h3>现在由你决定下一步</h3>
      {meeting.latestHostSummary ? <p className="latest-host-summary"><b>最新主持人总结</b>{meeting.latestHostSummary}</p> : <p>主持人已完成当前推进并让渡控制权。会议不会自动结束或超时。</p>}
      <div className="boss-decision-actions">
        <button type="button" className="ghost" disabled={busy || !speak} onClick={speak}><b>1</b> 我要发言</button>
        <button type="button" className="ghost" disabled={busy || !requestSummary} onClick={requestSummary}><b>2</b> 请主持人总结</button>
        <button type="button" className="primary" disabled={busy || Boolean(meeting.bossEndBlockedReason) || !endMeeting} onClick={() => { setFinalSummary(meeting.latestHostSummary ?? ""); setEnding(true); }}><b>3</b> 结束会议</button>
      </div>
      {meeting.bossEndBlockedReason ? <small className="end-blocked-reason">结束按钮暂不可用：{meeting.bossEndBlockedReason}</small> : null}
    </div>;
  }
  return null;
}

function AutomaticEndCountdown({ meeting }: { meeting: MeetingDetail }) {
  const [remaining, setRemaining] = useState(() => secondsRemaining(meeting.autoEndAt));
  useEffect(() => {
    const update = () => setRemaining(secondsRemaining(meeting.autoEndAt));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [meeting.autoEndAt]);
  return <div className="boss-gate end-approval automatic-end">
    <span>主持人申请结束</span>
    <h3>{remaining > 0 ? `${remaining} 秒后自动结束` : "正在自动结束会议"}</h3>
    <p>{meeting.endRequestedSummary}</p>
    <div className="countdown-track"><i style={{ width: `${Math.min(100, Math.max(0, remaining / 60 * 100))}%` }} /></div>
  </div>;
}

function secondsRemaining(autoEndAt: string | null) {
  return autoEndAt ? Math.max(0, Math.ceil((Date.parse(autoEndAt) - Date.now()) / 1000)) : 0;
}
