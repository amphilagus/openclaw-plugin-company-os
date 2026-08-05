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

## 会议恢复与超时

- Gateway 重启后，活动会议、当前轮次、队列和任务草案从 SQLite 恢复。
- 恢复调度先按幂等 tag 删除同 tag 旧任务，再调度到 `agent:<agentId>:main`，避免重复点名。
- 普通参会者默认 10 分钟未发言：轮次标记失败，控制权回主持人。
- 主持人默认 30 分钟无动作：会议变成 `timed_out`，不创建任务、不发布正常汇报，会议室推进到下一场。
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

Schema 版本保存在 `schema_meta`，迁移在服务启动时执行。不要手工修改任务状态来绕过关单规则。

## 常见故障

### WebUI 返回 401

确认从已登录的 Control UI「公司」标签进入，且：

```bash
openclaw config get gateway.controlUi.embedSandbox
```

结果为 `trusted`。严格 sandbox 无法读取同源 Control UI 登录令牌。

### 新员工无法加入组织

`company_org_add` 只接受已经存在于 OpenClaw `agents.list` 的 Agent ID。先创建 Agent，再由 `main` 加入组织。

### 员工无法停用或换上级

先处理该成员作为负责人/派发者的所有活动任务、活动或排队会议，并安置其直属下属。系统不会级联修改。

### 父任务无法提交 review

检查所有直接子任务。只有 `closed` 和带原因的 `canceled` 算终态；`assigned`、`in_progress`、`review`、`blocked` 都会阻止父任务提交。

### 任务会议无法结束

必须同时满足：无未完成发言轮次、无待处理 Boss 插话、总结非空、每个 worker 至少一份草案、全部草案负责人仍是主持人的直属下属、父任务仍由主持人负责且可继续拆分。
