import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { linkShared } from '../../agent-account-home'
import type { AccountSupport } from '../agent-adapter'
import { antigravityBrowserEnv } from './antigravity-browser'
import { antigravityTokenFile, requireAntigravity } from './antigravity-runtime'
import { readAntigravityCredential } from './antigravity-usage'

const defaultHome = () => process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini')

async function prepare(home: string): Promise<void> {
  const own = defaultHome()
  // Keep ACP credentials private; share its history below that directory, never the directory itself.
  const names = await readdir(own).catch(() => [])
  await linkShared(home, own, names.filter((name) => name !== 'antigravity-acp').map((name) => ({ name })))
  await linkShared(path.join(home, 'antigravity-acp'), path.join(own, 'antigravity-acp'), [{ name: 'conversations', create: 'dir' }])
}

export async function antigravityAccountSignedIn(home?: string): Promise<boolean> {
  return (await readAntigravityCredential(antigravityTokenFile(home))) !== null
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
  identity: async () => ({ email: null }),
  login: [],
  logout: [],
  authCommand: async (action) => action === 'login'
    ? { command: process.execPath, args: ['-e', antigravityLoginScript, await requireAntigravity()], env: { PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1', ...antigravityBrowserEnv() } }
    : { command: process.execPath, args: ['-e', "require('node:fs').rmSync(require('node:path').join(process.env.GEMINI_HOME, 'antigravity-acp', 'acp_token.json'), { force: true })"] }
}
