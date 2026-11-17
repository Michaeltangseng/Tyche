# 团队项目室手动验收场景（2026-11-17）

> 目标：在真实 Electron 窗口里跑通新 room domain 的完整闭环。
>
> 这些场景对应提交 `0f7117d` 之后的代码。POC 仍是 YOLO：Claude 默认 `bypassPermissions`，Codex 默认 `danger-full-access`；Room 的“写入权限”开关目前是产品状态，不是执行租约。

## 0. 前置

1. 退出所有正在运行的 Meldwork / Electron 实例。  
   旧版本创建过的 Room 会在启动时自动修正被错挂的默认 Captain/Worker 提示词；自定义提示词不会被覆盖。
2. 启动源码版本：
   ```bash
   cd desktop
   ./node_modules/.bin/electron .
   # 或：npm run dev（会重新构建 native + frontend）
   ```
3. 确认侧栏里 Claude Code 和 Codex 都是可用状态。
4. 创建一个**空测试目录**，不要用仓库目录：
   ```bash
   mkdir -p ~/Desktop/meldwork-room-smoke
   ```
5. 需要看主进程日志时，用：
   ```bash
   ROOM_OAR_DEBUG=1 ./node_modules/.bin/electron .
   ```

## 场景 A：创建 Room、角色与基础对话

1. 侧栏点击团队项目室入口，再点击右上角 `+`（或侧栏“新建团队项目”）。
2. 填写名称：`Smoke Room`。
3. 选择目录：`~/Desktop/meldwork-room-smoke`。
4. 勾选 Agent：
   - 默认可能已勾选一个；先取消它。
   - **先勾 Claude Code，再勾 Codex**。第一个勾选的会成为 Captain。
5. 点击创建。

预期：

- 进入 Room，标题显示 `Smoke Room`。
- 右上角显示 `Claude Code`（带 Captain 徽章）和 `Codex` 两个角色 chip。
- 副标题显示目录名 `meldwork-room-smoke` 和“只读 / 已允许写入”状态。
- 右侧工作台为空或没有任务。
- 文件按钮（文件夹图标）可以打开，且不再出现 `SCHEDULER_CLAIM_ROOT_INVALID`。

6. 在输入框发送：
   ```text
   请介绍一下你在这个项目室里的职责，一句话即可。
   ```
7. 观察发送后：用户消息先显示“发送中”，随后变成“已完成”；Captain 回复开始流式输出。

预期：

- 回复文字逐步出现（live output）。
- 回复完成后，消息行有“执行轨迹 / Trace”，展开能看到 tool 卡片和 usage。
- 顶部出现 context usage chip（百分比或 token 数）。
- 工作台里出现 Captain review / assignment 记录（可能稍晚）。

## 场景 A2：在新 Chat 里换 Captain

1. 在同一个 Room 新建一个 Chat（会复制当前角色）。
2. 打开 Codex 角色设置，把它从 Captain 改掉；或直接打开 Claude 角色设置，勾选 Captain 并保存。
3. 保存后查看角色 chip 和角色提示词。

预期：

- 不需要“先降旧 Captain，再升新 Captain”两次保存；一次保存原子完成。
- 旧 Captain 自动降为 Worker，提示词变为 Worker 默认值；
- 新 Captain 提示词变为 Captain 默认值；
- 修改只影响当前 Chat，其他 Chat 的角色不变。

## 场景 B：完整任务闭环（主场景）

1. 新开一个 Chat，或继续当前 Chat。
2. 发送：
   ```text
   请安排 Codex 完成一个任务：
   标题：Room smoke 文档
   描述：在项目目录创建 docs/room-smoke.md，写入一行 "# Room smoke"。
   验收标准：docs/room-smoke.md 存在且包含 "# Room smoke"。
   要求 Codex 用 create_task 创建任务并执行，完成后用 finish_task 报告。
   ```

预期顺序：

1. Captain 回复并调用 `assign_in_group`，时间线出现 Captain 的可见授权消息。
2. Codex 被唤醒，开始工作；消息行显示执行中，Trace 里能看到工具调用。
3. 右侧 Work 面板出现任务 `#1 Room smoke 文档`：
   - 状态从 `待办 / 进行中` 变为 `待验收`；
   - Runs 里出现 executor run，状态 `completed`；
   - Reports 里出现 `Ready` 摘要。
