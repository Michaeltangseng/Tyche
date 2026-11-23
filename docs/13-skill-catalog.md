# 13 Skill Catalog（当前实现）

更新日期：2026-11-23

状态：**当前实现，取代 docs/10、docs/11 和 docs/12 中关于信任、分发和风险扫描的部分。**

## 1. 产品决定

1. **Agent 原生 Skill 只读展示。** 平台不导入、不修改、不分发原生目录里的 Skill。
2. **平台只管理自己的 Skill。** 平台 Skill 来自市场下载或手动新建，存在 Tyche 的共享库里。
3. **不设信任。** 没有信任状态、审批、撤销或策略开关。Skill 进入平台库即可用。
4. **不做分发。** 不再向 Agent 目录写文件，也没有 Agent 列开关。平台库就是一份目录清单。
5. **角色配置直接从清单选。** 配置 chat agent 属性时，从平台 Skill 清单里选择；聊天时通过 prompt 注入生效。

## 2. 模型

```text
Market / Create ──► Platform library ──► Role skills ──► Chat briefing
Native Agent dirs ──► read-only display
```

- **Platform library**：`<userData>/tyche-private/skill-library/` 下的 Skill 目录。
- **Native display**：从 11 种 Agent 的原生目录扫描出来，只读展示，不参与角色选择。
- **Role skills**：`role.skills`，数量不设平台上限；只接受平台库中的 ID。
- **Delivery**：只有 `prompt`。`materialize` 把正文注入角色简报，会话按内容哈希轮换。

没有 projection、没有 native / prompt 双通道、没有 trusted / changed 状态。

## 3. 数据

`skill-library.json` 升到 schema v3：

```json
{
  "schemaVersion": 3,
  "sources": {},
  "skills": {},
  "defaults": {}
}
```

迁移：

- v1 `skill-inventory.json`：只保留 `defaults`；旧信任和 eligibility 丢弃，旧文件改名 `.bak`。
- v2 `skill-library.json`：保留 `sources`、`skills`、`defaults`；丢弃 `policy`、`approvedHashes`、`projections`、`releases`。首次加载时写回 v3。
- 旧 Tyche 分发副本如果还留在 Agent 目录，带有 `.tyche-managed.json`，扫描会跳过；平台不再管理它们，可由用户自行删除。

## 4. 后端

| 文件 | 责任 |
| --- | --- |
| `desktop/src/skills/skill-library.cjs` | 平台库扫描、创建/编辑/删除、市场安装/更新、角色选择校验、简报物化 |
| `desktop/src/skills/skill-library-store.cjs` | v3 JSON 状态、原子写、v1/v2 迁移 |
| `desktop/src/skills/skill-market.cjs` | Git 来源、浅克隆、预览、安装、更新 |
| `desktop/src/skills/skill-adapters.cjs` | Agent 标签和原生目录发现辅助 |
| `desktop/src/skills/local-skill-catalog.cjs` | 原生 Skill 发现（只读展示） |
| `desktop/src/shell/skill-library-ipc.cjs` | 窄 IPC：list/detail/create/update/remove/reveal + 市场 |

已删除：`skill-projections.cjs`、`skill-risk.cjs`、`skill-inventory.cjs`。

`assertSelectable(agent, ids)`：

- 校验 agent 合法、ID 合法；
- 只接受平台库中的 Skill；
- 不检查信任、不检查 Agent 兼容性、不限制数量。

`materialize(agent, ids)`：

- 只返回平台 Skill；
- `delivery: 'prompt'`，正文来自平台库；
- 原生 Skill 的 ID 会被丢弃。

`captainInventory(providers)`：对每个可启动 provider 返回同一份平台 Skill 清单（最多 24 条展示）。

## 5. IPC / preload

`skillLibrary`：

```text
summary()
list({ filter?, query? })
detail({ id })
create({ name, description, body })
update({ id, description?, body? })
remove({ id, confirmName })
reveal({ id })
marketSources()
marketAddSource({ url, ref?, subpath? })
marketRemoveSource({ sourceId })
marketPreview({ sourceId })
marketInstall({ token, repo? })
marketCheckUpdates()
marketPreviewUpdate({ skillId })
marketApplyUpdate({ skillId, token })
onChanged(callback)
```

`teamRoom` 保留：

```text
skillInventory()
rememberSkillDefault({ agent, skillIds })
```

已移除：`trustSkill`、`revokeSkill`、`setSkillEligible`、`enableSkillForAgents`、`policy`、`updatePolicy`、`importFromAgent`、`project`、`unproject`、`resolveProjection`。

## 6. 前端

**Settings › Skills**

- 顶部：浏览市场 / + 新建 Skill。
- 筛选：全部 / 共享库 / 市场 / Agent 原生。
- 表格：Skill（名称 + 描述）、来源、更新、操作。
- 平台行：更新（共享库编辑或市场更新）、删除。
- 原生行：只读，无操作。
- 详情：名称、来源、版本、描述、市场来源 URL；操作只有"打开源文件"和"删除"。
- 不显示信任、风险、分发、正文预览、文件清单。

**角色配置**

- 只列出平台 Skill，不再要求先信任或启用。
- 数量不设平台上限，UI 只显示 token 估算。

**权限与安全页**

- Skill 信任策略卡片已移除。

## 7. 已知限制

1. **仓库型 Skill 的工具链不会被 Agent 使用。** 因为不再分发，Agent 只能通过 prompt 拿到 `SKILL.md` 正文，`../cli`、`scripts/` 等文件不可达。市场仍可安装和更新整仓，但当前只作为内容库。
2. **旧分发副本不会自动清理。** 带 `.tyche-managed.json` 的目录被扫描跳过；如需清理，由用户手动删除。
3. **已有角色可能引用原生 Skill ID。** 保存角色时这些 ID 会被丢弃；聊天物化时也会跳过。UI 会提示哪些 ID 不可用。
4. **没有兼容性过滤。** 平台 Skill 对全部可启动 provider 可选；格式是否被某个 CLI 完整支持，由用户自行判断。
5. **没有风险扫描。** 安装或新建 Skill 不再给出 shell、网络、文件写入等标签。

## 8. 验证

```bash
node --test desktop/test/skills/skill-library.test.cjs \
  desktop/test/skills/skill-market.test.cjs \
  desktop/test/shell/skill-library-ipc.test.cjs \
  desktop/test/security/preload-security.test.cjs
node --test desktop/test/room/engine.test.cjs \
  desktop/test/room/repository.test.cjs \
  desktop/test/room/session-store.test.cjs \
  desktop/test/shell/team-room-ipc.test.cjs
cd frontend && NODE_OPTIONS=--no-experimental-webstorage npx vitest run \
  src/__tests__/tyche/skillLibrary.spec.js \
  src/__tests__/tyche/skillInventory.spec.js \
  src/__tests__/tyche/i18n.spec.js
npm --prefix frontend run build
npm --prefix frontend run build:desktop
```

Node 25 下前端测试需要 `NODE_OPTIONS=--no-experimental-webstorage`，否则 Node 内置 webstorage 会先于 jsdom 初始化报错。
