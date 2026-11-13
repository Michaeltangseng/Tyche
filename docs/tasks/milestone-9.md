# 任务单：里程碑 9 现有模式的限制、迁移与发布准备

## 目标

完成发布前的收尾：项目内群聊不提供自动讨论 V4；升级与备份的说明；文档与能力矩阵；所有边界变更在 `architecture.md` 与 `AGENTS.md` 中落实；决定功能开关的默认值。

## 前置条件

- 里程碑 8 已验收。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/functional-architecture.md`：M11、第 6 节（全部边界变更）。
- `docs/modules/m1-m5-storage-and-interfaces.md`：3.1（v4 与降级）。
- `docs/modules/m3-seat-invocation.md`：第 10 节（能力登记）。

## 任务

### 任务 9.1 项目内群聊不提供 V4

依据架构 M11：项目内群聊的模式选择器不显示自动讨论；从项目外移入项目室的群聊，如果设置为自动讨论，改为单次回答并提示（文案进入中英 locale）。**不修改** V4 执行器（`local-workspace-auto-runner*.cjs`）的任何代码。测试：前端选择器在项目内群聊中没有自动讨论；移入时的转换与提示；项目外群聊的模式选择不变。

### 任务 9.2 升级与降级说明

发布说明中写明：工作区文件升级到 v4；首次写入前生成 `meldwork-workspace.v3.backup.json`；不支持降级，降级前请先恢复这份备份，项目室在旧版本中不可用（M1/M5 3.1）。

### 任务 9.3 文档

1. `architecture.md`：落实架构第 6 节表格中的每一行（Trust Boundaries、Reliability、Known Risks、Local Data）。逐行核对，在汇报中列出每一行改在了哪里。
2. `AGENTS.md`：可执行文件路径一条按架构第 6 节修改（里程碑 7 若已修改，核对即可）。
3. `README.md`、`README.zh-CN.md`、`desktop/README.md`：项目室的简介、预览状态、已知限制（Windows 上受管理进程未实现等）。
4. `CATALOG.md`：能力矩阵加入 `readExec`、`managedProcess`、`writeSessionContinuity` 三列，取值与里程碑 5 的能力登记一致。

### 任务 9.4 发布验证

1. 全部验证命令：`npm --prefix frontend test`、`npm --prefix frontend run build`、`npm --prefix frontend run build:desktop`、`npm --prefix desktop test`、`npm --prefix desktop run pack`。
2. 在一台从未安装过 Meldwork 的机器（或一个新的系统用户）上安装打包产物：打开功能开关，新建项目室，推进到第一个关卡。
3. 从上一个正式版本升级：确认现有群聊、消息、会话完整，`meldwork-workspace.v3.backup.json` 存在。

### 任务 9.5 功能开关的默认值

根据里程碑 8 的试用记录与本里程碑的验证结果，写一段建议（保持关闭作为预览，或默认打开），交人决定。**不要自行修改默认值。**

## 验收

- 任务 9.1 的测试；9.4 的全部命令通过；9.4 第 2、3 条的人工验证记录。
- 9.3 的逐行核对清单。
- 9.5 的建议，以及人的决定。

需求追踪：R24、R26。
