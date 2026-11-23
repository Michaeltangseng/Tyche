# 12 Skill 信息模型、原生隔离与评审回应

状态：历史评审记录，2026-11-23。其中信任、分发和原生导入的方案已被产品决定取代；当前模型见 [13 Skill catalog](13-skill-catalog.md)。

修订记录：
- 2026-11-23 二轮评审后修订——补充隔离配置的持久化与 session rotation；区分代码事实与截图观察；修正"必须分发"和"信任即可用"的表述；将 Captain 权限提升为发布前阻塞项；补充真实运行时验收项。
- 2026-11-23 三轮评审后修订——补数据库迁移与 API 变更、拆分 `skillAvailable` 与 `providerLaunchable`、增加发布门禁和 chat/task 调用链；按产品决定移除角色技能数量上限。

关联文档：

- `AGENTS.md`：仓库工作规则和安全边界。
- `architecture.md`：Room / Chat / Role / Task 总架构。
- `docs/10-skill-management.md`：Skill 机制设计。
- `docs/11-skill-implementation-handoff.md`：当前实现状态与已知限制。

本文回应两轮外部评审意见（针对 Settings › Skills 页面与角色配置弹窗），并给出：

1. 在代码里核实过的技术事实；
2. 哪些评审意见可以直接采纳，哪些需要按 Tyche 的边界修正；
3. 分期建议和需要产品拍板的问题。

---

## 0. 摘要

- 评审提出的三层模型（库 → 可用清单 → 装配）与现有实现一致，并应扩展为四段链路：Library → Availability → Distribution → Loadout。Distribution 是显式写文件，不是可用性的必要条件。
- "原生 Skill 仍会被 Agent 自己加载，角色技能清单只是表面约束"——属实。Room 打开会话时没有做任何 Skill 隔离（`desktop/src/room/runtime-adapter.cjs:239-245`）。
- 平台不再限制一个角色能带多少个 Skill。原有的 `MAX_ROLE_SKILLS = 8` 已从 IPC、repository、skill-library、legacy inventory 和前端移除；数量属于角色配置 / UI 交互的决定，底层不截断、不拒绝。
- 隔离在技术上可行：OAR 0.113.0 提供 `SessionOptions.userConfiguration: "include" | "exclude"`。当前**已验证 Claude 支持**；Codex 及其他多数运行时明确拒绝；Pi 未声明拒绝但尚未实测。
- 评审建议的"可用清单自动生成、设置里只处理例外"不能直接套用：Tyche 的分发开关对 shared / market Skill 是真实写文件（projection），不是纯配置。
- 代码事实：Hermes 和 Gemini 不在 OAR 默认运行时注册表中，按当前接线不能作为 Room 成员。截图观察：矩阵中只有 Hermes 列出现原生开关，推断这 96 个原生 Skill 来自 Hermes。它们进入协作流程需要"导入共享库并信任"；分发只在需要原生加载时可选，不是前置条件。
- 发布前阻塞项：Captain 通过 `create_roles` 创建的角色会被赋予该 provider 的最大权限（Claude → `bypassPermissions`，Codex → `danger-full-access`），见 `desktop/src/room/tools/captain.cjs:5-9, 154`；而 `write_authorized` 尚未接入 execution lease（`architecture.md:45`）。

---

## 1. 背景

两轮评审的原始判断：

- 第一轮针对 Settings › Skills 截图：矩阵几乎全空、来源未标清、信任列无区分度、冲突被埋没、详情面板顺序诱导盲目信任、原生与分发的语义混在一张表里。
- 第二轮针对角色配置弹窗截图：提出三层模型，并指出如果原生 Skill 仍被加载，"选择性装配"就没有约束力；同时建议可用清单自动生成、装配能力开放给 Captain。

本文不重复视觉细节，只核对两项内容：**信息模型是否成立**，以及**原生隔离能不能落地**。

---

## 2. 已验证事实

### 2.1 Room 会话启动没有 Skill 隔离

`desktop/src/room/runtime-adapter.cjs:237-245`：

```js
async function openSession({ provider, cwd, resume, mcpServer, appendSystemPrompt, runId }) {
  const options = {
    cwd,
    ...(resume ? { resume } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    mcpServers: mcpServer ? [mcpServer] : [],
    env: sessionEnv,
  }
  ...
}
```

