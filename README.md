# OpenClaw Company OS

`company-os` 是一个原生 OpenClaw 插件，把公司治理收敛到一套共享基础设施和三种业务对象：会议、严格层级任务、公司公告。Boss 在统一 WebUI 操作，Agent 只能通过 `company_*` 工具参与。

## 核心约束

- 一个 Boss、一间会议室、单一 Gateway、单一 SQLite 数据库。
- 任务是严格树，不是 DAG：根任务只能由 Boss 派给一级直属员工；子任务只能由父任务负责人派给直属下属。
- 任务只能自下而上关闭。负责人携 proof 提交 review，派发者验收后永久关闭。
- 会议严格串行。任务会议结束时，子任务、会议总结、会议汇报公告、参会 Agent 的公告 read mark 和全员终局同步 outbox 在同一事务中原子提交。
- 会议可设置 `bossParticipates=true`：进入会议室后等待 Boss 手动开始，主持人只能申请结束，最终结束权固定属于 Boss。
- 未邀请 Boss 的会议也先提交结束申请，WebUI 显示 60 秒倒计时；到期后服务原子关会，Gateway 重启不会丢失倒计时。
- 公告不可编辑；修正通过 `supersedesNoticeId` 发布新公告。Boss 还可在 WebUI 二次确认后审计删除公告。
- Boss 写操作由服务端固定记录为 `actor=boss`；Agent 身份只读取可信的 `toolContext.agentId`。
- 普通任务派发与公告发布不立即唤醒 Agent；Boss 催办、逐级验收结果、分时任务巡检和公告半点提醒会进入持久调度队列。会议点名由插件同步调用 `agent:<agentId>:main`，会议工具成功后结束当前 turn，编排器持久化回写记录并用新的主持人 turn 继续会议。
- 会议进入完成、取消或超时终态后，编排器主动唤醒主持人及全部参会 Agent，同步各自水位之后的最终记录；曾占用会议室的会议必须等全员送达后才释放下一场。

## 技术结构

```text
OpenClaw Gateway
├── CompanyOsService（同步会议编排、持久主持人/终局队列、自动关会、恢复、超时扫描、SSE）
├── 28 个 company_* Agent 工具
├── /plugins/company-os/api/v1/*（Gateway 鉴权，仅 API）
├── /plugins/company-os-ui/*（无敏感数据的 WebUI 静态壳）
├── Control UI 标签页「公司」（operator.write）
└── company-os.sqlite
    ├── organization + audit
    ├── task tree + versions + proof
    ├── notices + read marks + half-past reminder runs/dispatch outbox
    ├── task check-in runs + batches + dispatch outbox
    └── meeting queue + transcript + turns + context watermarks + session append/dispatch/email/closeout outbox
```

前端是 React + Vite，包含三个真实路由：

- `/plugins/company-os-ui/meeting-room`：默认页面，当前会议、Boss 开始/结束审批、普通会议结束倒计时、插话、任务草案、散会同步进度、队列和历史。
- `/plugins/company-os-ui/tasks`：任务树、风险、版本/proof/审计、Boss 催办与兜底操作和根任务创建。
- `/plugins/company-os-ui/notices`：当前共识、历史更正、会议汇报、阅读覆盖和公告半点提醒状态。

## 安装与开发

要求 OpenClaw `>=2026.7.1` 和支持 `node:sqlite` 的 Node.js。

```bash
cd /Users/amphilagusgu/.openclaw/company/openclaw-plugin-company-os
npm install
npm test
npm run plugin:validate
openclaw plugins install --link /Users/amphilagusgu/.openclaw/company/openclaw-plugin-company-os
openclaw config set gateway.controlUi.embedSandbox trusted
openclaw gateway restart
```

`trusted` 让同源插件 iframe 在静态壳加载后复用 Control UI 保存在同一顶层浏览上下文 `sessionStorage` 中的 Gateway 登录令牌；页面本身不提供第二套认证。静态壳不包含公司数据，所有读取、写入和 SSE 请求仍访问 Gateway 鉴权的 `/plugins/company-os/api/v1/*`。标签页和写接口面向拥有 `operator.write` 的 Boss 操作者。

