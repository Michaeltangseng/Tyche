const path = require('node:path')
const { deepseekNativeConfig } = require('./deepseek-native-config.cjs')

const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  codex: 4,
  hermes: 1,
  opencode: 4,
})
const DEFAULT_INTERNAL_TURN_LIMITS = Object.freeze({
  // Preserve the default for independent replies. Automatic discussions pass
  // an explicit zero to let the native tool loop finish its work.
  workbuddy: 8,
})

function internalTurnLimit(kind, requested) {
  if (requested === 0) return 0
  const value = Number(requested)
  if (Number.isInteger(value) && value >= 1 && value <= 50) return value
  return DEFAULT_INTERNAL_TURN_LIMITS[kind]
}

function codexSandbox(requested) {
  if (requested === 'read-exec') return 'read-only'
  if (requested != null) {
    if (!CODEX_SANDBOXES.has(requested)) throw new Error('CODEX_SANDBOX_UNSUPPORTED')
    return requested
  }
  const configured = process.env.MELDWORK_CODEX_SANDBOX || 'read-only'
  return CODEX_SANDBOXES.has(configured) ? configured : 'read-only'
}

function imageAttachmentLimit(kind) {
  return IMAGE_ATTACHMENT_LIMITS[kind] || 0
}

function attachmentPaths(kind, value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  const limit = imageAttachmentLimit(kind)
  if (value.length && !limit) throw new Error('LOCAL_AGENT_IMAGE_UNSUPPORTED')
  if (value.length > limit) throw new Error('LOCAL_AGENT_IMAGE_LIMIT')
  const normalized = value.map((filename) => {
    if (typeof filename !== 'string' || !filename || filename.length > 4096
        || !path.isAbsolute(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
    }
    return path.normalize(filename)
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('LOCAL_ATTACHMENT_REFERENCE_INVALID')
  }
  return normalized
}

function invocation(kind, executable, workdir, sessionRef = '', options = {}) {
  if (options.sandbox === 'read-exec' && !['claude', 'codex'].includes(kind)) {
    throw Object.assign(new Error('PROJECT_CAPABILITY_UNSUPPORTED'), {
      code: 'PROJECT_CAPABILITY_UNSUPPORTED',
      details: { agentKind: kind, capability: 'read-exec' },
    })
  }
  const attachments = attachmentPaths(kind, options.attachments)
  if (kind === 'codex') {
    const sandbox = codexSandbox(options.nativePermission || options.sandbox)
    const imageArgs = attachments.flatMap(filename => ['--image', filename])
    if (sessionRef) {
      return {
        command: executable,
        args: [
          'exec', 'resume', '--json', '--skip-git-repo-check',
          '-c', `sandbox_mode="${sandbox}"`, ...imageArgs, sessionRef, '-',
        ],
        stdin: true,
      }
    }
    return {
      command: executable,
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox',
        sandbox, '-C', workdir, ...imageArgs, '-'],
      stdin: true,
    }
  }
  if (kind === 'hermes') {
    if (options.hermesStreamJsonAvailable === true
        && (options.hermesAcpAvailable === false || options.invocationTransport === 'stream-json'
          || (sessionRef && options.sessionTransport !== 'acp'))
        && (!sessionRef || options.sessionTransport !== 'acp')) {
      return {
        command: executable,
        args: ['chat', '--format', 'stream-json',
          ...((options.nativePermission === 'yolo' || (!options.nativePermission && options.sandbox === 'workspace-write')) ? ['--yolo'] : []),
          ...(sessionRef ? ['--resume', sessionRef] : []),
          ...(attachments[0] ? ['--image', attachments[0]] : []), '--query'],
        promptArg: true,
        eventTransport: 'stream-json',
      }
    }
    // Hermes uses the same native conversation identifier across its ACP and
    // legacy transports. Keep it when an attachment requires the legacy path.
    const legacySessionRef = sessionRef
    const useAcp = options.invocationTransport !== 'legacy'
      && options.hermesAcpAvailable !== false
      && (!sessionRef || options.sessionTransport === 'acp')
    if (useAcp) {
      return {
        command: executable,
        args: ['acp'],
        acpMode: options.sandbox === 'workspace-write' ? 'accept_edits' : 'default',
        eventTransport: 'acp',
        fallbackTransport: 'legacy',
        fallbackSessionPolicy: 'invalidate',
        // Hermes ACP advertises image prompts; send images as content blocks
        // instead of silently dropping them from a text-only prompt.
        ...(attachments.length ? { imageAttachments: attachments } : {}),
      }
    }
    return {
      command: executable,
      args: [
        'chat',
        '--quiet',
        ...(options.sandbox === 'workspace-write' ? ['--yolo'] : []),
        ...(legacySessionRef ? ['--resume', legacySessionRef] : []),
        ...(attachments[0] ? ['--image', attachments[0]] : []),
        '--query',
      ],
      promptArg: true,
      eventTransport: 'legacy',
    }
  }
  if (kind === 'openclaw') {
    if (options.invocationTransport !== 'legacy') {
      return {
        command: executable,
        args: [
          '--no-color', '--log-level', 'info',
          'acp',
          ...(sessionRef ? ['--session', sessionRef] : []),
          '--no-prefix-cwd',
          '--verbose',
        ],
        eventTransport: 'acp',
        acpSessionStrategy: 'new',
        publicSessionRef: sessionRef,
        openClawGateway: true,
        fallbackTransport: 'legacy',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'agent', '--local', '--agent', 'main',
        ...(sessionRef ? ['--session-key', sessionRef] : []),
        '--message',
      ],
      suffixArgs: ['--json'],
      promptArg: true,
      eventTransport: 'legacy',
    }
  }
  if (kind === 'workbuddy') {
    const maxTurns = internalTurnLimit(kind, options.maxTurns)
    return {
      command: executable,
      args: [
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        // Workspace write access means accepting file edits in the working
        // directory. Skipping every permission check would also let the CLI
        // run any command anywhere on the machine without confirmation.
        '--permission-mode', options.nativePermission || (options.sandbox === 'workspace-write' ? 'acceptEdits' : 'plan'),
        ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
        ...(options.model ? ['--model', options.model] : []),
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
      eventTransport: 'stream-json',
    }
  }
  if (kind === 'zcode') {
    return {
      command: executable,
      args: ['--json', '--no-color', '--verbose', '--cwd', workdir,
        '--mode', options.nativePermission || (options.sandbox === 'workspace-write' ? 'edit' : 'plan'),
        ...(sessionRef ? ['--resume', sessionRef] : []), '--prompt'],
      promptArg: true,
    }
  }
  if (kind === 'pi') {
    const approve = options.nativePermission
      ? options.nativePermission === 'approve'
      : options.sandbox === 'workspace-write'
    return {
      command: executable,
      args: [
        '--mode', 'json', '--print',
        ...(approve
          ? ['--approve']
          : ['--no-approve', '--tools', 'read,grep,find,ls']),
        ...(sessionRef ? ['--session', sessionRef] : []),
      ],
      promptArg: true,
      eventTransport: 'json',
    }
  }
  if (kind === 'kimi') {
    // Kimi rejects --auto together with --prompt. Use the permission-aware
    // ACP transport for both modes instead of bypassing approval with --yolo.
    return {
      command: executable,
      args: ['acp'],
      acpMode: 'default',
      eventTransport: 'acp',
    }
  }
  if (kind === 'mimo') {
    if (!attachments.length && options.invocationTransport !== 'json') {
      return {
        command: executable,
        args: ['acp', '--cwd', workdir],
        acpMode: options.nativePermission || (options.sandbox === 'workspace-write' ? 'build' : 'plan'),
        eventTransport: 'acp',
        fallbackTransport: 'json',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'run', '--agent', options.nativePermission || (options.sandbox === 'workspace-write' ? 'build' : 'plan'),
        '--format', 'json', '--dir', workdir,
        ...(sessionRef ? ['--session', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'deepseek') {
    const mode = options.nativePermission || (options.sandbox === 'workspace-write' ? 'write' : 'read')
    // The external dsh process cannot read files inside Electron's ASAR.
    const policyDirectory = __dirname.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
    return {
      command: executable,
      args: ['--profile', 'acp', ...(deepseekNativeConfig({ env: options.env }).explicitModel
        ? [] : ['--patch', path.join(policyDirectory, 'deepseek-zgci.yml')]),
        '--patch', path.join(policyDirectory, `deepseek-${mode}.yml`)],
      eventTransport: 'acp',
      deepSeekMode: mode,
    }
  }
  if (kind === 'claude') {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]
    if (options.nativePermission === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else if (options.nativePermission) {
      args.push('--permission-mode', options.nativePermission)
    } else if (options.sandbox === 'workspace-write') {
      args.push('--permission-mode', 'acceptEdits')
    } else if (options.sandbox === 'read-exec') {
      // Verified in milestone 0 task 0.5: Claude has no `default` mode;
      // pre-approve read and Bash tools and hide edit tools instead. The
      // trailing `--` keeps the variadic tool list from swallowing the prompt.
      args.push(
        '--allowedTools', 'Read,Glob,Grep,Bash',
        '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit',
      )
    } else {
      args.push('--permission-mode', 'plan')
    }
    if (sessionRef) args.push('--resume', sessionRef)
    if (options.sandbox === 'read-exec') args.push('--')
    return {
      command: executable,
      args,
      promptArg: true,
    }
  }
  if (kind === 'qwen') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--approval-mode', options.nativePermission || (options.sandbox === 'workspace-write' ? 'auto-edit' : 'plan'),
        ...(sessionRef ? ['--resume', sessionRef] : []),
      ],
      promptArg: true,
    }
  }
  if (kind === 'gemini') {
    return {
      command: executable,
      args: [
        '--output-format', 'stream-json',
        '--approval-mode', options.nativePermission || (options.sandbox === 'workspace-write' ? 'auto_edit' : 'plan'),
        ...(sessionRef ? ['--resume', sessionRef] : []),
        '--prompt',
      ],
      promptArg: true,
    }
  }
  if (kind === 'opencode') {
    if (!attachments.length && options.invocationTransport !== 'json') {
      return {
        command: executable,
        args: ['acp', '--cwd', workdir],
        acpMode: options.sandbox === 'workspace-write' ? 'build' : 'plan',
        eventTransport: 'acp',
        fallbackTransport: 'json',
        fallbackSessionPolicy: 'preserve',
      }
    }
    return {
      command: executable,
      args: [
        'run', '--format', 'json',
        '--agent', options.sandbox === 'workspace-write' ? 'build' : 'plan',
        ...(sessionRef ? ['--session', sessionRef] : []),
        ...attachments.flatMap(filename => ['--file', filename]),
      ],
      promptArg: true,
    }
  }
  if (kind === 'opencodereview') {
    return {
      command: executable,
      args: [
        'review', '--audience', 'agent', '--format', 'json', '--repo', workdir,
        '--background',
      ],
      promptArg: true,
    }
  }
  throw new Error('LOCAL_AGENT_KIND_UNSUPPORTED')
}

module.exports = {
  imageAttachmentLimit,
  invocation,
}
