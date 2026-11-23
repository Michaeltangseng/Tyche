# 11 Skill 实施交接文档

更新日期：2026-11-23

面向对象：接手 Tyche Skill 管理、市场、仓库型 Skill 和 Room 技能链路的后端 / 前端 / 桌面端工程师。

配套阅读：

- `AGENTS.md`：仓库工作规则和安全边界。
- `architecture.md`：Room / Chat / Role / Task 的总架构。
- `docs/10-skill-management.md`：Skill 机制的设计文档和数据模型。本文档记录**当前实现状态**、差异、验证和后续任务。

当前基线：

- 分支：`master`
- 工作树：干净（截至本文档创建时）
- 本轮提交：

```text
ec7e85e feat(skills): install repo-shaped Skills with symlink toolchains
f829b7d fix(skills): fail market approval when the network policy blocks it
69c74b5 feat(skills): add the Git market client
88817f2 feat(skills): rotate sessions on Skill changes and wire trust policy
e2796ed feat(skills): add row actions for editing and deleting Skills
ce6f6ec feat(skills): add the shared Skill library and trust-bound distribution
```

---

## 1. 产品决策与本阶段边界

用户在本阶段明确要求：

> 不用管信任等级和权限限制。Skill 允许执行工具链，先放开了做，后续阶段再根据真实需求收缩。

落实到实现：

| 场景 | 当前行为 |
| --- | --- |
| 仓库型（repo-shaped）Skill 安装 | 自动信任，直接可用于分发和角色 |
| 仓库型 Skill 更新 | 自动信任，更新后直接可用 |
| 仓库型 Skill 的网络风险 | 只展示风险标签，不阻止安装/更新/信任 |
| 普通文件夹 Skill（native / shared / 市场单目录） | 仍保留原有信任确认流程：先信任，才能启用或分发 |
| 市场单目录安装 | 默认不信任，受权限与安全页的策略影响 |
| `denySkillNetwork` | 对普通文件夹 Skill 的信任/审批生效；对仓库型 Skill 不生效 |

这是**有意的前置放开**，不是遗漏。后续如果决定全面放开，可把普通 Skill 的信任门槛也去掉；如果决定收紧，应先补充仓库型 Skill 的信任等级、工具链环境检查和 hooks 审批。

当前未实现、且不要误以为是已完成的：

- 插件包（plugin bundle）的 MCP / hooks / commands 拆包与路由。
- Project / session / per-step 技能作用域。
- 原生市场（Claude / Codex `marketplace.json`）导入。
- 公开目录搜索、企业私有源。
- Windows 符号链接投放。
- 依赖安装、Node/Chrome/FFmpeg 等环境检查。
- Git LFS 大资源拉取。
- 接管无标记的原生 Skill 目录。

---

## 2. 已实现能力

### 2.1 共享库与信任

- v2 库状态文件：`skill-library.json`。
- 启动时把旧的 `skill-inventory.json` 迁移为 v2；旧文件改名为 `skill-inventory.json.bak`。
- 原生 Skill 发现：复用 `LocalSkillCatalog` 对 11 种 Agent 目录的扫描。
- 内容哈希：SHA-256，覆盖 Skill 目录内常规文件；排除 `.git`、`node_modules`、`.DS_Store`、`.tyche-managed.json`、`.tyche-provenance.json`、`.tyche-tmp-*`。
- 信任状态：`untrusted / trusted / changed / unavailable`。
- 信任按内容哈希生效；同一内容可复用已有批准。撤销一个 Skill 只清它自己的批准；共享哈希记录在没有其他 Skill 使用时删除。
- 风险扫描：`dynamic-command`、`shell-tools`、`hooks`、`scripts`、`network`、`file-write`、`external-paths`、`large-assets`、`nonstandard-fields` 等，静态扫描，不执行。
- 权限与安全页的“Skill 信任策略”是真实可写的：
  - `untrustedByDefault`
  - `revokeOnChange`
  - `denySkillNetwork`

### 2.2 导入、新建、编辑、删除

- **从 Agent 导入**：复制原生 Skill 到共享库；不移动、不覆盖原生目录；同名默认重命名，可选替换。
- **新建 Skill**：生成标准 `SKILL.md`；创建后自动信任；可立即分发。
- **更新**：共享库 Skill 可编辑描述和正文；保存后内容变化，状态变为 `changed`，需要重新授权。
- **删除**：输入名称确认（L2）；移入回收区；删除 Tyche 管理的副本；原生目录不动。
- 原生 Skill 行不提供更新/删除操作。

