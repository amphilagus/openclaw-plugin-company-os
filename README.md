# OpenClaw Company OS

`company-os` 是一个原生 OpenClaw 插件，把公司治理收敛到一套共享基础设施和三种业务对象：会议、严格层级任务、公司公告。Boss 在统一 WebUI 操作，Agent 只能通过 `company_*` 工具参与。

## 核心约束

- 一个 Boss、一间会议室、单一 Gateway、单一 SQLite 数据库。
- 任务是严格树，不是 DAG：根任务只能由 Boss 派给一级直属员工；子任务以分阶段任务流原子创建，阶段内并行、阶段间按屏障顺序激活，负责人仍只能选择自己的直属下属。
- 任务只能自下而上关闭。负责人携 proof 提交 review，派发者验收后永久关闭。
- 会议严格串行。任务会议结束时，子任务、会议总结、会议汇报公告、参会 Agent 的公告 read mark 和全员终局同步 outbox 在同一事务中原子提交。
- 会议可设置 `bossParticipates=true`：进入会议室后等待 Boss 手动开始，主持人只能申请结束，最终结束权固定属于 Boss。
- 未邀请 Boss 的会议也先提交结束申请，WebUI 显示 60 秒倒计时；到期后服务原子关会，Gateway 重启不会丢失倒计时。
- 公告不可编辑；修正通过 `supersedesNoticeId` 发布新公告。Boss 还可在 WebUI 二次确认后审计删除公告。
- Boss 写操作由服务端固定记录为 `actor=boss`；Agent 身份只读取可信的 `toolContext.agentId`。
- 任务状态事件与定时工作提示彻底分离：验收结果、阻塞上下行、取消审批和终态纠错进入即时 outbox；可执行、待验收和阻塞审查事项进入每名员工自己的持久 FIFO 回转池。公告发布仍不立即唤醒 Agent。所有 Company OS main-session 调用共享会话级协调器。
- 会议进入完成、取消或超时终态后，编排器主动唤醒主持人及全部参会 Agent，同步各自水位之后的最终记录；曾占用会议室的会议必须等全员送达后才释放下一场。

## 技术结构

