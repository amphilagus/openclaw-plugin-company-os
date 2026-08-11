# OpenClaw Company OS

`company-os` 是**自研的 OpenClaw 独立插件**（针对 OpenClaw 平台用其 Plugin SDK 开发，非 OpenClaw 内置或官方插件），把公司治理收敛到一套共享基础设施和三种业务对象：会议、严格层级任务、公司公告。Boss 在统一 WebUI 操作，Agent 只能通过 `company_*` 工具参与。

## 核心约束

- 一个 Boss、一间会议室、单一 Gateway、单一 SQLite 数据库。
- 任务是严格树，不是 DAG：根任务只能由 Boss 派给一级直属员工；子任务以分阶段任务流原子创建，阶段内并行、阶段间按屏障顺序激活，负责人仍只能选择自己的直属下属。
- 任务只能自下而上关闭。负责人携 proof 提交 review，派发者验收后永久关闭。
- 会议严格串行。任务会议结束时，子任务、会议总结、会议汇报公告、参会 Agent 的公告 read mark 和全员终局同步 outbox 在同一事务中原子提交。
- 会议可设置 `bossParticipates=true`：进入会议室后等待 Boss 手动开始；主持人不能申请或执行结束，只能继续主持、提交总结或把控制权让渡给 Boss，最终结束权固定属于 Boss。
- 未邀请 Boss 的会议也先提交结束申请，WebUI 显示 60 秒倒计时；到期后服务原子关会，Gateway 重启不会丢失倒计时。
- 公告不可编辑；修正通过 `supersedesNoticeId` 发布新公告。Boss 还可在 WebUI 二次确认后审计删除公告。
- Boss 写操作由服务端固定记录为 `actor=boss`；Agent 身份只读取可信的 `toolContext.agentId`。
- 任务状态事件与定时工作提示彻底分离：验收结果、阻塞上下行、取消审批和终态纠错进入即时 outbox；可执行、待验收和阻塞审查事项进入每名员工自己的持久 FIFO 回转池。公告发布仍不立即唤醒 Agent。所有 Company OS session 调用共享会话级协调器。
- 每位 Agent 预先准备一个名称为 `meeting` 的固定 session（推荐 key 为 `agent:<agentId>:meeting`）；`meeting_messages` 是共享事实源，main 只接收入会通知和散会总结。
- 会议进入完成、取消或超时终态后，编排器向主持人及全部参会 Agent 的 main 写入可见系统总结；全员送达后释放本场会议绑定，但固定 meeting session 及 transcript 持续保留，曾占用会议室的会议随后才释放下一场。

## 技术结构

```text
OpenClaw Gateway
├── CompanyOsService（同步会议编排、持久主持人/终局队列、自动关会、恢复、超时扫描、SSE）
├── 32 个 company_* Agent 工具
├── /plugins/company-os/api/v1/*（Gateway 鉴权，仅 API）
├── /plugins/company-os-ui/*（无敏感数据的 WebUI 静态壳）
├── Control UI 标签页「公司」（operator.write）
└── company-os.sqlite
    ├── organization + audit
    ├── task tree + versions + proof + root-review email outbox
    ├── notices + read marks + half-past reminder runs/dispatch outbox
    ├── task check-in runs + batches + dispatch outbox
    └── meeting queue + shared transcript + entry/session bindings + context/dispatch/email/closeout outbox
```

前端是 React + Vite，包含三个真实路由：

- `/plugins/company-os-ui/meeting-room`：默认页面，当前会议、全员入会屏障、Boss 三项决策、普通会议结束倒计时、插话、任务草案、散会同步进度、队列和历史。
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

插件必须设置 `plugins.entries.company-os.hooks.allowConversationAccess=true`，用于通过可信工具上下文完成会议专属 session 的记录回写。会议基本规则不由插件注入，而由现有 `company-guidelines` Hook 在 `agent:bootstrap` 时从 `~/.openclaw/company-info/company-hard-rules.md` 统一添加到临时 `AGENTS.md` 头部。完整配置见样例。

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

