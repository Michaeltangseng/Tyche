# Tyche

Tyche is a local-first desktop workspace for the Agent tools already installed on your machine. You open a room on a local directory, put roles into a chat, and let those Agents share one timeline: they see each other's work, take on tasks, and leave reports you can accept. The app stores the room, the conversation, and the run history on this computer.

<p align="center">
  <a href="architecture.md"><img src="https://img.shields.io/badge/architecture-docs-8B5CF6?style=plastic" alt="Architecture documentation" height="26"></a>
  &nbsp; <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-14B8A6?style=plastic" alt="Apache License 2.0" height="26"></a>
  &nbsp; <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/语言-简体中文-1677FF?style=plastic" alt="切换为简体中文" height="26"></a>
</p>

## What it is for

Use Tyche when several Agents should work on the same local project and you want the handoff to stay in one place. Typical work includes research, writing, review, and implementation inside a directory you choose. You still set the goal, choose who is in the room, and accept the result. The app does not require an account or a hosted conversation store.

The room runtime currently drives Claude Code and Codex. Other local Agent CLIs remain available through the existing local-workspace path; see the [agent catalog](CATALOG.md).

## How a room works

1. **Open a room** on a local directory and add roles. Each chat has one Captain.
2. **Talk on one timeline.** A message is recorded first. An @, a Captain authorization, or an Agent `mention` wakes the roles that should respond.
3. **Let the Agent own the task.** The Agent creates the task, runs it, and files a report. Tyche checks permissions, queues the run, and keeps the record. It does not split the task for the Agent.
4. **Accept the result.** Review the report, answer anything that is blocked on you, and inspect files, traces, and room artifacts.
5. **Continue later.** Messages, tasks, reports, and session pointers stay in a local SQLite ledger and can be recovered after a restart.

Chat replies are read-only by default. Writing happens in an authorized task run.

## Local boundary

Tyche runs as a local Electron application. Agent execution stays in the main process. The renderer talks to the room through a narrow preload API and receives display-safe data only. Executable paths, credentials, native session references, and unrestricted shell access stay in the main process. Secrets go to operating-system secure storage.

An Agent may still send prompts to the model provider configured in its own CLI. Local-first describes where Tyche keeps the room, not whether that provider is offline.

## Run from source

Prerequisite: Node.js 24 or newer, and npm. The desktop package requires `node >=24`.

```bash
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

Before distributing a build:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
```

## Documentation

- [Architecture](architecture.md)
- [Room domain notes](docs/README.md)
- [Desktop setup and Agent matrix](desktop/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

Tyche is open source under the [Apache License 2.0](LICENSE). Commercial use, private use, modification, and redistribution are permitted under the license terms. Apache-2.0 does not grant trademark rights; see [COMMERCIAL_USE.md](COMMERCIAL_USE.md).
