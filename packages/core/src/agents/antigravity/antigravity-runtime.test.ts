import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ANTIGRAVITY_VERSION, antigravityInstallation, antigravityRuntimeDir, antigravitySignedIn, antigravityTokenFile, detectAntigravity, requireAntigravity } from './antigravity-runtime'
import { antigravityBrowserEnv } from './antigravity-browser'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), 'antumi-antigravity-'))
  roots.push(root)
  return root
}

const commandPath = (tool: string) => spawnSync('/bin/bash', ['-c', 'command -v "$1"', 'bash', tool], { encoding: 'utf8' }).stdout?.trim()
const linuxHost = process.platform === 'linux'

describe('Antigravity runtime', () => {
  it('uses the Windows browser only for WSL without an explicit browser', () => {
    const windows = '/mnt/c/Windows/System32/rundll32.exe'
    const executable = (file: string) => file === windows
    const wsl = { WSL_INTEROP: '/run/WSL/socket' }
    expect(antigravityBrowserEnv('linux', wsl, executable)).toEqual({ BROWSER: `${windows} url.dll,FileProtocolHandler %s &` })
    expect(antigravityBrowserEnv('linux', { ...wsl, BROWSER: 'custom-browser' }, executable)).toEqual({})
    expect(antigravityBrowserEnv('linux', {}, executable)).toEqual({})
    expect(antigravityBrowserEnv('linux', wsl, () => false)).toEqual({})
    expect(antigravityBrowserEnv('win32', wsl, executable)).toEqual({})
  })

  it('downloads the pinned archive, checks its hash and renames it into place', () => {
    const host = { platform: 'darwin' as const, arch: 'arm64', home: "/Users/o'neil/.antumi" }
    const install = antigravityInstallation('darwin', host)
    expect(install?.shell).toBe('bash')
    expect(install?.command).toContain(`curl -fL --progress-bar 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-${ANTIGRAVITY_VERSION}-darwin-arm64.zip'`)
    expect(install?.command).toContain('f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17  $z" | shasum -a 256 -c')
    expect(install?.command).toContain(`d='/Users/o'\\''neil/.antumi/runtimes/antigravity-acp/${ANTIGRAVITY_VERSION}'`)
    expect(install?.command).toContain('rm -rf "$d" && mv "$d.partial" "$d"')
    expect(antigravityInstallation('linux', { ...host, platform: 'linux', arch: 'x64' })?.command).toContain('| sha256sum -c')
    const windows = antigravityInstallation('win32', { platform: 'win32', arch: 'x64', home: "C:\\Users\\o'neil\\.antumi" })
    expect(windows?.command).toContain(`$d = 'C:\\Users\\o''neil\\.antumi\\runtimes\\antigravity-acp\\${ANTIGRAVITY_VERSION}'`)
    expect(antigravityInstallation('freebsd', { ...host, platform: 'freebsd' })).toBeNull()
  })

  it.skipIf(!linuxHost || !commandPath('python3'))('installs with Python when unzip is missing and keeps both programs executable', async () => {
    const root = await home()
    const host = { platform: 'linux' as const, arch: 'x64', home: root }
    const bin = path.join(root, 'bin')
    const archive = path.join(root, 'fixture.zip')
    await mkdir(bin)
    for (const tool of ['python3', 'mktemp', 'sha256sum', 'rm', 'mkdir', 'mv', 'chmod', 'cp']) {
      const file = commandPath(tool)
      if (!file) throw new Error(`missing test tool: ${tool}`)
      await symlink(file, path.join(bin, tool))
    }
    execFileSync(path.join(bin, 'python3'), ['-I', '-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    z.writestr("agy_acp_server.par", "#!/bin/sh\\n")\n    z.writestr("localharness_external", "#!/bin/sh\\n")', archive])
    await writeFile(path.join(bin, 'curl'), '#!/bin/bash\ncp "$FIXTURE_ZIP" "${!#}"\n', { mode: 0o755 })
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
    const pinned = antigravityInstallation('linux', host)!.command
    const run = (command: string) => spawnSync('/bin/bash', ['-o', 'pipefail', '-c', command], {
      encoding: 'utf8', env: { PATH: bin, TMPDIR: root, FIXTURE_ZIP: archive }
    })
    expect(run(pinned).status).not.toBe(0)
    await expect(requireAntigravity(host)).rejects.toThrow(/未安装/)
    const result = run(pinned.replace(/[a-f0-9]{64}(?=  \$z)/, hash))
    expect(result.status, result.stderr).toBe(0)
    const server = await requireAntigravity(host)
    const harness = path.join(path.dirname(server), 'localharness_external')
    for (const file of [server, harness]) expect(spawnSync(file).status).toBe(0)
  })

  it.skipIf(!linuxHost)('reports missing extractors before it downloads anything', async () => {
    const root = await home()
    const command = antigravityInstallation('linux', { platform: 'linux', arch: 'x64', home: root })!.command
    const result = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', `curl() { echo unexpected-download >&2; }; ${command}`], {
      encoding: 'utf8', env: { PATH: root }
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unzip.*Python 3/)
    expect(result.stderr).not.toContain('unexpected-download')
  })

  it.skipIf(!linuxHost)('does not download when a temporary directory cannot be created', async () => {
    const root = await home()
    const command = antigravityInstallation('linux', { platform: 'linux', arch: 'x64', home: root })!.command
    const stubs = 'unzip() { return 0; }; mktemp() { return 73; }; curl() { echo unexpected-download >&2; };'
    const result = spawnSync('/bin/bash', ['-o', 'pipefail', '-c', `${stubs} ${command}`], {
      encoding: 'utf8', env: { PATH: root }
    })
    expect(result.status).toBe(73)
    expect(result.stderr).not.toContain('unexpected-download')
  })

  it('is found only once its server and harness are both in place', async () => {
    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const host = { platform, arch: 'arm64', home: await home() } as const
    expect(await detectAntigravity('', platform, host)).toEqual({ status: 'missing', version: null, path: null, signedIn: null })
    await expect(requireAntigravity(host)).rejects.toThrow(/未安装/)
    const dir = antigravityRuntimeDir(host)
    await mkdir(dir, { recursive: true })
    const server = path.join(dir, platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par')
    await writeFile(server, '')
    await chmod(server, 0o755)
    expect((await detectAntigravity('', platform, host)).status).toBe('missing')
    await writeFile(path.join(dir, platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), '')
    expect(await detectAntigravity('', platform, host)).toMatchObject({ status: 'ok', version: ANTIGRAVITY_VERSION, path: server })
    expect(await requireAntigravity(host)).toBe(server)
    await expect(requireAntigravity({ ...host, arch: 'ia32' })).rejects.toThrow(/不支持/)
  })

  it('reads a sign-in kept in its token file', async () => {
    const gemini = await home()
    const file = antigravityTokenFile(gemini)
    expect(await antigravitySignedIn(file)).toBe(false)
    await mkdir(path.dirname(file))
    await writeFile(file, '{}')
    expect(await antigravitySignedIn(file)).toBe(true)
  })
})
