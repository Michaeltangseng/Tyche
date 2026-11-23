# 10 Skill Management

Status: proposed design, 2026-11-23.

This document designs the Skill management mechanism for the settings page, the shared library, native distribution, the Git market client, and Room skill delivery. It follows the external review model: **SkillSource → Release → Skill → Projection**, and the visual target of the Skills page mockup. Where the mockup and the external review conflict with Tyche's read-only and trust-boundary rules, this document records the deviation and the reason.

It supersedes the Skill parts of `system-settings/多Agent平台设置界面重构与Skills页设计图-assets-20261122/Tyche_设置界面重构_实施交接文档.md` §6.2.

**Implementation status (2026-11-23):** Slices A and B are implemented: the v2 library and migration, content-hash trust, import, authoring, projection copies with markers, drift/outdated/conflict handling, the settings matrix and detail panel, row edit/delete actions, the import/editor dialogs, native/prompt Room delivery, real session skill bindings, and the permissions trust-policy card. Market sources, plugin/repo-shaped Skills, project scope, takeover of unmarked folders, and the Agent detail/Room drawer Skill views remain for later slices. The old `skill-inventory.cjs` is no longer wired at runtime; its v1 store is migrated on first launch.

## 1. Goals and scope

### 1.1 Goals

- **One source, many agents.** A Skill is written or imported once into a Tyche-managed library and can be projected to any Agent that reads the standard `SKILL.md` format.
- **Trust is content-bound.** The user approves a content hash, not a name. Changed content becomes `changed` and cannot be used until re-approved.
- **Distribution is explicit and reversible.** Turning a switch on writes a marked copy into the Agent's skill directory; turning it off removes only Tyche-managed copies. Native directories are never modified without an explicit takeover.
- **Room roles can use trusted Skills.** The existing per-role prompt delivery stays; projected Skills use the Agent's native loading instead, without duplicating the full body.
- **Market is a client, not a new content market.** Tyche reads federated sources, pins a release, shows a review page, and never auto-updates.
- **Local-first.** No server, no remote conversation store, no required container. Network is used only by an explicit market fetch.
- **Trust boundary holds.** The renderer gets display-safe DTOs only. It never receives executable paths, native session references, credentials, or a way to start a process.

### 1.2 Non-goals for v1

- Hosting or searching a public content marketplace.
- Plugin bundles (skills + MCP + hooks + commands). The model reserves a place for them; the v1 installer does not unpack them.
- Repo-shaped Skills that ship a toolchain, dependencies, or model downloads (the `huashu-motion` class).
- Symlink projections.
- Project / session / per-step Skill scope. The data model keeps `scope`, but v1 implements `global` only.
- Enterprise private sources and native marketplace import (Claude / Codex `marketplace.json`).

### 1.3 Anti-goals

- Overwriting or deleting an unmarked native directory.
- Silent updates, silent re-trust, or executing a Skill's scripts during import.
- Sending absolute paths, executable paths, PIDs, tokens, or native session references to the renderer.
- Adding a hidden scheduler, a required server, or remote storage.
- Writing into the Room workspace from a chat reply.

## 2. Current state and what changes

| Current | New |
| --- | --- |
| `LocalSkillCatalog` discovers native Skills in 11 Agent roots | Keep as the discovery primitive. Extend it into an Agent adapter table with global and future project roots. |
| `SkillInventory` combines scan, trust, eligibility, defaults, and prompt materialization in one file | Replace with `SkillLibrary` (content + trust + policy), `SkillProjections` (copy / marker / drift), and `SkillMarket` (sources / releases / updates). The room-facing methods stay as a narrow facade. |
| Settings Skills page lists native Skills only; shared / market filters are 0; import / new / market buttons are disabled | Full matrix over native + shared + market Skills, with real counts, import, authoring, market, detail, trust, distribution, and conflict handling. |
| A switch only writes Tyche's own eligibility list. No file is written. | For shared Skills a switch projects a managed copy into the Agent's skill directory. For native Skills the switch remains Tyche eligibility; files stay untouched. |
| Room injection always puts the full Skill body into the briefing | Hybrid delivery: a valid native projection means "installed natively" and no body injection; otherwise the trusted library snapshot is injected. |
| `engine.cjs` / `runtime-adapter.cjs` pass `skillBindings: []` | Pass `{id, contentHash, delivery}` bindings so a Skill change rotates the session, as ADR-N3 requires. |
| `skill-inventory.json` v1 (`eligibility`, `trust`, `defaults`) | `skill-library.json` v2 with sources, releases, Skills, projections, approvals, policy, defaults. One-time migration. |
| Old composer `@` Skill path uses `local-skill-trust-store` | Out of scope in v1. It stays on the legacy workspace path. The design records the convergence target; do not add a second new store. |

## 3. Core model

