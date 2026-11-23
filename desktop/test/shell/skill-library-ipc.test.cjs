const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { LocalSkillCatalog } = require('../../src/skills/local-skill-catalog.cjs')
const { SkillLibrary } = require('../../src/skills/skill-library.cjs')
const { registerSkillLibraryIpc } = require('../../src/shell/skill-library-ipc.cjs')

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-skill-ipc-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const native = path.join(home, '.claude', 'skills', 'pptx')
  fs.mkdirSync(native, { recursive: true })
  fs.writeFileSync(path.join(native, 'SKILL.md'), [
    '---',
    'name: pptx',
    'description: Create presentations',
    '---',
    '',
    'Use the deck workflow.',
    '',
  ].join('\n'))
  const catalog = new LocalSkillCatalog({ home })
  const library = new SkillLibrary({
    storagePath: path.join(home, 'store', 'skill-library.json'),
    legacyPath: path.join(home, 'store', 'skill-inventory.json'),
    libraryRoot: path.join(home, 'library'),
    backupRoot: path.join(home, 'backups'),
    trashRoot: path.join(home, 'trash'),
    home,
    catalog,
  })
  const handlers = new Map()
  const opened = []
  registerSkillLibraryIpc({
    registerTrustedHandle: (channel, handler) => handlers.set(channel, handler),
    getLibrary: () => library,
    shell: { openPath: async target => { opened.push(target); return '' } },
  })
  return { handlers, home, library, native, opened }
}

test('skill library IPC validates ids and resolves reveal paths in the main process', async (t) => {
  const { handlers, library, native, opened } = setup(t)
  assert.equal(typeof handlers.get('skill-library:summary'), 'function')
  const summary = handlers.get('skill-library:summary')()
  assert.equal(summary.counts.native, 1)

  const listed = handlers.get('skill-library:list')()
  assert.equal(listed.skills[0].id, 'claude/global/pptx')

  const detail = handlers.get('skill-library:detail')({ id: 'claude/global/pptx' })
  assert.equal(detail.name, 'pptx')
  assert.equal('sourceDirectory' in detail, false)
  assert.equal(JSON.stringify(detail).includes(native), false)

  assert.throws(
    () => handlers.get('skill-library:detail')({ id: '../../etc/passwd' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:detail')({ id: 'claude/global/pptx', path: '/tmp' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:project')({ id: 'claude/global/pptx', agent: '../../tmp' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:import')({ ids: ['../../etc'] }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:resolve-projection')({ projectionId: '../x', action: 'restore' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:import')({ ids: ['claude/global/pptx'], onConflict: 'takeover' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )
  assert.throws(
    () => handlers.get('skill-library:create')({ name: '../bad', description: 'x', body: 'y' }),
    /SKILL_LIBRARY_INPUT_INVALID/,
  )

  const revealed = await handlers.get('skill-library:reveal')({ id: 'claude/global/pptx' })
  assert.deepEqual(revealed, { opened: true })
  assert.deepEqual(opened, [fs.realpathSync(native)])

  handlers.get('skill-library:trust')({ id: 'claude/global/pptx' })
  const imported = handlers.get('skill-library:import')({
    ids: ['claude/global/pptx'],
    trust: true,
    onConflict: 'rename',
  })
  assert.equal(imported.imported[0].id, 'shared/library/pptx')
  assert.equal(library.list().skills.some(skill => skill.id === 'claude/global/pptx'), false)
})
