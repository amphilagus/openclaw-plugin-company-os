# Company OS 运行手册

## 启动检查

1. `npm run plugin:validate` 必须通过。
2. `openclaw plugins inspect company-os --runtime --json` 应显示插件已加载。
3. `openclaw plugins doctor` 不应报告 `company-os` 错误。
4. `openclaw gateway status` 应通过健康检查。
5. Control UI 侧栏出现「公司」，打开后默认进入会议室。

首次启动后，数据库应包含 `boss` 和 `main`。如果没有 `main`，先确认 OpenClaw `agents.list` 中存在 `id: "main"`，再重启 Gateway。

## 日常操作

- Boss 在任务页创建根任务；一级员工从 `company_inbox` 看到派发。
- 管理者在会外用 `company_task_create` 拆分，或申请 `task` 会议原子生成子任务。
- 负责人持续调用 `company_task_progress`，避免 72 小时后出现 stale 告警。
- 叶子负责人用 `company_task_submit` 提交摘要和 proof/artifact；派发者用 `company_task_review` 验收或驳回。
- Agent 读取公告必须调用 `company_notice_read` 才会产生 read mark；读取 inbox 不会自动标记。
- 后续可由架构师把 `company_inbox` 加入 Agent heartbeat；本插件本身不唤醒 Agent 处理任务或公告。
- 需要 Boss 直接参加的会议在 `company_meeting_request` 中设置 `bossParticipates: true`。Boss 会收到创建和进入会议室两封邮件，并在会议室页面负责开始和最终结束审批。

## 会议恢复与超时

- Gateway 重启后，活动会议、队列、任务草案、上下文水位和持久主持人任务从 SQLite 恢复。
- Boss 开始、排队会议激活和主持人恢复使用 `meeting_agent_dispatches`。遗留的 `running` 任务以原 ID 重新排队；`succeeded` 任务不会再次领取。
- 重启时无法继续等待原调用者的同步参会者轮次会被审计标记失败，再由持久任务唤醒主持人检查记录并继续，系统不会伪造或重复参会者发言。
- 普通参会者默认 10 分钟未发言：轮次标记失败，控制权回主持人。
- 主持人默认 30 分钟无动作：会议变成 `timed_out`，不创建任务、不发布正常汇报，会议室推进到下一场。
- 等待 Boss 开始或等待 Boss 审批结束时暂停主持人超时；Gateway 重启后仍保持等待，不会误唤醒主持人。
- Boss 只能取消排队会议，不能从 WebUI 中断当前活动会议。

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

Schema 版本保存在 `schema_meta`，当前版本为 v3，迁移在服务启动时执行。不要手工修改任务状态来绕过关单规则。

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

`company_org_add` 只接受已经存在于 OpenClaw `agents.list` 的 Agent ID。先创建 Agent，再由 `main` 加入组织。

### 员工无法停用或换上级

先处理该成员作为负责人/派发者的所有活动任务、活动或排队会议，并安置其直属下属。系统不会级联修改。

### 父任务无法提交 review

检查所有直接子任务。只有 `closed` 和带原因的 `canceled` 算终态；`assigned`、`in_progress`、`review`、`blocked` 都会阻止父任务提交。

### 任务会议无法结束

必须同时满足：无未完成发言轮次、无待处理 Boss 插话、总结非空、每个 worker 至少一份草案、全部草案负责人仍是主持人的直属下属、父任务仍由主持人负责且可继续拆分。

如果会议设置了 `bossParticipates: true`，满足上述条件后主持人的 `company_meeting_end` 只产生结束申请。Boss 需在「公司 → 会议室」中批准；选择「暂不结束」时必须填写反馈，系统随后重新唤醒主持人。

### 主持人一直显示“启动中”或“启动失败”

先检查会议详情中的 `hostDispatchStatus` 和 Gateway 日志里的 `company-os host dispatch`。插件通过本机 `openclaw agent --agent <id> --message-file ... --json` 调用主持人的 main session；确认 `openclaw` 在 Gateway 进程的 `PATH` 中，并且目标 Agent ID 仍存在于配置和组织中。`in_flight` 会自动重试三次；其他失败最多领取三次，最终状态和错误会保留在数据库及 WebUI，不能用日志中的“queued”当作主持人已经收到消息。

会议详情中的 `hostId` 是组织成员 ID，不一定等于 OpenClaw Agent ID；实际调用目标可在 `hostDispatchStatus.targetAgentId` 中确认。CLI 有时会在 Agent 已通过会议工具完成工作后返回空的最终文本；服务会用本次调用冻结上下文之后是否出现经过校验的消息进展作为成功证据，这种情况不应重试或标记失败。

### 参会者返回了文字但会议没有卡住

这是审计代录兜底：当被点名 Agent 没有调用 `company_meeting_speak`、但 CLI 返回了非空文本时，系统会把该文本记录为其发言，并将轮次标记为 `completionSource=fallback`。审计时间线中的 `meeting.spoke_fallback` 会记录被调用 Agent 和代录原因。正常路径应当显示 `completionSource=tool`。

### Boss 没有收到会议邮件

默认读取 `~/.config/mail-skills/.env`，其中 QQ 默认账号至少需要 `PROVIDER=qq`、`USERNAME` 和 `PASSWORD`（QQ SMTP 授权码）。邮件采用持久 outbox，失败不会撤销会议；服务每 30 秒重试，最多五次，并将 `meeting.email_sent` 或 `meeting.email_failed` 写入审计。

如果使用命名邮箱账号或不同收件地址，在插件配置中设置 `bossEmailNotifications.account` 或 `bossEmailNotifications.recipient`。检查 Gateway 日志中的 `company-os sent Boss meeting email` / `company-os failed to send Boss meeting email`，不要把授权码写入日志或仓库。