```text
Source ──► Release ──► Skill (library content)
                         │
                         ├── TrustRecord (content hash, approval preview, risk)
                         ├── Projection × agent × scope  ──► Agent skill directory
                         └── Role binding (room role.skills) ──► native or prompt delivery
```

### 3.1 Entities

| Entity | Responsibility | Key fields |
| --- | --- | --- |
| `Source` | Where content can come from | `id`, `type` (`git` / `curated` / `native` / `local`), `url`, `ref`, `subpath`, `trustTier`, `addedAt`, `lastCheckedAt` |
| `Release` | One immutable resolved fetch | `id`, `sourceId`, `repoUrl`, `commit`, `subpath`, `contentHash`, `fileManifest`, `fetchedAt`, `skillId` |
| `Skill` | One logical Skill stored in the library | `id`, `name`, `description`, `sourceKind` (`shared` / `market`), `origin`, `version`, `contentHash`, `approvedHash`, `risk`, `projections`, timestamps |
| `TrustRecord` | Approval of one content hash | `contentHash`, `approvedAt`, `preview`, `fileManifest`, `riskAtApproval` |
| `Projection` | A placement of a Skill into an Agent | `id`, `skillId`, `agent`, `scope`, `mode` (`copy` / `nativeOrigin`), `targetRef` (internal), `displayPath`, `contentHash`, `deployedAt` |
| `Policy` | Defaults and safety switches | `untrustedByDefault`, `revokeOnChange`, `denySkillNetwork` |
| `Role binding` | A Room role's equipped Skills | `role.skills: [skillId]`, max 8 |

### 3.2 IDs and names

Keep the existing three-segment ID shape so Room role IDs keep working:

- Native Skill: `<agentKind>/<namespace>/<slug>`, for example `claude/global/pptx`.
- Shared or market Skill: `shared/library/<name>`, for example `shared/library/frontend-design`.
- Release: `rel-<sha256 prefix>`.
- Projection: `proj-<sha256 prefix>`.

Name rules follow the Agent Skills specification:

- The folder name is the Skill name.
- Lowercase letters, digits, and hyphens; 1–64 characters; no leading or trailing hyphen.
- `SKILL.md` frontmatter `name` must equal the folder name.
- On import from a native directory, normalize a mismatch in the library copy and show the change in the review sheet. On market install, reject a mismatch instead of rewriting the publisher's content.

### 3.3 Trust state

Trust is evaluated against the current content hash:

| State | Condition | Effect |
| --- | --- | --- |
| `untrusted` | No approval for this hash, and no previous approved hash for this Skill | Not selectable, not projectable, not injectable |
| `trusted` | `approvedHashes[currentHash]` exists | Selectable, projectable, injectable |
| `changed` | This Skill has a previous `approvedHash` that differs from `currentHash` | Not selectable; projections show `outdated`; re-auth required |
| `unavailable` | Unreadable, over the file / size cap, or no hash | Not selectable; UI explains why |
| `revoked` | The user revoked the hash | Treated as `untrusted`; managed projections are removed after confirmation |

Trust is keyed by **content hash**, not by Skill ID. Two Agents that have byte-identical content share one approval. Revoking one Skill clears that Skill's approval; the shared hash record is removed only when no other Skill still uses it, so another identical copy keeps its approval. The confirmation dialog explains the effect.

`approvedHashes[hash]` keeps:

- `approvedAt`
- a `preview` of the approved `SKILL.md` (first 20 lines, ≤1,200 chars)
- a `fileManifest` of relative paths and per-file hashes
- the risk report at approval time

The preview and manifest make the re-auth diff possible without keeping a second full copy of the Skill.

### 3.4 Projection state

Projection state is derived on read, never trusted from the store:

| State | Condition |
| --- | --- |
| `deployed` | Target exists, marker matches, and target hash equals `contentHash` |
| `outdated` | Target matches the deployed copy, but the library Skill now has a newer hash |
| `drifted` | Target exists with the marker, but its content hash differs from `contentHash` |
| `missing` | Target is absent |
| `conflict` | Target exists without a Tyche marker, or with another projection's marker |
| `unsupported` | The Agent adapter has no writable skill root |

`nativeOrigin` projections are a special mode for a Skill imported from an Agent's own directory. Tyche records the association but does not write, move, or delete those files. The projection is `deployed` while the native hash matches, `drifted` when the native file changes, and can be forgotten without touching disk.

### 3.5 Conflicts

A name conflict exists when two records that can serve the same Agent have the same `name` but different `contentHash`. Typical cases:

- A shared Skill and a native Skill with the same name.
- Two Agents' native Skills with the same name and different content.
- A market install whose name already exists in the library.

The read model computes `conflict: { name, variants: [{ skillId, agent, contentHash }] }`. The matrix row shows an amber badge. The detail panel offers:

- **Compare** — side-by-side `SKILL.md` preview and file manifests.
- **Use this version** — make the chosen library version canonical.
- **Adopt native** — copy the native version into the library (the native directory remains untouched).
- **Take over the native directory** — an explicit, confirmed action that backs up the native directory and replaces it with a managed projection. This is the only path that writes over an unmarked directory.