### 2.3 分发 / 投影

支持三种投影模式：

| 模式 | 用途 | 说明 |
| --- | --- | --- |
| `copy` | 普通文件夹 Skill | 复制到 Agent skill 目录，写 `.tyche-managed.json`；支持漂移/待更新/冲突 |
| `nativeOrigin` | 从某 Agent 原生导入的 Skill | 只记录关联，不写、不搬原生文件 |
| `symlink` | 仓库型 Skill | 链接到共享库 `.repos/` 内的 Skill 子路径；`../cli`、`scripts/` 等引用可解析 |

状态：

- `deployed`
- `outdated`（copy）
- `drifted`（copy）
- `missing`
- `conflict`
- `unavailable`（copy）

仓库型 Skill 的符号链接状态只区分 `missing / conflict / deployed`；因为链接是实时的，不做漂移/待更新判定。

### 2.4 仓库型 Skill（工具链）

- Git 市场预览会标记嵌套 Skill 为 `repoMode`。
- 用户可勾选“整仓安装（支持工具链）”，默认勾选。
- 安装布局：

```text
<userData>/tyche-private/skill-library/
  <name> -> .repos/repo-<sha256>/skills/<name>
  .repos/
    repo-<sha256>/          # 整个仓库副本，跳过 .git / node_modules
```

- 共享库入口是相对符号链接；Agent 投影是指向真实 Skill 子路径的绝对符号链接。
- 仓库更新：在 `.repos/repo-<id>` 原路径就地替换 checkout；旧仓库先备份到 `skill-backups/<name>/<timestamp>/`；Agent 符号链接保持有效；投影记录同步更新内容哈希。
- 删除：整个仓库移到 `skill-trash/`；库入口和 Agent 链接移除。
- 仓库复制上限：5,000 文件 / 单文件 128 MB / 总计 512 MB。
- 仓库型安装/更新自动信任，不受 `denySkillNetwork` 影响。

### 2.5 Git 市场

- 来源：HTTPS Git URL，或用户显式输入的本地 `file://` 仓库。
- 拒绝：`http://`、SSH、带用户名/密码/query/hash 的 URL、非法 ref、带 `..` 的 subpath。
- 添加来源后可以预览：浅克隆到 `skill-market/staging/<sourceId>-<timestamp>/`，扫描其中的 `SKILL.md`，展示描述、正文预览、文件数、风险标签。
- 安装：复制到共享库，写入 `.tyche-provenance.json`，记录来源 URL、commit、相对路径。
- 检查更新：`git ls-remote`；只提示，不自动更新。
- 更新：重新克隆并审核，应用后旧库目录/仓库备份；普通 Skill 需要重新授权，仓库型 Skill 自动可用。
- 来源仍被已安装 Skill 引用时，不允许移除来源。
- 克隆要求本机 `git` 在 PATH 中；缺失时报 `SKILL_MARKET_GIT_MISSING`。

### 2.6 Room 集成

- 角色仍然从可信、可用的 Skill 中选择，最多 8 个。
- 有有效原生投影（`deployed`）时，简报只提示“已安装原生版本”，不再注入完整正文。
- 没有有效投影时，沿用原来的 prompt 注入。
- 简报里 `delivery` 为 `native` 的条目只输出一行说明；`prompt` 条目输出正文。
- Captain inventory 使用同一份可信集，每个 provider 最多 24 条。
- `ensureSession` 现在收到真实的：

```js
{ id, contentHash, delivery }
```

Skill 变化会触发 session 轮换。

### 2.7 设置 UI

- Settings › Skills：
  - 来源筛选：全部 / 共享库 / Agent 原生 / 市场 / 需重新授权 / 冲突。
  - 矩阵：检测到的 Agent 列 + 已安装 Agent 列。
  - 更新 / 信任 / 时间列。
  - 操作列：更新 / 删除。
  - 仓库/有更新/冲突徽标。
- 详情面板：
  - 风险标签、分发列表与状态、预览、文件清单。
  - 打开源文件（主进程执行）。
  - 信任 / 撤销信任 / 重新授权。
  - 漂移处理：恢复 / 采纳 / 停止管理。
  - 删除名称确认。