插件必须设置 `plugins.entries.company-os.hooks.allowConversationAccess=true`，用于通过可信工具上下文完成 main-session 会议记录回写。会议基本规则不由插件注入，而由现有 `company-guidelines` Hook 在 `agent:bootstrap` 时从 `~/.openclaw/company-info/company-hard-rules.md` 统一添加到临时 `AGENTS.md` 头部。完整配置见样例。

开发前端：

```bash
npm run dev:web
```

无业务写入的三页视觉验收：`npm run build && npm run preview:fixture`。

生产构建：

```bash
npm run build
```

默认数据库位于 `~/.openclaw/plugins/company-os/company-os.sqlite`。配置样例见 [examples/openclaw.config.json5](examples/openclaw.config.json5)，运行与恢复说明见 [docs/RUNBOOK.md](docs/RUNBOOK.md)。

### Boss 直接参会

Agent 申请会议时可传入 `bossParticipates: true`。该模式有四个额外约束：

1. 创建会议时向 Boss 邮箱发送“会议已创建”提醒；轮到该会议进入唯一会议室时再发送“已进入会议室”提醒。
2. 会议进入会议室后不会唤醒主持人，也不会触发主持人超时；Boss 必须在会议室页面点击「我已进入，开始会议」。
3. 主持人调用 `company_meeting_end` 只会提交总结和结束申请。Boss 在 WebUI 批准后才会原子创建任务/公告并释放会议室，也可退回主持人继续讨论。
4. Boss 可在开始前填写原因并拒绝会议；会议以取消状态保留在历史和审计中，并在受邀 Agent 全部收到取消原因后释放会议室。会议一旦开始便不能再使用会前拒绝。

Boss 点击开始后接口立即返回，会议室显示“主持人启动中”。Boss 开场原文和主持人启动任务在同一 SQLite 事务中持久化；Gateway 重启时会恢复未完成任务，但不会重复执行已经成功的任务。

未设置 `bossParticipates` 的会议调用 `company_meeting_end` 后不会瞬间消失：总结和结束申请先持久化，默认 60 秒后自动完成。倒计时由 `meetingAutoEndDelaySeconds` 配置，服务重启后从 SQLite 继续恢复。

### 同步会议编排与 session 回写

主持人调用 `company_meeting_delegate` 后，插件通过 `openclaw agent --agent <id> --message-file <private-file> --json` 直接调用目标 Agent 的 main session，并等待其本轮发言完成。`company_meeting_speak` 只接收正文，系统根据可信的 `toolContext.agentId`、公司唯一活动会议和当前发言权自动识别会议与轮次。点名、任务草案和申请结束同样自动作用于当前活动会议，不要求 Agent 复制会议 ID。若 Agent 只返回普通文本而没有调用发言工具，系统会审计代录并标记 `completionSource=fallback`；调用失败或超时则记录结构化失败轮次。

`company_meeting_speak` 和 `company_meeting_delegate` 成功时只返回 `{ "accepted": true, "receipt": "成功，本轮会话结束" }`，并以 `terminate: true` 结束调用者当前 turn。`delegate` 不再把参会者回答塞进 toolResult。服务会先把主持人的点名持久化追加到其 main-session transcript，再释放 `host_resume`，通过一个新的主持人 turn 交付参会者回答及其后的新增记录。主持人直接发言后同样自动续接，会议不会因为 turn 被终止而停住。

追加内容是普通 `user` 历史消息，不触发 Agent 回复，也不是“回执”。它使用数据库中的真实消息号和轮次号，例如 `【消息 #000014｜第 3 轮｜点名】`；在该 Agent 自己的 session 中写作 `你（架构师） @高级工程师：...`，而不是第一人称“我”。其他人的消息仍显示“姓名（Agent ID）”。每名主持人和参会者都有独立增量水位，只有 transcript 追加成功后才推进；重启和重试依靠幂等键避免重复写入。Boss WebUI 始终展示完整会议记录。