v1 implements Compare, Adopt native, and Use this version. "Take over" is a separate confirmation and can be deferred.

## 4. Filesystem layout

```text
<userData>/tyche-private/
  skill-library.json                  # authoritative state, atomic writes
  skill-library/
    <name>/
      SKILL.md
      scripts/ references/ assets/     # copied as-is
      .tyche-provenance.json           # excluded from content hash
  skill-backups/
    <name>/<timestamp>/                # previous versions and takeover backups
  skill-trash/
    <timestamp>/<name>/                # deleted library Skills, purge later
  skill-market/
    staging/<fetchId>/                 # fetch then validate, never executed
    releases/<releaseId>/              # optional retained release content
```

Projection target for a managed copy:

```text
<agent skill root>/<name>/
  SKILL.md
  ...
  .tyche-managed.json
```

`.tyche-managed.json`:

```json
{
  "schemaVersion": 1,
  "projectionId": "proj-...",
  "skillId": "shared/library/frontend-design",
  "contentHash": "<sha256>",
  "mode": "copy",
  "createdAt": "2026-11-23T00:00:00.000Z"
}
```

Renderer display paths are home-relative (`~/.claude/skills/frontend-design`) and read-only. Absolute paths and the `targetRef` stay in the main process.

## 5. Sources and discovery

### 5.1 Native discovery

Reuse the roots already encoded in `local-skill-catalog.cjs`, promoted into a data-driven adapter table:

| Agent | Global roots (v1) |
| --- | --- |
| Claude | `~/.claude/skills`, `~/.agents/skills` |
| Codex | `~/.codex/skills`, `~/.agents/skills`, Codex plugin cache |
| DeepSeek | `~/.dsh/skills`, `~/.agents/skills` |
| Gemini | `~/.gemini/skills` (or the configured directory) |
| Pi | `~/.pi/agent/skills` |
| Hermes | `~/.hermes/skills` |
| Kimi | `~/.kimi-code/skills`, `~/.kimi/skills` |
| Qwen | `~/.qwen/skills` (or the configured directory) |
| OpenCode | `~/.config/opencode/skills`, `~/.config/opencode/skill` |
| OpenClaw | `~/.openclaw/workspace/skills`, `~/.openclaw/skills` |
| WorkBuddy | `~/.workbuddy/skills`, WorkBuddy marketplace plugin roots |

The adapter keeps the existing `configDirectoryForKind` / `sharedDirectoryForKind` inputs. Native Skills are always read-only.

Project roots (`.claude/skills`, `.codex/skills`, `.gemini/skills`, `.agents/skills` under a workspace) are declared by the same adapter table but are not used in v1. They are the hook for project scope later.

### 5.2 Shared library

- The library is a directory of Skill folders plus the v2 store.
- A folder is valid when it contains `SKILL.md`, the name matches the folder, and the file caps pass.
- Library Skills have `sourceKind = shared` unless they came from a market release (`sourceKind = market`).
- The library is the source of truth for distribution and for prompt delivery. The main process scans it on open, after a write, and on a debounced file change.

### 5.3 Market sources

v1 supports `git` sources only:

- `url` must be HTTPS, without embedded credentials.
- `ref` defaults to the remote HEAD; a branch, tag, or full commit is accepted.
- `subpath` selects a directory. If it is empty, Tyche scans the repository for `SKILL.md` folders with a bounded search and lets the user pick one.
- The resolved commit SHA is pinned in the `Release`. A branch name alone is never enough to install.

The source model reserves `curated`, `nativeMarketplace`, and `local` types. v1 exposes only `git` in the UI.

## 6. Import and authoring

### 6.1 From Agent

1. The user opens **从 Agent 导入**.
2. Tyche lists every native Skill found across the detected Agents, with Agent, name, description, trust state, hash, and conflict flags.
3. Selecting a row shows a review sheet: `SKILL.md` preview, file list with sizes, risk labels, name normalization (if needed), and a conflict notice.
4. On confirm, Tyche copies the Skill into the library (never moves the native directory), writes `.tyche-provenance.json`, records `origin = { type: 'import', fromAgent, namespace, slug }`, and computes the hash.
5. If the Skill was already trusted in Tyche, the approval for that hash is reused. Otherwise it is imported as `untrusted` unless the user chooses **信任此版本** in the same review.

The origin Agent gets a `nativeOrigin` projection record when the native directory has the same name and content. No files are written for it. Other Agents get managed projections when the user turns their switch on.

### 6.2 New Skill

- Fields: name (validated), description, `SKILL.md` body, optional target Agents.
- A template pre-fills the six standard frontmatter fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.
- Saving writes the folder into the library, computes the hash, and creates an approval for the content because the user authored it in this session.
- Target Agents selected in the dialog create managed projections immediately, after the same write confirmation as a matrix switch.

