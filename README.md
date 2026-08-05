# OpenClaw Company OS

`company-os` 是一个原生 OpenClaw 插件，把公司治理收敛到一套共享基础设施和三种业务对象：会议、严格层级任务、不可变公告。Boss 在统一 WebUI 操作，Agent 只能通过 `company_*` 工具参与。

## 核心约束

- 一个 Boss、一间会议室、单一 Gateway、单一 SQLite 数据库。
- 任务是严格树，不是 DAG：根任务只能由 Boss 派给一级直属员工；子任务只能由父任务负责人派给直属下属。
- 任务只能自下而上关闭。负责人携 proof 提交 review，派发者验收后永久关闭。
- 会议严格串行。任务会议结束时，子任务、会议总结和会议汇报公告在同一事务中原子提交。
- 公告不可编辑或删除；修正通过 `supersedesNoticeId` 发布新公告。
- Boss 写操作由服务端固定记录为 `actor=boss`；Agent 身份只读取可信的 `toolContext.agentId`。
- 任务与公告不主动唤醒 Agent；会议点名会调度 `agent:<agentId>:main`。

## 技术结构

```text
OpenClaw Gateway
├── CompanyOsService（恢复、超时扫描、SSE、会议调度）
├── 28 个 company_* Agent 工具
├── /plugins/company-os/api/v1/*（Gateway 鉴权）
├── Control UI 标签页「公司」（operator.write）
└── company-os.sqlite
    ├── organization + audit
    ├── task tree + versions + proof
    ├── notices + read marks
    └── meeting queue + transcript + turns + drafts
```

前端是 React + Vite，包含三个真实路由：

- `/plugins/company-os/meeting-room`：默认页面，当前会议、Boss 插话、任务草案、队列和历史。
- `/plugins/company-os/tasks`：任务树、风险、版本/proof/审计、Boss 兜底操作和根任务创建。
- `/plugins/company-os/notices`：当前共识、历史更正、会议汇报和阅读覆盖。

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

`trusted` 让同源插件 iframe 复用 Control UI 的 Gateway 登录令牌；页面本身不提供第二套认证。标签页和写接口面向拥有 `operator.write` 的 Boss 操作者。

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

`npm test` 覆盖组织环、非法员工、跨级派发、proof、版本、阻塞/停滞风险、取消分支、逐层关单、统一 inbox、单会议室、Boss `@` 插话、任务会议原子回滚、超时、重启恢复、公告更正和完整的 Boss → CTO → 高工 → 工程师演练。

`npm run plugin:validate` 还会验证构建产物、清单与 28 个工具契约、长驻服务、Gateway 鉴权路由，以及 `operator.write` Control UI 标签页。

## 来源说明

本仓库不合并来源仓库的 Git 历史，也不迁移旧数据库。

- [openclaw-plugin-company-board](https://github.com/LobsterFarmerAmp/openclaw-plugin-company-board)：参考 SQLite/WAL、迁移、`toolContext.agentId` 身份边界和 read mark 思路。
- [company-board-viewer](https://github.com/LobsterFarmerAmp/company-board-viewer)：参考 React/TypeScript 的轻量卡片、徽章和排版基础；Python/FastAPI 后端未保留。
- 本地 `openclaw-plugin-meeting-orchestrator`：参考主持人点名、发言权和总结概念；会议引擎已用 TypeScript 重写，不保留飞书、Tunnel 或外部 Python 编排。
- OpenClaw Workboard：仅借鉴 proof、blocked、stale、review 语义，不复用其数据模型或 API。

现有插件仓库保持不变；本项目只提供新的 `company_*` 接口，不提供旧工具兼容别名。
