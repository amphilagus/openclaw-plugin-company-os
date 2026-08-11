# Company OS 运行手册

## 启动检查

1. `npm run plugin:validate` 必须通过。
2. `openclaw plugins inspect company-os --runtime --json` 应显示插件已加载。
3. `openclaw plugins doctor` 不应报告 `company-os` 错误。
4. `openclaw gateway status` 应通过健康检查。
5. Control UI 侧栏出现「公司」，打开后默认进入会议室。

`openclaw plugins inspect company-os --runtime --json` 的 diagnostics 不应出现 `agent_end` 被策略拦截。若出现，确认配置含有：

```json5
plugins: {
  entries: {
    "company-os": {
      enabled: true,
      hooks: {
        allowConversationAccess: true,
      },
    },
  },
}
```

首次启动后，数据库应包含 `boss` 和组织架构师的真实 Agent ID。本机默认 Agent 是 `jia-goushi`，因此不应再出现作为别名的 `main`；可用 `organizationAdminAgentId` 显式覆盖架构师。

## 日常操作

- Boss 在任务页创建根任务；一级员工从 `company_inbox` 看到派发。
- 管理者在会外用 `company_task_create({ parentId, stages })` 原子创建分阶段任务流，或申请 `task` 会议用同样的阶段结构生成任务；阶段内并行，前一阶段全部必需任务验收关闭后才激活下一阶段。
- 负责人持续调用 `company_task_progress`，避免 72 小时后出现 stale 告警。
- Boss 可在活动任务详情点击「催促负责人」，主动唤醒负责人 main session 核对任务并推进实际状态；重复点击会在发送完成前自动去重。
- 叶子负责人先把当前成果推送到远端并读取分支 tip，再用 `company_task_submit` 提交摘要、proof/artifact 及必填的 `gitLocation.remoteUrl/branch/commit`。每个 `artifact.path` 必须指向提交者 workspace 内的真实普通文件，系统在提交事务前自动冻结；相对路径按 workspace 解析，最多 5 个文件且合计 15 MB，更多文件或目录需先打包。功能入口使用 `reviewHandoff.functionalVerification`。根任务附件随 Boss 邮件发送；子任务材料进入派发者 workspace 的 `验收材料/<taskId>/<submissionId>/`，并生成结构化 README。非 Boss 派发者必须先 `company_task_read` 当前 submission，再对冻结 commit 和材料用带结构化 `reviewReport` 的 `company_task_review` 验收或驳回。一级员工提交根任务时会立即给 Boss 排队一封持久化待验收邮件；子任务提交进入派发者的回转池。
- 不要让负责人在提交前等待验收人介入。Boss/派发者亲测、扫码、真机体验和业务人工确认属于 `review` 阶段：负责人完成本人交付、自测、运行环境和操作说明后直接提交，并在摘要中标明待验收检查；只有负责人自己的交付无法推进时才能报告 blocked。
- Agent 读取普通公告必须调用 `company_notice_read` 才会产生 read mark；读取 inbox 或收到半点提醒不会自动标记。会议完成时产生的 `meeting_report` 是例外：主持人与全部 worker/advisor 因已经接收终局同步而由系统原子写入 read mark。
- 后续可由架构师把 `company_inbox` 加入 Agent heartbeat；普通任务派发不会主动唤醒 Agent，公告发布后统一在北京时间半点汇总提醒，Boss 任务催办则立即进入持久队列。
- 需要 Boss 直接参加的会议在 `company_meeting_request` 中设置 `bossParticipates: true`。Boss 会收到创建、进入会议室和最终结果邮件，并在会议室页面负责开始、会前拒绝，以及发言、要求主持总结或直接结束三项决策。
- 会议发言必须结论先行并聚焦当前要求：默认“结论 + 最多 3 条关键依据 + 下一步/风险”，300 字以内，不复述背景或他人发言。主持人点名一次只问一个明确问题，每轮只收敛共识、分歧和下一动作，结论及责任人明确后及时结束。
- 未邀请 Boss 的会议提交结束申请后默认倒计时 60 秒自动完成；这段时间会议仍占用唯一会议室。
- 会议完成、取消或超时后先进入 WebUI 的“散会同步中”。主持人和全部参会 Agent 收到各自水位之后的最终时间线并确认送达后，会议才进入历史并让出下一场；Boss 不接收 Agent 调度。

