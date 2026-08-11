# Bug 报告：gateway 重启后 meeting session 绑定失效，会议 entry 卡死

- **报告时间**：2026-08-11 19:01 CST
- **报告人**：架构师（jia-goushi）
- **组件**：Company OS 插件（openclaw-plugin-company-os）
- **影响版本**：v0.7.0（含此前 v0.4+ 的既有缺陷）
- **复现日期**：2026-08-09 首次记录；2026-08-11 复现
- **严重度**：高（阻塞所有需要 advisor 参与的会议编排）

## 症状

1. **会议 entry 永远卡在 `notifying`**：入会通知已投递到成员 main（gateway.log 有 `delivered meeting entry ... to agent:x:main`），但 `meeting_member_sessions` 全部停留在 `pending`、`attempts=0`、`next_attempt_at` 卡在创建时刻，**重试循环不推进**。全员屏障永远无法满足，主持人无法开始。
2. **会议工具报 session 不匹配**：`company_meeting_speak` / `company_meeting_delegate` 返回
   `meeting tool session ID does not match the persisted meeting session binding`。
3. **会议最终"伪完成"**：因主持人无法从 meeting session 推进，会议由主持人超时自动收束，summary 里 advisor 发言为 0（实际未讨论），对外表现为"completed"。

## 根因

gateway（或插件）重启后，`agent:<id>:meeting` 固定 session 被**重建、sessionId 轮转**，但 Company OS 持久化的 `meeting_member_sessions.session_id` 仍指向**旧 sessionId**（或 entry 阶段绑定用的是旧 id）。`ensureSession` 按 `session_key` 找到的是新 session，与会话级协调器持有的持久绑定不一致：

- entry 阶段：绑定步骤发现 id 不匹配 → 失败，且失败后**重试循环未正确推进**（`next_attempt_at` 不再更新），entry 永久卡死。
- 会议工具：当前运行 session id ≠ 持久绑定 id → 直接拒绝。

## 证据

- `gateway.log`：`2026-08-11T18:52:57` 与 `18:58:06` 各投递两次 entry 通知成功，其后**无任何绑定/重试日志**。
- `meeting_member_sessions`：两次会议（`4e212c0e`、`a5a1fa5f`）成员行均 `pending`/`attempts=0`，`next_attempt_at` 定格在创建时间。
- 8-09 任务会日志（林知衡/宪章/探微）：「`company_meeting_speak` 持续报 session ID does not match persisted binding」「gateway 重启导致 meeting session 重建、绑定 sessionId 错位，需运行侧回写 `meeting_member_sessions`」。
- 记忆线索：`LRN-20260810-002 · company_meeting_speak session binding bug + fallback 路径`。

## 复现步骤

1. 正常召开一场有多名 advisor 的讨论会（可正常入会）。
2. 重启 gateway（强制真实重启，`openclaw gateway restart`）。
3. 在重启后**新开**一场会议。
4. 观察：entry 卡 `notifying`，成员 session 绑定不推进；若成员尝试 `company_meeting_speak` 报 session 不匹配。

## 影响范围

- 任何在 gateway 重启后新开的、需要成员绑定固定 meeting session 的会议。
- 主持人自身也受影响（`company_meeting_end` 从 main 调用同样被拒，无法正常收束）。
- 直接影响：会议编排不可用、讨论无法进行。

## 临时规避（已验证可行）

手动回写绑定到**当前** sessionId 并置 `ready`：

```sql
UPDATE meeting_member_sessions
SET session_id='<当前 session_id>', status='ready', ready_at=strftime('%Y-%m-%dT%H:%M:%S.000Z','now')
WHERE meeting_id='<meeting_id>' AND member_id='<member_id>';
```

- 当前 sessionId 通过 `sessions_list`（`agent:<id>:meeting`）或 `~/.openclaw/agents/<id>/sessions/*.jsonl` 最近的 meeting transcript 文件名获取。
- 回写后 entry 可推进到 `ready`，但会议工具仍可能因运行 session 与绑定差异继续报错，稳妥做法是**回写后重开会话或重启再重开**。

## 修复建议（根治）

1. **entry/绑定阶段**：`ensureSession` 在找到以 `agent:<id>:meeting` 为 key 的 session 后，若发现当前 `session_id` 与持久绑定不同，应**自动回写**新 id 并记录审计，而不是失败后卡死。
2. **重试循环**：entry 绑定失败后 `next_attempt_at` 必须按指数退避推进，不能定格在创建时刻；当前失败即永久停滞是缺陷。
3. **会议工具**：`company_meeting_speak`/`delegate`/`end` 的 session 校验失败时，应走"回写绑定 + 重试一次"，而不是直接拒绝。
4. **回归测试**：补一条"gateway 重启后重开会话 → 会议可正常入会并发言"的用例。

## 状态

- [ ] 根因已定位（本报告）
- [ ] 临时规避已验证（手动回写）
- [ ] 修复实现
- [ ] 回归测试
- [ ] 上线验证