1. 创建会议时向 Boss 邮箱发送“会议已创建”提醒；轮到该会议进入唯一会议室时发送“已进入会议室”提醒，结束或取消后再发送结果邮件。
2. 会议进入会议室后不会唤醒主持人，也不会触发主持人超时；Boss 必须在会议室页面点击「我已进入，开始会议」。
3. 主持人无权调用 `company_meeting_end`，也不能申请审批；无更多内容时调用 `company_meeting_yield_to_boss`。Boss 随后固定选择「我要发言」「请主持人总结」「结束会议」，主持总结不会自动散会。
4. Boss 可在开始前填写原因并拒绝会议；会议以取消状态保留在历史和审计中，并在受邀 Agent 全部收到取消原因后释放会议室。会议一旦开始便不能再使用会前拒绝。

Boss 点击开始后接口立即返回，系统先等待每名 Agent 的 main 空闲并幂等写入入会通知，再绑定其预建的固定 meeting session。只有通知与 session 绑定全部成功，主持人的 meeting session 才会启动。Gateway 重启会从 SQLite 恢复未完成步骤，不重复通知或越过全员屏障。

未设置 `bossParticipates` 的会议调用 `company_meeting_end` 后不会瞬间消失：总结和结束申请先持久化，默认 60 秒后自动完成。倒计时由 `meetingAutoEndDelaySeconds` 配置，服务重启后从 SQLite 继续恢复。

### 固定 meeting session 编排与回写

主持人、被点名参会者和 Boss 定向插话都显式运行在各自预建、名称为 `meeting` 的固定 session。系统优先绑定 `agent:<agentId>:meeting`，也能按唯一的 `label/displayName=meeting` 找到 UI 创建的 session。会议写工具以可信 runtime Agent 与完整 session key 作为持久身份；底层 session ID 仅是当前 transcript 实例缓存，OpenClaw 每日重置导致 ID 轮转时会自动刷新并留下审计。从 main、错误 session key 或错误 Agent 调用仍会被拒绝。`company_meeting_list/status/request` 仍可在 main 使用。若 Agent 只返回普通文本而没有调用发言工具，系统会审计代录并标记 `completionSource=fallback`；调用失败或超时则记录结构化失败轮次。

`company_meeting_speak` 和 `company_meeting_delegate` 成功时只返回 `{ "accepted": true, "receipt": "成功，本轮会话结束" }`，并以 `terminate: true` 结束调用者当前 turn。服务先把主持人的点名持久化追加到其会议 session transcript，再释放 `host_resume`，通过一个新的主持人 turn 交付新增记录。主持人直接发言后同样自动续接。

追加内容是普通 `user` 历史消息，不触发 Agent 回复，也不是“回执”。它使用数据库中的真实消息号和轮次号，例如 `【消息 #000014｜第 3 轮｜点名】`；在该 Agent 自己的 session 中写作 `你（架构师） @高级工程师：...`，而不是第一人称“我”。其他人的消息仍显示“姓名（Agent ID）”。每名主持人和参会者都有独立增量水位，只有 transcript 追加成功后才推进；重启和重试依靠幂等键避免重复写入。Boss WebUI 始终展示完整会议记录。

OpenClaw 2026.7.1 会把某些 `terminate: true` 工具路径归类为 `incomplete_turn`，此时不能假定一定收到 `agent_end`。因此工具成功后会立即登记一个内存空闲检查；服务通过官方 active-run 探针确认目标会议 session 已退出 active run，才调用 transcript API。`agent_end` 只负责加速同一检查，普通超时扫描绝不写 transcript，避免 session takeover。

会议时间线按固定六位消息号和全局轮次排序；增量窗口从某轮中间开始时显示“第 N 轮（续）”。Company OS 每轮上下文都会附带精简表达要求：结论先行、最多三条关键依据、明确下一步/风险、默认 300 字以内，不复述背景或他人发言。主持人只归纳当前共识、尚存分歧和下一动作，点名一次只问一个明确问题，结论和责任人清楚后及时收束。相同规则也由 `company-guidelines` Hook 从 `company-hard-rules.md` 注入，保证工具外的会议判断保持一致。