## 会议恢复与超时

- Gateway 重启后，活动会议、队列、任务草案、上下文水位、持久主持人任务和未完成终局同步从 SQLite 恢复。任务巡检和公告提醒都只恢复从未尝试过的 dispatch；已经调用过 Agent 的巡检不会重新注入。
- Boss 开始、排队会议激活和主持人恢复使用 `meeting_agent_dispatches`。遗留的 `running` 任务以原 ID 重新排队；`succeeded` 任务不会再次领取。
- 重启时无法继续等待原调用者的同步参会者轮次会被审计标记失败，再由持久任务唤醒主持人检查记录并继续，系统不会伪造或重复参会者发言。
- 普通参会者默认 10 分钟未发言：轮次标记失败，控制权回主持人。
- 主持人默认 30 分钟无动作：会议变成 `timed_out`，不创建任务、不发布正常汇报；全员收到超时原因后会议室才推进到下一场。
- 等待 Boss 开始或等待 Boss 审批结束时暂停主持人超时；Gateway 重启后仍保持等待，不会误唤醒主持人。
- 普通会议的结束倒计时同样存放在 SQLite；Gateway 重启后按原 `end_requested_at` 继续，而不是重新计时。
- Boss 可取消排队会议，也可在受邀会议尚未开始时填写原因并拒绝；会前拒绝仍要等受邀 Agent 收到原因后释放该会议占用的房间。排队阶段取消会通知受邀成员，但不阻塞当前会议室。会议开始后仍不能从 WebUI 强制中断当前活动会议。

## 数据与备份

默认路径：

```text
~/.openclaw/plugins/company-os/company-os.sqlite
```

数据库启用 WAL、外键和事务。任务、会议、公告和审计记录不硬删除。稳定备份建议先停止 Gateway，再复制 SQLite 主文件及同目录的 `-wal`、`-shm` 文件；或者使用 SQLite 在线备份工具。

恢复前：

1. 停止 Gateway。
2. 备份现有数据库文件。
3. 将备份恢复到配置的 `databasePath`。
4. 启动 Gateway，检查 `openclaw plugins doctor` 和会议室状态。

Schema 版本保存在 `schema_meta`，当前版本为 v16，迁移在服务启动时执行。v4–v12 保留成员 ID 规范化、会议回写/终局同步、即时任务通知、旧整点巡检历史、公告提醒、根任务验收邮件和每日治理。v13 新增回转提示池、结构化验收、取消审批/事件、终态纠错及 Boss 任务事件邮件 outbox。v14 为 submission 增加经过远端验证的 Git 定位。v15 新增任务流/阶段、会议阶段草案、根任务会议要求和个人倒计时周期；v14 历史直接子任务组成一个隐式阶段，历史 canceled 项获得完成豁免，旧全局 tick 只读保留。v16 为任务增加不可恢复的 Boss 中止标记和原因；中止事务会废止整棵任务树、撤销尚未发送的任务调度、发布单条公告并返回可复用的根任务草稿。Boss 在任务页设置的回转池工作小时以 `task_prompt_work_start_hour` / `task_prompt_work_end_hour` 持久化到 `schema_meta`，不要手工修改。不要手工修改任务状态、阶段、池序号、个人调度、调度状态、水位、read mark 或任何 outbox 来绕过状态机。

## 常见故障

### WebUI 返回 401

先确认静态壳无需 Gateway Bearer token 即可加载：

```bash
curl -I http://127.0.0.1:18789/plugins/company-os-ui/meeting-room
```

应返回 `200`。公司数据 API 必须继续拒绝无 token 请求：

```bash
curl -i http://127.0.0.1:18789/plugins/company-os/api/v1/snapshot
```