### 6.3 Market install

1. Add a Git source (URL, optional ref and subpath).
2. Tyche fetches into `skill-market/staging/<fetchId>`, resolves the commit, validates `SKILL.md`, and runs the static risk scan. Nothing in the staging tree is executed.
3. The review page shows: source commit, `SKILL.md`, file manifest, risk labels, compatibility notes, and the content hash.
4. **Install** copies the Skill into the library, records the `Release`, and leaves the Skill untrusted. The user trusts it on the same page or later.
5. A market Skill keeps `sourceKind = market` and its `releaseId`; the market filter uses this provenance.

### 6.4 Validation rules

- `SKILL.md` must be present, UTF-8, and under the header cap (64 KB).
- Name must match the folder and the specification.
- Files: at most 256 regular files, 1 MB per file, 8 MB total. Larger Skills are `unavailable`; repo-shaped support raises the cap later.
- Symlinks are rejected on import. Projection never follows a symlink.
- Path traversal, absolute paths inside the Skill, and `..` escapes are rejected.
- `.git`, `node_modules`, `.DS_Store`, `.tyche-managed.json`, `.tyche-provenance.json`, and `.tyche-tmp-*` are excluded from the copy and the hash.
- The risk scan records executable bits and `scripts/` presence; it does not run them.
- A `SKILL.md` reference to `../` is flagged as `external-paths` so the user knows a pure-text import may be incomplete.

## 7. Distribution

### 7.1 Adapter contract

Each Agent adapter provides:

- `kind`, `displayName`
- `globalRoots()`, `projectRoots(workspacePath)` (project roots unused in v1)
- `canProject` (false when the root is unknown or unwritable)
- `unsupportedReason`
- The existing `configDirectoryForKind` / `sharedDirectoryForKind` inputs

v1 copies `SKILL.md` and its files as-is. Target-specific frontmatter merging (the `skill.targets.yaml` idea) is a later addition; the library stays standard-only.

### 7.2 Project

1. Validate the Skill is trusted and the Agent adapter supports projection.
2. Target is `<root>/<name>`.
3. If the target exists:
   - Managed by this projection → update: back up the current target, stage the new copy, swap.
   - Managed by another projection → `conflict`, refuse.
   - Unmarked → `conflict`, refuse, unless it is the origin of a `nativeOrigin` projection (then record the association without writing).
4. Stage the copy in a sibling temp directory, write the payload, compute `deployedHash`, write `.tyche-managed.json` last, then rename into place.
5. Record the projection and emit `skill-library:changed`.

Copy mode is the only mode in v1. The reasons: Windows symlink privileges, some Agents not following links, and drift semantics that need a marker file. Symlink can be added later as an explicit per-Agent option.

### 7.3 Unproject

- Managed projection: refuse if `drifted`. The user must restore, adopt, or explicitly discard the edits first. Then remove the directory only if its marker matches.
- `nativeOrigin`: forget the association; never touch the native files.
- Removing a library Skill removes its managed projections but leaves native-origin directories and requires name confirmation.

### 7.4 Drift and outdated

- A debounced watcher on each managed projection and on the library root triggers a hash check.
- On startup and on every list, status is re-derived.
- `drifted` offers: restore from the library, adopt the edited copy into the library (new hash, re-auth), or stop managing (becomes native).
- `outdated` (library changed, target still matches the old deployed hash) offers **Update projection**. It never overwrites a drifted target silently.
- Content changes never auto-delete files. The `revokeOnChange` policy clears role bindings and marks projections outdated; it does not remove them.

### 7.5 Conflicts and same-name native Skills

- A managed projection is blocked by an unmarked same-name directory. The UI explains which Agent and path, and offers **导入该原生版本** or **接管** (explicit, backed up).
- The matrix row groups the variants by name and shows the conflict badge. A conflict never blocks the native Skill itself; it only blocks a new projection with the same name.

## 8. Trust and security

### 8.1 Content hash

`sha256` over the sorted relative paths and file bytes, excluding the entries listed in §6.4. The hash covers the whole Skill directory, not only `SKILL.md`.

The store keeps a `contentHash` and a small scan cache (`mtime`, `size`, `hash`) so a list does not rehash an unchanged Skill. A change at any file invalidates the hash.

### 8.2 Approval and re-auth

- Approving stores `contentHash`, `approvedAt`, `preview`, `fileManifest`, and the risk report.
- On a hash change, the Skill becomes `changed`. The detail panel shows a diff of the approved preview against the current `SKILL.md`, plus the file additions, deletions, and modifications from the manifest. New `allowed-tools`, hooks, scripts, or network patterns are highlighted first.
- Re-approval replaces the record and creates a new approval for the new hash.
- Revoking removes the approval, clears role bindings, and removes managed projections after confirmation. Native-origin files are not touched.

### 8.3 Risk scan