- 从 Agent 导入弹窗、新建/编辑弹窗、删除弹窗、市场弹窗。
- 权限与安全页的 Skill 信任策略卡片。
- 中英文文案已补齐。

---

## 3. 磁盘布局

macOS 实际路径：

```text
~/Library/Application Support/tyche-desktop/tyche-private/
  skill-library.json
  skill-library/
    <name>/                  # 普通共享库 Skill
    <name> -> .repos/...     # 仓库型 Skill 的入口符号链接
    .repos/
      repo-<hash>/           # 整仓副本
  skill-backups/
    <name>/<timestamp>/      # 更新/替换前的备份；仓库更新也备份旧仓库
  skill-trash/
    <timestamp>-<name>/      # 删除的 Skill 或仓库
  skill-market/
    staging/<sourceId>-<timestamp>/
    staging/update-<skillId>-<timestamp>/
  skill-inventory.json.bak   # 旧 v1 状态文件（迁移后）
```

标记文件：

- 拷贝投影：`<agent skill root>/<name>/.tyche-managed.json`
- 共享库 Skill 的来源记录：`<skill dir>/.tyche-provenance.json`
- 仓库型 Skill 的 provenance 写在仓库内的 Skill 子目录。

---

## 4. 数据模型

`skill-library.json`：

```json
{
  "schemaVersion": 2,
  "policy": {
    "untrustedByDefault": true,
    "revokeOnChange": true,
    "denySkillNetwork": false
  },
  "sources": {},
  "releases": {},
  "skills": {},
  "approvedHashes": {},
  "projections": {},
  "defaults": {}
}
```

`skills[id]` 常见字段：

```text
name
sourceKind: shared | market | native
origin: { type, sourceId, url, ref, subpath, commit, relativePath, repoId, repoMode, fromAgent, namespace, slug }
repoId / repoSkill
version
contentHash
approvedHash
updateAvailable
nativeEligible
nativeSourceRef        # 原生导入时记录的原生目录，主进程内部使用
createdAt / updatedAt
```

`projections[id]`：

```text
id
skillId
agent
scope: global
mode: copy | symlink | nativeOrigin
targetRef              # 主进程内部绝对路径
sourceRef              # symlink 模式：共享库真实 Skill 路径
displayPath            # 渲染进程可见的 ~/... 路径
contentHash
deployedAt
```

`approvedHashes[hash]`：

```text
approvedAt
preview
fileManifest
risk
scannedHash
```

其他：

- `sources` 已使用；`releases` 目前是预留字段，市场安装把来源 / commit / relativePath 写在 `skill.origin` 和 `.tyche-provenance.json`，没有单独写 release ledger。需要多版本 / 回滚时再补。
- 普通 Skill 大小限制：256 文件 / 单文件 1 MB / 总计 8 MB。
- 仓库复制限制：5,000 文件 / 单文件 128 MB / 总计 512 MB。
- 信任状态和风险扫描以内容哈希为准。

---

## 5. 关键模块

### 5.1 桌面端

| 文件 | 责任 |
| --- | --- |
| `desktop/src/skills/skill-library.cjs` | 门面：扫描合并、信任、导入、创建、编辑、删除、投影、repo 安装/更新、Room 的 assertSelectable/materialize/captainInventory |
| `desktop/src/skills/skill-library-store.cjs` | v2 JSON 状态、原子写、v1 迁移、defaults 修复 |
| `desktop/src/skills/skill-library-util.cjs` | 哈希、frontmatter、目录遍历、复制、provenance、marker、大小限制 |
| `desktop/src/skills/skill-projections.cjs` | copy / nativeOrigin / symlink 投影、状态、漂移、删除、停止管理 |
| `desktop/src/skills/skill-adapters.cjs` | 11 种 Agent 的 skill 根目录和可投影能力 |
| `desktop/src/skills/skill-risk.cjs` | 静态风险扫描 |
| `desktop/src/skills/skill-market.cjs` | Git 来源、浅克隆、预览、安装 token、更新检查、更新预览/应用 |
| `desktop/src/shell/skill-library-ipc.cjs` | 窄 IPC：输入校验、display-safe DTO、主进程 reveal |
| `desktop/src/main.cjs` | 创建 `SkillLibrary`，传入 room host；注册 IPC；迁移和事件 |
| `desktop/src/preload.cjs` | `skillLibrary` API |
| `desktop/src/room/engine.cjs` | 角色技能 materialize；session bindings；briefing |
| `desktop/src/room/runtime-adapter.cjs` | TaskRun 的 session bindings；任务 prompt 的 equipped skills |
| `desktop/src/room/briefing.cjs` | native / prompt 两种 equipped skill 行 |
| `desktop/src/room/room-host.cjs` | 房间侧 skillInventory 方法代理 |
| `desktop/src/skills/local-skill-catalog.cjs` | 原生 Skill 发现；新增 `listResolved` 供库扫描使用 |