没有覆盖 HOME / 配置目录，也没有关闭用户级配置。因此：

- 各 CLI 启动时会按自身规则扫描 `~/.claude/skills`、`~/.codex/skills` 等目录；
- 角色装配（prompt 注入或 native 投递）只是在 Agent 原有加载之上追加内容；
- 角色技能清单是 Tyche 侧的装配表达，不是运行时约束；平台也不限制清单长度（见 §3.7）。

结论：评审的核心质疑成立。

### 2.2 OAR 提供隔离能力，但支持面很窄

OAR（`@botiverse/oar` 0.113.0）的会话选项里已有：

```ts
// desktop/node_modules/@botiverse/oar/dist/contracts/session-options.d.ts:179
readonly userConfiguration?: "include" | "exclude";
```

语义（同文件注释）：`exclude` 跳过用户级 plugins、skills、commands、agents、MCP servers、hooks、memory 和 settings，同时保留原生登录、原生会话历史和 host 传入的 session options。

各运行时的支持情况（读各 runtime 的 `refusedSessionOptions`）。当前**已验证 Claude 支持**；Pi 尚未验证：

| 运行时 | `userConfiguration: "exclude"` | 说明 |
| --- | --- | --- |
| Claude | ✅ 支持（已验证） | — |
| Codex | ❌ 拒绝 | 隔离 home 会把临时历史路径写进共享索引，破坏 resume |
| dsh / kimi / opencode / qwen / antigravity / devin / codebuddy / grok / factory / qoder / pi-durable | ❌ 拒绝 | 无法在保留登录和历史的前提下安全分离用户配置 |
| Pi | 未验证 | 未声明拒绝，但尚未实测 |
| cursor | 不在默认注册表 | 需要宿主自装 SDK |

需要注意的副作用：

- `exclude` 不只去掉 skills，还会去掉用户 MCP、权限设置、hooks、memory；
- 项目级配置仍会加载（工作区里的 `.claude/skills` 等），隔离不等于"清零"；
- 在 Claude 上这是可用的"干净房间"，在 Codex 上做不到，UI 必须明说。

### 2.3 "可用"的判定绑定来源 Agent 与信任

`desktop/src/skills/skill-library.cjs:324-328`：

```js
record.available = record.trust !== 'trusted'
  ? []
  : record.kind === 'native'
    ? (record.nativeEligible.includes(record.originKind) ? [record.originKind] : [])
    : [...AGENT_KINDS]
```

- 原生 Skill 只对来源 Agent 可用，且需要先信任、再打开 eligibility；
- shared / market Skill 对全部 Agent 可用（只要信任）；是否还能作为 Room 成员装配，取决于该 Agent 能否启动；
- `materialize` 再次校验 trust 与 available，并决定 `delivery: native | prompt`（`skill-library.cjs:691-711`）。

因此角色弹窗出现"这个 Agent 还没有可选用的 Skill"时，通常不是 UI bug，而是：该 Agent 没有原生 Skill、共享库为空，且原生 Skill 属于别的 Agent。

### 2.4 Hermes / Gemini 不在 Room 可启动注册表

**代码事实。** OAR 默认运行时（`desktop/node_modules/@botiverse/oar/dist/index.js:41-55`）：

```text
antigravity, claude, codex, codebuddy, devin, dsh, factory,
grok, kimi, opencode, pi, qwen, qoder
```

`hasLauncher(provider)` 基于这份列表（`runtime-adapter.cjs:636-643`）；不在列表中的 provider 无法启动，`create_roles` 会拒绝。`desktop/src` 里没有找到额外的 runtime 注册。

**截图观察。** 矩阵中只有 Hermes 列出现原生开关；原生行只在来源 Agent 列可见（`SkillsPage.vue:278-282`），因此推断截图中的 96 个原生 Skill 来自 Hermes。这是从 UI 状态得出的观察，不是扫描数据的持久化事实；数据变化后该推断可能失效。

把两者结合，可以得到的结论：

