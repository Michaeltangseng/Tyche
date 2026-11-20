# Tyche desktop client

Tyche is an Electron client that runs entirely on this computer. It loads the desktop frontend from this repository and detects and invokes local Agent CLIs in the Electron main process. It does not need a login, a JWT, a remote platform, Docker, or a cloud service.

Local group chats, messages, group configuration, and CLI session references are stored in the Electron user-data directory. The renderer calls the constrained preload API only through `window.tycheDesktop`. It does not receive executable paths, provider API keys, or arbitrary shell execution.

The client can detect and invoke these local Agent CLIs:

- Codex
- Hermes
- OpenClaw
- WorkBuddy
- Zcode
- Pi Agent
- Kimi Code
- MiMo Code
- DeepSeek Harness
- Claude Code
- Gemini CLI
- OpenCode
- Qwen Code
- OpenCodeReview

See the [Agent Connector SDK](AGENT_CONNECTOR_SDK.md) for the current Connector package scope, examples, and verification.

The Agent management panel offers an allowlisted install entry. Install commands and download URLs are fixed in the main process. Page input never becomes an arbitrary command. Built-in Agents run with their own native permission mode or with a Tyche-managed tool policy. An Agent that cannot meet the current permission contract fails closed. Group-level workspace writes are off by default and turn on only after an explicit user authorization. In a read-only conversation, Kimi runs through the Agent Client Protocol `plan` mode. After the user turns writes on, it switches to Kimi's native `stream-json --prompt` mode.

## First launch and local Agent detection

The V1.0.7 GitHub prerelease uses an ad-hoc signature. It does not use an Apple Developer ID and it is not notarized. If macOS blocks the app on first launch, open System Settings → Privacy & Security, find this app's block notice, choose Open Anyway, and confirm.

The first launch shows a three-page carousel: local Agent detection, multi-Agent collaboration, and Skill and file context. The client runs one startup refresh when the carousel opens. Get Started stays disabled until detection actually finishes. It is not released by a fixed timer. The button is released after detection succeeds or fails. Finishing or closing the carousel records that state in the renderer. Later launches go straight to the workspace. Agents can still be detected again from the management panel.

## Concurrent collaboration harness V4

After several Agents are selected in a group chat, Concurrent Responses freezes one task snapshot before any Agent takes a scheduling slot. Every selected Agent generates independently, and the batch commits in a stable order after the barrier.

Auto Discussion moves through independent proposals, cross-questioning and responsibility negotiation, divided execution, single-writer synthesis, and independent review. The responsibility graph comes from the Agents. The harness validates the one plan everyone agreed to, plus dependencies, permissions, receipts, recovery, and commit boundaries. It does not assign work privately outside the model. Participants are still chosen by the user. Automatic selection from a larger pool is not in this version.

## `@` Skill references

Type `@` in the composer, or click the `@` button, to pick a Skill already discovered for the current target Agent. The list returns only the sanitized Agent, namespace, slug, and display name. It does not return Skill file paths or contents. One message can select at most four Skills. Before send, the main process scans again for the target Agent and validates the selection. A Skill claimed for another Agent, a stale entry, or an arbitrary path built by the frontend is rejected. Hermes preloads a validated Skill with its native `--skills` argument. Other Agents receive only their own Skill coordinates. They do not receive another target's selection.

## Files and multimodal attachments

The composer accepts the system file picker, clipboard images, and files dropped onto the input. It accepts PNG, JPEG, audio, video, PDF, text, Markdown, common code and configuration files, Office documents, and common archive containers after MIME type, extension, and file signature agree. One message can have at most four attachments, and each format has its own size limit. Attachments are copied into private storage under the Electron user-data directory. A workspace message stores only `id`, file name, MIME type, and size. The renderer cannot read the attachment path. It can request a preview, or open the file with the system default app, only through a narrow IPC call.

Images a native Agent supports are passed directly, within that Agent's count limit. Other files, and attachments past an Agent's native media capability, are staged as read-only input files in the workspace for the run and removed when the run ends. The prompt tells the Agent to read them and not to execute them. Unsent attachments, unreferenced attachments after a conversation is deleted, and leftover failed imports are reclaimed by the main process.

## Provider configuration

Each Agent uses its own local native authentication, provider, and default model configuration. Tyche does not require one shared provider, and it does not inject one Agent's secret into another. An encrypted WorkBuddy desktop login cannot unlock the standalone CLI directly. In Tyche you can select a model that is already present and authenticated in the desktop configuration. Tyche stores only the model identifier. At runtime the main process reads the native configuration and does not return secrets to the renderer. Zcode keeps its default configuration. If that default provider has no API key, fix the local native configuration first.

Hermes's native configuration directory setting shows the provider named in `config.yaml`, including nested models and the older root-level configuration, or `HERMES_INFERENCE_PROVIDER` when the file does not name one. `auto` means Hermes chooses. It does not mean the final route is known. When the file cannot be read or has no clear configuration, the setting shows unspecified. This summary does not return credentials. Codex settings show `model_provider` from the user configuration, including the selected profile. Project configuration or runtime arguments can still override it, so the value is not the final provider of every call.

DeepSeek Harness uses the `dsh` ACP profile. When no native ACP provider or model is set, it connects to ZGCI `smart-router-v2` by default. If the ACP profile or `cordis.patch.yml` in the DSH home already names a provider or model, that native configuration and its declared credential environment variables are used. Set `ZGCI_API_KEY` in DeepSeek Harness's native credential service, or provide the variable in the environment that starts Tyche. Tyche does not store that secret. The default is read-only. Workspace writes are allowed only after authorization. Changing the permission mode starts a new native session, and Tyche supplies the conversation context. A native escalation that asks for more than the selected workspace permission is refused.

