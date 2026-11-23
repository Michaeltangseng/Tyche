# 14 Usage and Cost

更新日期：2026-11-23

`设置 › 用量与成本` 现在读取真实的 Room 数据，不再使用示意数字。

## 数据来源

- 每个已完成的 Agent 回复把 usage 存在 `messages.data_json.usage`：
  `inputTokens`、`outputTokens`、`cachedInputTokens`、`context`。
- 报表按 `messages.author_id → chat_roles → chats → rooms` 关联到 Agent 和 Room。
- 时间范围按本地时区计算：今天、本周（周一起）、本月（1 日起）。
- `runtime_events` 里的 usage 事件是流式快照，不是稳定的事实来源；报表只用 message 上已结算的 usage。

## 费用

- 如果 usage 带 `costUsd` / `costMicros`，直接使用 Provider 报告的成本。
- 否则按 Provider 的公开价目估算：`input / output / cache` 每 1M token 单价。
- 报表返回 `totals.estimated`，页面会明确标注"费用为估算值"。
- 价目表在 `desktop/src/room/usage-report.cjs` 的 `PRICES`，后续可替换为真实账单数据。

## 指标

| 指标 | 含义 |
| --- | --- |
| 费用 | 选中范围内的估算成本 |
| 总 Token | input + output + cached |
| 接力次数 | 范围内带 usage 的 Agent 回复数 |
| 被中止的循环 | 这些回复里 status 为 `stopped` / `failed` 的数量 |
| 每日趋势 | 按本地日期聚合，按 Provider 堆叠；悬停查看当天明细，点击固定，图例可切换 Provider |
| 按 Room | 每个 Room 的 token 和费用 |
| 按 Agent | 按 Provider 聚合的 token、费用和占比 |

## 预算与限制

- 设置持久化在 `<privateRoot>/usage-settings.json`：
  - `monthlyBudgetUsd`
  - `warnAtPercent`
  - `overBudgetAction`（当前只支持 `warn`）
  - `roomDailyLimitUsd`
  - `maxTokensPerTurn`
- 页面显示本月已用百分比和是否跨过提醒阈值。
- **目前只是记录和提醒，运行时不强制暂停或截断**。`budget.enforced` 固定为 `false`，页面会说明这一点。
- 真正执行"暂停所有 Agent / 单 Room 日限 / 单次接力链上限"需要接入执行 lease 和运行中 token 计数，属于后续独立工作。

## IPC

`teamRoom`：

```text
usageReport({ range: 'today' | 'week' | 'month' })
usageSettings()
updateUsageSettings({ monthlyBudgetUsd?, warnAtPercent?, overBudgetAction?, roomDailyLimitUsd?, maxTokensPerTurn? })
```

返回 DTO 只包含 Provider 名称、Room 名称、token 和费用，不含路径、命令、凭据或 session 引用。

## 验证

```bash
node --test desktop/test/room/usage-report.test.cjs
```

测试覆盖：范围过滤、token/费用聚合、Room/Agent 分组、被中止计数、空范围、预算设置持久化与提醒阈值。