OpenClaw 2026.7.1 会把某些 `terminate: true` 工具路径归类为 `incomplete_turn`，此时不能假定一定收到 `agent_end`。因此工具成功后会立即登记一个内存空闲检查；服务通过官方 `resolveActiveEmbeddedRunSessionId` 探针确认目标 main session 已退出 active run，才调用 transcript API。`agent_end` 只负责加速同一检查，普通超时扫描绝不写 transcript，避免 session takeover。

会议时间线按固定六位消息号和全局轮次排序；增量窗口从某轮中间开始时显示“第 N 轮（续）”。参会规则不重复塞进每一条会议调度消息，而由公司治理项目的 `company-guidelines` Hook 维护和注入；Company OS 只发送本场会议上下文与当前动作。

### 会议终局同步

正常完成、主持人超时、Boss 会前拒绝和排队取消都会为主持人、worker 与 advisor 各创建一项持久终局同步；Boss 是真人，只在 WebUI 查看完整记录，不调用 Agent session。每项提示在关会事务中冻结，从该成员的 `meeting_context_watermarks` 之后开始，按六位消息号包含全部新增时间线、主持人最终总结或明确终止原因。只有 `AgentInvoker` 成功处理提示后才推进该成员水位，Agent 的确认回复保留在其 main session，不写回已关闭会议。

曾经占用会议室的会议进入终态后，WebUI 会先显示“散会同步中”，逐人展示送达、尝试次数和最近错误。`meeting_closeout_dispatches` 对临时失败持续指数退避重试，Gateway 重启会回收租约并恢复未完成项；最后一名成员送达前，排队会议始终保持 `queued`，没有跳过失败成员的旁路。排队阶段取消也会通知受邀成员，但不会阻塞当前正在使用的会议室。v7 上线前的历史终态会议不会回溯唤醒。

Agent 成员 ID 与 OpenClaw Agent ID 保持一致，不再维护 `main → jia-goushi` 一类别名。Schema v4 会把旧别名及任务、会议、消息、公告和调度外键统一迁移到真实 Agent ID，并留下迁移审计。若主持人的 CLI 最终结果为空，但本次调用期间已经产生经过工具校验的会议进展，持久调度会按成功处理，避免把已完成的主持过程误报为启动失败。

Boss 是真人虚拟成员，不走 Agent 身份解析。WebUI 默认从 `~/.openclaw/workspace-boss/avatar.png` 读取 Boss 头像并通过鉴权身份接口传给会议消息组件；可用 `bossAvatarPath` 覆盖。

### Boss 任务催办

Boss 可在“已派发”“进行中”或“阻塞”的任务详情点击「催促负责人」。插件会把催办写入 SQLite 持久队列，再主动调用负责人的 `agent:<agentId>:main` session；同一任务存在等待中或发送中的催办时不会重复入队。提示要求负责人先调用 `company_task_read` 核对最新版本、验收标准、子任务和进度，再根据事实调用 `company_task_progress`、`company_task_block` / `company_task_unblock` 或 `company_task_submit`，不能只回复一段进度说明。

任务详情会显示最近一次催办的等待、发送、送达或失败状态。每条提示都带唯一通知 ID；CLI 明确未启动时最多尝试三次，已经启动但结果不确定时停止自动重放，避免同一消息重复进入 main session。Gateway 重启时会用已审计的任务进展确认成功，无法确认的运行中项记为失败并保留人工检查线索。负责人已变更或任务进入 `review` / 终态时，旧催办会审计取消。普通任务派发不会主动唤醒 Agent；公告发布瞬间也不唤醒，统一留到半点汇总。

### 全层级任务验收通知

