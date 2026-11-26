import { randomUUID } from 'node:crypto'
import { readdir, mkdir, copyFile, rm, constants } from 'node:fs/promises'
import path from 'node:path'
import { linkShared } from '../../agent-account-home'
import type { AccountSupport } from '../agent-adapter'
import { antigravityBrowserEnv } from './antigravity-browser'
import { requireAntigravity } from './antigravity-runtime'
import type { AntigravityBackend } from '@antumi/protocol'
import { ANTIGRAVITY_STRIPPED_ENV, activeAntigravityBackend, defaultGeminiHome, agyCliCommand, ensureOAuthSettings, requireAgyCli } from './antigravity-backend'
import { hasAnyAntigravityCredential, readAntigravityIdentity, syncAfterAntigravityLogin } from './antigravity-credentials'

async function prepare(home: string): Promise<void> {
  const own = defaultGeminiHome()
  const names = await readdir(own).catch(() => [])
  const privateEntries = new Set(['antigravity-acp', 'antigravity-cli', 'antigravity-cli-acp', 'antigravity-acp-meta.json', 'tmp'])
  const shared = names.filter(name => !privateEntries.has(name) && !name.endsWith('.lock'))
  await linkShared(home, own, shared.map(name => ({ name })))
  // Windows may refuse file symlinks; preserve global rules without replacing account files.
  if (shared.includes('GEMINI.md') && path.resolve(home) !== path.resolve(own)) {
    await copyFile(path.join(own, 'GEMINI.md'), path.join(home, 'GEMINI.md'), constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  }
  await linkShared(path.join(home, 'antigravity-acp'), path.join(own, 'antigravity-acp'), [{ name: 'conversations', create: 'dir' }])
  await mkdir(path.join(home, 'antigravity-cli-acp'), { recursive: true, mode: 0o700 })
}

async function beforeRemove(home: string): Promise<void> {
  const source = path.join(home, 'antigravity-cli-acp', 'conversations')
  const files = (await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })).filter(entry => entry.isFile())
  if (!files.length) return
  const destination = path.join(defaultGeminiHome(), 'antigravity-cli-acp', 'archived-conversations', path.basename(home))
  await mkdir(destination, { recursive: true, mode: 0o700 })
  // A fresh prefix keeps DB/WAL/metadata together without replacing an earlier archive.
  const existing = new Set(await readdir(destination))
  const prefix = files.some(entry => existing.has(entry.name)) ? randomUUID() + '-' : ''
  for (const entry of files) {
    const file = path.join(source, entry.name)
    await copyFile(file, path.join(destination, prefix + entry.name), constants.COPYFILE_EXCL)
  }
  // Copying exclusively also works across volumes; retain all originals on copy failure.
  for (const entry of files) await rm(path.join(source, entry.name))
}

export async function antigravityAccountSignedIn(home?: string, backend?: AntigravityBackend): Promise<boolean> {
  return hasAnyAntigravityCredential(home, backend)
}

// Run in a daemon-owned terminal so closing settings cannot interrupt browser authorization.
// Only initialize/authenticate are sent: no session or model request is needed to sign in.
export const antigravityLoginScript = String.raw`
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const child = spawn(process.argv[1], process.platform === 'linux' ? ['--uid='] : [], { stdio: ['pipe', 'pipe', 'inherit'] });
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill();
  process.exitCode = code;
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  force.unref();
}
const timer = setTimeout(() => { console.error('Google sign-in timed out. Please retry.'); finish(1); }, 330000);
child.on('error', (error) => { console.error(error.message); finish(1); });
child.on('exit', (code) => { if (!finished) { clearTimeout(timer); process.exitCode = code || 1; } });
child.stdin.on('error', () => finish(1));
process.on('SIGINT', () => finish(1));
process.on('SIGTERM', () => finish(1));
function send(id, method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
createInterface({ input: child.stdout }).on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.id !== 1 && frame.id !== 2) return;
  if (frame.error) { console.error(frame.error.message || 'Google sign-in failed'); finish(1); return; }
  if (!('result' in frame)) return;
  if (frame.id === 1) {
    console.log('Complete Google sign-in in your browser.');
    send(2, 'authenticate', { methodId: 'oauth-personal' });
  } else { console.log('Google sign-in complete.'); finish(0); }
});
send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'antumi', version: '1' }, clientCapabilities: {} });
`

export const antigravityAccounts: AccountSupport = {
  env: (home) => ({ GEMINI_HOME: home }),
  prepare,
  beforeRemove,
  identity: async (home) => ({ email: (await readAntigravityIdentity(home)).email }),
  login: [],
  logout: [],
  authCommand: async (action, home) => {
    if (action === 'logout') return {
      command: process.execPath,
      args: ['-e', "const fs = require('node:fs'); const path = require('node:path'); const configured = process.env.GEMINI_HOME || process.argv[1]; const home = configured.startsWith('~/') ? path.join(require('node:os').homedir(), configured.slice(2)) : configured; for (const file of ['antigravity-acp/acp_token.json', 'antigravity-cli-acp/antigravity-oauth-token', 'antigravity-acp-meta.json']) fs.rmSync(path.join(home, file), { force: true });", defaultGeminiHome()],
      ...(home ? { env: { GEMINI_HOME: home } } : {})
    }
    const backend = await activeAntigravityBackend()
    await ensureOAuthSettings(backend, home)
    if (backend === 'agy-cli') {
      const command = agyCliCommand(await requireAgyCli(), home, true)
      return { ...command, backend, unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV], env: { ...command.env, ...antigravityBrowserEnv() } }
    }
    return { backend, unsetEnv: [...ANTIGRAVITY_STRIPPED_ENV], command: process.execPath, args: ['-e', antigravityLoginScript, await requireAntigravity()], env: { ...(home ? { GEMINI_HOME: home } : {}), PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1', ...antigravityBrowserEnv() } }
  },
  afterLogin: async (home, backend) => {
    const resolved: AntigravityBackend = backend === 'agy-cli' || backend === 'managed-acp' ? backend : await activeAntigravityBackend()
    await syncAfterAntigravityLogin(home, resolved)
  }
}
