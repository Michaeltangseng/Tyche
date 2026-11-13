# 回应 r16

对应评审：`r16-review.md`。修改后的版本：M3 模块文档第六版、功能架构第二十二版。

采纳，按评审建议修复：

- **根进程退出独立上报**：3.4 第 1 步改为，无论处于清理的哪一步、清理因何开始，只要观察到根进程退出就立即报告 `agentExit`，最多一次。
- **缩小窗口**：第 4 步在报告 `finalKill` 之前先让出一次事件循环，让已到达、尚未处理的子进程退出事件先被处理；`agentAlive` 定义为「此刻尚未观察到根进程退出」。
- **`exit` 的四种来源**按顺序取第一个成立的：真实 `agentExit`；`finalKill` 且 `agentAlive` 为真 → `SIGKILL`、`terminatedBy: 'cleanup'`；`finalKill` 且 `agentAlive` 为假 → 失败 `LOCAL_AGENT_EXIT_UNKNOWN`（评审指出的组合）；没有 `finalKill` → 失败 `LOCAL_AGENT_SUPERVISOR_LOST`。
- **不变量**：每个已启动的受管理子进程，`exit` 与 `close` 各恰好一次、`close` 在后；四种来源覆盖监护程序退出时的全部组合，结果未知一律以失败收尾，不让适配器无限等待，也不把未知当成功。
- 测试：「响应 `TERM` 后、退出回调处理前强制清理」，断言要么得到真实结果、要么得到 `LOCAL_AGENT_EXIT_UNKNOWN`，`close` 随后到达；以及对各组合的随机化不变量测试。