1. 若这些 Skill 确实属于 Hermes，它们在 Room 里不能作为 Hermes 角色装配，因为 Hermes 不能作为 Room 成员；Gemini 同理。
2. 它们进入协作流程需要先**导入共享库并信任**。共享/市场 Skill 只要可信且兼容，就可以通过 prompt delivery 供 Claude / Codex 使用；分发到原生目录是可选的，只在需要原生加载时执行。
3. 角色弹窗对 Claude 为空，是 2.3 与本节共同造成的，不是单纯缺少引导：共享库为空，而原生 Skill 只对来源 Agent 可用。

### 2.5 Captain 派生角色的权限上限

`desktop/src/room/tools/captain.cjs:5-9`：

```js
function maxNativePermission(provider) {
  if (provider === 'claude') return 'bypassPermissions'
  if (provider === 'codex') return 'danger-full-access'
  return 'default'
}
```

`createRoles` 用它给新角色赋值（`captain.cjs:154`）。也就是说，Captain（一个 Agent）可以通过 `create_roles` 自主创建拥有最高原生权限的成员。这比角色弹窗的视觉问题更值得单独立项：需要确认是否与 Room 的写入授权、`write_authorized` 和用户确认流程冲突。

### 2.6 评审未掌握、但已经实现的能力

- `create_roles` 已支持 `skills` 参数，Captain 从 briefing inventory 选择，平台用 `assertSelectable` 校验（`captain.cjs:155, 221-234`）。
- Skill 变化已通过 `{id, contentHash, delivery}` binding 触发 session 轮换（`engine.cjs` / `runtime-adapter.cjs`）。
- 信任按内容哈希共享；`approvedHashes` 已保存 preview、fileManifest 和 risk，具备重新授权 diff 的数据基础。
- 投影状态在读取时重新计算，不信任存储（`skill-projections.cjs`）。

### 2.7 "可用"与"能启动"是两件事

`SkillLibrary` 的 `available` 只回答"Skill 是否可信、是否兼容这个 Agent"，它按 `AGENT_KINDS` 覆盖全部 11 种 Agent（`skill-library.cjs:324-328`）。Room 能否真正让这个 Agent 说话，由 OAR launcher 决定（`runtime-adapter.cjs:636-643`）。两者目前没有在同一个 DTO 里合并。

后果：

- 设置页或角色选择器可能把 shared Skill 标成对 Hermes "可用"，但 Hermes 不能成为 Room 成员；
- Captain inventory 已经先按 speakable providers 过滤（`engine.cjs:195-199`），但人工角色编辑器拿到的 `teamRoom.skillInventory` 是 `SkillLibrary.list()` 原样返回（`room-host.cjs:944-946`），没有 launchable 标记；
- 最终可能在创建或更新角色时才因 provider 不可启动而失败。

建议拆成两个状态并在 DTO 中同时给出：

| 状态 | 含义 | 来源 |
| --- | --- | --- |
| `skillAvailable[agent]` | 可信、兼容、具备 delivery 能力 | `SkillLibrary` |
| `providerLaunchable[agent]` | OAR 注册表里有该 provider，可作为 Room 成员 | `runtimeAdapter.launchProviderIds()` |

UI 只在两者同时为真时显示"可在聊天中使用"；否则显示"可用但无法在本 Room 启动"。`create_roles` 保留 `canLaunch` 校验作为最后一道防线。

---

## 3. 信息模型修正

### 3.1 四段链路

保留评审提出的三层，并补上 Distribution：

```text
Library → Availability → Distribution → Loadout
```

| 层 | 含义 | Tyche 中的载体 |
| --- | --- | --- |
| Library（库） | 平台托管的 Skill 内容 | 共享库目录 + `skill-library.json` |
| Availability（可用） | 某 Agent 在本平台内能用到哪些 Skill | trust + 兼容性 + delivery 能力（native / prompt） |
| Distribution（分发） | 把 Skill 写入某 Agent 的原生目录 | projection（copy / symlink / nativeOrigin） |
| Loadout（装配） | 一个角色实际带上的 Skill（数量不设平台上限） | `role.skills` |

关键关系：**Distribution 不是 Availability 的必要条件**。共享 / 市场 Skill 只要可信且兼容，就可以通过 prompt delivery 参与角色装配；分发只决定是否改用原生加载。原生 Skill 则需要先导入共享库，才能跨 Agent 可用。

### 3.2 为什么"可用清单自动生成"不能直接套用