应返回 `401`。如果静态壳正常但页面内数据请求返回 401，再确认从已登录的 Control UI「公司」标签进入，且：

```bash
openclaw config get gateway.controlUi.embedSandbox
```

结果为 `trusted`。严格 sandbox 无法读取同源 Control UI 在当前顶层浏览上下文中的 `sessionStorage` 登录令牌。

### 新员工无法加入组织

`company_org_add` 只接受已经存在于 OpenClaw `agents.list` 的 Agent ID。先创建 Agent，再由配置的组织架构师加入组织。

### 员工无法停用或换上级

先处理该成员作为负责人/派发者的所有活动任务、活动或排队会议，并安置其直属下属。系统不会级联修改。

### 父任务无法提交 review

检查当前任务流的所有必需阶段任务。新产生的 `canceled` 不算完成，必须恢复到取消前状态并继续；只有 v14 升级前已经取消的历史子任务带迁移豁免。`assigned`、`in_progress`、`review`、`blocked` 以及未恢复的必需 `canceled` 都会阻止父任务提交。

### 任务催办一直显示“正在通知”或“发送失败”

检查任务详情中的最近催办状态和 Gateway 日志里的 `company-os task reminder`。催办通过本机 `openclaw agent --agent <id> --message-file ... --json` 调用当前负责人的 main session，要求 `openclaw` 在 Gateway 进程的 `PATH` 中，且负责人仍是在职、可解析的真实 Agent ID。`launch_failed` / `in_flight` 这类明确未注入的失败最多重新领取三次；超时、异常退出、无效 JSON、未确认完成的空响应或 Gateway 在调用中重启都属于结果不确定，系统会停止自动重放并保留失败记录，避免重复注入。任务已进入 `review` / 终态或已经重派时，待发催办会自动取消并保留审计。

### 任务验收通知一直显示“正在通知”或“发送失败”

先确认验收人就是任务的 `issuerId`；根任务只能由 Boss 验收，子任务只能由实际派发者验收。验收结果与任务状态在同一事务内进入任务调度队列，再通过负责人的 main session 发送。检查任务详情中的“最近验收通知”、审计事件 `task.review_notification_*` 以及 Gateway 日志里的 `company-os task review_* dispatch`。完成但没有正文的 CLI turn 会直接记为送达；驳回通知若已经产生负责人记录进度、阻塞处理、重提验收或创建整改子任务等审计操作，也会视为成功。只有明确未注入 main session 的失败才重试；结果不确定或 Gateway 中断会停止自动重放并留下失败原因。与催办不同，验收通知记录的是已经发生的历史结果，不会因任务随后重新提交或关闭而取消。

### 任务会议无法结束

必须同时满足：无未完成发言轮次、无待处理 Boss 插话、总结非空、每个 worker 至少一份草案、全部草案负责人仍是主持人的直属下属、父任务仍由主持人负责且可继续拆分。

如果会议设置了 `bossParticipates: true`，主持人不能调用 `company_meeting_end` 或申请审批；没有更多内容时应调用 `company_meeting_yield_to_boss`。会议稳定进入 `waiting_boss` 后，Boss 可发言、要求主持人通过 `company_meeting_submit_summary` 提交可重复修改的总结，或直接结束。没有主持人总结时，Boss 结束前必须填写最终总结。

如果会议没有邀请 Boss，同一个工具会产生 60 秒自动结束倒计时；倒计时结束时才原子创建任务/公告并进入“散会同步中”，全员送达后释放会议室。默认值可通过 `meetingAutoEndDelaySeconds` 调整。

### 会议一直显示“散会同步中”

先在会议详情查看 `closeoutStatus` 和 `closeoutDispatches`，确认当前成员、尝试次数、`nextAttemptAt` 与最近错误；再检查 Gateway 日志里的 `company-os meeting closeout`。终局同步等待每名成员的 main 空闲后，通过官方 transcript API 写入可见系统消息，不触发 Agent turn。失败项按 30 秒起步、最高 5 分钟的指数退避持续重试；失败不会推进个人水位，也不会释放曾被该会议占用的房间。Gateway 重启会回收遗留租约，幂等键阻止重复消息，禁止手工将失败成员标记为成功。

