# 任务单：里程碑 7 完整轨迹与工作目录浏览

## 状态：等待模块文档

本里程碑依据的 `docs/modules/m7-m8-trace-and-workdir.md` **尚未编写**。它改动的是信任边界（renderer 能看到完整的命令与输出、能读取工作目录内的文件），设计必须先经评审定稿，执行者不得在没有定稿文档的情况下开始实现。

**执行者在这个状态下不做任何实现。** 模块文档定稿后，由设计者补全本任务单，格式与里程碑 1–6 相同。

## 预定范围（供排期参考，不作为实现依据）

依据 `docs/functional-architecture.md` M7、M8 与第 6 节：

- 完整轨迹：ACP 通道与 print/exec 回退通道取得完整内容；只做密钥脱敏，不做路径与命令改写；追加写到 `meldwork-private/traces/<runId>/<agentRunId>.jsonl`；`trace:page` 分页读取；现有群聊的「运行详情」改用同一套组件。
- 工作目录浏览：`workdir:list`、`workdir:read`、`workdir:diff`；路径限制在工作目录内、拒绝指向外部的符号链接、读取大小上限、二进制只返回元信息；diff 基于影子仓库（里程碑 3 的 `numstat`、`fileDiff`），以 `@git-diff-view/vue` 展示。
- 文档：`architecture.md` Trust Boundaries 第 1、6 条与 Local Data 表格；`AGENTS.md` 中可执行文件路径一条（限定为「轨迹显示以外，renderer 不接收可执行文件路径，也不能据此启动进程」）。

## 依赖

- 模块文档可以在里程碑 4 完成后开始编写，与里程碑 5、6 并行。
- 实现依赖里程碑 3（diff 数据）、里程碑 4（项目与 IPC 的写法）、里程碑 6（抽屉外壳）。

需求追踪：R21、R22。
