// Packs out/backend, bundled for Linux, into the archive the app installs on a Linux machine it runs
// its backend on, a WSL distro or an SSH host (docs/WSL.md, docs/REMOTE.md):
// build/linux-backend/backend-linux-<arch>.tar.gz and, beside it, what the app checks it against.
// Runs on Linux after `bundle-backend.mjs --platform linux --linux-backend`, once per architecture,
// on the oldest glibc worth supporting: node-pty compiled against a newer one does not load on a
// machine with an older.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const backend = path.join(desktop, 'out', 'backend')
const out = path.join(desktop, 'build', 'linux-backend')

if (!existsSync(path.join(backend, 'node_modules/node-pty/build/Release/pty.node'))) {
  throw new Error('[pack-linux-backend] out/backend holds no Linux node-pty: run bundle-backend.mjs --platform linux --linux-backend first, on Linux')
}
if (!existsSync(path.join(backend, 'backend-control.mjs'))) throw new Error('[pack-linux-backend] out/backend was bundled without --linux-backend')
if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error(`[pack-linux-backend] no archive for ${process.arch}`)

const name = `backend-linux-${process.arch}`
const archive = path.join(out, `${name}.tar.gz`)
// Only this architecture's: the other's is packed on another machine into the same folder.
mkdirSync(out, { recursive: true })
rmSync(archive, { force: true })
execFileSync('tar', ['-czf', archive, '-C', backend, '.'], { stdio: 'inherit' })

const bytes = readFileSync(archive)
const { version } = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'))
const manifest = { file: path.basename(archive), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, version }
writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[pack-linux-backend] ${manifest.file} ${(manifest.size / 1024 / 1024).toFixed(1)}MB ${manifest.sha256}`)