### 会议终局同步

正常完成、主持人超时、Boss 会前拒绝和排队取消都会为主持人、worker 与 advisor 各创建一项持久终局同步；Boss 是真人，只在 WebUI 查看完整记录并接收结果邮件。每项提示在关会事务中冻结，从该成员的 `meeting_context_watermarks` 之后开始，按六位消息号包含全部新增时间线、最终总结或明确终止原因。系统等待 main 空闲后直接写入可见、幂等的系统消息，不触发额外 Agent 回复。

曾经占用会议室的会议进入终态后，WebUI 会先显示“散会同步中”，逐人展示送达、尝试次数和最近错误。`meeting_closeout_dispatches` 对临时失败持续指数退避重试，Gateway 重启会回收租约并恢复未完成项；最后一名成员送达前，排队会议始终保持 `queued`。全员总结送达后，Company OS 释放本场 session 绑定；固定 meeting session 不归档、不删除 transcript，可供下一场会议继续复用。

Agent 成员 ID 与 OpenClaw Agent ID 保持一致，不再维护 `main → jia-goushi` 一类别名。Schema v4 会把旧别名及任务、会议、消息、公告和调度外键统一迁移到真实 Agent ID，并留下迁移审计。若主持人的 CLI 最终结果为空，但本次调用期间已经产生经过工具校验的会议进展，持久调度会按成功处理，避免把已完成的主持过程误报为启动失败。

Boss 是真人虚拟成员，不走 Agent 身份解析。WebUI 默认从 `~/.openclaw/workspace-boss/avatar.png` 读取 Boss 头像并通过鉴权身份接口传给会议消息组件；可用 `bossAvatarPath` 覆盖。

### Boss 任务催办

Boss 可在“已派发”“进行中”或“阻塞”的任务详情点击「催促负责人」。插件会把催办写入 SQLite 持久队列，再主动调用负责人的 `agent:<agentId>:main` session；同一任务存在等待中或发送中的催办时不会重复入队。提示要求负责人先调用 `company_task_read` 核对最新版本、验收标准、子任务和进度，再根据事实调用 `company_task_progress`、`company_task_block` / `company_task_unblock` 或 `company_task_submit`，不能只回复一段进度说明。

任务详情会显示最近一次催办的等待、发送、送达或失败状态。每条提示都带唯一通知 ID；CLI 明确未启动时最多尝试三次，已经启动但结果不确定时停止自动重放，避免同一消息重复进入 main session。Gateway 重启时会用已审计的任务进展确认成功，无法确认的运行中项记为失败并保留人工检查线索。负责人已变更或任务进入 `review` / 终态时，旧催办会审计取消。普通任务派发不会主动唤醒 Agent；公告发布瞬间也不唤醒，统一留到半点汇总。

### 全层级任务验收通知

每项任务只能由自己的派发者验收：Boss 验收根任务，一级员工验收自己派发的二级任务，依次类推，Boss 不能越级验收子任务。非 Boss 验收人必须先用 `company_task_read` 读取当前 submission，再提交结构化 `reviewReport`；批准要求所有检查项通过并引用有效证据，驳回要求至少一个失败项和明确整改方案。根任务进入 review 后，Boss 还可以填写必填原因并选择“判定任务失败”：任务进入不可重新提交的 `failed` 终态，原 submission、Git、证据与验收材料永久保留，并即时通知一级负责人。批准、驳回或失败判定都会和状态变化一起写入即时 outbox；已经确认启动注入的通知不因空回复、异常退出、超时或 Gateway 中断重放。

任务负责人和验收人的介入阶段严格分离：负责人完成并自测自己能够执行的交付后应先提交，任务进入 `review` 后派发者才开始验收。验收标准中的 Boss 亲测、扫码、真机体验、业务人工确认等验收人专属动作不是提交前置条件，也不构成负责人阻塞；负责人只需准备可运行环境、操作步骤和证据，并在 submission 中标明待验收项目。执行催办与回转提示会明确禁止 Agent 因等待验收人操作而停留在 `in_progress`、反复记录进度或调用 `company_task_block`。

