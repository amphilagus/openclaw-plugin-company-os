import type { MeetingDetail } from "./types";

export function BossMeetingGate({
  meeting,
  busy,
  start,
  approveEnd,
  rejectEnd,
}: {
  meeting: MeetingDetail;
  busy: boolean;
  start: () => void;
  approveEnd: () => void;
  rejectEnd: () => void;
}) {
  if (meeting.awaitingBossStart) {
    return <div className="boss-gate">
      <span>会议已就位</span>
      <h3>所有人正在等待你</h3>
      <p>主持人尚未被唤醒。你进入会议室后点击开始，讨论才会正式启动。</p>
      <button type="button" className="primary" disabled={busy} onClick={start}>{busy ? "正在启动…" : "我已进入，开始会议"}</button>
    </div>;
  }
  if (meeting.endRequestedAt) {
    return <div className="boss-gate end-approval">
      <span>主持人申请结束</span>
      <h3>由你决定是否结束会议</h3>
      <p>{meeting.endRequestedSummary}</p>
      <div>
        <button type="button" className="primary" disabled={busy} onClick={approveEnd}>批准并结束</button>
        <button type="button" className="ghost" disabled={busy} onClick={rejectEnd}>暂不结束</button>
      </div>
    </div>;
  }
  return null;
}
