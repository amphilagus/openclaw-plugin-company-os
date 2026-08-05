import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
const now = new Date().toISOString();
const members = [
  { id: "boss", kind: "boss", name: "Boss", title: "CEO", managerId: null, level: 0, active: true },
  { id: "main", kind: "agent", name: "架构师", title: "首席架构师", managerId: "boss", level: 1, active: true },
  { id: "cto", kind: "agent", name: "CTO", title: "首席技术官", managerId: "boss", level: 1, active: true },
  { id: "eng-a", kind: "agent", name: "高工 A", title: "高级工程师", managerId: "cto", level: 2, active: true },
  { id: "eng-b", kind: "agent", name: "高工 B", title: "高级工程师", managerId: "cto", level: 2, active: true },
];
const tasks = [
  task("root-001", null, "交付 Company OS v1", "boss", "cto", "in_progress", ["child-001", "child-002"]),
  { ...task("child-001", "root-001", "完成原生会议引擎", "cto", "eng-a", "blocked", []), blockedReason: "等待 Session 调度接口确认" },
  task("child-002", "root-001", "完成任务树与审计", "cto", "eng-b", "review", []),
];
const activeMeeting = { id: "meeting-001", type: "task", status: "active", title: "Company OS 战略拆解会", agenda: "确定首版交付边界、负责人和验收标准", hostId: "cto", requestedBy: "cto", parentTaskId: "root-001", summary: null, queuePosition: 0, participantCount: 3, currentTurnId: "turn-001", createdAt: now, startedAt: now, endedAt: null, canceledReason: null };
const meeting = {
  ...activeMeeting,
  participants: [{ agentId: "eng-a", role: "worker", name: "高工 A", title: "高级工程师" }, { agentId: "eng-b", role: "worker", name: "高工 B", title: "高级工程师" }, { agentId: "main", role: "advisor", name: "架构师", title: "首席架构师" }],
  messages: [
    { id: "m1", sequence: 1, authorKind: "system", authorId: null, targetId: null, body: "会议室已开放，主持人开始组织会议。", createdAt: now },
    { id: "m2", sequence: 2, authorKind: "member", authorId: "cto", targetId: "eng-a", body: "请说明会议引擎的主要风险。", createdAt: now },
    { id: "m3", sequence: 3, authorKind: "boss", authorId: "boss", targetId: "main", body: "请从整体架构一致性上做一次判断。", createdAt: now },
  ],
  taskDrafts: [{ id: "d1", position: 0, title: "实现会议状态机", description: "队列与发言编排", acceptanceCriteria: "超时和恢复测试通过", assigneeId: "eng-a" }, { id: "d2", position: 1, title: "完成任务 API", description: "严格层级校验", acceptanceCriteria: "逐层验收演练通过", assigneeId: "eng-b" }],
  currentTurn: { speakerId: "eng-a", prompt: "请说明会议引擎的主要风险。", startedAt: now },
};
const historySummary = { ...activeMeeting, id: "meeting-history-001", status: "completed", title: "Company OS 立项会", summary: "确定会议、任务和告示板三大模块。", currentTurnId: null, endedAt: now };
const historyMeeting = { ...meeting, ...historySummary, currentTurn: null };
const snapshot = {
  organization: members,
  tasks,
  notices: [{ id: "notice-001", authorId: "main", kind: "manual", title: "Company OS 架构基线", body: "所有治理行为统一进入会议、任务和公告三个模块。\n任务关闭严格遵循自下而上原则。", sourceMeetingId: null, supersedesNoticeId: null, supersededById: null, effective: true, activeEmployeeCount: 4, readCount: 3, createdAt: now }],
  meetings: { active: activeMeeting, queue: [{ ...activeMeeting, id: "meeting-002", type: "discussion", status: "queued", title: "前端交互评审", hostId: "eng-a", parentTaskId: null, queuePosition: 1, currentTurnId: null }], history: [historySummary] },
  generatedAt: now,
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname.endsWith("/api/v1/snapshot")) return json(res, snapshot);
  if (url.pathname.endsWith("/api/v1/meetings/meeting-001")) return json(res, meeting);
  if (url.pathname.endsWith("/api/v1/meetings/meeting-history-001")) return json(res, historyMeeting);
  if (url.pathname.includes("/api/v1/identities/")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    const member = members.find((candidate) => candidate.id === id);
    return json(res, { id, name: member?.name ?? id, title: member?.title ?? "", emoji: id === "main" ? "⚙️" : "🔧", avatarUrl: "data:image/png;base64,iVBORw0KGgo=" });
  }
  if (url.pathname.includes("/api/v1/tasks/")) return json(res, { ...tasks.find((item) => url.pathname.endsWith(item.id)), versions: [], progress: [], submissions: [], audit: [] });
  if (url.pathname.endsWith("/api/v1/events")) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`event: ready\ndata: {}\n\n`);
    return;
  }
  if (req.method === "POST") return json(res, meeting);
  const relative = url.pathname.replace(/^\/plugins\/company-os-ui\/?/, "") || "index.html";
  const candidate = path.resolve(root, relative);
  const file = candidate.startsWith(`${root}${path.sep}`) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : path.join(root, "index.html");
  res.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(res);
});

server.listen(4174, "127.0.0.1", () => console.log("Company OS fixture: http://127.0.0.1:4174/plugins/company-os-ui/meeting-room"));

function task(id, parentId, title, issuerId, assigneeId, status, childIds) {
  return { id, parentId, issuerId, assigneeId, title, description: `${title} 的具体说明`, acceptanceCriteria: "相关测试与验收证据完整", status, revision: 1, blockedReason: null, reviewFeedback: null, childIds, childCounts: { total: childIds.length, active: childIds.length, closed: 0, canceled: 0 }, risks: { blockedDescendants: id === "root-001" ? 1 : 0, staleDescendants: 0, stale: false }, createdAt: now, updatedAt: now, lastActivityAt: now };
}

function json(res, value) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
function contentType(file) { return file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"; }
