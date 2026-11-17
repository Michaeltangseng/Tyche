# Meldwork Room v2 交接文档

> 用途：上下文压缩或换会话后，先把下面的“可直接粘贴的 prompt”交给下一个 agent，再按需补充细节。

## 可直接粘贴的 prompt

```text
你是 Tyche / Meldwork 项目的实施 agent。仓库：/Users/limu/Desktop/githubs/33-Tyche/Tyche，分支 project-room。

先读这些文件，不要先写代码：
1. docs-new2/README.md
2. docs-new2/01-principles-and-scope.md
3. docs-new2/02-target-architecture.md
4. docs-new2/03-conversation-session-and-briefing.md
5. docs-new2/04-task-captain-and-report.md
6. docs-new2/06-rewrite-and-migration.md
7. docs-new2/07-decisions.md
8. docs-new2/08-open-questions.md
9. docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md

当前状态：
- docs-new2 已批准为实施基线。
- 实施计划已完成，但还没有写任何产品代码。
- 用户尚未选择执行方式：Native（当前 session 自己实现）或 Subagent-driven（每个任务新 subagent + reviewer）。推荐 Native；不要未经用户确认就派 subagent。
- 用户要求“先不执行”。除非用户明确说开始，否则只做阅读、计划和澄清。

你必须守住的决定：
- 保留 Electron main / preload / renderer 信任边界、原生 CLI 调用、权限、进程注册、Run Ledger、Trace、写入租约、shadow Git、Artifact 快照。
- 新领域代码放在 desktop/src/room/，不要改 desktop/src/room-engine/、desktop/src/project-room/ 或旧 workspace JSON 路径。
- 每个 Chat × Role 一个持久 Chat session；每个 Task lane（executor/mention）一个 Task session；last_seq 属于 participant/lane，不属于 session。
- Agent 自己 create_task / 执行 / finish_task；Captain 只发可见授权，不建任务，不自我派发。
- Captain review 用 eta 的 review supervisor，不做 completion wake、独立 completion 预算或 stage_complete。
- hasNew = activity_seq > max(checkpoint, 各未取消 assignment 的 public 消息 seq)；review 行和 review reply 不计入 activity_seq；post_in_chat 是 public，可能再次触发。
- 5 次唤醒预算只约束 Agent 的 mention 工具；assign_in_group 和 Captain review 不计入。
- Chat 回复默认只读；写入只发生在有授权、writeScopes 和租约的 TaskRun；隔离前每个 Room 同时最多一个写入型 run。
- finish_task 是完成声明，不是结算：退出确认 + 快照/Report 校验后才 in_review/blocked；accept_task 只能在结算后。
- 写入型结算要快照；只读型 snapshot_state=not_applicable，由平台按运行权限确定。
- 观察到的非零退出 = failed/outcome=known；无法确认退出 = interrupted/outcome=unknown，不能合并。
- MCP 是完整工具循环；文本标记只支持单一终止动作，Captain 工具需要 MCP；幂等键是逻辑 callId，不是参数 hash。
- 不回退旧架构，不做双引擎长期兼容；旧数据只做一次性迁移/归档（迁移不在首个切片）。
- 早期阶段允许重写，但不要顺手重构无关代码；每个任务保持可回滚。

执行计划时：
- 按 docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md 的任务顺序，TDD：先写失败测试，再实现，再跑通过，再提交。
- 每个任务只改计划列出的文件；接口名、字段、错误码不要擅自改名。
- Phase 2 必须先跑 Claude Code 和 Codex 的 resume proof；resume 不成立就停下报告，不要继续铺 Task/UI。
- 同时验证 MCP 工具能否 list/call 并回传结果；不能验证就明确降级，不要声称完全自主。
- Phase 2.5 必须用真实 CLI 跑通：持久 session → 工具 → Task session → finish_task → 退出确认 → 快照/结算 → Captain review。
- 报告时给出实际运行的命令和输出；没跑就说没跑。

用户偏好：
- 不要未经允许派 adversarial-review subagent；需要 review 先问。
- 不要用“MVP”框定需求；这是完整产品，分期只在实施计划里。
- 复用优先；能复用现有能力就不要自研。
- Agent for agent：平台不拆大任务、不追踪 Agent 内部步骤。
```

