# OpenClaw Company OS

`company-os` 是一个原生 OpenClaw 插件，把公司治理收敛到一套共享基础设施和三种业务对象：会议、严格层级任务、公司公告。Boss 在统一 WebUI 操作，Agent 只能通过 `company_*` 工具参与。

## 核心约束

- 一个 Boss、一间会议室、单一 Gateway、单一 SQLite 数据库。
- 任务是严格树，不是 DAG：根任务只能由 Boss 派给一级直属员工；子任务只能由父任务负责人派给直属下属。
- 任务只能自下而上关闭。负责人携 proof 提交 review，派发者验收后永久关闭。
- 会议严格串行。任务会议结束时，子任务、会议总结和会议汇报公告在同一事务中原子提交。
- 会议可设置 `bossParticipates=true`：进入会议室后等待 Boss 手动开始，主持人只能申请结束，最终结束权固定属于 Boss。
- 公告不可编辑；修正通过 `supersedesNoticeId` 发布新公告。Boss 还可在 WebUI 二次确认后审计删除公告。
- Boss 写操作由服务端固定记录为 `actor=boss`；Agent 身份只读取可信的 `toolContext.agentId`。
- 任务与公告不主动唤醒 Agent；会议点名由插件同步调用 `agent:<agentId>:main`，主持人的原工具调用会等待并校验实际发言。

## 技术结构

```text
OpenClaw Gateway
├── CompanyOsService（同步会议编排、持久主持人队列、恢复、超时扫描、SSE）
├── 28 个 company_* Agent 工具
├── /plugins/company-os/api/v1/*（Gateway 鉴权，仅 API）
├── /plugins/company-os-ui/*（无敏感数据的 WebUI 静态壳）
├── Control UI 标签页「公司」（operator.write）
└── company-os.sqlite
    ├── organization + audit
    ├── task tree + versions + proof
    ├── notices + read marks
    └── meeting queue + transcript + turns + context watermarks + dispatch/email outbox
```

前端是 React + Vite，包含三个真实路由：

- `/plugins/company-os-ui/meeting-room`：默认页面，当前会议、Boss 开始/结束审批、插话、任务草案、队列和历史。
- `/plugins/company-os-ui/tasks`：任务树、风险、版本/proof/审计、Boss 兜底操作和根任务创建。
- `/plugins/company-os-ui/notices`：当前共识、历史更正、会议汇报和阅读覆盖。

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

Agent 申请会议时可传入 `bossParticipates: true`。该模式有三个额外约束：

1. 创建会议时向 Boss 邮箱发送“会议已创建”提醒；轮到该会议进入唯一会议室时再发送“已进入会议室”提醒。
2. 会议进入会议室后不会唤醒主持人，也不会触发主持人超时；Boss 必须在会议室页面点击「我已进入，开始会议」。
3. 主持人调用 `company_meeting_end` 只会提交总结和结束申请。Boss 在 WebUI 批准后才会原子创建任务/公告并释放会议室，也可退回主持人继续讨论。

Boss 点击开始后接口立即返回，会议室显示“主持人启动中”。Boss 开场原文和主持人启动任务在同一 SQLite 事务中持久化；Gateway 重启时会恢复未完成任务，但不会重复执行已经成功的任务。

### 同步会议编排

主持人调用 `company_meeting_delegate` 后，插件通过 `openclaw agent --agent <id> --message-file <private-file> --json` 直接调用目标 Agent 的 main session，并保持主持人工具调用等待。目标 Agent 必须把提示中的 `meetingId` 和 `turnId` 一起传给 `company_meeting_speak`；插件同时校验会议、当前轮次和可信的 `toolContext.agentId`，再把发言返回给主持人。若 Agent 只返回普通文本而没有调用发言工具，系统会审计代录并标记 `completionSource=fallback`；调用失败或超时则以结构化失败轮次把控制权交还主持人。

