# 疑问: 这个项目的前后端 技术栈是什么
## 前后端都是 TypeScript，跑在 Bun 1.4.3 上。浏览器和主机之间只有一条 WebSocket（`/ws`），产品数据不走 REST。

**前端**在 `apps/web`。React 19，用 Vite 8 开发，生产构建后由主机直接提供静态页。路由是 TanStack Router，服务端状态用 TanStack Query，本地界面状态用 Zustand。样式是 Tailwind CSS 4，组件基于 Radix 和 shadcn。表单是 react-hook-form 加 Zod，文案是 i18next，输入框是 Lexical。

**后端**在 `apps/eta`，是一个 Bun 进程。功能做成 cordis 插件，产品数据放在 `~/.eta` 的 SQLite（`bun:sqlite`）里，会话记录是文件。模型订阅走它拉起的 CLIProxyAPI 子进程，网页搜索走 SearXNG 子进程。

记忆是可选的旁路服务 `apps/memory`：Python 3.13、uvicorn、mem0、fastembed，自己用带 pgvector 的 PostgreSQL。没有它，主机照常跑，界面上不出现记忆页。


# 疑问: 
1.captain 是怎么指派任务的?
2.多轮对话, 那么 agent 是使用同一个 session ,还是每次被指派任务时 都会新建独立 session

## Captain 不建任务。它在群里发一条看得见的指令，被点名的智能体自己建任务、自己执行。

**1. 指派怎么发生**

Captain 调用 `assign_in_group`：在已有群里写一条消息，并 @ 一个或多个成员。没点名时，这条消息交给群的主理人。消息留在群时间线上，同时记下这一轮指派。

被叫醒的智能体在群里回复，并自己调用 `create_task`。所以它既是任务的创建者，也是执行者。分阶段的工作会建成一棵任务树：每一阶段一个父任务，下面挂子任务，后一阶段用 `dependsOn` 等前一阶段做完。做完后，智能体调用 `finish_task`，任务进入待验收，同一段总结会发回原来的群。

**2. Session 何时新建、何时沿用**

群里的多轮对话用同一个 session。每个智能体在每个群里只有一个 session，第一次被叫醒时创建，之后一直沿用。下一次被指派时，它只收到上次看过之后的新消息，不会重读整段群聊。

任务执行是另一条 session，和群聊分开。一个任务第一次跑时新建，session 键是 `task:<任务 id>`。它看不到群聊记录，开头只有任务标题、说明和验收标准。同一任务上的评论和后续执行都回到这个 session。你手动点「重跑」，或者这是另一个新任务，才会再开一个不记得上次的 session。


# 我测试需求:
```
@Captain 你来讲个程序员笑话
@claude 你来评审幽默程度
@codex 你来分析 claude 说的对不对
```

疑问:
1.我测试发现: 提出需求时, 多个 agent 似乎同时并发响应, 而不是由 Captain 来主控 workflow, 比如 Captain 指派 claude ,claude 完成后再由 Captain 指派 codex .代码里这一块的底层机制是什么?
2.上下文是如何共享的? 文件/工作区 是如何共享的? Captain 说完笑话之后, 这个笑话是如何给其他 agent ?


##  你这条消息同时点了三个人，所以三个人一起开工。Captain 不会因为被 @ 了就变成调度者，也不会等前一个说完再叫下一个。

**1. 为什么是并发**

用户消息里的每个 @ 都会叫醒对应成员。`routeUserMessage` 把这条消息里点到的成员全部列为目标，然后为每个人各排一条回复。不同智能体的队列互不相等，三条回复同时开始。同一个智能体在同一个群里仍然串行，一次只答一件事。

Captain 主控是另一条路，而且要它自己走。只 @ Captain，让它讲完笑话后调用 `mention` 去叫下一个人。`mention` 写在它正在进行的回复里，工具说明写明它不等对方答完。一次用户发言里，智能体互相叫醒最多 5 次。Claude 答完后，没有人会自动再叫醒 Captain 或 Codex。下一步要么 Claude 自己 `mention` Codex，要么你再发一条消息。

**2. 笑话和目录怎么到别人手里**

三个人各有各的 session，会话记忆不合并。共享的是群时间线，外加同一个项目目录。

每次被叫醒时，简报只带两样东西：上次看过之后、已经写完的发言（谁说的、说了什么，单条最多 2000 字），以及这条叫醒它的消息。还在写的回复不算数。你这条消息把三个人同时叫醒时，Captain 的笑话还在生成，Claude 和 Codex 的简报里只有你的原文，没有笑话。

笑话要到别人手里，得等 Captain 这轮回复结束，或者 Captain 把笑话写进 `mention` 的消息正文。`mention` 发生时 Captain 自己的回复仍是进行中，对方读到的是这条 mention，不是尚未写完的回复。

工作区是群绑定的那个目录，三个人的 cwd 都是它，读写的是同一批文件。没有人把笑话自动写成文件。谁要留给别人，就写进时间线，或自己存进这个目录。


# 我想测试需求, Captain / Claude / Codex 都要参与
## 只 @ Captain。Claude 和 Codex 由上一环用 `mention` 叫醒，这样三个人是串行的。

