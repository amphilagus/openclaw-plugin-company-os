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
- 管理者在会外用 `company_task_create` 拆分，或申请 `task` 会议原子生成子任务。
- 负责人持续调用 `company_task_progress`，避免 72 小时后出现 stale 告警。
- Boss 可在活动任务详情点击「催促负责人」，主动唤醒负责人 main session 核对任务并推进实际状态；重复点击会在发送完成前自动去重。
- 叶子负责人用 `company_task_submit` 提交摘要和 proof/artifact；派发者用 `company_task_review` 验收或驳回。
- Agent 读取公告必须调用 `company_notice_read` 才会产生 read mark；读取 inbox 不会自动标记。
- 后续可由架构师把 `company_inbox` 加入 Agent heartbeat；普通派发和公告不会主动唤醒 Agent，Boss 明确点击任务催办时除外。
- 需要 Boss 直接参加的会议在 `company_meeting_request` 中设置 `bossParticipates: true`。Boss 会收到创建和进入会议室两封邮件，并在会议室页面负责开始、会前拒绝和最终结束审批。
- 未邀请 Boss 的会议提交结束申请后默认倒计时 60 秒自动完成；这段时间会议仍占用唯一会议室。
- 会议完成、取消或超时后先进入 WebUI 的“散会同步中”。主持人和全部参会 Agent 收到各自水位之后的最终时间线并确认送达后，会议才进入历史并让出下一场；Boss 不接收 Agent 调度。

## 会议恢复与超时

- Gateway 重启后，活动会议、队列、任务草案、上下文水位、持久主持人任务和未完成终局同步从 SQLite 恢复。
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

Schema 版本保存在 `schema_meta`，当前版本为 v8，迁移在服务启动时执行。v4 会把旧成员别名规范成真实 Agent ID；v5 新增持久化 main-session 会议记录回写和主持人“等待回写完成”关联；v6 新增 Boss 任务催办持久调度表；v7 新增会议终局同步 outbox 和严格房间屏障；v8 扩展任务调度表以发送验收通过/驳回结果。v7 不回溯处理已存在的历史终态会议。不要手工修改任务状态、调度状态、水位或任何 outbox 来绕过状态机。

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

检查所有直接子任务。只有 `closed` 和带原因的 `canceled` 算终态；`assigned`、`in_progress`、`review`、`blocked` 都会阻止父任务提交。

### 任务催办一直显示“正在通知”或“发送失败”

检查任务详情中的最近催办状态和 Gateway 日志里的 `company-os task reminder`。催办通过本机 `openclaw agent --agent <id> --message-file ... --json` 调用当前负责人的 main session，要求 `openclaw` 在 Gateway 进程的 `PATH` 中，且负责人仍是在职、可解析的真实 Agent ID。发送失败最多重新领取三次；Gateway 重启会恢复遗留的 `running` 记录。任务已进入 `review` / 终态或已经重派时，待发催办会自动取消并保留审计。

### 任务验收通知一直显示“正在通知”或“发送失败”

先确认验收人就是任务的 `issuerId`；根任务只能由 Boss 验收，子任务只能由实际派发者验收。验收结果与任务状态在同一事务内进入任务调度队列，再通过负责人的 main session 发送。检查任务详情中的“最近验收通知”、审计事件 `task.review_notification_*` 以及 Gateway 日志里的 `company-os task review_* dispatch`。通知失败最多重试三次，Gateway 重启会恢复发送；与催办不同，验收通知记录的是已经发生的历史结果，不会因任务随后重新提交或关闭而取消。

### 任务会议无法结束

必须同时满足：无未完成发言轮次、无待处理 Boss 插话、总结非空、每个 worker 至少一份草案、全部草案负责人仍是主持人的直属下属、父任务仍由主持人负责且可继续拆分。

如果会议设置了 `bossParticipates: true`，满足上述条件后主持人的 `company_meeting_end` 只产生结束申请。Boss 需在「公司 → 会议室」中批准；选择「暂不结束」时必须填写反馈，系统随后重新唤醒主持人。

如果会议没有邀请 Boss，同一个工具会产生 60 秒自动结束倒计时；倒计时结束时才原子创建任务/公告并进入“散会同步中”，全员送达后释放会议室。默认值可通过 `meetingAutoEndDelaySeconds` 调整。

### 会议一直显示“散会同步中”