```text
OpenClaw Gateway
├── CompanyOsService（同步会议编排、持久主持人/终局队列、自动关会、恢复、超时扫描、SSE）
├── 30 个 company_* Agent 工具
├── /plugins/company-os/api/v1/*（Gateway 鉴权，仅 API）
├── /plugins/company-os-ui/*（无敏感数据的 WebUI 静态壳）
├── Control UI 标签页「公司」（operator.write）
└── company-os.sqlite
    ├── organization + audit
    ├── task tree + versions + proof + root-review email outbox
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

会议时间线按固定六位消息号和全局轮次排序；增量窗口从某轮中间开始时显示“第 N 轮（续）”。Company OS 每轮上下文都会附带精简表达要求：结论先行、最多三条关键依据、明确下一步/风险、默认 300 字以内，不复述背景或他人发言。主持人只归纳当前共识、尚存分歧和下一动作，点名一次只问一个明确问题，结论和责任人清楚后及时收束。相同规则也由 `company-guidelines` Hook 从 `company-hard-rules.md` 注入，保证工具外的会议判断保持一致。

### 会议终局同步

正常完成、主持人超时、Boss 会前拒绝和排队取消都会为主持人、worker 与 advisor 各创建一项持久终局同步；Boss 是真人，只在 WebUI 查看完整记录，不调用 Agent session。每项提示在关会事务中冻结，从该成员的 `meeting_context_watermarks` 之后开始，按六位消息号包含全部新增时间线、主持人最终总结或明确终止原因。只有 `AgentInvoker` 成功处理提示后才推进该成员水位，Agent 的确认回复保留在其 main session，不写回已关闭会议。

曾经占用会议室的会议进入终态后，WebUI 会先显示“散会同步中”，逐人展示送达、尝试次数和最近错误。`meeting_closeout_dispatches` 对临时失败持续指数退避重试，Gateway 重启会回收租约并恢复未完成项；最后一名成员送达前，排队会议始终保持 `queued`，没有跳过失败成员的旁路。排队阶段取消也会通知受邀成员，但不会阻塞当前正在使用的会议室。v7 上线前的历史终态会议不会回溯唤醒。

Agent 成员 ID 与 OpenClaw Agent ID 保持一致，不再维护 `main → jia-goushi` 一类别名。Schema v4 会把旧别名及任务、会议、消息、公告和调度外键统一迁移到真实 Agent ID，并留下迁移审计。若主持人的 CLI 最终结果为空，但本次调用期间已经产生经过工具校验的会议进展，持久调度会按成功处理，避免把已完成的主持过程误报为启动失败。

Boss 是真人虚拟成员，不走 Agent 身份解析。WebUI 默认从 `~/.openclaw/workspace-boss/avatar.png` 读取 Boss 头像并通过鉴权身份接口传给会议消息组件；可用 `bossAvatarPath` 覆盖。

### Boss 任务催办

Boss 可在“已派发”“进行中”或“阻塞”的任务详情点击「催促负责人」。插件会把催办写入 SQLite 持久队列，再主动调用负责人的 `agent:<agentId>:main` session；同一任务存在等待中或发送中的催办时不会重复入队。提示要求负责人先调用 `company_task_read` 核对最新版本、验收标准、子任务和进度，再根据事实调用 `company_task_progress`、`company_task_block` / `company_task_unblock` 或 `company_task_submit`，不能只回复一段进度说明。

任务详情会显示最近一次催办的等待、发送、送达或失败状态。每条提示都带唯一通知 ID；CLI 明确未启动时最多尝试三次，已经启动但结果不确定时停止自动重放，避免同一消息重复进入 main session。Gateway 重启时会用已审计的任务进展确认成功，无法确认的运行中项记为失败并保留人工检查线索。负责人已变更或任务进入 `review` / 终态时，旧催办会审计取消。普通任务派发不会主动唤醒 Agent；公告发布瞬间也不唤醒，统一留到半点汇总。

### 全层级任务验收通知

每项任务只能由自己的派发者验收：Boss 验收根任务，一级员工验收自己派发的二级任务，依次类推，Boss 不能越级验收子任务。非 Boss 验收人必须先用 `company_task_read` 读取当前 submission，再提交结构化 `reviewReport`；批准要求所有检查项通过并引用有效证据，驳回要求至少一个失败项和明确整改方案。批准或驳回会和状态变化一起写入即时 outbox，并主动通知该任务负责人。已经确认启动注入的通知不因空回复、异常退出、超时或 Gateway 中断重放。

任务负责人和验收人的介入阶段严格分离：负责人完成并自测自己能够执行的交付后应先提交，任务进入 `review` 后派发者才开始验收。验收标准中的 Boss 亲测、扫码、真机体验、业务人工确认等验收人专属动作不是提交前置条件，也不构成负责人阻塞；负责人只需准备可运行环境、操作步骤和证据，并在 submission 中标明待验收项目。执行催办与回转提示会明确禁止 Agent 因等待验收人操作而停留在 `in_progress`、反复记录进度或调用 `company_task_block`。

所有 `company_task_submit` 都必须携带 `gitLocation.remoteUrl`、相对于 `refs/heads/` 的完整 `gitLocation.branch` 和 40 位 `gitLocation.commit`。负责人必须先把当前成果推送到远端；Service 使用禁用交互凭据、15 秒超时的 `git ls-remote` 验证分支存在，并要求填写的 commit 精确等于远端分支当时的 tip。验证发生在任务状态事务之前，URL、分支、SHA、认证、超时或 tip 任一校验失败时，任务保持 `in_progress`，不会创建 submission、邮件或池项。通过后，远端、分支、commit 和验证时间作为冻结的 submission 元数据进入任务详情、验收 Prompt 与 Boss 邮件；分支后来继续移动也不会改变旧 submission 的验收对象。

所有 `closed` 任务都保留「二次审查不通过」。Boss 可纠正任意层级，原验收人只能纠正自己的决定；任务恢复为 `in_progress`，原 accepted submission 和验收报告永久保留，closed 祖先同步重开，处于 review 的祖先 submission 标记为 `invalidated`。`canceled` 任务可由 Boss 或原取消人恢复到取消前精确状态；存在 canceled 祖先时必须先恢复最高层已取消祖先。blocked 任务的非 Boss 取消会转为 Boss 审批申请。

一级员工每次调用 `company_task_submit` 把根任务提交给 Boss 验收时，系统会在同一事务内创建一封持久化待验收邮件，并立即触发发送；普通子任务提交只通知其实际派发者，不给 Boss 发邮件。驳回后的重新提交使用新的 submission ID，因此会产生一封新的提醒。邮件失败最多重试五次，Gateway 重启后继续处理，且不会因为重复刷新而为同一次提交重复建信。

邮件默认复用 `~/.config/mail-skills/.env` 的默认 SMTP 账号，并发送到该账号自身。本机已有的 QQ 邮箱配置无需复制授权码。可以通过 `bossEmailNotifications.account` 选择命名账号，或用 `recipient`、`configPath` 覆盖收件地址和配置路径。

### 分阶段任务流与根任务拆解会

`company_task_create` 现在一次提交完整的 `stages`：每个阶段包含名称、目标和至少一个并行任务。第一阶段立即可执行，未来阶段以 `waiting` 状态预创建；只有当前阶段全部必需任务验收到 `closed`，下一阶段才激活。新产生的 `canceled` 不算阶段完成，必须恢复后继续；v14 升级前已经取消的历史子任务会获得一次迁移豁免。最后阶段完成后，父任务回到负责人执行池，由负责人整合并提交自己的 Git 定位，不会自动提交。

任意任务都能继续拥有自己的嵌套任务流。`company_task_flow_update` 使用 `expectedRevision` 并且只能追加未来阶段，或原子替换所有从未激活的等待阶段；被替换的阶段和任务进入只读 `retired` 历史，不再参与队列、风险或父任务屏障。二次审查打回上游任务会重新激活相应阶段并冻结已经开始的下游阶段，但保留下游状态、进度、submission 和 FIFO 位置。

Boss 创建根任务时可勾选“要求负责人通过任务会完成拆解（Boss 参与）”。勾选只会改变该根任务轮到个人池首时的实时 Prompt，不即时唤醒、不改变 FIFO。负责人必须邀请全部在职直属下属作为 worker、由自己主持并设置 `bossParticipates=true`；会议取消、超时或被 Boss 拒绝后要求恢复为待发起。会议正常结束并在同一事务中生成分阶段任务流后，要求才完成；此前不能绕过会议直接建流或提交根任务。

### 任务回转提示池

每名员工拥有一个持久 FIFO 回转池和独立工作时间倒计时。默认间隔为组织层级乘以 10 分钟：一级 10 分钟、二级 20 分钟、三级 30 分钟；Boss 可在任务页为单个 Agent 设置 1–600 分钟覆盖值或恢复层级默认。池从空变为非空时启动完整倒计时，新事项追加到非空池不重置；到期最多处理池首一项，确认 Agent run 已开始后立即移到队尾并重新计时，不等待回复。池中只有一项时，下一次个人倒计时仍会再次提醒尚未处理的同一事项。

默认工作窗口为北京时间 `[08:00, 18:00)`。下班时倒计时暂停并保留剩余工作分钟，例如 17:55 尚余 10 分钟会在次日 08:05 到期。员工 main session 忙碌、已被更早调度保留或正在会议中时，本次记录 `skipped_busy`，池首不移动并从当下重新走完整间隔；明确未启动或 CLI 不可用同样不移动。Gateway 在未到期前重启保留原到期时间，离线错过的到期点不补发，启动后记录 `skipped_offline` 并重新走完整间隔。

池中包含：没有活动直接子任务的本人执行任务、本人派发且待验收的直接子任务、本人派发且 blocked 的直接子任务。根任务验收与根任务阻塞不进入 Boss 池，继续使用即时邮件。新事项只进队尾，不设优先级或全员共享时间点。

每个时间点都重新读取数据库生成真实 Prompt。执行项包含状态、验收标准、最近进度、直接子任务摘要，以及“推送后读取远端 tip 再提交”的要求；验收项包含 submission、冻结的 Git 远端定位、证据与结构化审查要求；阻塞审查项要求派发者实际选择向上阻塞父任务、带具体建议解除子任务阻塞，或创建 Boss 取消审批申请。候选失效会从池中删除并继续检查新池首。

所有 main-session 调度同时检查 OpenClaw active-run registry 和内部会话保留权。先发生的调度先取得会话；即时通知会持久等待，后发生的个人倒计时直接跳过本轮。配置项 `taskRollingPrompts.enabled/startHour/endHour` 保持有效；旧 `taskRollingPrompts.intervalMinutes` 和 `taskHourlyCheckins` 仅兼容读取并标记废弃。旧 `task_prompt_ticks` / `task_prompt_dispatches` 保留为只读历史，不再创建新记录。

### 公告半点提醒与会议公告自动已读

公告提醒默认在北京时间每天 08:30–17:30 的每个半点建立一轮。系统冻结每名在职 Agent 当时所有“当前有效且未读”的公告，每名 Agent 每轮只进入一条汇总 dispatch；提示列出公告 ID、类型、标题和发布时间，并要求先调用 `company_notice_list({ effectiveOnly: true })` 阅读正文，再逐条调用 `company_notice_read`。Boss、停用员工、已读公告、被更正替代的旧公告和快照后发布的新公告不会进入本轮。

发送前会再次过滤候选。公告已经阅读、删除或失效时会移除，全部移除则该 dispatch 为 `skipped`，员工已停用则为 `canceled`。同一 Agent 若仍有旧轮的 `pending` / `running` 汇总，新一轮保留候选统计但记为 `skipped`，避免恢复后连续重复唤醒。成功进入 main session 即记为 `succeeded`，不会替普通公告自动写 read mark；下个半点仍未读会产生新的 dispatch 再提醒。同一公告巡检 dispatch 严格只调用 Agent 一次，不因任何回复或失败结果重新注入；Agent turn 虽报错但已经产生候选公告的可信 `notice.read` 时，仍按已送达处理。Gateway 不补建离线期间错过的半点，只恢复从未尝试过的持久 dispatch；已尝试记录直接保留成功或失败终态。可通过 `noticeUnreadReminders.enabled/startHour/endHour` 调整，时区固定为 `Asia/Shanghai`。

任务会议必定生成的 `meeting_report`，以及选择发布公告的讨论会，会自动把主持人与全部 worker/advisor 写入该公告的 read marks；同一成员集合也用于会议终局同步。Boss 即使直接参会也不计入 Agent 阅读覆盖，未参会员工仍保持未读。未发布公告、取消或超时会议不产生自动已读；后续人工更正是新的公告版本，不继承原会议成员的 read mark。系统用 `actor=system` 的 `notice.meeting_participants_marked_read` 审计记录这次自动处理，不伪装成 Agent 主动阅读。

### 每日自省治理

Company OS 默认在北京时间 05:00 建立每日经验沉淀任务、06:00 建立每日人设治理任务。每轮冻结当时所有在职 Agent，按组织层级升序、同级按 Agent ID 排序，并从基础时间开始每人错开一分钟。两类任务都进入每名 Agent 固定的 `agent:<agentId>:self-audit` custom session，跨天保留治理上下文；CLI 不启用 `--deliver`，最终回复不会自动发送到聊天渠道。

调度记录持久化在 `daily_agent_runs` 与 `daily_agent_dispatches`。Gateway 不补建离线期间错过的每日轮次，但会恢复已经排队且从未尝试的 dispatch；已经领取过的任务不会自动重放，避免重复编辑 workspace。不同 Agent 可以并行执行，同一 Agent 的两类治理任务严格串行。可通过 `dailySelfImprovement.enabled/hour/minute` 与 `dailyPersonaAudit.enabled/hour/minute` 调整配置，时区固定为 `Asia/Shanghai`。

Boss 可从顶部导航进入“自省治理”页面，查看两个机制的下一轮时间、今日队列、失败原因及最近七个北京时间自然日的执行历史。页面只读，配置仍由 OpenClaw 插件配置文件管理。

## Agent 工具

| 模块 | 工具 |
| --- | --- |
| 收件箱 | `company_inbox` |
| 组织 | `company_org_list`、`company_org_add`、`company_org_update`、`company_org_deactivate` |
| 告示板 | `company_notice_list`、`company_notice_read`、`company_notice_publish` |
| 会议 | `company_meeting_request`、`company_meeting_list`、`company_meeting_status`、`company_meeting_speak`、`company_meeting_delegate`、`company_meeting_set_task_drafts`、`company_meeting_end`、`company_meeting_cancel` |
| 任务 | `company_task_list`、`company_task_read`、`company_task_create`、`company_task_flow_update`、`company_task_start`、`company_task_progress`、`company_task_revise`、`company_task_block`、`company_task_unblock`、`company_task_submit`、`company_task_review`、`company_task_reassign`、`company_task_cancel`、`company_task_correct` |

首次启动固定建立虚拟成员 `boss`，并以 OpenClaw 默认 Agent 的真实 ID 建立组织架构师；也可通过 `organizationAdminAgentId` 显式指定。只有该架构师能修改组织，新增员工的 Agent ID 必须已经存在于 `agents.list`。

## 测试

`npm test` 覆盖组织环、真实 Agent ID 迁移、非法员工、跨级派发、proof、Git 远端 URL/分支/tip 校验与无部分写入、版本、阻塞/停滞风险、Boss 持久催办、根任务提交验收邮件及重启恢复、分时任务巡检轮转/递补/单次投递恢复、Boss 巡检邮件、公告半点时区/快照/聚合/过滤/跨轮去重/单次投递恢复、每日自省治理的时区/排序/错峰/custom session/按 Agent 并发/单次投递恢复/七天历史页面、会议公告自动已读和更正重置、取消分支、逐层关单、统一 inbox、单会议室、同步点名、可信发言校验、审计代录、固定消息号/全局轮次、第二人称 session 回写、幂等水位推进、先回写再恢复主持人的顺序、Boss `@` FIFO、Boss 参会开始/拒绝/结束闸门、普通会议自动结束与重启恢复、全终态的逐成员终局同步、严格散会屏障、失败重试/租约恢复、Boss 真人头像、持久主持人任务恢复、QQ SMTP 配置、数据库迁移、任务会议原子回滚、超时、公告更正和完整的 Boss → CTO → 高工 → 工程师演练。

`npm run plugin:validate` 还会验证构建产物、清单与 30 个工具契约、长驻服务、相互隔离的 WebUI/API 路由，以及 `operator.write` Control UI 标签页。

## 来源说明

本仓库不合并来源仓库的 Git 历史，也不迁移旧数据库。

- [openclaw-plugin-company-board](https://github.com/LobsterFarmerAmp/openclaw-plugin-company-board)：参考 SQLite/WAL、迁移、`toolContext.agentId` 身份边界和 read mark 思路。
- [company-board-viewer](https://github.com/LobsterFarmerAmp/company-board-viewer)：参考 React/TypeScript 的轻量卡片、徽章和排版基础；Python/FastAPI 后端未保留。
- [openclaw-plugin-meeting-orchestrator](https://github.com/LobsterFarmerAmp/openclaw-plugin-meeting-orchestrator)：以其 `meeting.py` 已验证的“主持人同步调用目标 Agent、等待并验证发言”闭环为编排基线；Company OS 用 TypeScript 原生重写，不保留飞书、Tunnel 或 Python 运行时。
- OpenClaw Workboard：仅借鉴 proof、blocked、stale、review 语义，不复用其数据模型或 API。

现有插件仓库保持不变；本项目只提供新的 `company_*` 接口，不提供旧工具兼容别名。
