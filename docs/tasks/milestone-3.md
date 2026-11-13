# 任务单：里程碑 3 影子仓库与版本

## 目标

实现影子仓库的唯一入口 `shadow-git.cjs`：快照、占位条目、接受提交、漂移确认与恢复文件、diff 数据、用户仓库提交、回收，以及统一的路径状态描述。它不碰用户自己的 `.git`，保存工作目录文件的原始字节。

## 前置条件

- 里程碑 0 已验收（任务 0.7 给出了快照上限的建议值，以它为准；若建议值与 M4/M6 B3.4 不同，模块文档应已按人确认的结论修订）。
- 本里程碑只依赖里程碑 0，可以与里程碑 1、2 并行开发，但按顺序验收。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/modules/m4-m6-versions-and-writes.md`：B 全部（B1–B9）、D 中「影子仓库」部分。
- `docs/modules/m2-checkpoint-engine.md`：9.1 副作用目录中与 git 有关的行（`snapshot`、`evaluate-submission`、`verify-candidate`、`verify-observed`、`drift-check`、`detect-accepted-changes`、`accept-commit`、`restore-files`、`user-git-commit`、`drop-snapshot-refs`）。
- `docs/modules/m1-m5-storage-and-interfaces.md`：第 3 节中项目目录的布局。

## 范围

| 包括 | 不包括 |
| --- | --- |
| `desktop/src/project-room/shadow-git.cjs` 及其测试 | 谁、何时调用这些函数（引擎，里程碑 5） |
| `desktop/src/project-room/path-change.cjs`（`describePathChange`） | 项目状态文件（里程碑 4）：占位清单由调用方传入、传出 |
| 测试套件登记 | 界面 |

## 任务

### 任务 3.1 测试套件

在 `desktop/scripts/test-discovery.cjs` 的 `TEST_SUITES` 中加入 `projectRoom: ['project-room']`。本里程碑起的测试放在 `desktop/test/project-room/`。

### 任务 3.2 调用封装与仓库创建

新文件 `desktop/src/project-room/shadow-git.cjs`。

```
encodeId(id)                          → 64 位小写十六进制：UTF-8 字节的 SHA-256（M4/M6 B1「名字的编码」）
class ShadowRepo {
  constructor({ gitDir, workTree, gitExecutable = 'git', execFileFn })
  static async create({ gitDir, workTree, ... })   创建（M4/M6 B1）并写入 info/attributes、info/exclude；返回实例
  async git(args, { env, input, indexFile })       唯一的执行点：M4/M6 B1 的全部固定参数与环境；execFile，不经过 shell
  async withLock(fn)                               项目互斥队列：同一实例的所有操作串行
}
async checkGitVersion(gitExecutable)  → { ok, version }    要求 ≥ 2.32
```

- `git()` 生成的参数必须包含 `--git-dir=<gitDir>`、`--work-tree=<workTree>` 与 M4/M6 B1 列出的全部 `-c` 配置；环境中清除所有 `GIT_` 开头的变量，再设置 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM`、`GIT_TERMINAL_PROMPT`。
- `info/attributes` 的内容恰好是一行：`* -text -eol -filter -ident -working-tree-encoding`。
- `info/exclude` 分固定段与自动段，自动段用注释行包围，由 3.4 维护。

测试 `desktop/test/project-room/shadow-git-invocation.test.cjs`：

- 用注入的 `execFileFn` 记录每次调用，断言都带 `--git-dir`、`--work-tree` 与全部固定配置，环境中没有用户的 `GIT_DIR` 等变量，第一个参数不是 shell。
- 在用户的全局 git 配置中放入钩子与 `core.autocrlf=true`（用一个临时的 `HOME`），断言不生效。
- `encodeId('cp:1:0')` 只含 `[0-9a-f]`、长度 64；用它作引用名，`git update-ref` 成功。

### 任务 3.3 快照

```
async snapshot({ effectId, targets = [], placeholderList, limits, isOptional })
  → { commit, placeholderList, skipped: false } | { skipped: true, reason }
```

严格按 M4/M6 B3.1 的七步与 B3.5「每次快照对占位路径的处理」实现，**顺序不能变**：