先在会议详情查看 `closeoutStatus` 和 `closeoutDispatches`，确认当前成员、尝试次数、`nextAttemptAt` 与最近错误；再检查 Gateway 日志里的 `company-os meeting closeout`。终局同步通过本机 `openclaw agent --agent <id> --message-file ... --json` 主动调用每名成员的 main session，要求目标 Agent 仍在配置中且 `openclaw` 位于 Gateway 的 `PATH`。失败项按 30 秒起步、最高 5 分钟的指数退避持续重试；失败不会推进个人水位，也不会释放曾被该会议占用的房间。Gateway 重启会回收遗留租约，成功项依靠 `(meeting_id, member_id)` 唯一键保持幂等，禁止手工将失败成员标记为成功。

部分 provider 会把 Agent 的确认正常写入 main-session transcript，但 CLI 的成功 JSON 不带 text payload。服务仅在 CLI 进程正常退出、JSON 有效且 `status` 明确为 `ok` / `completed` / `success` 时把这种 `empty_reply` 视为已处理，并记录 warning；超时、异常退出、无效 JSON 或未确认完成的空响应仍会重试。这个宽容只用于无需正文回传的终局同步，不会放宽会议发言路径。

终局提示必须包含“Company OS 会议结束同步”、结果、该成员水位之后的六位消息号时间线以及主持人最终总结或终止原因，并要求只确认同步、不再调用会议工具。Agent 的确认只能留在其 main session；如果确认出现在 `meeting_messages`，说明有其他路径在已关闭会议上错误写入，需要保留数据库并检查日志。

### 主持人一直显示“启动中”或“启动失败”

先检查会议详情中的 `hostDispatchStatus` 和 Gateway 日志里的 `company-os host dispatch`。插件通过本机 `openclaw agent --agent <id> --message-file ... --json` 调用主持人的 main session；确认 `openclaw` 在 Gateway 进程的 `PATH` 中，并且目标 Agent ID 仍存在于配置和组织中。`in_flight` 会自动重试三次；其他失败最多领取三次，最终状态和错误会保留在数据库及 WebUI，不能用日志中的“queued”当作主持人已经收到消息。

Schema v4 起 Agent 的 `hostId` 就是真实 OpenClaw Agent ID，实际调用目标也可在 `hostDispatchStatus.targetAgentId` 中确认。CLI 有时会在 Agent 已通过会议工具完成工作后返回空的最终文本；服务会用本次调用冻结上下文之后是否出现经过校验的消息进展作为成功证据，这种情况不应重试或标记失败。

### 会议工具成功，但下一个主持人 turn 没有出现

先检查 `openclaw plugins inspect company-os --runtime --json`，确认 typed hook `agent_end` 已注册且没有策略警告。再检查 `meeting_session_context_appends`：成功记录应为 `appended`，对应 `meeting_agent_dispatches.wait_for_context_append_id` 的 `host_resume` 才会被领取。工具成功和 `agent_end` 都只会触发空闲检查；服务通过 OpenClaw active-run registry 确认同一 main session 已退出后才追加，并在同一次安全刷新中重试临时失败。Gateway 重启会把遗留的 `appending` 恢复为 `pending`，在没有活动 run 的启动阶段补写。普通 30 秒扫描绝不会改写 transcript，以免与仍在执行的 main session 抢写。三次失败后记录保留为 `failed`，不会绕过回写顺序强行唤醒主持人。

正常回写是追加到同一 `agent:<agentId>:main` transcript 的普通 `user` 消息，不会触发新回复。该 Agent 自己的历史记录应显示 `你（姓名）`，例如：

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

### 员工没有收到分时任务巡检

先在“公司 → 任务”的“今日任务整点巡检”面板确认功能已开启、下一轮和下一提醒时间。默认只在北京时间 08:00–17:00 的整点建立新一轮，员工提示安排在 `:00`、`:15`、`:30`；Gateway 在整点之后才启动不会补建该小时，但数据库里已存在的历史槽位会继续发送。

检查 `task_checkin_runs`、`task_checkin_batches` 和 `task_checkin_dispatches`。`skipped` 表示整点候选快照中的任务在实际发送前已经失效且没有可递补项；`failed` 表示三次 Agent 调用均失败。日志关键字为 `company-os task check-in`。每个提示只包含一个任务，成功送达只代表 Agent turn 完成，实际审批或推进结果应继续检查任务状态及审计。

Boss 巡检邮件与会议邮件共用 `bossEmailNotifications`。任务页会显示 Boss 当前待验收数、异常数、邮件状态和最后错误；检查日志中的 `company-os sent Boss task check-in email`。显式关闭 Boss 邮件时，Boss 调度记为 `skipped`，任务页仍保留当前待办数量。