Settings → Agents → DeepSeek Harness → Model and usage lists the default model, credential setup, and capability range. After configuring credentials, refresh, then open a direct chat or add it to a group. Direct chats and group chats keep separate native sessions. A group can choose concurrent responses, ordered discussion, or auto discussion. File attachments are provided through a controlled staging path. Local Skills can be chosen from the composer. There is no native image input yet. The icon comes from `Contents/Resources/icon.png` in the official macOS app. The source is recorded in `frontend/public/agent-logos/deepseek-source.md`.

## Local CLI support matrix

| Agent | Detect command | macOS install | Windows install | User provider |
| --- | --- | --- | --- | --- |
| Codex | `codex` | npm: `@openai/codex@latest` | npm: `@openai/codex@latest` | Not injected. Uses the local Codex configuration |
| Hermes | `hermes` | Official `install.sh` | Official `install.ps1` | Uses the local configuration |
| OpenClaw | `openclaw` | npm: `openclaw@latest` | npm: `openclaw@latest` | Uses the local configuration |
| WorkBuddy | `codebuddy` | npm: `@tencent-ai/codebuddy-code@2.115.0` | npm: `@tencent-ai/codebuddy-code@2.115.0` | Can select a model already configured in the desktop app |
| Zcode | `zcode` | Official CLI install | Official CLI install | Uses the default configuration |
| Pi Agent | `pi` | npm: `@mariozechner/pi-coding-agent` | npm: `@mariozechner/pi-coding-agent` | Uses the local configuration |
| Kimi Code | `kimi` | Official `install.sh` | Official `install.ps1` | Not injected. Uses the local Kimi configuration |
| MiMo Code | `mimo` | npm: `@mimo-ai/cli@latest` | npm: `@mimo-ai/cli@latest` | Not injected. Uses the local MiMo configuration, `plan` or `build` according to authorization |
| DeepSeek Harness | `dsh` | npm: `@deepseek-ai/dsh@0.2.1-rc.2` | npm: `@deepseek-ai/dsh@0.2.1-rc.2` | ZGCI `smart-router-v2`, using native credentials or an environment variable |
| Claude Code | `claude` | npm: `@anthropic-ai/claude-code@latest` | npm: `@anthropic-ai/claude-code@latest` | Not injected. Uses the local Claude configuration |
| Gemini CLI | `gemini` | npm: `@google/gemini-cli@latest` | npm: `@google/gemini-cli@latest` | Not injected. Uses the local Gemini configuration |
| OpenCode | `opencode` | npm: `opencode-ai@latest` | npm: `opencode-ai@latest` | Not injected. Uses the local OpenCode configuration |
| Qwen Code | `qwen` | npm: `@qwen-code/qwen-code@latest` | npm: `@qwen-code/qwen-code@latest` | Uses the local configuration |
| OpenCodeReview | `ocr` | npm: `@alibaba-group/open-code-review@latest` | npm: `@alibaba-group/open-code-review@latest` | Uses the local configuration |

On macOS, detection also searches common directories outside the current `PATH`: Volta, pnpm, fnm, asdf, mise, bun, `~/.local/bin`, `~/.kimi-code/bin`, `~/.mimocode/bin`, and Homebrew. On Windows it also searches the user npm directory, WindowsApps, Node.js, WorkBuddy, Chocolatey, and Scoop, and it resolves commands with `PATHEXT`.

The Hermes and Kimi installers come from fixed HTTPS allowlist URLs. The client does not bundle a copy of those scripts, so the one-click installers do not work offline. Automatic install currently targets macOS and Windows. The Windows install flow still needs a pre-release check on a real Windows machine.

## Directory layout

- `src/agents/`: Agent compatibility, routing, runtime, CLI, installer, and connectors
- `src/attachments/`: attachments, content storage, and image dimension checks
- `src/collaboration/`: conversations, context packs, outcomes, and task graphs
- `src/workspace/`: the local workspace and automatic scheduling. Shared failure, retry, and wait behavior for the auto runner lives in `local-workspace-auto-runner-support.cjs`
- `src/runs/`: runs, budgets, events, scheduling, and logs
- `src/knowledge/`: knowledge bases and knowledge connectors
- `src/skills/`: Skill catalog, snapshots, and trust
- `src/security/`: private files and redaction
- `test/`: tests mirrored by domain name. `support/` holds test helpers. Test discovery and suite selection live in `scripts/test-discovery.cjs`

## Local development

```bash
cd desktop
npm install
npm run dev
```

Optional environment variable:

- `TYCHE_CODEX_SANDBOX`: Codex's default sandbox mode. `read-only` and `workspace-write` are supported. An unset or unsupported value uses `read-only`.

## Tests and packaging

A task-graph `primary` node can set an optional `claimKey`. Conclusions that share a key are checked for conflicts. Different keys fit independent deliverables. When the key is unset, the shared-conclusion check is used. The field is part of the workflow input. It does not infer what the task means.

The current default V4 group chat does not support task graphs yet. A review node in an older V3 task graph can mark a reply that points out a problem as passed. Until that is fixed, read the review yourself. Do not treat node completion as the result.

```bash
npm test
npm run pack
npm run dist
npm run dist:public
```

`pack` builds an unpacked app and checks the Electron output. `dist` builds the ad-hoc signed DMG and ZIP used by the V1.0.7 GitHub prerelease candidate. Those artifacts do not have a Developer ID trust chain and are not notarized. They cannot be described as passing Gatekeeper.

`dist:public` is reserved for a future signed public release. It requires a Developer ID certificate and full notarization credentials, forces code signing, checks the permanent bundle ID, Team ID, and hardened runtime after signing, and calls Apple notarization. It fails if any of those conditions is missing. Output goes to `desktop/dist/` and includes the local frontend. It does not depend on a server or a container.