评审建议：兼容性由平台判断，信任一次全 Agent 通用，默认规则为"已信任 + 兼容 = 可用"，设置页只处理例外。

这个规则对**角色选择器**成立，对**分发动作**不成立：

- shared / market Skill 的矩阵开关会真实复制或链接文件到 `<agent skill root>/<name>`；
- 自动打开等于向各 Agent 目录写入大量副本，违反"写入必须显式"的现有边界（`docs/10-skill-management.md` §7）；
- 原生 Skill 的开关只影响 Tyche eligibility，不写文件，但语义容易与分发混淆。

建议的拆分：

- **可用性自动**：角色选择器直接展示"已信任 + 兼容 + 具备 delivery 能力"的 Skill，不需要用户先手工维护清单；
- **分发显式**：设置页保留分发开关，但单元格改成状态化展示，明确区分"已分发"（写入了文件）和"可用"（只是 Tyche 侧候选）；
- **分发不是装配前提**：未分发的 shared / market Skill 仍可通过 prompt delivery 被角色使用；原生 Skill 跨 Agent 使用的路径是导入共享库，而不是必须分发。

### 3.3 信任的实际语义

需要在 UI 上直说：

| 信任管什么 | 信任不管什么 |
| --- | --- |
| 能否分发到其他 Agent | Agent 自己加载来源目录中的原生 Skill |
| 能否被角色选择 / 注入 | 原生 Skill 在原生 CLI 会话中的执行 |
| 能否进入 Captain inventory | 运行时的网络、shell、文件访问 |

因此"未信任"不等于"这个 Skill 不存在或不能运行"，只等于"Tyche 不会把它带进协作流程"。

### 3.4 矩阵状态化

建议单元格从"开关 + —"改为明确状态：

| 状态 | 条件 | 表现 |
| --- | --- | --- |
| 原生 | 来源 Agent 的原生目录（只读） | 实心点 + 锁；是否保留启用开关见下文 |
| 已分发 | 存在 `deployed` 投影 | 勾 |
| 待更新 | 存在 `outdated` 投影 | 勾 + 提示 |
| 已修改 | 存在 `drifted` 投影 | 琥珀色，点击处理 |
| 缺失 / 冲突 | `missing` / `conflict` | 红色或灰色，点击处理 |
| 可分发 | 兼容但未分发 | 空心点，悬停显示"分发" |
| 不兼容 | Agent 适配器不支持投影 | 灰色斜线 |

列可见性规则需要修正：不能只看"有原生或投影"，否则会隐藏尚未分发、但已经可以通过 prompt delivery 注入的 Agent。建议的列出现条件：

- 该 Agent 有原生 Skill；
- 该 Agent 有投影（任意状态）；
- 存在"已信任、兼容且具备 delivery 能力"的 shared / market Skill。

原生行开关的处置需要单独立项，因为它会改变现有语义：

- 当前实现中，原生 Skill 即使已信任，也必须 `nativeEligible` 包含来源 Agent 才可用（`skill-library.cjs:324-328`）；单纯信任不会让它跨 Agent 可用；
- 建议的改法是"信任后自动为来源 Agent 启用"，但这会改变 `nativeEligible` 的语义和已有默认值，需要迁移方案；
- 在改法确定前，UI 可以保留启用动作，但应把"信任"和"启用"合并成一次明确的就地操作，并说明：其他 Agent 需要先导入共享库，而不是再点一个 eligibility 开关。

### 3.5 去重与冲突

- 不按内容哈希合并行。哈希相同的不同来源仍保留独立行，附加"同内容"链接；否则会丢失来源和分发关系。
- 冲突视图里再做合并比较，提供"以此为准 / 采纳原生 / 导入"动作。
- 信任已经按哈希共享，不会因为保留多行而重复审核。

### 3.6 批量导入与批量信任

这是解决当前截图问题的最短路径：

1. 原生区按来源 Agent 分组，组头显示数量与风险摘要；
2. 提供"全部纳入共享库"与"全部信任"；
3. 导入仍复制、不移动原生目录；
4. 批量信任展示合并后的风险标签，以及将影响的分发 / 角色数量；
5. 导入并信任后，即可通过 prompt delivery 供 Claude / Codex 使用；需要原生加载时再分发。

