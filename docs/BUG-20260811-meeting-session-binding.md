# 更正声明 + 事件复盘：meeting session 绑定"疑似卡死"实为误判

> **本文件取代前一份 `BUG-20260811-meeting-session-binding.md`（那份定性错误，已作废）。**
> 更正时间：2026-08-11 · 更正人：架构师（jia-goushi）· 复核：Boss

## 结论（先看这个）

**v0.7 在 2026-08-11 的"会议 entry 卡死"不是真 bug。** 前一份报告的定性是**误判**，它把三件事混为一谈：

1. 一个 **8-09 曾经存在、v0.7 已修复**的旧缺陷；
2. 对**入会屏障（两阶段）正常行为**的误读；
3. 一次**手工改库绕过协调器**造成的新卡死（我的操作）。

## 逐条澄清（对应前报告的错误论断）

| 前报告论断 | 事实 |
| --- | --- |
| 会议 `4e212c0e` 卡死在 notifying | 否。advisors 通知 18:52:57 完成，主持人通知因 main 忙碌延迟到 18:55:34，随后立即 `entry_ready`，18:57:08 正常结束 |
| sessionId 轮转导致绑定失效 | 否。sessionId 确实轮转，但系统在 18:55:43 自动执行 `meeting.session_binding_refreshed`，把 `03642c43…` 刷新为 `c78fccaa…`。这是**当前代码的设计**（`src/store.ts:9351` 自动刷新绑定），并有回归测试（`tests/meeting-governance-v17.test.ts:100`） |
| advisor 发言为 0 是绑定问题 | 否。真实原因是审计记录里的 `Token Plan 用量上限 2056`，与 session binding 无关 |
| 会议 `a5a1fa5f` 观察时 session 行 pending/attempts=0 是卡死 | 否。观察时只完成 2 名 advisor 通知，主持人通知直到 19:00:46 才完成；**全员通知完成前 session 行保持 pending/attempts=0 是两阶段屏障的正常行为**（`src/store.ts:7348` 状态迁移逻辑） |
| 手工 SQL 是"修复" | 否。**该 SQL 不安全**：只把成员行改成 `ready`，未执行 `entry_state=ready`、未创建主持人 dispatch、未写审计。`a5a1fa5f` 呈现"仍 provisioning、成员却全 ready、无 entry_ready 审计"的不一致状态，正是手工改库绕过协调器造成的卡死 |
| 8-11 发生了"重启后普遍卡死" | 否。8-11 没有真实 gateway 重启：当前 gateway PID 自 8-09 12:45 一直运行，重启日志最后记录是 8-09 |

## 定向测试（已通过）

2 个测试文件、10 个测试全部通过，覆盖 sessionId 轮转刷新与入会恢复。

## 更准确的定性

- **8-09 的 session binding 错误**：历史真 bug，**当前 v0.7 已修复**（自动刷新 + 回归测试）。
- **8-11"重启后普遍卡死"**：误判，证据不成立。
- **仍值得改进**：入会通知等待主持人 main session 时，**可观测性不足**——容易把 `running`（通知投递中）误看成 session provisioning 卡死。建议在 WebUI/状态接口区分"等待通知投递"与"session 绑定中"，并给出明确进度。

## 教训（我方的）

1. **不要用绕过协调器的手工 SQL"修"会议状态**——协调器（store.ts 的 entry 状态机 + service 的 work loop）是唯一权威，手工改库会制造协调器无法识别的不一致状态。
2. **诊断先看权威事实**：审计日志（`audit_events`）、协调器源码（状态迁移/绑定刷新路径）、gateway 日志——而不是只看 `meeting_member_sessions` 的瞬时 pending 就下"卡死"结论。
3. **两阶段屏障是设计**：通知（main）→ session 绑定（meeting）是串行两段，任一未完成时 session 行 pending 是正常的。

## 当前第二场会议（a5a1fa5f）状态

手工 SQL 已回滚（成员行恢复为 pending/session_id NULL，可被协调器 driver 重新捞起）。协调器 entry work loop 当前空闲，需一次 kick（gateway 重启，或任一触发 `dispatchAdvance` 的会议操作）即可按正常路径完成 provisioning → `entry_ready` → host dispatch。**不会再用手工 SQL 干预。**

## 状态

- [x] 更正前报告（本文件）
- [x] 回滚手工 SQL
- [ ] 通过协调器恢复会议（待 kick）
- [ ] 可观测性改进（建议排期）