每名主持人和参会者都有独立的增量上下文水位。只有成功发言、审计代录或成功交付给主持人后才推进水位；提示中使用组织成员姓名，并仍保留 Agent ID 供审计定位。Boss WebUI 始终展示完整会议记录。

组织成员 ID 是 Company OS 内部稳定主键，可以与 OpenClaw 配置中的 Agent ID 不同。例如成员 `main` 可以绑定 Agent `jia-goushi`：会议记录和关系仍使用 `main`，实际 CLI 调用则始终解析为经过配置校验的 `jia-goushi`。若主持人的 CLI 最终结果为空，但本次调用期间已经产生经过工具校验的会议进展，持久调度会按成功处理，避免把已完成的主持过程误报为启动失败。

邮件默认复用 `~/.config/mail-skills/.env` 的默认 SMTP 账号，并发送到该账号自身。本机已有的 QQ 邮箱配置无需复制授权码。可以通过 `bossEmailNotifications.account` 选择命名账号，或用 `recipient`、`configPath` 覆盖收件地址和配置路径。

## Agent 工具

| 模块 | 工具 |
| --- | --- |
| 收件箱 | `company_inbox` |
| 组织 | `company_org_list`、`company_org_add`、`company_org_update`、`company_org_deactivate` |
| 告示板 | `company_notice_list`、`company_notice_read`、`company_notice_publish` |
| 会议 | `company_meeting_request`、`company_meeting_list`、`company_meeting_status`、`company_meeting_speak`、`company_meeting_delegate`、`company_meeting_set_task_drafts`、`company_meeting_end`、`company_meeting_cancel` |
| 任务 | `company_task_list`、`company_task_read`、`company_task_create`、`company_task_start`、`company_task_progress`、`company_task_revise`、`company_task_block`、`company_task_unblock`、`company_task_submit`、`company_task_review`、`company_task_reassign`、`company_task_cancel` |

首次启动固定建立虚拟成员 `boss`；如果 OpenClaw 配置中存在 Agent `main`，同时建立架构师 `main`。只有 `main` 能修改组织，新增员工的 Agent ID 必须已经存在于 `agents.list`。

## 测试

`npm test` 覆盖组织环、非法员工、跨级派发、proof、版本、阻塞/停滞风险、取消分支、逐层关单、统一 inbox、单会议室、同步点名、可信发言校验、审计代录、增量上下文、Boss `@` FIFO、Boss 参会开始/结束闸门、持久主持人任务恢复、QQ SMTP 配置、数据库迁移、任务会议原子回滚、超时、公告更正和完整的 Boss → CTO → 高工 → 工程师演练。

`npm run plugin:validate` 还会验证构建产物、清单与 28 个工具契约、长驻服务、相互隔离的 WebUI/API 路由，以及 `operator.write` Control UI 标签页。

## 来源说明

本仓库不合并来源仓库的 Git 历史，也不迁移旧数据库。

- [openclaw-plugin-company-board](https://github.com/LobsterFarmerAmp/openclaw-plugin-company-board)：参考 SQLite/WAL、迁移、`toolContext.agentId` 身份边界和 read mark 思路。
- [company-board-viewer](https://github.com/LobsterFarmerAmp/company-board-viewer)：参考 React/TypeScript 的轻量卡片、徽章和排版基础；Python/FastAPI 后端未保留。
- [openclaw-plugin-meeting-orchestrator](https://github.com/LobsterFarmerAmp/openclaw-plugin-meeting-orchestrator)：以其 `meeting.py` 已验证的“主持人同步调用目标 Agent、等待并验证发言”闭环为编排基线；Company OS 用 TypeScript 原生重写，不保留飞书、Tunnel 或 Python 运行时。
- OpenClaw Workboard：仅借鉴 proof、blocked、stale、review 语义，不复用其数据模型或 API。

现有插件仓库保持不变；本项目只提供新的 `company_*` 接口，不提供旧工具兼容别名。