优先级应高于矩阵视觉重构：截图中的这批原生 Skill 目前无法进入协作流程（尚未导入共享库，且来源 Agent 不可启动），这是功能死路，不只是观感问题。

### 3.7 角色技能数量不设平台上限

原实现有三层 8 个上限：IPC 的 `skillIdList`、repository 的 `skillIds`、`SkillLibrary.assertSelectable/materialize`，以及前端 `MAX_ROLE_SKILLS`。这些都已移除：

- `team-room-ipc.cjs:58-64` 只校验格式，不校验数量；
- `repository.cjs:77-83` 只校验 ID 形状；
- `skill-library.cjs` 的 `assertSelectable` 不拒绝超长数组，`materialize` 不截断；
- `skill-inventory.cjs`（legacy，未接线）同步移除；
- 前端 `skillInventory.js` 不再截断，角色编辑器不再因数量禁用选项。

保留的 24 是 Captain briefing 的展示上限（`MAX_CAPTAIN_SKILLS`），不是角色容量限制。UI 仍显示 token 估算，作为用户自己的判断依据。

---

## 4. 建议分期

### P0 — 信息模型修正（前端 + i18n）

- 行内标注来源 Agent（"Hermes 原生"），不再笼统显示"Agent 原生"。
- 空列折叠，但列可见条件必须包含"已信任且可 prompt delivery"的 Agent（见 3.4），不能只按原生或投影判断。
- 单元格状态化（见 3.4）；原生行是否去掉开关，取决于 3.4 中 `nativeEligible` 语义迁移是否获批。
- 名称第二行显示描述摘要；移除固定"操作"列；"更新"改为内容更新时间或最近使用时间。
- 顶部"待处理"条：冲突 / 需重新授权 / 有更新，均可点击直达；冲突前置。
- 详情面板按决策顺序重排，信任按钮移到底部。
- 角色弹窗的死胡同：灰显不可用 Skill，标注原因（未信任 / 不兼容 / 属于其他 Agent）。来源 Agent 的原生 Skill 提供"审核并启用"；其他 Agent 的原生 Skill 提供"导入共享库"，不承诺"信任即可跨 Agent 使用"。

涉及：`frontend/src/components/skills/SkillsPage.vue`、`SkillDetailPanel.vue`、`RoomWorkspace.vue`、`locales/zh.js`、`locales/en.js`。

### P0.5 — 批量导入与批量信任（主进程 + IPC + UI）

- 新增按来源组批量的 IPC 与校验；
- 导入与信任分开确认，展示合并风险与影响面；
- 导入后可直接选择目标 Agent 分发。

涉及：`desktop/src/skills/skill-library.cjs`、`desktop/src/shell/skill-library-ipc.cjs`、`preload.cjs`、`SkillsPage.vue`。

### P1 — 原生隔离（Claude 优先）

不能只在 `openSession` 临时传参。需要先定状态归属，再接入持久化和 session rotation。

**状态模型**

- 建议做成**角色级**属性（`chat_roles` 新增 `native_isolation` 列，取值 `inherit | isolate`），因为同一个 Agent 在不同角色下可能需要不同配置；Room 级可作为后续默认值。
- 会话启动时把该值快照进 `sessions`（新增列），使"当时用的什么配置"可追溯。
- `session-store.cjs:9-27` 的 `sameConfiguration` 目前只比较 provider / promptRevision / permissionMode / workspaceRef / skillBindings / model / thinkingLevel。**必须把隔离配置加入比较**，否则切换后 `ensureSession` 会复用旧会话，`resume` 仍沿用旧配置。
- 切换隔离设置 → 下一次 `ensureSession` 判定配置不同 → 现有逻辑自动把旧会话标记 `rotated` 并新建会话（`session-store.cjs:44-74`）。任务 lane 的会话也要覆盖。

**数据库与 API 变更**

沿用现有幂等列迁移模式（`schema.cjs:352-393` 的 `ensurePortraitColumn` / `ensureRoleSkillsColumn`）：

