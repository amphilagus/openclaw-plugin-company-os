import { useEffect, useState } from "react";
import type { MeetingDetail } from "./types";

export function BossMeetingGate({
  meeting,
  busy,
  start,
  rejectMeeting,
  approveEnd,
  rejectEnd,
}: {
  meeting: MeetingDetail;
  busy: boolean;
  start: () => void;
  rejectMeeting: (reason: string) => void;
  approveEnd: () => void;
  rejectEnd: (feedback: string) => void;
}) {
  const [rejectingMeeting, setRejectingMeeting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

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
  if (meeting.endRequestedAt) {
    if (!meeting.bossParticipates) return <AutomaticEndCountdown meeting={meeting} />;
    if (rejecting) {
      return <div className="boss-gate end-approval">
        <span>暂不结束</span>
        <h3>告诉主持人为什么还不能结束</h3>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="驳回原因……" />
        <div>
          <button type="button" className="primary" disabled={busy || !feedback.trim()} onClick={() => { rejectEnd(feedback); setRejecting(false); setFeedback(""); }}>{busy ? "提交中…" : "发送驳回"}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setRejecting(false); setFeedback(""); }}>取消</button>
        </div>
      </div>;
    }
    return <div className="boss-gate end-approval">
      <span>主持人申请结束</span>
      <h3>由你决定是否结束会议</h3>
      <p>{meeting.endRequestedSummary}</p>
      <div>
        <button type="button" className="primary" disabled={busy} onClick={approveEnd}>批准并结束</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setRejecting(true)}>暂不结束</button>
      </div>
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
