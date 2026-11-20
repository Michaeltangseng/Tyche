# Milestone 0 spikes

这里是里程碑 0 的实测脚本，**手动运行，不属于应用，不被测试收集**。

- 运行方式与场景说明见各脚本顶部注释，以及 `docs/spikes/milestone-0-results.md`。
- 这些脚本不进入 `desktop/package.json` 的 `files`，不被 `npm --prefix desktop test` 收集。
- 实验用的临时目录一律建在 `os.tmpdir()` 下，结束后删除；实验进程在报告里用 `pgrep` 确认已清理。
- 实测结论决定后续里程碑是否按现有设计实现。脚本本身不追求成为产品代码。