```text
@Captain 讲一个程序员笑话。
讲完后用 mention 叫醒 Claude，让它给这个笑话的幽默程度打分（1 到 10 分，并说明理由）。
mention 的正文里必须写上笑话原文。

在叫 Claude 的 mention 里同时写明：Claude 打完分后，用 mention 叫醒 Codex，让 Codex 判断这个分数公不公平。
Claude 的 mention 正文里必须写上笑话原文和它的分数、理由。

不要在这条消息里 @ Claude 或 Codex，也不要一次叫醒两个人。
```

Codex 读到的是 Claude 写进 mention 的那段话，里面要有笑话和评分。Captain 和 Claude 自己还没写完的回复，下一环看不到。



# 疑问: 
1.信息传递: 目前是通过 叫醒 + 简报. 简报会重写上次的总结. 这会不会造成 token 的二次浪费? 因为传递的不是原文, 而是用简报来重写总结
2. session管理: 是用 sqlite 台账来持久化缓存吗?
3.我看见每个agent至少发言了两次: 完成任务 + 叫醒下一个. 比如 Captain :
发言1: **笑话讲完了，只叫醒了 Claude。Codex 等 Claude 打完分再由它叫醒。**
发言2: **给这个笑话的幽默程度打个分：1 到 10，并说明理由。笑话原文如下：

一个程序员去面试，面试官问：「你最大的缺点是什么？」 他说：「我不太诚实。」 面试官说：「这不算什么大缺点。」 他说：「那我再告诉你，我精通十门编程语言。」

打完分后，用 mention 叫醒 Codex，让 Codex 判断这个分数公不公平。你给 Codex 的 mention 正文里必须写上笑话原文，以及你的分数和理由。不要在这次回复里同时叫醒 Codex。**


## 你看到的两段话是同一次回复里的两行记录。简报不会把上一轮重写成总结，session 的正文也不在 SQLite 里。

**1. 简报不是重写**

简报把这个智能体还没看过、而且已经写完的发言按原文摘进去：谁说的、说了什么。自己的发言会跳过，还在写的回复会跳过。每条最多 2000 字，最多 100 条。看过的位置记在 `participant.last_seq`，下次叫醒不会把同一批再摘一遍。已经摘进去的内容留在这个 session 里，直到上下文太长才压缩。

压缩是另一件事。session 变长之后，另一次模型调用把旧记录收成笔记，之后模型只看笔记和最近一段。那一次会多花 token，换的是后面不再发送整段旧记录。交接本身不走这一步。

笑话会出现两份，是因为 `mention` 必须自带正文。Captain 回复还在写的时候，Claude 读不到那段回复，所以笑话要写进 mention。Captain 的 session 里有这段工具参数，Claude 的 session 里有这段 mention。这是同一段原文的拷贝，不是又总结了一遍。

**2. SQLite 是台账，session 是文件**

`~/.eta/eta.sqlite` 记群、时间线、每个成员的 `session_id` 和 `last_seq`。模型上下文在 `~/.eta/sessions/<session id>/`：`meta.json` 是工作目录和模型，`journal.jsonl` 是追加写入的会话记录。重启后用 SQLite 里的指针找回这些文件。

**3. Captain 那两段是一行回复、一条 mention**

第一段是它在群里说的话：「笑话讲完了，只叫醒了 Claude。」第二段是 `mention` 工具写上时间线的正文，也就是叫醒 Claude 时交给它的那条消息。模型只跑了一轮，工具调用把第二段单独记成一行。Claude 读到的是第二段，所以笑话和后续指令都在里面。


# 1.这个项目由考虑到单个 agent 的上下文自动压缩吗?
2.我看到 claude 在第一次发言(给笑话打分): 调用了多次工具, 正常吗? @claude-chat.png 

## 单个内置 session 会自动压缩。截图里这一轮连着调工具，是这个 Claude 自己选的，打分并不需要搜仓库。

**1. 自动压缩**

内置 runtime 的每个智能体各有一个 session。每次回复开始前，host 会看上下文有没有越过门槛：模型窗口减去 16384，和 64000 里取较小的那个。越过之后，另一次模型调用把更早的记录收成笔记，最近大约 20000 token 原样保留。笔记写进 `journal.jsonl`，下一次请求用笔记代替被收掉的那段。

截图里的 Claude 走的是外部 runtime（有 `ToolSearch`、`Bash`、`mcp_eta_*`）。这种 session 不装 eta 的压缩，上下文由 Claude Code 自己管。

**2. 这轮工具调用**

打分本身不需要这些命令。host 只把工具交给它，调用是模型决定的。

其中两步符合提示：`ToolSearch` 是在按需加载 MCP 工具 `mention` 和 `conversation_info`；`conversation_info` 是提示要求它先看这个群里有谁。后面那一串 `cd` 到 eta 仓库再 `grep`，是它把工作目录当成了要查的代码。有一条 `cat tmp/...` 失败了，因为那个文件不存在。

「Now my reply text…」「this is chat work, no task」是它写在步骤记录里的计划，然后才发出「我给这个笑话打 7 / 10 分」。一轮里先调工具、再给正文，这个顺序正常；为了一个笑话去翻仓库，是这轮做得过头了。