- `chat_roles`：`CREATE TABLE` 增加 `native_isolation TEXT NOT NULL DEFAULT 'inherit'`，并新增 `ensureNativeIsolationColumn`，对旧库执行同样的 `ALTER TABLE`；默认 `inherit`，无需回填。
- `sessions`：增加 `native_isolation` 快照列，插入时写入；旧行默认 `inherit`。
- `ROOM_SCHEMA_VERSION` 当前为 4。新增列沿用现有"建表 + 幂等 ALTER"的方式即可；如果团队要求显式版本号，则 bump 到 5 并把迁移写进 `ensureRoomSchema`。
- `repository.createRole` / `roleView`（`repository.cjs:41-58, 137-165`）读写 `nativeIsolation`。
- `room-host.updateRole`（`room-host.cjs:520-600`）接受并校验 `inherit | isolate`。
- `read-model` 的 `roleView`（`read-model.cjs:70-89`）返回 `native_isolation`。
- `create_roles` 默认 `inherit`，除非后续显式开放参数。
- preload / IPC 只传枚举，不传路径或命令。

**调用链**

- chat：`engine.cjs:154-172` 物化技能并调用 `sessions.ensureSession`；同时把 `role.nativeIsolation` 传给 `runtime.start`，`runtime-adapter.cjs:463-505` 的 `start` 再传给 `openSession`。
- task lane：`runtime-adapter.cjs:534-580` 的 `startTaskRun` 已经从 `bindRun` 拿到 role；把 `role.nativeIsolation` 同时传给 `ensureSession` 和 `openSession`。
- `openSession`（`runtime-adapter.cjs:237-245`）在 `isolate` 时设置 `userConfiguration: 'exclude'`。
- 失败映射：启动前先读 `runtime.refusedSessionOptions?.userConfiguration`，不支持就直接抛 `ROOM_NATIVE_ISOLATION_UNSUPPORTED`；运行期 OAR 的 `UnsupportedOptionError` 也映射到同一错误码，并附 provider 名称，不泄露路径。UI 在角色编辑器映射到 i18n。

**实现**

- Captain 通过 `create_roles` 创建的角色默认继承，除非后续明确开放该参数；
- UI 在角色配置中提供"原生 Skill：继承 / 隔离"，并说明：隔离会同时失去用户 MCP、hooks、memory、settings。

**能力矩阵**

- 从 OAR 各 runtime 的 `refusedSessionOptions` 派生，而不是在 Tyche 里硬编码；
- 当前已验证 Claude 支持；Pi 未验证；Codex 及其他拒绝的运行时必须在选择前就显示原因，而不是启动后才报错。

**真实运行时验收（不能只靠单元测试）**

1. Claude 隔离后，用户级原生 Skill 不再出现；登录与基础对话仍可用。
2. 切换隔离开关后，旧会话被标记 `rotated`，新会话生效；`resume` 不会沿用旧配置。
3. Claude 隔离后 `resume` 仍能恢复原生会话历史。
4. 工作区内的项目级 `.claude/skills` 仍然加载——这是已记录的边界，需要在 UI 说明。
5. Codex 选择隔离时返回明确的 `UnsupportedOptionError` 映射，而不是静默忽略。
6. 任务 lane 会话与 chat 会话使用相同的隔离配置和轮换规则。

### P2 — 能力型风险、使用统计、作用域

- 风险标签翻译成能力影响（shell、网络域名、凭据名、文件写入范围）；
- "非标准字段"从风险区移到兼容性区；
- 最近使用时间 / 调用次数；
- 项目级作用域（工作区 `.claude/skills`）留到写入授权方案确定后。

### 发布前阻塞项 — Captain 权限上限（不随分期延后）

- `create_roles` 直接赋予 Claude `bypassPermissions`、Codex `danger-full-access`（`captain.cjs:5-9, 154`）；Captain 是一个 Agent，可以自主创建拥有最高原生权限的成员。
- 这与 `architecture.md:45` 的现状叠加：`write_authorized` 尚未接入 execution lease，聊天回复的"只读"边界还没有运行时保证。
- 处理方式二选一，但必须有明确结论：
  1. **收紧**：派生角色默认最低权限，提升权限需要用户显式确认；Captain 自身默认也不应是 bypass；
  2. **接受**：将其记录为当前产品风险，由 owner 明确签字，并在发布说明中披露。
- 与 `write_authorized`、Room 执行 lease 的关系需要单独设计，但不能因此推迟结论。

**发布门禁（owner 拍板前）**