所有 `company_task_submit` 都必须携带 `gitLocation.remoteUrl`、相对于 `refs/heads/` 的完整 `gitLocation.branch` 和 40 位 `gitLocation.commit`。负责人必须先把当前成果推送到远端；Service 使用禁用交互凭据、15 秒超时的 `git ls-remote` 验证分支存在，并要求填写的 commit 精确等于远端分支当时的 tip。验证发生在任务状态事务之前，URL、分支、SHA、认证、超时或 tip 任一校验失败时，任务保持 `in_progress`，不会创建 submission、邮件或池项。通过后，远端、分支、commit 和验证时间作为冻结的 submission 元数据进入任务详情、验收 Prompt 与 Boss 邮件；分支后来继续移动也不会改变旧 submission 的验收对象。

所有层级的文件证明统一使用 `evidence` 中的 `artifact.path`：该路径必须指向提交者 OpenClaw workspace 内的真实普通文件，相对路径按 workspace 解析。Company OS 在提交事务前自动冻结文件字节、大小、SHA-256 及对应 evidence 编号；任一文件缺失、越界、不可读或超限都会拒绝整个提交。单次最多 5 个文件、合计 15 MB，更多文件或目录必须先打包。功能验收入口仍可用 `reviewHandoff.functionalVerification`，系统生成可直接复制的 `cd -- '<绝对目录>' && <command>`，但不会自动执行。根任务材料随 Boss 验收邮件作为附件发送；子任务材料按 submission ID 投递到实际派发者 workspace 的 `验收材料/<taskId>/`，自动生成 `CURRENT.md`、结构化 `README.md` 和 `files/`。workspace 投递失败最多重试五次并支持重启恢复，但不会阻塞派发者依据 Git 和数据库证据完成验收。

所有 `closed` 任务都保留「二次审查不通过」。Boss 可纠正任意层级，原验收人只能纠正自己的决定；任务恢复为 `in_progress`，原 accepted submission 和验收报告永久保留，closed 祖先同步重开，处于 review 的祖先 submission 标记为 `invalidated`。`canceled` 任务可由 Boss 或原取消人恢复到取消前精确状态；存在 canceled 祖先时必须先恢复最高层已取消祖先。blocked 任务的非 Boss 取消会转为 Boss 审批申请。

Boss 任务面板不再提供「带审计取消」和「全局重派」，统一改为「中止任务」。中止不受子任务、阶段、提交或会议状态限制：选中任务及全部后代永久标记为 `aborted` 并退出所有现行任务流，pending submission 失效，未开始的任务提示、任务即时通知和任务邮件撤销，绑定的排队/活动任务会议直接废止。该操作不会向任何个人 main session 注入消息，只原子发布一条不可变公司公告，由公告自身的半点阅读机制处理。中止结果不可通过 `company_task_correct` 恢复；页面会把被中止任务的标题、说明、验收标准、合法一级负责人和任务会要求自动填入下方任务提交注册表，Boss 可直接修改或重新创建一项全新的根任务。

一级员工每次调用 `company_task_submit` 把根任务提交给 Boss 验收时，系统会在同一事务内创建一封持久化待验收邮件，并立即触发发送；普通子任务提交只通知其实际派发者，不给 Boss 发邮件。驳回后的重新提交使用新的 submission ID，因此会产生一封新的提醒。邮件失败最多重试五次，Gateway 重启后继续处理，且不会因为重复刷新而为同一次提交重复建信。

邮件默认复用 `~/.config/mail-skills/.env` 的默认 SMTP 账号，并发送到该账号自身。本机已有的 QQ 邮箱配置无需复制授权码。可以通过 `bossEmailNotifications.account` 选择命名账号，或用 `recipient`、`configPath` 覆盖收件地址和配置路径。

### 分阶段任务流与根任务拆解会

