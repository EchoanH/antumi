import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LinuxArch } from './bundled-archive'
import type { LinuxResult, LinuxTarget } from './linux-target'

// The Node the backend runs on where the machine has none new enough (docs/REMOTE.md 自带 Node):
// the official build, pinned with its hash, fetched by the machine itself as VS Code's server is,
// from nodejs.org or its China mirror, else by this app and sent over. Only bin/node is kept, in
// ~/.antumi/node/<version>/.

// Raise with the Node Electron runs the backend on here; the hashes are nodejs.org's SHASUMS256.txt.
export const MANAGED_NODE = {
  version: 'v24.22.3',
  files: {
    x64: { name: 'node-v24.22.3-linux-x64.tar.gz', sha256: '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2' },
    arm64: { name: 'node-v24.22.3-linux-arm64.tar.gz', sha256: '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8' }
  }
} as const

// Tried in turn; the hash makes a mirror as good as the original.
export const NODE_SOURCES = ['https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node'] as const

type NodeRelease = { version: string; files: Record<LinuxArch, { name: string; sha256: string }> }

const nodeUrls = (arch: LinuxArch, release: NodeRelease = MANAGED_NODE) => NODE_SOURCES.map((source) => `${source}/${release.version}/${release.files[arch].name}`)

// $1 the folder, $2 the archive's name, $3 its hash; then the URLs to try, or "-" for the archive on
// stdin. Prints node's path once it is there; exits 11 when no URL gave the archive.
const INSTALL_SCRIPT = [
  'dir=$1; file=$2; sum=$3; shift 3',
  'if [ -f "$dir/.ready" ] && [ -x "$dir/node" ]; then echo "$dir/node"; exit 0; fi',
  'umask 077',
  'mkdir -p "$dir" || exit 12',
  'tmp="$dir/.archive.$$"',
  'got=',
  'for url in "$@"; do',
  '  if [ "$url" = - ]; then cat > "$tmp" || continue',
  '  elif command -v curl > /dev/null 2>&1; then curl -fsSL --connect-timeout 15 --max-time 600 -o "$tmp" "$url" 2> /dev/null || continue',
  '  elif command -v wget > /dev/null 2>&1; then wget -q -T 30 -O "$tmp" "$url" 2> /dev/null || continue',
  '  else continue',
  '  fi',
  '  if echo "$sum  $tmp" | sha256sum -c - > /dev/null 2>&1; then got=1; break; fi',
  'done',
  'if [ -z "$got" ]; then rm -f "$tmp"; exit 11; fi',
  'tar -xzf "$tmp" -C "$dir" --strip-components=2 "${file%.tar.gz}/bin/node" || { rm -f "$tmp"; exit 13; }',
  'rm -f "$tmp"',
  ': > "$dir/.ready"',
  'echo "$dir/node"'
].join('\n')

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

export type ManagedNode = { ok: true; node: string } | { ok: false; detail: string }

// The archive as this app fetched it, from its cache when it already did; null when it could not.
export type FetchNode = (arch: LinuxArch) => Promise<Buffer | null>

function failed(result: LinuxResult, what: string): string {
  return `${what}: ${(result.stderr.trim() || `exit ${String(result.code)}`).slice(-400)}`
}

// Node there, installed if it is not yet: the machine downloads it, else `fetch` brings it.
export async function ensureManagedNode(target: LinuxTarget, home: string, arch: LinuxArch, fetch: FetchNode | null): Promise<ManagedNode> {
  const { name, sha256 } = MANAGED_NODE.files[arch]
  const dir = `${home}/.antumi/node/${MANAGED_NODE.version}`
  const args = ['/bin/sh', '-c', INSTALL_SCRIPT, 'sh', dir, name, sha256]
  const there = await target.run([...args, ...nodeUrls(arch)], { timeoutMs: DOWNLOAD_TIMEOUT_MS })
  const said = there.stdout.trim().split('\n').at(-1) ?? ''
  if (there.code === 0 && said.startsWith('/')) return { ok: true, node: said }
  if (there.code !== 11) return { ok: false, detail: failed(there, 'installing Node') }
  const archive = fetch ? await fetch(arch) : null
  if (!archive) return { ok: false, detail: `the machine could not download ${name}, and neither could this computer` }
  const sent = await target.run([...args, '-'], { input: archive, timeoutMs: DOWNLOAD_TIMEOUT_MS })
  const sentSaid = sent.stdout.trim().split('\n').at(-1) ?? ''
  return sent.code === 0 && sentSaid.startsWith('/') ? { ok: true, node: sentSaid } : { ok: false, detail: failed(sent, 'sending Node') }
}

// This app's way to the archive, kept in `cache` once fetched and checked.
export function fetchNodeInto(cache: string, download: (url: string) => Promise<Buffer | null> = downloadBytes, release: NodeRelease = MANAGED_NODE): FetchNode {
  return async (arch) => {
    const { name, sha256 } = release.files[arch]
    const file = path.join(cache, name)
    const matches = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex') === sha256
    const cached = await readFile(file).catch(() => null)
    if (cached && matches(cached)) return cached
    for (const url of nodeUrls(arch, release)) {
      const bytes = await download(url).catch(() => null)
      if (!bytes || !matches(bytes)) continue
      await mkdir(cache, { recursive: true })
      await writeFile(`${file}.part`, bytes)
      await rename(`${file}.part`, file)
      return bytes
    }
    return null
  }
}

async function downloadBytes(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null
}
