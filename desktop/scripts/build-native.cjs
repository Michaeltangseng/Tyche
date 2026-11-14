'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(DESKTOP_ROOT, 'native', 'supervisor', 'meldwork-supervisor.c')
const OUTPUT_DIR = path.join(DESKTOP_ROOT, 'native', 'build')
const OUTPUT = path.join(OUTPUT_DIR, 'meldwork-supervisor')
const COMMON_FLAGS = ['-std=c99', '-O2', '-Wall', '-Wextra', '-Werror']

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: 'inherit' })
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error(`missing build tool: ${command}`), {
        code: 'NATIVE_BUILD_TOOL_MISSING',
        tool: command,
      })
    }
    throw error
  }
}

function build() {
  if (!fs.existsSync(SOURCE)) {
    throw Object.assign(new Error(`native source not found: ${SOURCE}`), {
      code: 'NATIVE_SOURCE_MISSING',
    })
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  if (process.platform === 'darwin') {
    const arm64 = path.join(OUTPUT_DIR, 'meldwork-supervisor.arm64')
    const x86_64 = path.join(OUTPUT_DIR, 'meldwork-supervisor.x86_64')
    try {
      run('clang', [...COMMON_FLAGS, '-arch', 'arm64', SOURCE, '-o', arm64])
      run('clang', [...COMMON_FLAGS, '-arch', 'x86_64', SOURCE, '-o', x86_64])
      run('lipo', ['-create', '-output', OUTPUT, arm64, x86_64])
    } finally {
      fs.rmSync(arm64, { force: true })
      fs.rmSync(x86_64, { force: true })
    }
  } else {
    run('clang', [...COMMON_FLAGS, SOURCE, '-o', OUTPUT])
  }
  fs.chmodSync(OUTPUT, 0o755)
  return OUTPUT
}

if (require.main === module) {
  try {
    build()
  } catch (error) {
    if (error.code === 'NATIVE_BUILD_TOOL_MISSING') {
      console.error(
        `${error.tool} is required to build the managed-process supervisor. `
        + 'Install the Xcode Command Line Tools (xcode-select --install) and retry.',
      )
    } else {
      console.error(error.message || error)
    }
    process.exit(1)
  }
}

module.exports = { build, OUTPUT, OUTPUT_DIR, SOURCE }
