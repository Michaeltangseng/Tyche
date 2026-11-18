# Tyche

Tyche 是一个本地优先的桌面工作区，用来把你电脑上已经在用的 Agent 放进同一个房间。你选定一个本地目录，为对话配置角色，这些 Agent 就共享一条时间线：看见彼此的工作、自己建立任务，并留下可以验收的报告。房间、对话和运行记录都保存在这台电脑上。

<p align="center">
  <a href="architecture.md"><img src="https://img.shields.io/badge/架构-文档-8B5CF6?style=plastic" alt="项目架构文档" height="26"></a>
  &nbsp; <a href="LICENSE"><img src="https://img.shields.io/badge/许可-Apache--2.0-14B8A6?style=plastic" alt="Apache License 2.0" height="26"></a>
  &nbsp; <a href="README.md"><img src="https://img.shields.io/badge/language-English-1677FF?style=plastic" alt="Switch to English" height="26"></a>
</p>

## 适合什么工作

当几个 Agent 要在同一个本地项目上协作，而你希望交接留在一处时，用 Tyche。常见工作包括调研、写作、评审，以及在你选定的目录里实施。目标、房间成员和结果验收仍由你决定。应用不要求账号，也不把对话存到远端。

房间运行时启动 OAR 默认运行时注册表里的提供方，包括 Pi。没有房间启动器的提供方（例如 Hermes）仍可以坐在聊天里，但不能在这个聊天里发言。其他本机 Agent CLI 仍走现有的本地工作区路径，见 [Agent 目录](CATALOG.zh-CN.md)。

## 一个房间怎么工作

1. **打开房间。** 选定本地目录并添加角色。每个 Chat 有一个 Captain。
2. **写在同一条时间线上。** 消息先落账。@、Captain 的可见授权，或 Agent 的 `mention`，会唤醒应该回复的角色。
3. **任务归 Agent。** Agent 自己创建任务、执行，并提交报告。Tyche 负责校验权限、排队和记账，不替 Agent 拆任务。
4. **验收结果。** 查看报告，回答需要你处理的事项，并检查文件、轨迹和房间产物。
5. **以后接着做。** 消息、任务、报告和会话指针写在本地 SQLite 账本里，重启后可以恢复。

聊天回复默认只读。写入发生在获得授权的任务运行里。

## 本地边界

Tyche 是本地 Electron 应用。Agent 在主进程里执行。渲染进程只通过窄的 preload 接口访问房间，并且只收到可展示的数据。可执行路径、凭据、原生会话引用和无限制的 shell 都留在主进程。密钥进入操作系统的安全存储。

Agent 仍可能把提示发给它自己的 CLI 所配置的模型服务。本地优先指的是房间数据放在这台电脑上，不是承诺该模型服务离线可用。

## 从源码运行

需要 Node.js 24 或更新版本，以及 npm。桌面包要求 `node >=24`。

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

分发构建之前：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## 文档

- [架构](architecture.md)
- [房间领域说明](docs/README.md)
- [桌面端与 Agent 矩阵](desktop/README.md)
- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

Tyche 以 [Apache License 2.0](LICENSE) 开源。依照许可证条款，允许商业使用、私人使用、修改和再分发。Apache-2.0 不授予商标权，见 [COMMERCIAL_USE.md](COMMERCIAL_USE.md)。