### 5.2 前端

| 文件 | 责任 |
| --- | --- |
| `frontend/src/components/skills/SkillsPage.vue` | 页面、矩阵、筛选、行操作、市场入口 |
| `SkillDetailPanel.vue` | 详情、信任、分发、漂移处理、删除 |
| `SkillImportDialog.vue` | 从 Agent 导入 |
| `SkillEditorDialog.vue` | 新建 / 编辑 |
| `SkillDeleteDialog.vue` | L2 删除确认 |
| `SkillTrustPolicy.vue` | 权限与安全页的策略卡片 |
| `SkillMarketDialog.vue` | 市场来源、预览、安装、检查更新、更新审核 |
| `frontend/src/skillLibrary.js` | 矩阵/筛选/投影辅助函数 |
| `frontend/src/skillInventory.js` | Room 角色选择辅助（`available` 字段） |
| `SettingsPages.vue` / `SystemSettingsView.vue` / `App.vue` | 页面装载、`api.skillLibrary` 注入 |
| `locales/zh.js` / `locales/en.js` | 全部可见文案 |

### 5.3 测试

| 文件 | 覆盖 |
| --- | --- |
| `desktop/test/skills/skill-library.test.cjs` | 信任、导入、投影、漂移、策略、迁移、默认选择 |
| `desktop/test/skills/skill-market.test.cjs` | Git 来源、预览、安装、更新、仓库型工具链、非法 URL |
| `desktop/test/shell/skill-library-ipc.test.cjs` | IPC 校验、reveal 主进程解析 |
| `desktop/test/security/preload-security.test.cjs` | `skillLibrary` 暴露面 |
| `desktop/test/room/briefing.test.cjs` | 简报 |
| `frontend/src/__tests__/tyche/skillLibrary.spec.js` | 矩阵、操作、市场、策略、repo 安装 |
| `frontend/src/__tests__/tyche/skillInventory.spec.js` | Room 角色选择辅助 |
| `frontend/src/__tests__/tyche/i18n.spec.js` | 中英文 key 一致性 |

---

## 6. 主要流程

### 6.1 扫描与列出

1. `SkillLibrary.scan()` 加载 v2 store。
2. 通过 `LocalSkillCatalog.listResolved(kind)` 扫描 11 种 Agent 的原生根目录，并跳过 Tyche 管理的投影目录。
3. 扫描 `skill-library/`：
   - 普通目录；
   - 只跟随指向 `.repos/` 内部的符号链接；
   - 读取 `SKILL.md`、provenance、内容哈希。
4. 计算信任、可用 Agent、冲突、投影状态。
5. 前端拿到 display-safe DTO：没有 `sourceDirectory`、`targetRef`、`sourceRef`、绝对路径。

### 6.2 信任

1. 用户点“信任此 Skill”。
2. 主进程计算风险，写入 `approvedHashes[currentHash]` 和 skill 的 `approvedHash`。
3. 如果 `denySkillNetwork` 为真且风险包含 `network`，普通 Skill 抛出 `SKILL_NETWORK_DENIED`；仓库型 Skill 在安装/更新时自动信任，不经过这里。
4. 内容变化 → `changed`；角色选择、注入、投影都会按不可用处理。

### 6.3 普通分发

1. `project(id, agent)` 检查 trust、Agent 适配器。
2. 目标存在时：
   - 有本 projection 的 marker → 备份并覆盖；
   - 无 marker → `SKILL_PROJECTION_CONFLICT`；
   - 是 native 原目录且与首次导入来源相同 → 记录 `nativeOrigin`，不写文件。
3. 复制到 staging，写 `.tyche-managed.json`，rename 到目标。
4. 漂移/待更新状态在读取时重新计算，不信任存储。

### 6.4 仓库型安装

