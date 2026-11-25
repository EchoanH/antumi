import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Launch, LaunchHost } from '@antumi/protocol/node'
import { detectDsh, dshOverlay, prepareDshProfile } from './dsh-cli'

const desktopBin = 'D:\\DeepSeek Harness\\resources\\runtime\\cli\\bin'
const npmBin = 'C:\\Users\\user\\AppData\\Roaming\\npm'
const nodeBin = 'C:\\Program Files\\nodejs'
const desktopDsh = path.win32.join(desktopBin, 'dsh.cmd')
const npmDsh = path.win32.join(npmBin, 'dsh.cmd')
const npmEntry = 'node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const cliScript = path.win32.join(npmBin, npmEntry)
const manifestPath = (prefix: string) => path.win32.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const manifest = (bin = 'lib/bin.js') => JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: bin } })

// The launchers shipped by DeepSeek Desktop rc.5 and npm cmd-shim.
const desktopShim = [
  '@echo off', 'setlocal DisableDelayedExpansion', 'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  'exit /b %errorlevel%'
].join('\r\n')
const npmShim = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"', 'SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\' + npmEntry + '" %*'
].join('\r\n')

function windowsProbe(shim = npmShim, extraFiles: [string, string][] = []) {
  const files = new Map([
    [desktopDsh, desktopShim], [npmDsh, shim], [cliScript, ''], [manifestPath(npmBin), manifest()],
    [path.win32.join(npmBin, 'dsh'), '#!/bin/sh'], [path.win32.join(nodeBin, 'node.exe'), ''],
    ...extraFiles
  ])
  const host: LaunchHost = { platform: 'win32', isFile: (file) => files.has(file), isExecutable: (file) => files.has(file), read: (file) => files.get(file) ?? null }
  const output = vi.fn(async (_launch: Launch) => '0.2.2-rc.5\r\n')
  return { host, output }
}

describe('Windows DSH detection', () => {
  it.each([[desktopBin, npmBin, nodeBin], [npmBin, desktopBin, nodeBin]].map((dirs) => dirs.join(';')))(
    'selects the standalone npm CLI on %s',
    async (searchPath) => {
      const probe = windowsProbe()
      expect(await detectDsh(searchPath, 'win32', probe)).toMatchObject({ status: 'ok', path: npmDsh, version: '0.2.2-rc.5' })
      expect(probe.output).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        file: path.win32.join(nodeBin, 'node.exe'),
        args: [cliScript, '--version']
      }))
    }
  )

  it('offers the standalone CLI when only the desktop launcher is available', async () => {
    const probe = windowsProbe(npmShim.replace('@deepseek-ai\\dsh', 'other-package'))
    expect(await detectDsh([desktopBin, npmBin, nodeBin].join(';'), 'win32', probe)).toMatchObject({
      status: 'unknown', path: desktopDsh, problem: 'probe-failed', requiresStandaloneCli: true
    })
    expect(probe.output).not.toHaveBeenCalled()
  })

  it.each(['0.2.2-rc.2', '0.2.3-alpha.2', 'v1.0.0+build.7'])('accepts the reported DSH version %s', async (version) => {
    const probe = windowsProbe()
    probe.output.mockResolvedValueOnce(version + '\n')
    expect(await detectDsh([desktopBin, npmBin, nodeBin].join(';'), 'win32', probe))
      .toEqual({ status: 'ok', path: npmDsh, version: version.replace(/^v/, ''), signedIn: null })
  })

  it('reports a probe failure when the standalone CLI cannot start', async () => {
    const probe = windowsProbe()
    const searchPath = [desktopBin, npmBin, nodeBin].join(';')
    probe.output.mockRejectedValueOnce(new Error('could not start'))
    expect(await detectDsh(searchPath, 'win32', probe)).toEqual({
      status: 'unknown', path: npmDsh, version: null, problem: 'probe-failed', signedIn: null
    })
  })

  it('continues after a failed probe and uses the npm package’s declared entry point', async () => {
    const otherBin = 'E:\\Custom npm prefix'
    const otherDsh = path.win32.join(otherBin, 'dsh.cmd')
    const otherEntry = 'node_modules\\@deepseek-ai\\dsh\\dist\\cli.mjs'
    const otherScript = path.win32.join(otherBin, otherEntry)
    const probe = windowsProbe(npmShim, [
      [otherDsh, npmShim.replace(npmEntry, otherEntry)], [otherScript, ''], [manifestPath(otherBin), manifest('dist/cli.mjs')]
    ])
    probe.output.mockResolvedValueOnce('').mockResolvedValueOnce('1.0.0\n')
    expect(await detectDsh([desktopBin, npmBin, '"' + otherBin + '"', nodeBin].join(';'), 'win32', probe))
      .toMatchObject({ status: 'ok', path: otherDsh, version: '1.0.0' })
    expect(probe.output).toHaveBeenLastCalledWith(expect.objectContaining({ args: [otherScript, '--version'] }))
  })
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(failOnce = false, failRemove = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'antumi-dsh-install-'))
  roots.push(root)
  const command = path.join(root, 'dsh')
  const home = path.join(root, 'home')
  const bundle = path.join(root, 'runtime.tgz')
  await writeFile(bundle, 'test-bundle')
  // Models pnpm 12.3 to 12.6: an add over an existing install keeps the old plugin and still exits 0.
  await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const profile = path.join(process.env.DSH_HOME, 'profiles', 'antumi')