## 当前状态

- 基线文档：`docs-new2/` 已提交。
- 实施计划：`docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md` 已提交。
- 代码：**尚未开始**。
- 执行方式：**未选择**。用户说“先不执行”。
- 最近提交（以实际 `git log` 为准）：
  - `a6da20c` add room v2 vertical slice implementation plan
  - `ef9d31e` tighten project room execution contracts
  - `5f50d7d` record eta-inspired project room rewrite direction

## 关键文件

### 设计基线
- `docs-new2/README.md`：总览、原则、方案对比、明确抛弃项。
- `docs-new2/01`：目标、非目标、约束、术语、成功标准。
- `docs-new2/02`：目标架构、schema 草案、effect 生命周期、MCP/标记、DTO。
- `docs-new2/03`：Message/回复行、Session、简报、routing/mention、Captain review。
- `docs-new2/04`：Task/TaskRun/lane、finish/结算、Report、Agent 工具、Captain、Attention。
- `docs-new2/05`：eta 复用映射（固定 eta commit `03197d88`）。
- `docs-new2/06`：保留/重写/删除、迁移矩阵、阶段、风险。
- `docs-new2/07`：ADR-N1 ~ N21。
- `docs-new2/08`：已定问题、待定问题、证明门槛。

### 实施计划
- `docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md`
- 13 个任务：DB/schema → repository → timeline → session store → routing → briefing → effects/engine → tools/MCP/mention/read → task queue → settlement → Captain review → recovery → real CLI proofs。

### 现有代码参考
- 原生调用：`desktop/src/workspace/local-workspace-agent-invocation.cjs`
- session 原语：`desktop/src/workspace/invocation-session.cjs`
- CLI adapter：`desktop/src/agents/cli/`
- 进程注册：`desktop/src/agents/process/process-registry.cjs`
- Run Ledger / journal：`desktop/src/runs/`
- 写入租约：`desktop/src/runs/path-claims.cjs`
- shadow Git：`desktop/src/project-room/shadow-git.cjs`
- 旧 v2 参考（不要复用 schema）：`desktop/src/room-engine/`
- 真实 CLI smoke 参考：`desktop/scripts/smoke-room.cjs`

### eta 参考
- 源码：`/Users/limu/Desktop/githubs/33-Tyche/eta/eta`
- 固定 commit：`03197d88`
- 关键文件：`apps/eta/src/conversations/{engine,briefing,routing,places}.ts`、`apps/eta/src/tasks/{runner,session-key,tools}.ts`、`apps/eta/src/captain/{supervisor,service,tools}.ts`、`packages/eta-compaction/src/`。
- 注意：另一个 eta commit `fab4012` 使用 `session-owner.ts`；不要混用两个快照。

## 下一步

1. 用户选择执行方式：Native（推荐）或 Subagent-driven。
2. 用户明确说开始后，按计划 Task 1 开始；不要先写 UI、不要先迁移旧数据。
3. Phase 2 proof 是硬门槛：
   - Claude Code resume：记住事实 → resume → 问回事实；
   - Codex resume：同上；
   - MCP：list/call 工具并拿到结果；
   - 任一失败：停下报告，调整设计。
4. Phase 2.5 真实 CLI 接缝通过后，再继续 Task/UI/迁移。

## 验证命令（计划执行时使用）

```bash
# 单个测试
cd desktop && node --test test/room/<file>.test.cjs

# 计划完成后，按 AGENTS.md
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

真实 proof 脚本（计划 Task 13）：

```bash
cd desktop
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-resume-proof.cjs --run --provider claude
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-resume-proof.cjs --run --provider codex
```

## 交接检查

- [ ] 已读 `docs-new2/README.md` 与 `02/03/04`。
- [ ] 已读实施计划的任务列表与 Review Focus。
- [ ] 已确认执行方式。
- [ ] 已确认当前没有未提交的代码改动（文档改动除外）。
- [ ] 已确认 Phase 2 proof 是硬门槛，不会跳过。