每项任务只能由自己的派发者验收：Boss 验收根任务，一级员工验收自己派发的二级任务，依次类推，Boss 不能越级验收子任务。批准或驳回会和任务状态变更一起写入持久调度队列，并主动通知该任务负责人。批准通知说明任务已经关闭；驳回通知包含验收意见，并要求负责人读取任务、记录整改进度后重新提交。任务详情会独立显示最近一次验收通知的发送状态。完成但没有最终文本的 Agent turn、以及驳回后已经产生的有效任务操作都视为送达；只有 `launch_failed` / `in_flight` 这类明确未注入的失败才自动重试，模糊失败与 Gateway 中断不会重复注入同一通知。

邮件默认复用 `~/.config/mail-skills/.env` 的默认 SMTP 账号，并发送到该账号自身。本机已有的 QQ 邮箱配置无需复制授权码。可以通过 `bossEmailNotifications.account` 选择命名账号，或用 `recipient`、`configPath` 覆盖收件地址和配置路径。

### 分时任务巡检

任务巡检默认每天按北京时间 08:00–17:00 每个整点启动。系统在整点冻结每位员工当轮候选清单：本人派发的待验收任务，以及本人负责的 `assigned`、`in_progress`、`blocked` 任务。每位员工每轮最多收到三个单任务提示，计划时间固定为 `:00`、`:15`、`:30`；发送前若原候选已失效，会从同一整点快照中递补，整点后新增任务进入下一轮。

候选统一按等待时间排序：待验收使用提交时间，执行任务使用最后活动时间。当天尚未成功提醒的任务优先；全部轮过后按最早一次成功提醒继续轮转，避免少数老任务永久占满三个名额。每次 Agent 只处理一个任务，并被要求实际调用读取、审批、进度、阻塞或提交工具。

Boss 每个整点收到一封不设任务上限的汇总邮件，包含全部根任务待验收和根任务树阻塞/停滞异常；未处理事项下个整点继续提醒。邮件账号完全复用 `bossEmailNotifications`。巡检运行、候选快照和三个分时槽位都持久化到 SQLite，每条 Agent 巡检带唯一调度 ID，并且严格只调用 Agent 一次：无论正常回复、空回复、报错、超时、`in_flight` 还是 Gateway 中断，同一 dispatch 都不会重新注入；已尝试过的旧待重试记录在重启恢复时直接封存。Boss SMTP 邮件是独立通道，仍最多重试三次。Gateway 重启不补建错过的整点，但会继续处理从未启动的历史槽位。可通过 `taskHourlyCheckins.enabled/startHour/endHour` 调整开关与整点窗口，时区固定为 `Asia/Shanghai`。

### 公告半点提醒与会议公告自动已读

公告提醒默认在北京时间每天 08:30–17:30 的每个半点建立一轮。系统冻结每名在职 Agent 当时所有“当前有效且未读”的公告，每名 Agent 每轮只进入一条汇总 dispatch；提示列出公告 ID、类型、标题和发布时间，并要求先调用 `company_notice_list({ effectiveOnly: true })` 阅读正文，再逐条调用 `company_notice_read`。Boss、停用员工、已读公告、被更正替代的旧公告和快照后发布的新公告不会进入本轮。

发送前会再次过滤候选。公告已经阅读、删除或失效时会移除，全部移除则该 dispatch 为 `skipped`，员工已停用则为 `canceled`。同一 Agent 若仍有旧轮的 `pending` / `running` 汇总，新一轮保留候选统计但记为 `skipped`，避免恢复后连续重复唤醒。成功进入 main session 即记为 `succeeded`，不会替普通公告自动写 read mark；下个半点仍未读会产生新的 dispatch 再提醒。同一公告巡检 dispatch 严格只调用 Agent 一次，不因任何回复或失败结果重新注入；Agent turn 虽报错但已经产生候选公告的可信 `notice.read` 时，仍按已送达处理。Gateway 不补建离线期间错过的半点，只恢复从未尝试过的持久 dispatch；已尝试记录直接保留成功或失败终态。可通过 `noticeUnreadReminders.enabled/startHour/endHour` 调整，时区固定为 `Asia/Shanghai`。