Static only. It reads text and file metadata, never executes anything:

| Label | Severity | Trigger |
| --- | --- | --- |
| `dynamic-command` | High | `!` command syntax, inline shell, `eval`, `base64 -d` pipelines |
| `shell-tools` | High | `allowed-tools` grants `Bash`, `exec`, or an unrestricted shell |
| `hooks` | High | hook declarations in frontmatter or a `hooks/` directory |
| `scripts` | Medium | `scripts/` or executable files |
| `network` | Medium | `curl`, `wget`, `nc`, `ssh`, `scp`, or URL fetches in scripts |
| `file-write` | Medium | commands that write outside the Skill directory |
| `external-paths` | Medium | `../` references outside the Skill folder |
| `large-assets` | Low | large files or a directory near the cap |
| `nonstandard-fields` | Info | frontmatter fields outside the six standard ones |

The scan is advisory. It is not a sandbox proof. The review page says so.

### 8.4 Market pinning and updates

- Every install points at a resolved commit, not a branch.
- **Check updates** uses `git ls-remote` and only reports. It never fetches content or updates automatically.
- An update fetches the new commit into staging, runs the risk scan, shows the diff and the new hash, and requires the user to install and re-trust. The previous release stays in `skill-backups`.
- A plugin's hooks are a separate trust surface and are not executed by Tyche in v1.

### 8.5 Boundaries

- Projection writes only inside adapter roots. The Room workspace is never a projection target in v1.
- Chat replies remain read-only. Skill installation, distribution, and trust are explicit user actions in settings.
- The renderer receives IDs, labels, home-relative display paths, hashes, and risk labels. It never receives `sourceDirectory`, `targetRef`, a native session reference, a PID, or credentials.
- **打开源文件** is an IPC action performed by main, which resolves the path itself and reveals it through the OS. The renderer cannot pass a path or start a process.
- Market fetch is HTTPS-only, has timeouts and size limits, rejects archive path traversal and symlinks, and never runs install scripts. Private repositories and keychain credentials are later.
- `denySkillNetwork` is a review policy: it blocks approving or installing Skills with network risk labels. It is not a runtime network sandbox; the UI must say that.

## 9. Room integration

### 9.1 Role selection

- `role.skills` keeps the current max of 8 IDs.
- A native Skill is selectable only for its origin Agent and only when trusted and eligible.
- A shared or market Skill is selectable for any Agent that reads the format when it is trusted. Projection is not required for role use; prompt delivery works without writing files.
- The Captain's briefing inventory uses the same trusted set, capped at 24 per provider, and `create_role` / `add_members` validate the chosen IDs through `SkillLibrary.assertSelectable`.
- `defaults` per Agent stay; **remember as default** stores trusted, selectable IDs.

### 9.2 Delivery

Two delivery channels:

| Channel | When | What the run sees |
| --- | --- | --- |
| `native` | A valid managed (or native-origin) projection exists for the provider and scope | A short line that the Skill is installed and should be used; no full body injection |
| `prompt` | No valid projection | The trusted snapshot body, as today (`Equipped skills. Follow these recorded instructions...`) |

If a projection is `drifted` or `missing`, Tyche falls back to `prompt` from the trusted library copy and surfaces the projection problem in settings. It does not trust the modified native copy.

The `config` / `scope` / `delivery` decision is made in the main process and is not exposed as an executable path.

### 9.3 Session rotation

Pass `skillBindings = [{ id, contentHash, delivery }]` into `sessions.ensureSession` for chat and task runs. The current code passes an empty array. With the real bindings, a re-trusted or changed Skill changes the JSON and the session rotates, matching ADR-N3.

### 9.4 Room drawer (later)

The Room settings drawer gets a Skills tab: inherit / custom, with a matrix of the Room's members. v1 settings can ship without it; the role editor already exposes per-role selection. Per-step Skills stay a later phase.

### 9.5 Token estimate

Show an estimate in the role editor and the detail panel:

```text
metadata ≈ 100 tokens per Skill
prompt body ≈ ceil(bodyChars / 4)
native projection adds no prompt body
```

Label it as an estimate. The hard limits remain 8 role Skills and 24 Captain inventory entries.

## 10. UI design

### 10.1 Settings › Skills

Follow the mockup's three-column layout: settings navigation, matrix, detail panel.

**Header**

- Title: Skills.
- Subtitle: 集中管理所有 Agent 的 Skill：一次编写，分发到多个 Agent。
- Buttons: **浏览市场**, **从 Agent 导入**, **+ 新建 Skill** (all enabled).

**Filters**

- Search.
- Chips with counts: 全部 n · 共享库 n · Agent 原生 n · 市场 n · 需重新授权 n. Add 冲突 n when conflicts exist.
- Counts come from the read model, not hard-coded.

**Matrix**