- 默认行为：`create_roles` 派生角色和人工新建角色的默认权限都不得高于最低档；Claude 默认 `plan`，Codex 默认 `read-only`。
- 提升到 `bypassPermissions` / `danger-full-access` 必须由用户显式操作并写入角色配置；Captain 工具不能自行提升。
- 验收条件：
  1. `create_roles` 不产生高权限角色；
  2. `create_roles` 参数里没有权限字段，`updateRole` 才接受显式高权限；
  3. 人工验收：新建 Captain 与 Captain 派生角色都从最低权限开始；
  4. 发布检查清单把该项列为 blocker；除非 owner 书面接受风险并更新本文档。

---

## 5. 需要评审拍板的问题

1. 原生 Skill 的开关：保留 `nativeEligible` 的手动启用，还是改为"信任后自动为来源 Agent 启用"？后者需要迁移已有默认值和语义。
2. 批量信任的粒度：按来源组、按风险等级，还是按筛选结果？是否需要逐条预览？
3. 隔离的归属与默认值：做成 Role 级、Room 级还是 Session 级？默认继承（兼容现有行为）还是新建 Room 默认隔离？
4. `userConfiguration: "exclude"` 的副作用是否可接受？是否需要在 OAR 增加"只排除 skills"的更细粒度选项？
5. Codex 无法隔离时，产品话术是"装配为建议"还是"不支持严格装配，请改用 Claude"？
6. 是否引入角色模板，替代"记住为该 Agent 新角色的默认"？
7. Captain 派生角色的权限上限是否立即收紧？如果需要用户确认，确认发生在哪个界面？
8. 分发是否需要在设置页保留为显式动作，还是收敛到"导入 → 选择目标 Agent"的向导里？
9. 既然平台不限制数量，角色编辑器是否保留 token 估算之外的软提示（例如数量很多时提醒上下文成本），还是完全交给用户判断？

---

## 6. 明确不做的事

- 不自动开启分发（会向 Agent 目录写入大量副本）。
- 不按内容哈希合并矩阵行（会丢失来源与分发关系）。
- 不把"官方 / 签名来源默认可信"作为本阶段规则；目前没有签名或策展体系。
- 不在本阶段实现项目级 / 会话级 / 步骤级作用域。
- 不新增远程目录、账号体系或服务端依赖。
- 不把路径、可执行文件、token 暴露给 renderer；隔离开关只传布尔语义。
- 不在平台层限制一个角色的技能数量；数量属于角色配置，UI 只做提示和 token 估算。

---

## 7. 验证方式

自动：

```bash
node --test desktop/test/skills/skill-library.test.cjs \
  desktop/test/skills/skill-market.test.cjs \
  desktop/test/skills/skill-inventory.test.cjs \
  desktop/test/shell/skill-library-ipc.test.cjs \
  desktop/test/shell/team-room-ipc.test.cjs \
  desktop/test/security/preload-security.test.cjs
node --test desktop/test/room/engine.test.cjs \
  desktop/test/room/repository.test.cjs \
  desktop/test/room/session-store.test.cjs
cd frontend && npx vitest run \
  src/__tests__/tyche/skillLibrary.spec.js \
  src/__tests__/tyche/skillInventory.spec.js \
  src/__tests__/tyche/i18n.spec.js
npm --prefix frontend run build
npm --prefix frontend run build:desktop
```

不跑全量 desktop 测试（耗时约 9 分钟）；按改动范围选定向套件。

Node 25 下前端测试需要加 `NODE_OPTIONS=--no-experimental-webstorage`，否则 Node 内置的 webstorage 会先于 jsdom 初始化并报错。这是环境问题，与本轮改动无关。

人工（Electron）：

1. 原生 Skill 行显示来源 Agent；若 `nativeEligible` 自动启用方案获批，则不再有独立开关。
2. shared / market Skill 未分发时，角色选择器仍能选中，并通过 prompt delivery 生效。
3. 共享 Skill 分发生效后单元格显示"已分发"，撤销后回到"可分发"。
4. 角色弹窗对不可用 Skill 显示原因：来源 Agent 可"审核并启用"，其他 Agent 提供"导入共享库"。
5. 批量导入原生 Skill 并信任后，Claude 角色可直接使用 prompt delivery；需要原生加载时再分发。
6. Claude 角色开启隔离后，用户级原生 Skill 不再出现；关闭后恢复。
7. 切换隔离设置后，旧会话被标记 `rotated`，新会话使用新配置；resume 正常恢复原生历史。
8. 工作区内的项目级 `.claude/skills` 仍然加载——确认 UI 已说明这一边界。
9. Codex 选择隔离时被明确拒绝并提示原因，而不是静默沿用旧行为。
10. 一个角色可以选择并保存 9 个以上 Skill；保存、读取和 materialize 都不被截断。
11. renderer 的 Skill DTO 中不出现绝对路径、可执行路径或凭据。

