# 裁决：监护程序的宿主

日期：2026-11-13。来源：里程碑 0 任务 0.2 的停止汇报。

## 事实

- Node 原型的四个场景（M3 3.6）在系统 Node 与开发用的 Electron（`ELECTRON_RUN_AS_NODE=1`）上全部通过。
- 在打包后的应用上全部失败：`desktop/scripts/after-pack.cjs:13-19` 把 Electron 的 `runAsNode` fuse 设为关闭（同时关闭 `NODE_OPTIONS`、`--inspect`，开启 asar 完整性校验与只从 asar 加载），`ELECTRON_RUN_AS_NODE` 被忽略；Helper 可执行文件也不能替代。

## 选项

1. 随应用分发独立的原生小程序。
2. 打开 `runAsNode` fuse。
3. 先继续其他实测，以后再定。

## 裁决：选项 1

- 不打开 fuse：打开后，任何能启动进程的东西都可以把签过名的 Meldwork 当作通用 Node 解释器运行任意脚本，等于为了监护程序放宽整个应用的这项加固。
- 原生小程序：监护逻辑很小；macOS 的 `libproc`（`proc_listpids(PROC_PGRP_ONLY)`、`proc_pidinfo`）已在本机验证可用，不必再启动 `pgrep`、`ps`；与 Windows 计划中的原生作业对象辅助程序统一为「随应用分发的原生小程序」；由现有 `codesign --deep` 一并签名。
- 不选 3：宿主不定，里程碑 1 无法开始；但这一裁决不影响任务 0.3–0.7，它们继续执行。

## 修改的文档

- `docs/modules/m3-seat-invocation.md`：第九版（3.2 组成、3.3 握手、3.5 事件循环、3.6 结论、第 2 节现状、第 13 节）。
- `docs/tasks/milestone-1.md`：任务 1.3 改为原生监护程序与构建脚本；任务 1.5 启动方式与定位；人工检查增加 fuse 与签名的确认；停下来问的情况。
- `docs/tasks/milestone-0.md`：任务 0.2 标为已完成、已裁决。
- `docs/error-codes.md`：新增 `LOCAL_MANAGED_PROCESS_UNAVAILABLE`。
- `docs/functional-architecture.md`、`docs/implementation-plan.md`：版本与风险项。

## 同时采纳的实测发现

- 关闭 fd 0/1/2 后必须用 `/dev/null` 重新占用，否则之后的描述符会落到这些编号上（Node 原型中直接 `SIGABRT`）：写入 M3 3.3。
- 只加 `asarUnpack` 不会把文件打进包，必须同时加入 `files`：原生方案改用 `extraResources`，不再涉及。
- 基线测试中有 26 个既有失败（`preload-security` 在 Node 25 下的 localStorage 初始化；`local-skill-snapshot` 在临时目录的 `EACCES`），与本项目无关，未修改任何测试。不在本项目中修复。实施期间的判断标准已写入交接手册 2.5：改动后的失败集合必须是基线失败集合的子集。