终局提示必须包含“Company OS 会议结束同步”、结果、该成员水位之后的六位消息号时间线以及最终总结或终止原因。写入完成后，该成员解除会议专注状态；全员完成后释放本场固定 meeting session 绑定，但不会归档或删除该 session。

### 主持人一直显示“启动中”或“启动失败”

先看 `entryStatus` 与 `memberSessions`：所有 Agent 的 main 入会通知必须成功，随后每个 Agent 预建、名称为 `meeting` 的固定 session 都必须绑定成功，主持任务才会出现。推荐 key 为 `agent:<agentId>:meeting`；若通过 UI 创建，必须保证该 Agent 只有一个活动 session 的 `label` 或 `displayName` 为 `meeting`。失败时可在 WebUI 立即重试；系统不允许跳过成员。屏障完成后再检查 `hostDispatchStatus` 和 Gateway 日志里的 `company-os host dispatch`。插件通过本机 `openclaw agent --agent <id> --session-key <meetingSessionKey> --message-file ... --json` 调用主持人的固定 meeting session；确认 `openclaw` 在 Gateway 进程的 `PATH` 中，并且目标 Agent ID 仍存在于配置和组织中。OpenClaw 每日重置可能为同一 key 生成新的 session ID，这是正常轮转；首个会议写工具会按可信 Agent + session key 自动刷新缓存并记录 `meeting.session_binding_refreshed`，不应手工绕过会议派发任务。

Schema v4 起 Agent 的 `hostId` 就是真实 OpenClaw Agent ID，实际调用目标也可在 `hostDispatchStatus.targetAgentId` 中确认。CLI 有时会在 Agent 已通过会议工具完成工作后返回空的最终文本；服务会用本次调用冻结上下文之后是否出现经过校验的消息进展作为成功证据，这种情况不应重试或标记失败。

### 会议工具成功，但下一个主持人 turn 没有出现

先检查 `openclaw plugins inspect company-os --runtime --json`，确认 typed hook `agent_end` 已注册且没有策略警告。再检查 `meeting_session_context_appends`：成功记录应为 `appended`，对应 `meeting_agent_dispatches.wait_for_context_append_id` 的 `host_resume` 才会被领取。工具成功和 `agent_end` 都只会触发空闲检查；服务通过 OpenClaw active-run registry 确认同一会议 session 已退出后才追加，并在同一次安全刷新中重试临时失败。Gateway 重启会把遗留的 `appending` 恢复为 `pending`。普通 30 秒扫描绝不会改写 transcript，以免与仍在执行的 session 抢写。

正常回写是追加到该 Agent 固定 meeting session transcript 的普通 `user` 消息，不会触发新回复。该 Agent 自己的会议历史记录应显示 `你（姓名）`，例如：

```text
【消息 #000014｜第 3 轮｜点名】
你（架构师） @高级工程师：
请检查相关源码后给出判断。
```

工具的直接结果只应是 `accepted=true` 和“成功，本轮会话结束”，参会者回答必须由后续 `host_resume` 交付，不能出现在 `delegate` toolResult 中。

### Boss 头像没有显示

Boss 不属于 `agents.list`，头像走独立逻辑。默认读取 `~/.openclaw/workspace-boss/avatar.png`，要求是 2 MiB 以内的 PNG/JPEG/WebP/GIF/ICO；可用 `bossAvatarPath` 指向其他本地文件。修改后重启 Gateway 并刷新公司页面。

### 参会者返回了文字但会议没有卡住

这是审计代录兜底：当被点名 Agent 没有调用 `company_meeting_speak`、但 CLI 返回了非空文本时，系统会把该文本记录为其发言，并将轮次标记为 `completionSource=fallback`。审计时间线中的 `meeting.spoke_fallback` 会记录被调用 Agent 和代录原因。正常路径应当显示 `completionSource=tool`。