fs.mkdirSync(profile, {recursive:true})
const argv = process.argv.slice(2)
const verb = argv[3]
fs.appendFileSync(path.join(profile, 'calls'), verb + '\\n')
const install = path.join(profile, 'node_modules', '@antumi', 'dsh-runtime')
const head = argv.slice(0, 3).join('|')
if (head !== 'plugin|--profile|antumi') process.exit(2)
if (verb === 'remove' && argv.slice(4).join('|') === '@antumi/dsh-runtime') {
  if (${failRemove}) process.exit(1)
  fs.rmSync(install, {recursive:true, force:true})
  process.exit(0)
}
if (verb !== 'add' || argv.slice(4).join('|') !== ${JSON.stringify(bundle)}) process.exit(2)
const adds = fs.readFileSync(path.join(profile, 'calls'), 'utf8').split('\\n').filter((line) => line === 'add').length
if (${failOnce} && adds === 1) process.exit(1)
if (fs.existsSync(install)) process.exit(0)
fs.mkdirSync(install, {recursive:true})
fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({name:'@antumi/dsh-runtime'}))
fs.writeFileSync(path.join(install, 'bundle'), fs.readFileSync(${JSON.stringify(bundle)}))
`, { mode: 0o700 })
  return { root, home, command, bundle, profile: path.join(home, 'profiles', 'antumi') }
}

const callsTo = async (profile: string, verb: string) =>
  (await readFile(path.join(profile, 'calls'), 'utf8')).split('\n').filter((line) => line === verb).length
const installedBundle = (profile: string) => readFile(path.join(profile, 'node_modules', '@antumi', 'dsh-runtime', 'bundle'), 'utf8')

describe.skipIf(process.platform === 'win32')('DSH managed profile', () => {
  it('coalesces concurrent preparation, skips the installed digest, and reinstalls a changed bundle', async () => {
    const f = await fixture()
    await Promise.all([prepareDshProfile(f.command, f.bundle, f.home), prepareDshProfile(f.command, f.bundle, f.home)])
    expect(await callsTo(f.profile, 'add')).toBe(1)
    expect(await callsTo(f.profile, 'remove')).toBe(0)
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await callsTo(f.profile, 'add')).toBe(1)
    await writeFile(f.bundle, 'updated-bundle')
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await callsTo(f.profile, 'add')).toBe(2)
    expect(await installedBundle(f.profile)).toBe('updated-bundle')
  })

  it('still installs the changed bundle when removing the old plugin fails', async () => {
    const f = await fixture(false, true)
    await prepareDshProfile(f.command, f.bundle, f.home)
    await writeFile(f.bundle, 'updated-bundle')
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await callsTo(f.profile, 'remove')).toBe(1)
    expect(await callsTo(f.profile, 'add')).toBe(2)
  })

  it('can retry an installation failure and preserves files already in the profile', async () => {
    const f = await fixture(true)
    await mkdir(f.profile, { recursive: true })
    const existing = path.join(f.profile, 'cordis.patch.yml')
    await writeFile(existing, 'user-config')
    await expect(prepareDshProfile(f.command, f.bundle, f.home)).rejects.toMatchObject({ reason: 'dsh-runtime-install-failed' })
    await prepareDshProfile(f.command, f.bundle, f.home)
    expect(await readFile(existing, 'utf8')).toBe('user-config')
  })
})

describe('DSH stage overlay', () => {
  it('patches the provider plugin only for a session on an Antumi provider', () => {
    expect(dshOverlay(false)).toContain('- id: skill-filesystem')
    expect(dshOverlay(false)).not.toContain('llm-pi-ai')
    expect(dshOverlay(true)).toContain('- id: skill-filesystem')
    expect(dshOverlay(true)).toContain('- id: llm-pi-ai')
  })
})