- Columns: detected Agents, ordered Claude, Codex, Pi, Gemini, Hermes, then the rest. An Agent appears when it is detected, has a native Skill, or has a projection. A column manager is a later addition.
- A row is one Skill record. It shows the name, source badge (共享库 / Agent 原生 / 市场), version or hash prefix, trust state, and update time.
- Cell states:
  - Shared / market: toggle on = managed projection (or `nativeOrigin`), toggle off = absent. `unsupported` shows `—` with a reason tooltip. Untrusted / changed is disabled with an amber hint and a link to trust.
  - Native: toggle on = Tyche eligibility for the origin Agent. Other columns show `—`. The files are never moved.
- Trust cell: dot + label. `changed` is amber; `unavailable` is gray; `trusted` is green.
- Update column: relative edit time in the library; "有更新" badge for market Skills with a newer commit; `—` for native.
- Conflict rows show an amber badge next to the name; the detail panel and the conflict filter explain the variants.
- The mockup's "示例路径，不会写入本机目录" note is removed. Distribution now writes real, marked copies after an explicit switch.

**Detail panel**

- Name, version / source, description.
- Risk labels (with a tooltip that the scan is advisory).
- **已分发到**: one row per Agent with a display path, state (`已分发` / `待更新` / `已修改` / `缺失` / `冲突`), and copy action. Native-origin shows `原生（未由 Tyche 管理）`.
- `SKILL.md` preview (first 20 lines).
- Actions:
  - **分发到其他 Agent** — agent picker; each target is confirmed.
  - **打开源文件** — main reveals the library or native path.
  - **信任此版本 / 重新授权** — with preview, risk, and diff for re-auth.
  - **撤销信任** — dangerous; lists affected projections and role bindings.
  - **删除** — library Skills only; moves to trash and removes managed projections; requires typing the name (L2).
- For `changed`: an amber banner, **查看差异**, and **重新授权**.
- For `drifted`: **恢复** / **采纳当前内容** / **停止管理**.
- For `outdated`: **更新分发**.

**Import dialog**

- Tabs or filters by Agent; search; multi-select.
- Review sheet with preview, files, risk, name normalization, and conflicts.
- Import copies; it never moves or overwrites native files.

**New Skill dialog**

- Name, description, body editor with the standard template, target Agents.
- Name validation inline. Saving writes to the library and trusts the authored content.

**Market dialog**

- Source list with URL, ref, last checked, trust tier.
- **添加来源** (Git URL, optional ref/subpath), **检查更新**.
- Entry list with SKILL.md preview, files, risk, commit, and install.
- Update offers a diff and a re-trust step; no auto-update.

### 10.2 Permissions › Skill trust policy

- Toggles for `untrustedByDefault`, `revokeOnChange`, and `denySkillNetwork`, stored in the library policy.
- A summary line: "n 个 Skill 需重新授权" with a link to Skills.
- Explain that `denySkillNetwork` is review-time, not a runtime sandbox.

### 10.3 Agent detail › Skills

- **来自共享库**: projected and injectable Skills with a distribution state.
- **{Agent} 原生**: native Skills with trust and an **导入到共享库** action.
- Context estimate and a Room usage summary.
- This is a later slice; the page already has a read-only Skill list today.

### 10.4 Room settings drawer

- Skills tab: inherit / custom, matrix over the Room's members, only trusted Skills, and an estimated context occupancy.
- Per-step Skills are later.

### 10.5 Shared UI rules

- All copy goes through i18n with Chinese and English keys.
- Overlays close on Escape and back, and lock background scroll.
- Keep the existing Room visual language: dark surfaces, accent chips, 10 px cards, compact tables.
- Empty, loading, error, and unavailable states are explicit. A store error shows a banner with retry; it does not crash the settings page.

## 11. IPC and preload

Add a dedicated `skillLibrary` preload namespace. Keep the room-facing `teamRoom.skillInventory` methods for the role editor and delegate them to the same service.

```text
skillLibrary.summary()                       -> { agents, counts, policy }
skillLibrary.list({ filter?, query? })       -> { rows, counts }
skillLibrary.detail({ id })                  -> display-safe detail
skillLibrary.trust({ id })
skillLibrary.revokeTrust({ id })
skillLibrary.importFromAgent({ ids: [] })
skillLibrary.create({ name, description, body, targets: [] })
skillLibrary.update({ id, description, body })
skillLibrary.remove({ id, confirmName })
skillLibrary.project({ id, agent })
skillLibrary.unproject({ id, agent })
skillLibrary.resolveProjection({ projectionId, action })
skillLibrary.reveal({ id })
skillLibrary.addMarketSource({ url, ref?, subpath? })
skillLibrary.listMarketSources()
skillLibrary.checkMarketUpdates({ sourceId? })
skillLibrary.installRelease({ releaseId })
skillLibrary.removeMarketSource({ sourceId })
```