1. 来源预览里 `repoMode=true`。
2. 用户勾选整仓安装。
3. 主进程将整个 clone root 复制到 `.repos/repo-<hash>/`。
4. 规范化 Skill 子目录的 `SKILL.md` 名称/描述。
5. 计算 Skill 子目录哈希 + 风险。
6. 写 provenance。
7. 在 `skill-library/<name>` 创建指向 `.repos/.../skills/<name>` 的相对符号链接。
8. 写入 store，自动信任。
9. 分发时创建指向真实 Skill 子目录的绝对符号链接。

### 6.5 市场更新

1. `checkUpdates` 对每个 market skill 的来源执行 `ls-remote`，比较 `origin.commit`。
2. 有更新时设置 `updateAvailable=true`，矩阵显示徽标。
3. 行操作“更新”打开市场更新视图：clone 最新，按相对路径/名称找同一个 Skill。
4. 普通 Skill：重新复制单目录，保留旧批准哈希 → `changed`。
5. 仓库型 Skill：在 `.repos/` 原路径替换 checkout，更新所有 symlink 投影的内容哈希；自动信任。

### 6.6 Room

1. 角色保存 `skills_json`（≤8 个 ID）。
2. `SkillLibrary.materialize(provider, ids)` 返回技能；若该 Agent 有 `deployed` 投影，`delivery='native'`，否则 `delivery='prompt'`。
3. `engine` / `runtime-adapter` 把 `{id, contentHash, delivery}` 传给 `ensureSession`。
4. `briefing` 对 native 条目只写一行“已原生安装，按需使用”；prompt 条目写正文。
5. Captain 使用 `captainInventory` 选角色技能；`create_role`/`add_members` 通过 `assertSelectable` 校验。

---

## 7. IPC / API

`preload` 暴露 `skillLibrary`：

```text
summary()
list({ filter?, query? })
detail({ id })
policy()
updatePolicy({ untrustedByDefault?, revokeOnChange?, denySkillNetwork? })
trust({ id })
revokeTrust({ id })
setEligible({ id, agent, enabled })
importFromAgent({ ids, onConflict?, trust? })
create({ name, description, body, targets? })
update({ id, description?, body? })
remove({ id, confirmName })
project({ id, agent })
unproject({ id, agent })
resolveProjection({ projectionId, action })   # restore | adopt | unmanage
reveal({ id })
marketSources()
marketAddSource({ url, ref?, subpath? })
marketRemoveSource({ sourceId })
marketPreview({ sourceId })
marketInstall({ token, trust?, repo? })
marketCheckUpdates()
marketPreviewUpdate({ skillId })
marketApplyUpdate({ skillId, token, trust? })
onChanged(callback)
```

Room 侧仍使用 `teamRoom.skillInventory/trustSkill/revokeSkill/setSkillEligible/enableSkillForAgents/rememberSkillDefault`，由同一个 `SkillLibrary` 支撑。

安全约束：

- 渲染进程只拿 ID、标签、`~/...` 展示路径、哈希、风险标签。
- 不拿 `sourceDirectory`、`targetRef`、`sourceRef`、native session ref、PID、token、凭据。
- `reveal` 由主进程自己解析路径并调用 `shell.openPath`。
- 市场 URL/ref/subpath、Skill ID、投影 ID、token 都在 IPC 层校验。
- Git 通过 `execFile` 参数数组执行，不经过 shell；`GIT_TERMINAL_PROMPT=0`。

主要错误码：

```text
SKILL_LIBRARY_UNAVAILABLE
SKILL_LIBRARY_STORE_INVALID
SKILL_NOT_FOUND
SKILL_TRUST_REQUIRED
SKILL_NETWORK_DENIED
SKILL_NAME_INVALID / SKILL_NAME_CONFLICT
SKILL_IMPORT_INVALID
SKILL_TOO_LARGE / SKILL_UNREADABLE / SKILL_UNSAFE
SKILL_AGENT_INVALID / SKILL_SELECTION_INVALID
SKILL_UNSUPPORTED_AGENT
SKILL_PROJECTION_CONFLICT / SKILL_PROJECTION_DRIFTED / SKILL_PROJECTION_OUTDATED / SKILL_PROJECTION_MISSING
SKILL_SYMLINK_UNSUPPORTED
SKILL_MARKET_SOURCE_INVALID / SKILL_MARKET_SOURCE_IN_USE / SKILL_MARKET_SOURCE_NOT_FOUND
SKILL_MARKET_FETCH_FAILED / SKILL_MARKET_GIT_MISSING
SKILL_MARKET_NO_SKILLS / SKILL_MARKET_ENTRY_INVALID / SKILL_MARKET_ENTRY_EXPIRED / SKILL_MARKET_ENTRY_NOT_FOUND
SKILL_MARKET_UPDATE_INVALID
```

