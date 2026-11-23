# 15 Project Skills

更新日期：2026-11-23

角色技能现在有两种交付方式：

1. **prompt**：Skill 正文注入角色 briefing，不写文件。
2. **native（项目投放）**：当 Room 允许写入工作区时，把 Skill 以符号链接放进工作区的 Agent skill 目录，Agent 原生加载，脚本和子目录可用。

## 投放规则

- 触发：Room 的 `write_authorized_root` 等于当前工作区。
- 范围：同一个工作区下所有 active 角色的 `skills_json` 并集。
- 目标目录（按 Room 中出现的 Provider）：

| Provider | 项目目录 |
| --- | --- |
| Claude | `.claude/skills` |
| Codex | `.codex/skills` |
| Gemini | `.gemini/skills` |
| Hermes | `.hermes/skills` |
| DeepSeek | `.dsh/skills` |
| Kimi | `.kimi/skills` |
| Qwen | `.qwen/skills` |
| OpenCode | `.config/opencode/skills` |
| OpenClaw | `.openclaw/skills` |
| WorkBuddy | `.workbuddy/skills` |

- 其他 Provider 使用 `.agents/skills`。
- 每个 Provider 只投放到一个目录，避免同一个 Skill 被两个根目录重复加载。
- 链接名是 Skill 名称，目标是指向平台库真实目录的相对符号链接。
- 仓库型 Skill 的真实目录在 `skill-library/.repos/repo-<id>/skills/<name>`，所以 `../cli`、`scripts/` 等相对路径可以解析。
- 已存在且不是本 Skill 的链接/目录 → 记为 conflict，不覆盖。
- 清空角色技能或撤销写入授权时，只删除 manifest 中记录且仍指向原目标的符号链接；用户文件不动。

## 状态

`<privateRoot>/room/project-skills.json`：

```json
{
  "workspaces": {
    "/path/to/workspace": {
      "links": {
        "/path/to/workspace/.claude/skills/deck": {
          "skillId": "shared/library/deck",
          "target": "/path/to/skill-library/deck"
        }
      }
    }
  }
}
```

## 交付切换

`SkillLibrary.materialize(provider, ids, { workspace })` 会检查项目目录里的符号链接：

- 有有效链接 → `delivery: 'native'`，briefing 只写一行“已原生安装”，不再注入正文；
- 没有链接 → `delivery: 'prompt'`，注入正文。

`delivery` 进入 session skill bindings，所以切换写入授权或增删技能会触发 session 轮换。

## 当前限制

1. **Windows 不支持**：符号链接返回 `supported: false`，仍使用 prompt 注入。
2. **依赖 Agent 跟随符号链接**：Claude Code / Codex 预期支持，其他 CLI 未逐一验证。
3. **写入授权目前由 `authorizeOpenRooms()` 在启动时自动授予**所有 Room；如果以后改成显式授权，project Skill 投放会随之关闭。
4. **同一个工作区被多个 Room 共享时**，投放按所有 Room 的角色技能并集计算。
5. **同名冲突不覆盖**：用户已有的 `.claude/skills/<name>` 会让该 Skill 保持 prompt 交付。
6. **不复制文件**：所有 Agent 共享同一个平台库目录，更新平台 Skill 会立即反映到链接目标。

## 测试

- `desktop/test/room/project-skills.test.cjs`：创建链接、冲突保护、清理、替换。
- `desktop/test/skills/skill-library.test.cjs`：有项目链接时 materialize 使用 native delivery，否则 prompt。