---

## 附录 A — 代码索引

| 主题 | 位置 |
| --- | --- |
| 会话启动参数 | `desktop/src/room/runtime-adapter.cjs:237-245` |
| 运行时可启动列表 | `desktop/src/room/runtime-adapter.cjs:636-643` |
| 会话配置比较与轮换 | `desktop/src/room/session-store.cjs:9-27, 44-74` |
| 角色表结构 | `desktop/src/room/schema.cjs:27-42` |
| OAR 隔离选项契约 | `desktop/node_modules/@botiverse/oar/dist/contracts/session-options.d.ts:179` |
| OAR 默认运行时 | `desktop/node_modules/@botiverse/oar/dist/index.js:41-55` |
| 原生可用性判定 | `desktop/src/skills/skill-library.cjs:324-328` |
| 角色技能物化 | `desktop/src/skills/skill-library.cjs:691-711` |
| Captain 派生角色权限 | `desktop/src/room/tools/captain.cjs:5-9, 154` |
| Captain 技能参数与校验 | `desktop/src/room/tools/captain.cjs:155, 221-234` |
| 矩阵单元格逻辑 | `frontend/src/components/skills/SkillsPage.vue:278-307` |
| 来源标签 | `frontend/src/skillLibrary.js:52-56` |
| 写入授权现状 | `architecture.md:45` |
| 设计决策 | `docs/10-skill-management.md` §7、§15 |
| 当前实现状态 | `docs/11-skill-implementation-handoff.md` §2、§9 |

## 附录 B — 评审意见对照

| 评审意见 | 本文处理 |
| --- | --- |
| 隔离方案缺少状态模型，需持久化并触发 session rotation | P1 补角色级持久化、`sessions` 快照、`sameConfiguration` 扩展和轮换验收 |
| "只有 Claude 支持"表述过强 | §0、§2.2 改为"已验证 Claude 支持；Pi 未验证" |
| 第 2.4 节把截图推断写成代码事实 | §2.4 拆分为"代码事实"和"截图观察"两段 |
| "唯一路径是导入后分发"不准确 | §0、§2.4、§3.1、§3.6 明确"导入并信任即可 prompt delivery，分发可选" |
| "信任即对来源 Agent 可用"与实现冲突 | §3.4、P0 保留 `nativeEligible` 现状，把自动启用列为需迁移的提案 |
| 空列折叠会隐藏可用性 | §3.4 增加列可见条件：原生 / 投影 / 已信任且可 prompt delivery |
| Captain 最高权限应提升优先级 | 从"独立安全项"改为"发布前阻塞项"，要求收紧或明确接受风险 |
| 隔离需要真实运行时验收 | P1 增加 6 项运行时验收，覆盖持久化、resume、项目级目录和 Codex 拒绝 |
| 模型应为 Library → Availability → Distribution → Loadout | §3.1 采纳四段链路，并声明 Distribution 不是 Availability 的前置条件 |

### 三轮评审补充

| 评审意见 | 本文处理 |
| --- | --- |
| 隔离配置的数据库迁移不完整 | P1 新增"数据库与 API 变更"：列迁移、默认值、schema version 策略、repository / read-model / 更新 API |
| Availability 混合了 Skill 能力与 provider 可启动性 | §2.7 拆成 `skillAvailable` 与 `providerLaunchable`，并说明 DTO 合并方式 |
| Captain 权限缺发布门禁 | "发布前阻塞项"新增默认行为和 4 条验收条件 |
| `openSession` 参数如何从两条调用链传入 | P1 新增"调用链"，覆盖 chat、task lane 和错误映射 |
| 角色技能不应限制数量 | §3.7 记录决策；IPC、repository、skill-library、legacy inventory、前端均已移除上限，并补测试 |