任务会议必定生成的 `meeting_report`，以及选择发布公告的讨论会，会自动把主持人与全部 worker/advisor 写入该公告的 read marks；同一成员集合也用于会议终局同步。Boss 即使直接参会也不计入 Agent 阅读覆盖，未参会员工仍保持未读。未发布公告、取消或超时会议不产生自动已读；后续人工更正是新的公告版本，不继承原会议成员的 read mark。系统用 `actor=system` 的 `notice.meeting_participants_marked_read` 审计记录这次自动处理，不伪装成 Agent 主动阅读。

## Agent 工具

| 模块 | 工具 |
| --- | --- |
| 收件箱 | `company_inbox` |
| 组织 | `company_org_list`、`company_org_add`、`company_org_update`、`company_org_deactivate` |
| 告示板 | `company_notice_list`、`company_notice_read`、`company_notice_publish` |
| 会议 | `company_meeting_request`、`company_meeting_list`、`company_meeting_status`、`company_meeting_speak`、`company_meeting_delegate`、`company_meeting_set_task_drafts`、`company_meeting_end`、`company_meeting_cancel` |
| 任务 | `company_task_list`、`company_task_read`、`company_task_create`、`company_task_start`、`company_task_progress`、`company_task_revise`、`company_task_block`、`company_task_unblock`、`company_task_submit`、`company_task_review`、`company_task_reassign`、`company_task_cancel` |

首次启动固定建立虚拟成员 `boss`，并以 OpenClaw 默认 Agent 的真实 ID 建立组织架构师；也可通过 `organizationAdminAgentId` 显式指定。只有该架构师能修改组织，新增员工的 Agent ID 必须已经存在于 `agents.list`。

## 测试

`npm test` 覆盖组织环、真实 Agent ID 迁移、非法员工、跨级派发、proof、版本、阻塞/停滞风险、Boss 持久催办、分时任务巡检轮转/递补/单次投递恢复、Boss 巡检邮件、公告半点时区/快照/聚合/过滤/跨轮去重/单次投递恢复、会议公告自动已读和更正重置、取消分支、逐层关单、统一 inbox、单会议室、同步点名、可信发言校验、审计代录、固定消息号/全局轮次、第二人称 session 回写、幂等水位推进、先回写再恢复主持人的顺序、Boss `@` FIFO、Boss 参会开始/拒绝/结束闸门、普通会议自动结束与重启恢复、全终态的逐成员终局同步、严格散会屏障、失败重试/租约恢复、Boss 真人头像、持久主持人任务恢复、QQ SMTP 配置、数据库迁移、任务会议原子回滚、超时、公告更正和完整的 Boss → CTO → 高工 → 工程师演练。

`npm run plugin:validate` 还会验证构建产物、清单与 28 个工具契约、长驻服务、相互隔离的 WebUI/API 路由，以及 `operator.write` Control UI 标签页。

## 来源说明

本仓库不合并来源仓库的 Git 历史，也不迁移旧数据库。

- [openclaw-plugin-company-board](https://github.com/LobsterFarmerAmp/openclaw-plugin-company-board)：参考 SQLite/WAL、迁移、`toolContext.agentId` 身份边界和 read mark 思路。
- [company-board-viewer](https://github.com/LobsterFarmerAmp/company-board-viewer)：参考 React/TypeScript 的轻量卡片、徽章和排版基础；Python/FastAPI 后端未保留。
- [openclaw-plugin-meeting-orchestrator](https://github.com/LobsterFarmerAmp/openclaw-plugin-meeting-orchestrator)：以其 `meeting.py` 已验证的“主持人同步调用目标 Agent、等待并验证发言”闭环为编排基线；Company OS 用 TypeScript 原生重写，不保留飞书、Tunnel 或 Python 运行时。
- OpenClaw Workboard：仅借鉴 proof、blocked、stale、review 语义，不复用其数据模型或 API。

现有插件仓库保持不变；本项目只提供新的 `company_*` 接口，不提供旧工具兼容别名。