---

## 8. 验证

### 8.1 已运行的局部校验

```text
node --test desktop/test/skills/skill-market.test.cjs \
  desktop/test/skills/skill-library.test.cjs \
  desktop/test/shell/skill-library-ipc.test.cjs \
  desktop/test/security/preload-security.test.cjs
→ 35 passed

node --test desktop/test/room/session-store.test.cjs desktop/test/room/engine.test.cjs
→ 15 passed

npx vitest run skillLibrary.spec.js skillInventory.spec.js i18n.spec.js
→ 16 passed

npm --prefix frontend run build
npm --prefix frontend run build:desktop
→ 均通过
```

### 8.2 未做 / 注意事项

- 没有在 Electron 实机启动。
- 没有跑全量测试。此前跑过一次全量前端和 desktop core，存在与本模块无关的既有失败：
  - 前端 `App.spec` / trace 相关；
  - desktop `local-skill-snapshot` 相关。
  接手人先用上面的局部命令，再按需全量。
- Windows 符号链接未验证。
- Git LFS / 大仓库未验证。

### 8.3 建议的人工验收

1. 设置 › Skills：原生行未信任时开关置灰；详情可信任；信任后可启用。
2. 从 Agent 导入 → 共享库出现；原 Agent 显示“原生目录（未托管）”。
3. 普通 Skill 分发到另一个 Agent，检查 `SKILL.md` + `.tyche-managed.json`。
4. 修改分发副本 → 详情显示“已修改”，可恢复/采纳/停止管理。
5. 修改共享库正文 → 状态“内容已变更”，重新授权后更新分发。
6. 新建 Skill → 自动信任 → 立即分发。
7. 删除 Skill → 名称确认 → 受管副本移除，原生目录不动，回收区有内容。
8. 市场：添加 HTTPS 或 `file://` 来源 → 预览 → 安装 → 检查更新 → 应用更新。
9. 仓库型：用 `skills/<name>/SKILL.md` + `cli/` 的仓库勾选整仓安装；确认：
   - `skill-library/<name>` 是符号链接；
   - `~/.claude/skills/<name>` / `~/.codex/skills/<name>` 是符号链接；
   - `../cli` 引用可访问；
   - 更新后符号链接仍有效。
10. 权限与安全：切换三个策略开关；普通 Skill 的导入默认未信任；网络策略阻止普通网络 Skill 的信任。

---

## 9. 已知限制与风险

按优先级排列：

1. **仓库型 Skill 跳过信任和网络策略**。这是本阶段的明确产品选择；如果后续收紧，需要同时补：
   - 仓库型信任等级；
   - 工具链可执行文件清单；
   - hooks 审批；
   - 网络/文件写入边界。
2. **仓库复制不包含 `.git` 和 `node_modules`**。如果 Skill 的 CLI 依赖 git 历史、git 命令或已安装依赖，可能失败；当前也不自动 `npm install` / 环境检查。
3. **符号链接依赖 Agent 是否跟随链接**。Claude Code / Codex 目前预期可以；未对所有 CLI 验证。Windows 明确不支持。
4. **市场依赖系统 `git`**。从 Finder 启动的 macOS 应用可能拿不到用户 shell 的 PATH；如果报 `SKILL_MARKET_GIT_MISSING`，需要先做 git 路径探测/引导。
5. **浅克隆 + 无 LFS**。大资源、LFS 指针、submodule 不会完整拉取。
6. **仓库大小上限**：5,000 文件 / 128 MB 单文件 / 512 MB 总计；超过会失败。huashu-motion 这类带大资源的仓库可能触顶。
7. **普通文件夹 Skill 仍有信任门槛**。如果用户要求“全部放开”，需要改 `SkillLibrary.project/assertSelectable` 的入口和导入默认值。
8. **市场预览会同步遍历 staging 目录**。仓库大时可能阻塞主进程一小段时间（clone 是异步的）。
9. **没有插件包**。插件里的 MCP/hooks/commands 不会自动生效；插件仓库里的 `SKILL.md` 只会作为普通/仓库型 Skill 被发现。
10. **没有项目/会话/步骤级技能作用域**。当前只有全局分发 + 角色级注入。
11. **旧链路仍在**：
    - `desktop/src/skills/skill-inventory.cjs` 已不接线，但文件保留；
    - 旧 composer `@` Skill 仍走 `local-skill-trust-store` / snapshot 路径；
    - 两套信任存储尚未合并。