1. 引用 `refs/meldwork/effects/<encodeId(effectId)>` 已存在：直接返回它。
2. **先**确定候选路径（上次的 `placeholderList` ∪ `git status --porcelain=v2 -z --untracked-files=all` 的结果），**在对索引做任何改写之前**。
3. 对候选路径 `lstat` 并按 B3.5 的表归类；目标文件或回应文件超限 → 抛出 `SHADOW_TARGET_TOO_LARGE`（附文件）。
4. 需要占位的路径 `git rm --cached -q --ignore-unmatch --`；按本次的占位集合**整体重写**排除规则的自动段。
5. `git add -A`；对存在的目标与回应文件 `git add -f --`。
6. 为归为「占位」的路径写入占位条目（`hash-object -w --stdin` + `update-index --add --cacheinfo`）。
7. `write-tree` → `commit-tree` → `update-ref`。

- 占位哈希的重算按 B3.5「占位哈希何时重算」：比较设备号、inode、大小、修改时间、ctime 与记录时刻，以及 2 秒的 racy 窗口。
- LFS 判定用**用户仓库**的 `git -C <workTree> check-attr -z --stdin filter`（不经过 `ShadowRepo.git()`，因为要用用户仓库的属性；同样不经过 shell）。工作目录不在 git 仓库里时跳过。
- 上限（B3.4）：超过用时或文件数上限时，`isOptional` 为真（调用前后的快照）返回 `{ skipped: true }`；否则抛出 `SHADOW_SNAPSHOT_LIMIT`。**绝不**在非可选的快照上返回 `skipped`。

测试 `desktop/test/project-room/shadow-git-snapshot.test.cjs`（M4/M6 D「快照」「原始字节」「占位」「候选路径的顺序」）：

- 被 `.gitignore` 忽略的目标文件进入快照；目标与回应文件都不存在时快照成功。
- 被强制加入过的目标文件删除后，快照记录删除。
- 同一 `effectId` 重复执行返回同一提交。
- 原始字节：`*.txt text eol=lf` 下 CRLF 原样保存；改为 LF 后 `diff --quiet` 报告差异；可执行位变化被检测到。
- 占位：已跟踪文件变大超过上限后快照中是占位，对象库中没有这个大小的对象；删除、缩小、换成符号链接三种时序；`utimes` 恢复修改时间后由 ctime 触发重算。
- 候选路径的顺序：写一个测试，把「移出旧占位路径」放到 `git status` 之前（用一个测试开关），断言被删除的占位文件**没有**表现为删除，以证明顺序的必要性；正确顺序下断言表现为删除。
- 超限：可选快照返回 `skipped`；非可选快照抛出。

### 任务 3.4 比较与核对

```
async diffQuiet(commitA, commitB, paths)        → boolean（true 表示无差异）
async nameStatus(commitA, commitB, paths?)      → Array<{ status, path }>
async verifyAgainst({ effectId, commit, paths, placeholderList, limits })
     → { intact, differing }     先 snapshot（非可选），再比较两个提交（M4/M6 B3.3）
async driftCheck({ effectId, acceptedByPath, placeholderList, limits })
     → { snapshotCommit, drifted: [path] }
```

测试：`verifyAgainst` 的快照超限时抛出，不返回 `intact: true`（失败闭合）。

### 任务 3.5 接受提交与漂移确认

```
async acceptCommit({ effectId, candidate, recordPaths, parent, message })   → commit     M4/M6 B4：临时索引，从候选构造，叠加记录文件
async driftAcceptCommit({ effectId, base, observed, paths, parent, message }) → commit   M4/M6 B5「以工作目录为准」
```

- 临时索引文件名 `accept-<encodeId(effectId)>.index`，放在 `gitDir` 下，完成后删除（失败也要删除）。
- 测试：工作目录中的目标文件在候选之后被改动，断言接受提交中的目标文件等于候选；记录文件取当前内容；不存在的记录文件被跳过；重复执行返回同一提交。

### 任务 3.6 恢复文件

```
async restoreFiles({ commit, paths, isCancelled })   → { restored: [path], stoppedAt?: path }
```