- Every input is validated in main: IDs against the ID regex, names against the name rule, Agents against the adapter table.
- The renderer cannot pass a path, a command, an environment variable, or a URL with credentials.
- Results contain display-safe DTOs only. `displayPath` is home-relative; `targetRef`, `sourceDirectory`, and process handles never cross IPC.
- Errors use stable codes (`SKILL_NOT_FOUND`, `SKILL_TRUST_REQUIRED`, `SKILL_HASH_CHANGED`, `SKILL_PROJECTION_CONFLICT`, `SKILL_PROJECTION_DRIFTED`, `SKILL_UNSUPPORTED_AGENT`, `SKILL_NAME_CONFLICT`, `SKILL_TOO_LARGE`, `SKILL_PATH_UNSAFE`, `SKILL_MARKET_INVALID`, `SKILL_MARKET_FETCH_FAILED`) and map to i18n messages.
- Emit `skill-library:changed` after any mutation; settings and the room refresh.

Main-process modules:

```text
desktop/src/skills/
  skill-library.cjs          # facade: list, detail, trust, import, create, remove, assertSelectable, materialize
  skill-library-store.cjs    # v2 JSON store, atomic write, v1 migration
  skill-library-scan.cjs     # native + library scan, hash cache, conflict computation
  skill-adapters.cjs         # agent roots and projection support
  skill-projections.cjs      # copy, marker, drift, unproject, takeover
  skill-risk.cjs             # static risk scan
  skill-market.cjs           # git sources, staging, releases, update check
desktop/src/shell/
  skill-library-ipc.cjs      # narrow IPC registration
```

## 12. Persistence, migration, recovery