12. **风险扫描是提示，不是沙箱**。仓库型 Skill 的工具链由 Agent 自己执行，Tyche 不拦截。
13. **renderer 路径边界**：市场来源 URL 可能是 `file:///...`，会显示本地仓库路径；这是用户输入，不是可执行路径。不要在未来把 staging/target 绝对路径加进 DTO。

---

## 10. 下一步建议

按推荐顺序：

### A. 先实测仓库型 Skill

用 huashu-motion 或一个 `skills/<name> + cli/` 的测试仓库验证：

- 整仓安装；
- 符号链接；
- `../cli`；
- 更新；
- 删除；
- Agent 是否跟随符号链接；
- 依赖/环境是否缺失。

实测结果决定下一阶段的仓库型加固顺序。

### B. 仓库型工具链加固

- 依赖检查（Node/Chrome/FFmpeg 等）；
- `package.json` / README / `om doctor` 类自检；
- 是否保留 `.git`；
- 是否自动安装依赖；
- 独立可写数据目录（避免污染仓库哈希）；
- 更大的资源上限 / LFS 支持。

### C. 插件包

需要先定产品边界：

- 是否拆包：skills → 共享库；MCP → Agent & MCP 管理；hooks/commands → 权限审批；
- 还是原样调用目标 Agent 的插件命令。
- 当前 Agent & MCP 管理和权限页很多还是视觉壳，插件拆包需要它们先落地。

### D. Project / session / per-step 作用域

- Task worktree 下生成项目级 skill 目录；
- 与 Room 的写入授权、worktree 生命周期配合；
- 需要明确“聊天只读”边界。

### E. Agent 详情 Skills 页签 / Room 设置抽屉

- 数据已经具备：`list()` 可按 Agent 过滤、投影状态、token 估算；
- 主要工作是 UI 和导航。

### F. 原生市场 / 公开目录

- Claude / Codex `marketplace.json` 适配；
- 公开索引搜索；
- 企业私有源；
- 信任分级。

### G. 收尾与收敛

- 合并旧 composer 的 trust store；
- 删除不再使用的 `skill-inventory.cjs`；
- 统一错误码到 i18n；
- 全量测试基线。

---

## 11. 接手第一天的检查清单

1. 读 `AGENTS.md`、`architecture.md`、`docs/10-skill-management.md`、本文档。
2. `git status` 应为干净；`git log --oneline -6` 对上本文档。
3. 跑局部测试：

```bash
node --test desktop/test/skills/skill-market.test.cjs \
  desktop/test/skills/skill-library.test.cjs \
  desktop/test/shell/skill-library-ipc.test.cjs \
  desktop/test/security/preload-security.test.cjs
cd frontend && npx vitest run \
  src/__tests__/tyche/skillLibrary.spec.js \
  src/__tests__/tyche/i18n.spec.js
cd ..
npm --prefix frontend run build
npm --prefix frontend run build:desktop
```

4. 在 Electron 实机打开 Settings › Skills，按 §8.3 走一遍。
5. 确认仓库型 Skill 的实测结果，再决定是否进入插件/作用域阶段。

---

## 12. 待用户确认的问题

1. 是否把普通文件夹 Skill 也改成默认自动信任，彻底进入“放开阶段”？
2. 仓库型 Skill 是否需要保留 `.git` 和 `node_modules`？是否允许 Tyche 自动安装依赖？
3. 仓库型自动信任绕过网络策略，是否可接受？
4. 插件包的 MCP/hooks/commands 如何归属和审批？
5. Windows 是否必须支持仓库型 Skill？如果不支持，是否提供“仅单目录安装”的降级提示？
6. Project 级 Skill 是否需要写入 Room 工作区？这会触碰聊天只读边界。
7. 公开市场/企业源是否在近期范围？
8. 旧 composer 的 Skill 信任链路何时合并？