### Boss 没有收到会议邮件

默认读取 `~/.config/mail-skills/.env`，其中 QQ 默认账号至少需要 `PROVIDER=qq`、`USERNAME` 和 `PASSWORD`（QQ SMTP 授权码）。邮件采用持久 outbox，失败不会撤销会议；服务每 30 秒重试，最多五次，并将 `meeting.email_sent` 或 `meeting.email_failed` 写入审计。

如果使用命名邮箱账号或不同收件地址，在插件配置中设置 `bossEmailNotifications.account` 或 `bossEmailNotifications.recipient`。检查 Gateway 日志中的 `company-os sent Boss meeting email` / `company-os failed to send Boss meeting email`，不要把授权码写入日志或仓库。

### 一级员工提交根任务后 Boss 没有收到验收邮件

先确认任务是 `parentId=null`、`issuerId=boss` 的根任务，并已通过 `company_task_submit` 进入 `review`；普通子任务不会给 Boss 发邮件。检查 `task_review_email_notifications` 和任务审计中的 `task.review_email_queued`、`task.review_email_sent`、`task.review_email_failed`。邮件与任务提交在同一事务排队，以 submission ID 去重，失败由 30 秒扫描继续重试，最多五次；日志关键字为 `company-os sent Boss task review email`。SMTP 配置与会议邮件、Boss 巡检邮件共用 `bossEmailNotifications`。

### `company_task_submit` 报 Git 远端验证失败

先在任务实际仓库完成 `git push`，再用 `git ls-remote <remoteUrl> refs/heads/<branch>` 读取远端 tip；`branch` 不带 `refs/heads/` 前缀，`commit` 必须填写该 tip 的完整 40 位 SHA。只接受不内嵌账号密码的 HTTPS、SSH 或 `git@host:path` 远端。分支不存在、tip 已移动、认证失败、Git 不可用或 15 秒超时都会拒绝整个提交，任务应仍为 `in_progress`，且不会存在新的 submission 或验收邮件。不要把本地路径、短 SHA 或旧历史 commit 当作正式定位。

### 子任务已提交但上级 workspace 没有验收材料

先用 `company_task_read` 检查最新 submission 的 `reviewHandoff.delivery`。只要提交包含 `artifact.path` 或 `reviewHandoff.functionalVerification` 就会创建材料交付；`artifact.path` 在提交时已自动冻结，不能用摘要里的附件声明或普通 proof 代替。子任务目标固定为实际派发者配置的 workspace 下 `验收材料/<taskId>/<submissionId>/README.md`。`pending/delivering` 表示后台投递尚未完成，`failed` 会显示最近错误和尝试次数，最多五次并支持 Gateway 重启恢复。检查 `task_submission_material_deliveries`、`task_submission_attachments` 以及 `task.review_material_*` 审计；日志关键字为 `company-os delivered review material` / `company-os failed review material delivery`。材料投递失败不会阻止派发者依据冻结 Git 和数据库 evidence 验收。

### 员工没有收到任务回转提示

先在“公司 → 任务”的“任务回转提示池”面板确认功能已开启，并检查该员工的队列、池首、层级默认/覆盖间隔、剩余工作分钟和 `nextDueAt`。默认工作窗口为北京时间 `[08:00, 18:00)`；默认间隔是层级乘以 5 分钟，Boss 可在面板设置 1–600 分钟覆盖或恢复默认。旧 `taskRollingPrompts.intervalMinutes`、`taskHourlyCheckins` 和全局 `:00/:20/:40` tick 已废弃。

检查 `task_prompt_pool_items`、`task_prompt_schedules`、`task_prompt_cycles`、`task_prompt_cycle_dispatches` 和 `entity_type=task_prompt_cycle` 的审计。`skipped_busy` 表示到期时 main session 已被用户、即时通知或其他系统激活，或员工正作为主持人/参会者处于活动会议中，池首不动并重走完整间隔；`skipped_empty` 表示池为空且计时停止；`skipped_offline` 表示 Gateway 离线错过到期点；`failed` 且 `started=0` 表示没有确认启动、池首不动；`started=1` 表示已经轮转到队尾，本次提示不会重放。日志关键字为 `company-os rolling task prompt countdown`。

