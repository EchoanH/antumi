// Exercise the archive an installer ships, with an isolated home and the backend's Node 24.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertLinuxBindingCompatible } from './linux-binding-compatibility.mjs'

assert.equal(process.platform, 'linux', 'Run this check on Linux')
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'The backend needs Node 24 or newer')
const archive = path.resolve(process.argv[2] ?? '')
assert.ok(archive.endsWith('.tar.gz'), 'usage: node smoke-linux-backend.mjs <backend-linux-arch.tar.gz>')
const manifest = JSON.parse(await readFile(archive.replace(/\.tar\.gz$/, '.json'), 'utf8'))
const bytes = await readFile(archive)
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256, 'Archive checksum')

const home = await mkdtemp(path.join(tmpdir(), 'antumi-backend-smoke-'))
// Where an install puts it (docs/WSL.md 安装和启动): unpacked into the home itself, the archive's
// plugins folder would land in the one core keeps installed plugins in.
const antumiHome = path.join(home, '.antumi')
const backend = path.join(antumiHome, 'backend', `${manifest.version}-${manifest.sha256.slice(0, 12)}`)
const env = { ...process.env, ANTUMI_HOME: antumiHome, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache') }
const children = []
let logs = ''
try {
  await mkdir(backend, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', backend, '--no-same-owner'])
  const ptyRoot = path.join(backend, 'node_modules/node-pty')
  assertLinuxBindingCompatible(await readFile(path.join(ptyRoot, 'build/Release/pty.node')), true)
  const check = JSON.parse(execFileSync(process.execPath, [path.join(backend, 'backend-control.mjs'), 'check'], { env, encoding: 'utf8', timeout: 30_000 }))
  assert.equal(check.pty, true, 'Packaged node-pty loads')
  assert.equal(check.arch, process.arch)
  await checkTerminal(createRequire(import.meta.url)(ptyRoot), home)

  for (const name of ['daemon', 'core']) {
    const child = spawn(process.execPath, [path.join(backend, `${name}.mjs`)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', (error) => { logs += `${name}: ${error.message}\n` })
    child.stdout.on('data', (chunk) => { logs += chunk })
    child.stderr.on('data', (chunk) => { logs += chunk })
    children.push(child)
  }
  const endpoint = await waitForCore(antumiHome, children)
  const hello = await askCore(endpoint)
  assert.equal(hello.serverVersion, manifest.version)
  assert.equal(hello.protocolVersion, endpoint.protocolVersion)
  assert.deepEqual(hello.home, { path: home, windows: false })
  console.log(JSON.stringify({ ok: true, node: process.version, arch: process.arch, pty: true, terminal: 'read/write/resize', core: hello.serverVersion, protocol: hello.protocolVersion }))
} catch (error) {
  if (logs) console.error(logs.slice(-12_000))
  throw error
} finally {
  for (const child of children.reverse()) await stop(child)
  await rm(home, { recursive: true, force: true })
}

function checkTerminal(pty, cwd) {
  return new Promise((resolve, reject) => {
    const terminal = pty.spawn('/bin/sh', ['-c', 'read -r line; stty size; printf "PTY:%s\\n" "$line"'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
    let output = ''
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY check timed out')) }, 10_000)
    terminal.onData((data) => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      try {
        assert.equal(exitCode, 0)
        assert.ok(output.includes('32 96'), `PTY resize: ${output}`)
        assert.ok(output.includes('PTY:ANTUMI_SMOKE'), `PTY input/output: ${output}`)
        resolve()
      } catch (error) { reject(error) }
    })
    terminal.resize(96, 32)
    terminal.write('ANTUMI_SMOKE\r')
  })
}

async function waitForCore(home, children) {
  const until = Date.now() + 180_000
  while (Date.now() < until) {
    assert.ok(children.every((child) => child.exitCode === null && child.signalCode === null), 'Backend exited before listening')
    const endpoint = await readFile(path.join(home, 'core.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (endpoint) return endpoint
    await delay(100)
  }
  throw new Error('Core did not listen within three minutes')
}

function askCore(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`)
    const timer = setTimeout(() => { socket.close(); reject(new Error('system.hello timed out')) }, 10_000)
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not connect to core')) }
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.hello', params: { protocolVersion: endpoint.protocolVersion } }))
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data))
      if (reply.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else resolve(reply.result)
    }
  })
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}
