# 交接手册：给实施项目室的执行者

本文写给按 `docs/implementation-plan.md` 实施项目室的执行者（以下称「你」）。每次开始一个里程碑之前，先完整读一遍本文，再读该里程碑的任务单 `docs/tasks/milestone-<N>.md`。

设计已经由多轮评审定下来了。你的工作是**按设计实现并证明它成立**，而不是重新设计。遇到设计没有覆盖、或者与代码现状矛盾的地方，按第 5 节停下来问，不要自己想一个办法补上。

## 1. 先读什么

按顺序：

1. `AGENTS.md`：仓库的开发规则。本文只补充，不替代它。
2. 本文。
3. 当前里程碑的任务单 `docs/tasks/milestone-<N>.md`。
4. 任务单「必读」一栏列出的模块文档章节。只读列出的章节即可；需要时再查别的章节。

文档的分工：

| 文档 | 回答什么 |
| --- | --- |
| `docs/product-target.md` | 要什么（需求，R1–R30） |
| `docs/functional-architecture.md` | 由哪些模块组成，关键决定（A1–A14），改哪些现有边界 |
| `docs/modules/*.md` | 每个模块的详细设计、数据结构、规则、测试要求。**实现以它们为准** |
| `docs/implementation-plan.md` | 里程碑顺序、依赖、验收方式 |
| `docs/tasks/milestone-<N>.md` | 一个里程碑的具体任务：改哪些文件、写哪些函数、写哪些测试 |
| `docs/error-codes.md` | 全部错误码：含义、由谁返回、界面提示 |
| `docs/playbook-content.md` | 默认 playbook、角色侧写、平台立场提示词的产品内容（里程碑 8 原样放进代码） |
| `docs/reviews/architecture-v5/` | 历次评审与回应。想知道「为什么这样设计」时查这里，不需要通读 |

模块文档之间如果互相矛盾，以**版本较新、且明确写了「随某某同步」的那一处**为准，并在汇报里指出矛盾。

## 2. 仓库的约定

### 2.1 代码

- 桌面端（`desktop/src/`）是 CommonJS，文件扩展名 `.cjs`，用 `require` / `module.exports`。不要写 ES module，不要引入 TypeScript。
- 前端（`frontend/src/`）是 Vue 3 + Vite，状态放在 `frontend/src/composables/` 的 composable 里。
- 输入校验用 zod（`desktop/package.json` 中的 4.4.3），写法参照 `desktop/src/shell/delivery-ipc.cjs`：`z.strictObject`，校验失败抛出带 `code` 的错误。
- 错误统一为 `Object.assign(new Error(CODE), { code: CODE })`，`CODE` 是大写下划线常量，例如 `PROJECT_GATE_STALE`。**只使用 `docs/error-codes.md` 中列出的错误码**；需要新的错误码时，先停下来问（第 5 节），不要自己起名。
- 私有文件只用 `desktop/src/security/private-file.cjs` 的 `atomicWritePrivateFile` 写入，不要自己写 `fs.writeFileSync` 再改名。
- 调用外部程序（git、ps、pgrep）只用 `execFile` / `spawn` 加参数数组，**永远不经过 shell**，不拼接命令字符串。
- 不新增第三方依赖，除非任务单明确写了。需要新依赖时停下来问。

### 2.2 安全边界（违反任何一条都是阻塞问题）

- Agent 的执行与一切文件、进程、git 操作都在 Electron main 进程。renderer 只能通过 `desktop/src/preload.cjs` 暴露的方法访问 main。
- 新的 IPC 方法一律用 `registerTrustedHandle` 注册（`desktop/src/main.cjs:244`），输入一律用 zod 校验。
- renderer 永远不向 main 提交文件系统路径（M1/M5 8.1）。
- 不把可执行文件路径、会话号、令牌、凭据、提示词、完整命令行送进 renderer（M1/M5 7.2）。
- 写入用户自己的 git 仓库只在 M4/M6 B7 规定的一个入口发生；影子仓库的 git 调用只在 `shadow-git.cjs` 中发生。

### 2.3 测试