如果池项内容与任务树不一致，重启 Gateway 会按真实状态删除过期项、补齐缺失项，同时保留仍有效项的原顺序。执行任务只有在没有活动直接子任务时才入池；blocked 子任务只进入派发者的 `blocked_review`，不再定时提醒负责人。一次已启动的阻塞审查结束后若子任务仍未解除，Company OS 会自动阻塞父任务；原子任务审查项随即失效，阻塞继续进入更上一级审查或 Boss 邮件，而不会留在当前员工池中无限回转。即时验收/驳回、阻塞上下行、取消审批和纠错通知检查 `task_agent_dispatches`，它们与回转池是两套独立队列。

### 员工没有收到公告半点提醒

先在“公司 → 告示板”的“公告半点提醒”面板确认功能已开启、北京时间窗口、下一轮、当前未读 Agent/人次和积压。默认只在 08:30–17:30 的半点建立新一轮；Gateway 离线期间错过的半点不会补建，已经写入数据库但从未尝试的 dispatch 会在启动时恢复，已经尝试过的 dispatch 不会重发。配置项为 `noticeUnreadReminders.enabled/startHour/endHour`，起止小时都包含在窗口内，时区固定为 `Asia/Shanghai`。

检查 `notice_reminder_runs`、`notice_reminder_dispatches`，以及 `entity_type=notice_reminder` 的审计。日志关键字为 `company-os notice reminder`。每名 Agent 每轮只有一条汇总：`pending` 等待唯一一次调用，`running` 已领取，`succeeded` 已进入 main session 或本轮已产生可信 `notice.read`，`failed` 表示唯一一次调用未确认成功且不会重试，`skipped` 表示候选在发送前已全部阅读/删除/被更正，或旧轮提醒仍未结束，`canceled` 表示目标员工已经停用。成功送达不会替普通公告写 read mark，因此员工未实际调用 `company_notice_read` 时下个半点会由新一轮、新 dispatch 再提醒。

会议汇报少于预期未读人数时，先检查公告审计 `notice.meeting_participants_marked_read`：正常情况下主持人和 `meeting_participants` 中所有 worker/advisor 都会自动已读，并与 `meeting_closeout_dispatches` 的 Agent 成员集合一致；Boss 不在 read mark 中，未参会员工仍未读。取消、超时、未发布公告的讨论会不会产生这条审计。人工更正公告是新 ID，原参会者必须重新阅读。

### Agent 没有执行每日自省治理

先进入“公司 → 自省治理”，确认“每日经验沉淀”和“每日人设治理”已开启、下一轮时间正确，并查看今日队列中的 Agent 状态与错误。默认基础时间为北京时间 05:00 和 06:00；同一轮按组织层级与 Agent ID 排序，每人错开一分钟。Gateway 在基础时间之后才启动不会补建当天错过的轮次。

检查 `daily_agent_runs`、`daily_agent_dispatches`，以及 `entity_type=daily_agent_run` 的审计。日志关键字为 `company-os daily self-improvement` 和 `company-os daily persona-audit`。`pending` 表示尚未调用，`running` 表示固定的 `agent:<agentId>:self-audit` session 正在执行，`succeeded` 表示 Agent turn 已完成，`failed` 表示唯一一次调用未确认成功且不会自动重放，`canceled` 表示目标员工已停用。

不同 Agent 会按计划时间并行，同一 Agent 的两类任务串行。如果前一项超过一小时，后一项会等前一项结束后再领取；若 Gateway 在已经领取后中断，该 dispatch 会封存为 `failed`，避免重复修改 persona 或 memory 文件。配置项为 `dailySelfImprovement.enabled/hour/minute` 与 `dailyPersonaAudit.enabled/hour/minute`，页面只读，修改配置后需按正常流程重启 Gateway。