`company_task_create` 现在一次提交完整的 `stages`：每个阶段包含名称、目标和至少一个并行任务。第一阶段立即可执行，未来阶段以 `waiting` 状态预创建；只有当前阶段全部必需任务验收到 `closed`，下一阶段才激活。新产生的 `canceled` 不算阶段完成，必须恢复后继续；v14 升级前已经取消的历史子任务会获得一次迁移豁免。最后阶段完成后，父任务回到负责人执行池，由负责人整合并提交自己的 Git 定位，不会自动提交。

任意任务都能继续拥有自己的嵌套任务流。`company_task_flow_update` 使用 `expectedRevision` 并且只能追加未来阶段，或原子替换所有从未激活的等待阶段；被替换的阶段和任务进入只读 `retired` 历史，不再参与队列、风险或父任务屏障。二次审查打回上游任务会重新激活相应阶段并冻结已经开始的下游阶段，但保留下游状态、进度、submission 和 FIFO 位置。

Boss 创建根任务时默认要求负责人通过任务会完成拆解，但默认不要求 Boss 参加；注册表可分别关闭任务会要求，或额外勾选“要求 Boss 参加任务会”。该选择只会改变该根任务轮到个人池首时的实时 Prompt，不即时唤醒、不改变 FIFO。负责人从在职直属下属中按任务需要选择至少一名 worker、由自己主持，并严格按任务登记值设置 `bossParticipates`；无需邀请与本任务无关的全部直属下属。会议取消、超时或被 Boss 拒绝后要求恢复为待发起。该要求是服务端硬锁：正式任务流工具和旧单任务兼容入口都会拒绝子任务派发。只有匹配 Boss 参与策略、绑定本任务的会议正常结束并在同一事务中生成分阶段任务流后才会解锁；此前也不能提交根任务。v18 以前的既有任务会要求迁移后继续视为“Boss 必须参加”。

### 任务回转提示池

每名员工拥有一个持久 FIFO 回转池和独立工作时间倒计时。默认间隔为组织层级乘以全公司节奏系数；系统默认系数为 5 分钟，即一级 5 分钟、二级 10 分钟、三级 15 分钟。Boss 可在任务页把该系数设置为 1–600 分钟，以统一调整公司节奏，也可为单个 Agent 设置 1–600 分钟覆盖值；个人覆盖始终优先于公司系数。修改系数后，所有使用层级默认且队列非空的员工从修改时刻按新周期重新计时。池从空变为非空时第一项立即到期并走会话检查与投递程序；新事项追加到非空池不重置当前计时。完成首次投递、遇到忙碌跳过或后续轮转后，才从当下重新走完整个人间隔。到期最多处理池首一项，确认 Agent run 已开始后立即移到队尾，不等待回复。池中只有一项时，下一次个人倒计时仍会再次提醒尚未处理的同一事项。

默认工作窗口为北京时间 `[08:00, 18:00)`。Boss 可直接在任务回转池面板按整点修改上班和下班时间；设置持久化在 Company OS 数据库，修改后所有非空队列按新窗口和各自有效周期重新计时，也可恢复插件配置默认值。面板还提供全公司“暂停任务回转”：暂停期间不创建任何定时任务提示，FIFO 顺序、池项和暂停瞬间的剩余工作时间均保留；恢复时从各自剩余时间继续，不补发暂停期间错过的提示。该开关不暂停验收结果、阻塞建议等即时通知。下班时倒计时同样暂停并保留剩余工作分钟，例如 17:55 尚余 5 分钟会在次日 08:00 到期。员工 main session 忙碌、已被更早调度保留或正在会议中时，本次记录 `skipped_busy`，池首不移动并从当下重新走完整间隔；明确未启动或 CLI 不可用同样不移动。Gateway 在未到期前重启保留原到期时间，离线错过的到期点不补发，启动后记录 `skipped_offline` 并重新走完整间隔。

池中包含：没有活动直接子任务的本人执行任务、本人派发且待验收的直接子任务、本人派发且 blocked 的直接子任务。根任务验收与根任务阻塞不进入 Boss 池，继续使用即时邮件。新事项只进队尾，不设优先级或全员共享时间点。