### 12.1 Store shape

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
  "skills": {
    "shared/library/frontend-design": {
      "name": "frontend-design",
      "sourceKind": "shared",
      "origin": { "type": "import", "fromAgent": "claude", "namespace": "global", "slug": "frontend-design" },
      "version": null,
      "contentHash": "<sha256>",
      "approvedHash": "<sha256>",
      "projections": ["proj-..."],
      "createdAt": "...",
      "updatedAt": "..."
    }
  },
  "approvedHashes": {
    "<sha256>": {
      "approvedAt": "...",
      "preview": "...",
      "fileManifest": [{ "path": "SKILL.md", "hash": "..." }],
      "risk": { "level": "medium", "labels": ["scripts"] }
    }
  },
  "projections": {
    "proj-...": {
      "skillId": "shared/library/frontend-design",
      "agent": "claude",
      "scope": "global",
      "mode": "copy",
      "targetRef": "/Users/.../.claude/skills/frontend-design",
      "displayPath": "~/.claude/skills/frontend-design",
      "contentHash": "<sha256>",
      "deployedAt": "..."
    }
  },
  "defaults": { "claude": ["shared/library/frontend-design"] }
}
```

- Writes go to a temp file in the same directory, `0600`, then `rename`. The directory is `0700`.
- The store never contains secrets.
- `targetRef` is internal; the renderer DTO uses `displayPath`.

### 12.2 Migration from `skill-inventory.json` v1

- Native IDs stay the same, so existing `role.skills` values keep resolving.
- `trust[id].contentHash` becomes `approvedHashes[hash]` plus `skills[id].approvedHash`.
- `eligibility[id]` becomes native eligibility for the origin Agent.
- `defaults` carry over.
- No shared Skills, projections, or market sources are created.
- Keep the v1 file as `skill-inventory.json.bak`.
- If the store is unreadable, back it up, start empty, and surface a settings banner. Do not fail app startup.

### 12.3 Recovery

- On startup: reconcile library folders and projections; mark `missing`, `drifted`, `outdated`, and `conflict`; never delete user files.
- Clean stale staging directories and expired trash on a schedule.
- A projection update is a copy to temp + swap; a failed swap restores the backup.
- The watcher is debounced; the list and detail always re-derive the state so a missed event is not permanent.

## 13. Implementation slices

### Slice A — Library foundation (read parity)

- `skill-library-store.cjs`, `skill-library-scan.cjs`, `skill-adapters.cjs`, `skill-library.cjs`.
- v1 migration.
- `skillLibrary.list/detail/trust/revokeTrust` IPC and preload.
- Settings Skills page renders the real native set with trust and counts (no shared/market yet).
- Tests: store atomicity, migration, trust state, hash cache, invalid input.

### Slice B — Import, authoring, distribution

- `skill-projections.cjs`, `skill-import` path.
- Import dialog, new Skill dialog, distribution switches, detail panel, drift / conflict / outdated states.
- Copy, marker, unproject, backup, native-origin projection.
- Tests: import copy, project/unproject, unmarked conflict, drift, takeover refusal, content hash exclusions.

### Slice C — Market client

- `skill-risk.cjs`, `skill-market.cjs`.
- Git source add, staging fetch, release review, install, update check.
- Trust diff and risk UI.
- Tests: local bare Git repository fixture, pinning, invalid source, update detection, no auto-update.

### Slice D — Room integration

- Role picker backed by the library; delivery channel selection; session bindings.
- Captain inventory and tool validation.
- Briefing native vs prompt delivery.
- Permissions policy card; Agent detail Skills tab and Room drawer if scope allows.
- Tests: native projection suppresses body injection; drifted projection falls back to prompt; session rotates on binding change; room selection rejects untrusted/changed.

### Slice E — Later

- Repo-shaped Skills (repo + subpath + dependency check + data directory).
- Plugin unpack and component routing.
- Project / session / per-step scope.
- Native marketplace adapters.
- Symlink projections and takeover of unmarked directories.

## 14. Verification

Automated:

- `npm --prefix desktop test`
- `npm --prefix frontend test`
- `npm --prefix frontend run build`
- `npm --prefix frontend run build:desktop`

Manual in Electron:

1. Import a native Skill, distribute it to another Agent, confirm the marked copy and the trust state.
2. Edit the projected copy and confirm `drifted`; restore and confirm it recovers.
3. Change the library `SKILL.md` and confirm `changed`; re-auth diff appears; projections show `outdated`.
4. Create two native Skills with the same name and different content; confirm the conflict badge and compare.
5. Add a local Git source, install at a pinned commit, then create a new commit and confirm "update available" only.
6. Equip a shared Skill in a Room role; confirm prompt delivery; distribute it and confirm native delivery without duplicate body.
7. Confirm the renderer never receives an absolute path, executable path, or secret in the Skill DTOs.

Acceptance scenarios for the first release:

- A user can import `pptx` from Claude, distribute it to Codex, and see it in `~/.codex/skills/pptx` with a marker.
- A user can revoke trust and see the managed copy removed, while the original native Skill is untouched.
- A changed Skill cannot be selected by a role or injected until re-approved.
- A market update never installs without review and re-auth.

## 15. Decisions and open questions

### Decisions

1. **Native directories are read-only.** The native switch means Tyche eligibility, not a file move. This deviates from the handoff doc's "native off → move to a disabled area" and follows the external review's "no marker = user-owned".
2. **Projection and Room delivery are separate.** The matrix switch is native distribution. Role delivery uses native when a valid projection exists, otherwise prompt injection. This preserves role-scoped skills without writing into the read-only chat workspace. It deviates from the handoff doc's "Room only lists globally distributed Skills" for the same reason.
3. **The library lives in app data**, not `~/.agents/skills`. It gives provenance, markers, atomic writes, and no home-directory pollution. An export/link to `.agents/skills` can be added later.
4. **v1 covers pure `SKILL.md` Skills.** Repo-shaped toolchains and plugins are later; they execute code and need a different trust tier.
5. **The market is a Git client in v1.** No hosted catalog, no search index, no auto-update.
6. **Trust is keyed by content hash across Agents.** Identical content shares one approval; revoking affects all identical copies.
7. **Copy-only projections in v1.** Symlinks are later.
8. **Only detected Agents are columns.** A column manager is later.
9. **No script execution, no silent trust, no silent update.** Platform invariants.
10. **Session bindings are real.** `skill_bindings_json` must contain `{id, contentHash, delivery}` so a Skill change rotates the session.

### Open questions

1. Do we implement "take over an unmarked native directory" in v1, or defer it and require the user to resolve the native conflict outside Tyche? Recommendation: defer; keep the safe default.
2. Does the first release need project-scope distribution (a Room workspace's `.claude/skills`), or is global-only enough? Recommendation: global-only; add project scope with Task write authorization.
3. Do we keep only the current release plus one backup, or retain all market releases? Recommendation: current + last backup.
4. Is a Tyche-curated official source planned, so the trust tiers are meaningful? Recommendation: define the tier now, ship community Git first.
5. Should the library support multiple versions of one Skill name? Recommendation: one active version; backups and releases provide rollback.

## Appendix A — Adapter table

The adapter table is the single place that knows Agent paths. It replaces the duplicated root tables in `local-skill-catalog.cjs`. Global roots are listed in §5.1; project roots will be added when project scope is implemented.

## Appendix B — Marker and provenance

`.tyche-managed.json` is written last into a managed projection. `.tyche-provenance.json` is written into a library Skill and records:

```json
{
  "schemaVersion": 1,
  "skillId": "shared/library/frontend-design",
  "sourceKind": "shared",
  "origin": { "type": "import", "fromAgent": "claude", "namespace": "global", "slug": "frontend-design" },
  "release": null,
  "contentHash": "<sha256>",
  "installedAt": "2026-11-23T00:00:00.000Z"
}
```

Both files are excluded from the content hash.

## Appendix C — Risk rules

The risk scanner reads `SKILL.md`, frontmatter, file names, executable bits, and text files under the size cap. It produces `{ level, labels, findings }` with safe strings. It never reads secrets into the DTO and never executes a file. `denySkillNetwork` blocks approval or install when `network` is present; the UI states that it is a review policy, not a runtime sandbox.