- 桌面端：`node --test`，测试文件以 `.test.cjs` 结尾，放在 `desktop/test/<目录>/` 下，风格参照 `desktop/test/runs/run-scheduler.test.cjs`（`require('node:test')`、`require('node:assert/strict')`）。
  - `npm --prefix desktop test` 运行 `desktop/test/` 下的**全部** `*.test.cjs`（`desktop/scripts/test-discovery.cjs`）。
  - 新建的测试目录（例如 `desktop/test/project-room/`）要在 `desktop/scripts/test-discovery.cjs` 的 `TEST_SUITES` 中加入一个套件，否则它只会在 `all` 中运行。
  - **实测、原型代码不要放在 `desktop/test/` 下**，否则会混进常规测试。放在 `desktop/spikes/`，手动运行。
- 前端：vitest，测试文件只能放在 `frontend/src/__tests__/meldwork/` 这一层（`frontend/package.json` 的 `test` 脚本只匹配 `*.spec.js`，不含子目录）。
- 涉及真实进程的测试（启动子进程、发信号）要在 `finally` 里结束它创建的所有进程，并断言没有残留；超时设置得足够短，避免挂起整个测试套件。
- 临时文件与目录用 `fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-'))`，测试结束删除。**不要在仓库根目录留下任何文件**（`AGENTS.md`）。

### 2.4 界面

- 所有用户可见的文字同时加到 `frontend/src/locales/zh.js` 与 `frontend/src/locales/en.js`。不要在组件里写死中文或英文。
- 新的弹层使用 `frontend/src/composables/useOverlayLifecycle.js`，支持 Escape 关闭并阻止背景滚动。
- 沿用现有的样式变量与组件风格，不做无关的重新设计。

### 2.5 验证命令

| 命令 | 何时运行 |
| --- | --- |
| `npm --prefix desktop test` | 每个任务完成后；每次汇报前 |
| `npm --prefix frontend test` | 改动前端后 |
| `npm --prefix frontend run build`、`npm --prefix frontend run build:desktop` | 改动前端后、每个里程碑验收前 |
| `npm --prefix desktop run pack` | 任务单要求时、里程碑 1 和 9 的验收前 |

**测试不通过就不能汇报完成。** 如果某个已有测试在你改动之前就失败，先在汇报里说明（附失败输出），不要修改或删除它来让套件通过。

## 3. 工作方式

1. **一次一个任务**。任务单里的任务按编号顺序做；每个任务做完，运行它列出的测试，通过后再做下一个。
2. **先测试，后实现**，在任务单这样要求的地方照做：先写失败的测试，再写代码让它通过。转移表、校验顺序、事件不变量这类规则密集的代码尤其如此。
3. **改动保持最小**。只改任务单列出的文件；需要改别的文件时，在汇报里说明原因。不要顺手重构相邻代码（`AGENTS.md`）。
4. **每个任务一个提交**，提交说明写：改了什么、为什么、运行了哪些检查（`AGENTS.md`）。不要提交生成的文件、构建产物、临时文件。
5. **不要改设计**。如果你认为设计有问题，照样按设计实现，并在汇报中写出你的理由；或者在必须改的情况下停下来问（第 5 节）。

## 4. 术语

| 术语 | 含义 | 定义在 |
| --- | --- | --- |
| 检查点、检查点实例 | 一个阶段性产物的循环：主笔 → 评审 → 关卡 | M2 |
| 主笔、评审、草稿席位 | 检查点中的角色 | 架构 M1 |
| 关卡（gate） | 等人决定的时刻；一个关卡只有一个原因 | M2 第 6 节 |
| 候选提交（candidate） | 主笔交回 `ready` 时的送审快照；评审与接受都绑定它 | M2 第 2 节、M4/M6 B3 |
| 影子仓库 | 应用私有区的 git 仓库，记录工作目录快照，不碰用户的 `.git` | M4/M6 B |
| 副作用、发件箱 | 转移函数返回的待执行动作，先落盘再执行 | M2 4.3、第 9 节 |
| 纪元（epoch） | 实例的执行代数；上游重开时加 1，过期的副作用不执行 | M2 5.3 |
| 写入作用域、路径声明 | 一组互斥的路径；调度器据此授予写入权 | M2 5.2、M4/M6 A2 |
| 租约申请的五种状态 | 等待中、已获批、待释放、已撤回、已释放 | M2 5.4 |
| 持有者类型 | `checkpoint-scope`、`project-maintenance`、`invocation` | M2 5.3、M4/M6 A3 |
| 对账 | 让调度器与落盘的租约记录一致 | M2 5.3 |
| 受管理进程、监护程序、钉子 | 可能写入的调用在一个进程组里运行，监护程序是组长 | 架构 A14、M3 第 3 节 |
| 可能写入的调用 | 权限为 `workspace-write` 或 `read-exec` 的调用 | M3 3.1 |
| 残留占用 | 崩溃后无法确认已结束的进程，按真实路径挡住写入 | M4/M6 A5、M3 3.7 |
| 未解决漂移 | 工作目录与已接受版本不一致、等人确认的条目 | M2 第 8 节 |
| 占位条目 | 超限文件与 LFS 文件在快照中只记录大小与哈希 | M4/M6 B3.5 |
| 投影 | main 给 renderer 的、去掉敏感内容的视图 | M1/M5 第 7 节 |

