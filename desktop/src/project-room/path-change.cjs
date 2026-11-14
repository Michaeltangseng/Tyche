function pathStateFromEntry(entry) {
  if (!entry) return { kind: 'absent' }
  if (entry.kind) {
    if (entry.kind === 'absent') return { kind: 'absent' }
    if (entry.kind === 'link') {
      return { kind: 'link', target: entry.target == null ? null : String(entry.target) }
    }
    if (entry.kind === 'placeholder') {
      return {
        kind: 'placeholder',
        mode: entry.mode || null,
        size: entry.size == null ? null : Number(entry.size),
        sha256: entry.sha256 || null,
      }
    }
    return {
      kind: 'file',
      mode: entry.mode || null,
      size: entry.size == null ? null : Number(entry.size),
      sha256: entry.sha256 || null,
    }
  }
  if (entry.type === 'link' || entry.mode === '120000') {
    return { kind: 'link', target: entry.target == null ? null : String(entry.target) }
  }
  if (entry.reason === 'oversize' || entry.reason === 'lfs'
      || (entry.path && entry.sha256 && entry.size != null)) {
    return {
      kind: 'placeholder',
      mode: entry.mode || null,
      size: entry.size == null ? null : Number(entry.size),
      sha256: entry.sha256 || null,
    }
  }
  return {
    kind: 'file',
    mode: entry.mode || null,
    size: entry.size == null ? null : Number(entry.size),
    sha256: entry.sha256 || null,
  }
}

function describePathChange(oldEntry, newEntry) {
  const oldState = pathStateFromEntry(oldEntry)
  const newState = pathStateFromEntry(newEntry)
  const details = {
    oldKind: oldState.kind,
    newKind: newState.kind,
    oldMode: oldState.mode || null,
    newMode: newState.mode || null,
    oldSize: oldState.size == null ? null : oldState.size,
    newSize: newState.size == null ? null : newState.size,
    oldTarget: oldState.target == null ? null : oldState.target,
    newTarget: newState.target == null ? null : newState.target,
  }
  if (oldState.kind === 'absent' && newState.kind === 'absent') {
    return { change: 'unchanged', details, diffAvailable: false }
  }
  if (oldState.kind === 'absent') {
    return {
      change: 'added',
      details,
      diffAvailable: newState.kind === 'file',
    }
  }
  if (newState.kind === 'absent') {
    return {
      change: 'deleted',
      details,
      diffAvailable: oldState.kind === 'file',
    }
  }
  if (oldState.kind === 'link' && newState.kind === 'link') {
    return {
      change: oldState.target === newState.target ? 'unchanged' : 'link-target-changed',
      details,
      diffAvailable: false,
    }
  }
  const fileLike = kind => kind === 'file' || kind === 'placeholder'
  if ((oldState.kind === 'link' && fileLike(newState.kind))
      || (newState.kind === 'link' && fileLike(oldState.kind))) {
    return { change: 'type-changed', details, diffAvailable: false }
  }
  if (oldState.kind === 'placeholder' || newState.kind === 'placeholder') {
    return { change: 'large-file-changed', details, diffAvailable: false }
  }
  if (oldState.kind === 'file' && newState.kind === 'file') {
    const modeChanged = Boolean(oldState.mode && newState.mode && oldState.mode !== newState.mode)
    const contentChanged = oldState.sha256 && newState.sha256
      ? oldState.sha256 !== newState.sha256
      : oldState.size !== newState.size
    if (modeChanged) {
      return {
        change: 'mode-changed',
        details: { ...details, contentChanged },
        diffAvailable: true,
      }
    }
    if (contentChanged) {
      return { change: 'content-changed', details, diffAvailable: true }
    }
    return { change: 'unchanged', details, diffAvailable: false }
  }
  return { change: 'unchanged', details, diffAvailable: false }
}

function driftOptions(acceptedEntry) {
  const acceptedState = pathStateFromEntry(acceptedEntry)
  if (acceptedState.kind === 'placeholder') {
    return { workdir: true, accepted: false, reason: 'placeholder-has-no-content' }
  }
  if (acceptedState.kind === 'absent'
      || acceptedState.kind === 'file'
      || acceptedState.kind === 'link') {
    return { workdir: true, accepted: true, reason: null }
  }
  return { workdir: true, accepted: false, reason: 'unknown-state' }
}

module.exports = {
  describePathChange,
  driftOptions,
  pathStateFromEntry,
}