按 M4/M6 B5 的六步：每个文件写临时文件、`fsync`、检查取消、改名；可执行位；已接受版本中不存在的文件即删除；链接重建；占位路径不在恢复范围内（调用方不应传入，传入时抛出 `SHADOW_PLACEHOLDER_NOT_RESTORABLE`）。

测试：在改名前后注入取消，断言不出现写了一半的文件；新增文件被删除；可执行位与链接被恢复。

### 任务 3.7 diff 数据

```
async numstat(a, b, paths?)        → Array<{ path, added, removed, binary }>
async fileDiff(a, b, path, { maxBytes = 2 * 1024 * 1024 })   → { text, truncated }   b 可以为 null 表示工作目录
```

### 任务 3.8 用户仓库提交

新文件 `desktop/src/project-room/user-git.cjs`（**不**经过 `ShadowRepo`，使用用户自己的 git 环境，但同样 `execFile`、不经过 shell、`GIT_TERMINAL_PROMPT=0`）。

```
async userRepoPreflight({ workTree, paths, acceptedEntries }) → { ok, reasons: [{ path, reason }] }
async userRepoCommit({ workTree, paths, acceptedEntries, message, decisionId, onStaged })
    → { committed: true, commit } | { committed: false, reasons } | 抛出（提交失败，已按规则恢复索引）
async userRepoCheckTrailer({ workTree, decisionId }) → boolean
```

严格按 M4/M6 B7 的五步。`acceptedEntries` 是每个路径在已接受版本中的状态（存在性、类型、模式、内容的 SHA-256 或链接目标）。`onStaged(stagedEntries)` 在 `git add` 之后、`git commit` 之前调用，由调用方把「已暂存」与条目落盘（M2 第 10 节）；本里程碑的测试中用一个记录调用的函数代替。

测试（M4/M6 D「用户仓库提交」）：用户已暂存其他文件时它们仍然暂存且不在提交里；本次路径有用户暂存时跳过且索引不变；被忽略的目标文件提交成功（`-f`）；只改可执行位时前置条件不满足；普通文件换成同内容的符号链接时前置条件不满足；钩子拒绝时只恢复本次暂存的路径；工作目录是仓库子目录时路径换算正确；SHA-256 对象格式的仓库（`git init --object-format=sha256`）中前置条件比较正确；尾注可以读出。

### 任务 3.9 回收与故障

```
async dropRefs(refNames)
async collectIfNeeded({ looseObjectThreshold = 5000 })   M4/M6 B8
async repairIndexIfCorrupt()                              M4/M6 B9：删除长期索引，下一次快照重建
```

### 任务 3.10 路径状态描述

新文件 `desktop/src/project-room/path-change.cjs`，纯函数：

```
pathStateFromEntry(entry)                    → { kind: 'absent' | 'file' | 'placeholder' | 'link', mode?, size?, sha256?, target? }
describePathChange(oldState, newState)       → { change, details, diffAvailable }   M4/M6 B3.5 的输出表
driftOptions(acceptedState)                  → { workdir: true, accepted: boolean, reason? }   B3.5「漂移的可选操作」表
```

测试：对 B3.5 两张表的每一种组合各一个用例。

### 任务 3.11 不碰用户仓库的总测试

`desktop/test/project-room/shadow-git-user-repo-untouched.test.cjs`：在一个真实的用户仓库（含钩子、自定义配置、暂存区内容）上依次运行 3.3–3.7、3.9 的全部操作，断言用户仓库的 `.git` 目录前后逐字节相同：比较目录下所有文件的内容哈希，**包括** `.git/index`，不排除任何文件。用户仓库提交（3.8）不在这个测试里运行，它有自己的测试。

## 验收

**本里程碑运行的测试**：任务 3.2–3.11 的全部测试；`npm --prefix desktop test` 全部通过。

**推迟到里程碑 5 的测试**：副作用以真实引擎调用这些函数的集成测试（幂等重放、崩溃后重放、纪元作废）。

**性能**：在里程碑 0 选定的三个真实仓库的副本上运行快照，用时在里程碑 0 确定的上限之内；结果写进汇报。

需求追踪：R10、R11、R12、R25。

## 停下来问的情况（除交接手册第 5 节之外）

- 任务 3.11 发现用户仓库的任何文件被改动。
- 某个必需的 git 子命令或参数在 2.32 中不可用。