4. 时间线出现 Report 卡（标题含 `#1 Room smoke 文档`，摘要、evidence、可能有 artifact id）。
5. Report 卡上有 **验收任务** 按钮。
6. Work 面板出现 **Captain 复盘**，时间线出现 Captain 的 review 回复。

3. 点击 Report 卡或任务卡上的 **验收任务**。

预期：

- 任务状态变为 `已完成`。
- 验收按钮消失。
- 消息、Report、Captain review 仍然保留，不刷新丢失。

4. 点击文件按钮，展开 `docs/room-smoke.md`。

预期：

- 文件存在，内容包含 `# Room smoke`。
- 只显示相对路径，不显示绝对路径。

## 场景 C：流式、Trace、Usage

1. 再发送一个会产生工具调用的任务，例如：
   ```text
   请让 Codex 列出当前项目目录下的文件，并报告结果。
   ```
2. 在 Codex 执行时观察：
   - 消息行实时文字；
   - Trace 中 tool 卡片从 `running` 变为 `completed`；
   - tool 的 input/output 可以展开；
   - 顶部 usage chip 更新。
3. 执行完成后展开历史 Trace。

预期：

- Trace 默认折叠，展开才请求/显示；
- host MCP 工具（assign_in_group/create_task/finish_task/post_in_chat/comment_task/mention/read_chat）只显示输入摘要，不显示内部 JSON 返回；
- 不出现可执行文件绝对路径、session ref、PID；
- 失败工具会显示 failed 状态（可以故意让它执行一个不存在的命令来验证）。

## 场景 D：写入权限开关

1. 点击顶部 Room 名称，打开项目设置。
2. 查看当前“写入权限”状态。
3. 点击开启/关闭。
4. 关闭设置，再重新打开项目设置。

预期：

- 开关状态保存并回显。
- 副标题同步显示“已允许写入 / 只读”。
- 注意：POC 下运行时仍按角色 native permission（YOLO）执行，这个开关尚未接入执行租约。

## 场景 E：多 Chat 与删除

1. 点击顶部 Chat 名称，打开 Chat 设置。
2. 新建 Chat：`Research`。
3. 切换回主 Chat，再切到 Research。

预期：

- 新 Chat 自动克隆主 Chat 的 Captain/Worker 角色。
- 两个 Chat 的消息、任务、trace 不串线。
- Research 的 Chat 设置里有删除按钮；主 Chat 没有。

4. 删除 Research。

预期：

- 回到主 Chat。
- 侧栏/标题中的 Research 消失。
- 主 Chat 不受影响。

## 场景 F（可选）：Mention lane

1. 在场景 B 的任务完成后，再创建一个 Codex Worker 角色（角色区 `+`）。
2. 让 Captain 授权这个新角色对任务 `#1` 调用 `comment_task`，例如：
   ```text
   请安排新 Worker 对任务 #1 添加一条评论，说明它检查了文档内容。
   ```
3. 观察 Work 面板的 Run。

预期：

- 新角色产生一条 mention lane run（评论 lane），不是 executor run。
- 评论不会把已经是 `已完成/待验收` 的任务重新推回 `进行中`。

## 失败排查

| 现象 | 检查 |
| --- | --- |
| 发消息后没有回复 | Agent 是否 ready；用 `ROOM_OAR_DEBUG=1` 看主进程日志；消息状态是否 queued/working |
| 回复报权限/工具错误 | 打开角色设置，确认 Claude = Bypass Permissions，Codex = Danger Full Access |
| 文件没有创建 | 测试目录是否可写；Codex 角色权限；文件抽屉里是否能看到目录 |
| 没有 captain review | assignment 可能还在 running；等 run 完成后看 Work 面板 |
| 没有 usage chip | provider 没有上报 usage，或刚启动尚未收到 usage 事件；展开 Trace 查看 |
| Attention 不出现 | 正常流程一般不会产生；硬崩恢复场景才容易出现 |

## 验收清单

- [ ] 创建 Room + 两个角色成功
- [ ] 消息发送、流式输出、Trace 展开正常
- [ ] Captain 授权 → Worker create_task → finish_task → Report → 验收 → done
- [ ] Captain review 出现在 Work 面板/时间线
- [ ] 文件抽屉可读，无绝对路径，无 `SCHEDULER_CLAIM_ROOT_INVALID`
- [ ] Chat 新建/切换/删除正常，角色被克隆
- [ ] 写入权限开关状态持久化
- [ ] 中英文界面切换无缺失 key
- [ ] 关闭/重启应用后 Room、Chat、Task、Report、Trace 仍在
