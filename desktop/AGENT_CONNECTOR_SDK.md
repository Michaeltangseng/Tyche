# Agent Connector SDK

A Tyche Connector package is a validated local JSON file. The package is identified by its content hash. After import it must be approved and installed by the user before an instance can be configured. Each instance stores its own CredentialRef. Credentials are encrypted in the operating system's secure storage through Electron. The Connector list never returns credential plaintext.

A Codex delegation Connector that uses instance credentials runs in a private native configuration directory owned by that instance. It does not read the global Codex or XDG configuration. The instance secret is passed through Codex's native `CODEX_API_KEY` environment variable and is not written into that directory. The directory keeps session data so the instance can continue its own conversation.

## Current support

The SDK version is `1.0.0`. It currently provides two built-in providers:

- `sdk.local-echo.v1`: local echo. Text only, read-only, no network and no credentials.
- `sdk.http-json.v1`: sends a JSON request to the HTTPS target declared in the manifest. Text and read-only permission. An optional required API key or token credential slot. It does not follow HTTP redirects.

The HTTP response is a JSON object. It must contain a string `text`, and it may contain string `sessionRef` and `outcome`. `outcome` may be `completed`, `partial`, `failed`, or `cancelled`. Omitted means `completed`. A non-empty `error`, or `success: false`, is a failure. Failures use a generic error code so sensitive text from the service is not written into the run record. A cancelled result requires the manifest to declare a cancel capability.

HTTP requests have a ten-minute transfer timeout. For a Connector that does not declare cancel, stopping a task aborts the local connection. It does not claim that the remote execution was cancelled.

Third parties can build packages for these providers without rebuilding Tyche. **A package cannot yet register arbitrary third-party executable code or a new transport.** A capability listed in the manifest schema is not a capability every provider implements. Package validation rejects declarations outside the provider's range. See the [package validation implementation](src/agents/connectors/agent-connector-package-store.cjs) and the [end-to-end example test](test/agents/connectors/agent-connector-sdk.test.cjs).

These two providers do not support checkpoints or durable idempotency, and they do not emit permission, source, artifact, evidence, usage, or waiting-for-input events. A package that declares those capabilities is rejected on import. An HTTP request carries `operationId`. That alone does not guarantee durable server-side deduplication.

## Generate a local sample package

After installing the desktop dependencies from the repository root, run this command. It does not need credentials:

```sh
node - <<'NODE'
const fs = require('node:fs')
const { SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE } = require('./desktop/src/agents/connectors/agent-connector-local.cjs')
const { serializeAgentConnectorPackage } = require('./desktop/src/agents/connectors/agent-connector-package-store.cjs')
fs.writeFileSync('/tmp/meldwork-local-echo.connector.json', serializeAgentConnectorPackage(SAMPLE_LOCAL_ECHO_AGENT_CONNECTOR_PACKAGE))
NODE
```

The command writes to the temporary directory on macOS and Linux. On Windows, change the target to a writable absolute path. A full HTTP package is built by `httpPackage()` in `agent-connector-sdk.test.cjs`. Use `createAgentConnectorManifest` and `createAgentConnectorPackage` to produce the hash. Do not edit the identifier of an existing package by hand.

## Import and lifecycle

The desktop main process and preload expose `localAgentConnector`: `import`, `inspect`, `approve`, `install`, `configure`, `test`, `disable`, `revoke`, `upgrade`, `remove`, and `audit`. Import uses the system file picker. Before approval the UI shows the publisher, source, hash, transport, permissions, credential slots, and outbound targets, and it asks the user to confirm. If the package changes during confirmation, it must be reviewed and approved again.

When an instance already exists, a new version from the same declared publisher and provider can upgrade if the credential declaration is identical. The instance ID and CredentialRef are kept. If writing the upgraded instance is interrupted, Tyche resumes from the persisted upgrade record on a later refresh. A revoked old package is not migrated automatically. Upgrade is blocked when the credential declaration is incompatible, a request is running, or a previous migration has not finished. The publisher ID is a declaration inside the package. It is not authentication. A package that still has instances cannot be deleted directly. An instance referenced by a session cannot be deleted directly.

Connector management in Settings provides import, inspect, approve, install, test, and trust controls. It does not give the page arbitrary command execution. When creating an instance with credentials, enter the name of an environment variable that already exists in the local shell. After local confirmation, the main process reads the variable and stores the value in OS secure storage. The page never receives the secret.

The preload `configure` method accepts only `credentials: null`. An instance with credentials uses `configureFromEnvironment` and submits the variable name. The renderer cannot submit the secret value.

`test` runs one read-only prompt in its own temporary working directory and cleans up afterward. It is a connectivity check, not a full certification of every provider feature or security behavior.

## Capabilities and events

Declared input types, permissions, sessions, cancel, event types, and usage fields are enforced at runtime. For the SDK HTTP transport, the target must match the declared HTTPS origin, and redirects are not followed. A Connector delegated to a local Agent CLI does not provide process-level network isolation. Network requests the CLI makes on its own are not forced to stay inside the Connector's outbound-target list. That list is not a complete network boundary for this kind of Connector.

`Usage` counts only fields the event actually reported. Missing reply-token usage is estimated by the run budget. The return value must not invent usage that was not declared or that disagrees with the event.

Events and their required fields follow the [run event protocol](src/runs/run-event-protocol.cjs) and [manifest validation](src/agents/connectors/agent-connector-manifest.cjs). Do not put an API key in a manifest, a request body, or a sample package.

## Verification

```sh
npm --prefix desktop run connector:conformance
```

That command runs the manifest, registry, runtime, instance, package, SDK, real Connector wiring, and main-process security tests, including the non-delegated local echo sample, multi-account credential isolation, and the renderer boundary. It checks the current built-in providers. It does not mean a third-party service has passed an independent certification.