每个时间点都重新读取数据库生成真实 Prompt。执行项包含状态、验收标准、最近进度、直接子任务摘要，以及“推送后读取远端 tip 再提交”的要求；验收项包含 submission、冻结的 Git 远端定位、证据与结构化审查要求；阻塞审查项只有“给出具体方案并解除子任务阻塞”与“向上阻塞父任务”两种结果。若一次已启动的阻塞审查结束后子任务仍为 `blocked`，系统会自动阻塞父任务并移除本级审查项，避免等待或空回复造成无限回转。候选失效会从池中删除并继续检查新池首。

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
| 会议 | `company_meeting_request`、`company_meeting_list`、`company_meeting_status`、`company_meeting_speak`、`company_meeting_delegate`、`company_meeting_set_task_drafts`、`company_meeting_yield_to_boss`、`company_meeting_submit_summary`、`company_meeting_end`、`company_meeting_cancel` |
| 任务 | `company_task_list`、`company_task_read`、`company_task_create`、`company_task_flow_update`、`company_task_start`、`company_task_progress`、`company_task_revise`、`company_task_block`、`company_task_unblock`、`company_task_submit`、`company_task_review`、`company_task_reassign`、`company_task_cancel`、`company_task_correct` |

首次启动固定建立虚拟成员 `boss`，并以 OpenClaw 默认 Agent 的真实 ID 建立组织架构师；也可通过 `organizationAdminAgentId` 显式指定。只有该架构师能修改组织，新增员工的 Agent ID 必须已经存在于 `agents.list`。

## 测试

`npm test` 覆盖组织环、真实 Agent ID 迁移、非法员工、跨级派发、proof、Git 远端 URL/分支/tip 校验与无部分写入、全层级验收材料冻结/邮件附件/workspace 投递/版本保留/重试、版本、阻塞/停滞风险、Boss 持久催办、根任务提交验收邮件及重启恢复、分时任务巡检轮转/递补/单次投递恢复、Boss 巡检邮件、公告半点时区/快照/聚合/过滤/跨轮去重/单次投递恢复、每日自省治理的时区/排序/错峰/custom session/按 Agent 并发/单次投递恢复/七天历史页面、会议公告自动已读和更正重置、取消分支、逐层关单、统一 inbox、单会议室、同步点名、可信发言校验、审计代录、固定消息号/全局轮次、第二人称 session 回写、幂等水位推进、先回写再恢复主持人的顺序、Boss `@` FIFO、Boss 参会开始/拒绝/结束闸门、普通会议自动结束与重启恢复、全终态的逐成员终局同步、严格散会屏障、失败重试/租约恢复、Boss 真人头像、持久主持人任务恢复、QQ SMTP 配置、数据库迁移、任务会议原子回滚、超时、公告更正和完整的 Boss → CTO → 高工 → 工程师演练。

`npm run plugin:validate` 还会验证构建产物、清单与 32 个工具契约、长驻服务、相互隔离的 WebUI/API 路由，以及 `operator.write` Control UI 标签页。

## 来源说明

本仓库不合并来源仓库的 Git 历史，也不迁移旧数据库。

- [openclaw-plugin-company-board](https://github.com/LobsterFarmerAmp/openclaw-plugin-company-board)：参考 SQLite/WAL、迁移、`toolContext.agentId` 身份边界和 read mark 思路。
- [company-board-viewer](https://github.com/LobsterFarmerAmp/company-board-viewer)：参考 React/TypeScript 的轻量卡片、徽章和排版基础；Python/FastAPI 后端未保留。
- [openclaw-plugin-meeting-orchestrator](https://github.com/LobsterFarmerAmp/openclaw-plugin-meeting-orchestrator)：以其 `meeting.py` 已验证的“主持人同步调用目标 Agent、等待并验证发言”闭环为编排基线；Company OS 用 TypeScript 原生重写，不保留飞书、Tunnel 或 Python 运行时。
- OpenClaw Workboard：仅借鉴 proof、blocked、stale、review 语义，不复用其数据模型或 API。

现有插件仓库保持不变；本项目只提供新的 `company_*` 接口，不提供旧工具兼容别名。