## 5. 什么时候必须停下来问

遇到以下任一情况，**停止当前任务**，按第 6 节的格式汇报，等人回复后再继续：

1. 模块文档的规定与现有代码的行为不一致，而任务单没有说明怎么处理。
2. 按设计实现后，某个已有测试失败，而且失败不是因为你的代码有错，而是因为设计改变了现有行为、任务单又没有提到这个改变。
3. 需要修改任务单没有列出的、属于其他模块的文件。
4. 需要新增第三方依赖。
5. 实测结果与模块文档的前提不符（主要在里程碑 0）。
6. 同一个测试连续三次尝试仍无法通过，且你不确定原因。
7. 你准备删除或放宽一条安全检查、一个测试断言、一处输入校验。

不要为了让流程继续而：注释掉测试、给断言加宽容条件、捕获错误后静默忽略、用 `setTimeout` 掩盖时序问题、把文档要求的「失败闭合」改成「继续执行」。

## 6. 汇报格式

每个任务完成、每次停下来问、以及里程碑完成时，都用下面的格式：

```
## 里程碑 <N> 任务 <编号>：<任务名>

状态：完成 / 停下来问 / 部分完成

改动的文件：
- <路径>：<做了什么>

新增或修改的测试：
- <测试文件>：<覆盖了哪些情况>

运行的命令与结果：
- npm --prefix desktop test：通过（<n> 个测试）/ 失败（附输出）
- ……

与设计的差异或疑问：
- 无 / <具体说明，引用文档章节>

没有完成的验证：
- 无 / <哪些没做，为什么>
```

里程碑完成时，另外附上任务单「验收」一节逐条的结果，以及人工检查清单的结果。

## 7. 常见错误

这些错误在设计评审中都出现过，实现时最容易犯：

- **把「写入报错」当成「没有发生」**。原子写入在改名之后仍可能报错（目录 `fsync` 失败），此时磁盘已经是新内容（M1/M5 6.1）。
- **在项目队列里阻塞等待**。队列里的操作都是短事务；需要等待的流程写成「状态 + 后续转移」（M1/M5 6.1）。
- **只看记录、不看调度器**。记录已落盘为「已释放」，不代表调度器已经释放（M2 5.3 对账）。
- **对单个进程 id 发信号**。没有钉子时，平台不自动结束任何进程（M3 3.4、3.7）。
- **在 fd 3 上用 `fs.createReadStream`**。必须用 `net.Socket({ fd: 3 })`，否则 `process.exit` 会挂起（M3 3.6）。
- **监护程序向 fd 1、2 写诊断**。fd 1、2 是 Agent 的输出通道（M3 3.3）。
- **用工作目录的当前内容做接受提交**。接受提交以候选提交为基础（M4/M6 B4）。
- **按字面比较路径**。路径声明要解析符号链接、处理大小写与 Unicode（M4/M6 A2.2）。
- **把纪元过期的租约通知也作废**。`release-scope`、`withdraw-lease`、`cancel-invocation` 永不作废（M2 5.3）。
- **对账时撤回群聊的租约**。对账只处理 `checkpoint-scope` 与 `project-maintenance`（M2 5.3）。
