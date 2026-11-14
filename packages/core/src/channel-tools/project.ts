import { execFile } from 'node:child_process'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { ChannelToolError, channelTool, type ChannelToolResult, type ChannelToolScope } from './channel-tool'

// The three tools an agent answering from a chat platform reads projects with. A path is always
// `project/relative/path`, and what it names must be inside that project once links are followed,
// not ignored by its git, not git's own folder, and not a file that by its name holds a secret.

const MAX_ENTRIES = 500
const MAX_MATCHES = 100
const MAX_MATCH_CHARS = 300
const MAX_READ_LINES = 400
const MAX_READ_BYTES = 64 * 1024
// A file larger than this is searched, not read.
const MAX_FILE_BYTES = 5 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const GIT_BUFFER = 32 * 1024 * 1024

const SECRET_NAMES = [
  /^\.env(\..*)?$/, /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/, /^id_(rsa|dsa|ecdsa|ed25519)/, /^\.(npmrc|netrc|pypirc|htpasswd)$/,
  /^credentials?(\..*)?$/, /^secrets?(\..*)?$/
]
const SECRET_FOLDERS = new Set(['.git', '.ssh', '.aws', '.gnupg'])
// The same, as git grep leaves them out of a search.
const SECRET_PATHSPECS = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks', '**/*.kdbx', '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*',
  '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.htpasswd', '**/credential', '**/credential.*', '**/credentials', '**/credentials.*', '**/secret', '**/secret.*', '**/secrets', '**/secrets.*',
  '**/.ssh/**', '**/.aws/**', '**/.gnupg/**'
].map((glob) => `:(exclude,glob,icase)${glob}`)

export function holdsSecret(relative: string): boolean {
  const parts = relative.split('/').filter(Boolean)
  const name = (parts.at(-1) ?? '').toLowerCase()
  return parts.some((part) => SECRET_FOLDERS.has(part.toLowerCase())) || SECRET_NAMES.some((pattern) => pattern.test(name))
}

type Project = { name: string; root: string }

// Each root under its folder's name, a second of the same name numbered.
export function projectsOf(scope: ChannelToolScope): Project[] {
  const taken = new Map<string, number>()
  return scope.roots.map((root) => {
    const base = path.basename(root) || 'project'
    const count = (taken.get(base) ?? 0) + 1
    taken.set(base, count)
    return { name: count === 1 ? base : `${base}-${count}`, root }
  })
}

function git(root: string, args: readonly string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=off', ...args], { maxBuffer: GIT_BUFFER, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout })
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout })
      reject(new ChannelToolError(error.killed ? '用时太长，换个更具体的条件' : '项目读取失败'))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

async function isRepo(root: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--is-inside-work-tree']).catch(() => ({ code: 1, stdout: '' }))).stdout.trim() === 'true'
}

// Where `project/relative` is, checked: the project is one of the scope's, the path stays inside it
// once links are followed, and names nothing withheld. relative is '' for the project itself.
async function locate(scope: ChannelToolScope, given: string): Promise<{ project: Project; relative: string; file: string }> {
  const clean = given.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const [name, ...rest] = clean.split('/')
  const project = projectsOf(scope).find((each) => each.name === name)
  if (!project) throw new ChannelToolError(`没有项目「${name ?? ''}」。路径要写成「项目名/相对路径」，可用的项目：${projectsOf(scope).map((each) => each.name).join('、') || '（无）'}`)
  if (rest.some((part) => part === '..' || part === '')) throw new ChannelToolError('路径不能包含 .. 或空段')
  const relative = rest.join('/')
  if (holdsSecret(relative)) throw new ChannelToolError('这个路径不提供')
  if (!(await isRepo(project.root))) throw new ChannelToolError(`项目「${project.name}」不是 Git 仓库，不能读取`)
  const root = await realpath(project.root)
  const file = await realpath(path.join(root, ...rest)).catch(() => null)
  if (!file) throw new ChannelToolError(`没有这个路径：${clean}`)
  const inside = path.relative(root, file)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new ChannelToolError('这个路径不提供')
  // Followed through a link it may have a name that is withheld, or sit in git's own folder.
  if (holdsSecret(inside.split(path.sep).join('/'))) throw new ChannelToolError('这个路径不提供')
  if (relative && (await git(root, ['check-ignore', '-q', '--', inside])).code === 0) throw new ChannelToolError('这个路径被 .gitignore 忽略了，不提供')
  return { project, relative, file }
}

const done = (text: string, target: string): ChannelToolResult => ({ text, target, bytes: Buffer.byteLength(text) })

const ListArgs = z.object({ path: z.string().max(2000).optional() })
export const projectList = channelTool({
  name: 'project_list',
  description: '列出可读的项目，或某个目录下一层的文件和子目录。path 写成「项目名/相对路径」，不写则列出项目。只列 Git 没有忽略的内容。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: '项目名/相对路径；不写则列出项目' } } },
  params: ListArgs,
  async run(scope, { path: given }) {
    if (!given?.trim()) return done(projectsOf(scope).map((each) => `${each.name}/`).join('\n') || '（没有可读的项目）', '')
    const { project, relative, file } = await locate(scope, given)
    if (!(await stat(file)).isDirectory()) throw new ChannelToolError('这是文件，用 project_read 读它')
    const root = await realpath(project.root)
    const prefix = path.relative(root, file).split(path.sep).join('/')
    const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix ? `${prefix}/` : '.'])
    const entries = new Set<string>()
    for (const each of listed.stdout.split('\0')) {
      // A folder shows only for a file in it that would be given.
      if (!each || holdsSecret(each)) continue
      const below = prefix ? each.slice(prefix.length + 1) : each
      const [first, ...deeper] = below.split('/')
      if (!first) continue
      entries.add(deeper.length ? `${first}/` : first)
    }
    const sorted = [...entries].sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
    const shown = sorted.slice(0, MAX_ENTRIES)
    const more = sorted.length > shown.length ? `\n（还有 ${sorted.length - shown.length} 项没有列出）` : ''
    return done((shown.join('\n') || '（空目录）') + more, `${project.name}/${relative}`.replace(/\/$/, ''))
  }
})

const SearchArgs = z.object({
  query: z.string().min(1).max(500),
  regex: z.boolean().optional(),
  path: z.string().max(2000).optional(),
  glob: z.string().max(200).optional()
})
export const projectSearch = channelTool({
  name: 'project_search',
  description: '在项目的文件内容里搜索，不分大小写。query 默认按原文匹配，regex 为 true 时按扩展正则。path 限定「项目名/相对路径」，glob 限定文件名（如 *.ts）。返回「项目名/路径:行号: 内容」。',
  inputSchema: {
    type: 'object', required: ['query'],
    properties: {
      query: { type: 'string', description: '要找的文字或正则' },
      regex: { type: 'boolean', description: '按扩展正则匹配' },
      path: { type: 'string', description: '只在这个「项目名/相对路径」下找' },
      glob: { type: 'string', description: '只找文件名匹配的，如 *.ts' }
    }
  },
  params: SearchArgs,
  async run(scope, { query, regex, path: given, glob }) {
    if (glob && (glob.includes('..') || glob.startsWith('/') || glob.startsWith(':'))) throw new ChannelToolError('glob 只能是文件名模式，如 *.ts')
    const within = given?.trim() ? await locate(scope, given) : null
    const projects = within ? [within.project] : projectsOf(scope)
    const lines: string[] = []
    let total = 0
    for (const project of projects) {
      if (!(await isRepo(project.root))) continue
      const root = await realpath(project.root)
      const base = within ? path.relative(root, within.file).split(path.sep).join('/') : ''
      const pathspec = glob ? `:(glob)${base ? `${base}/` : ''}**/${glob}` : base || '.'
      const found = await git(root, ['grep', '-n', '-I', '-i', '--untracked', '--no-color', regex ? '-E' : '-F', '-e', query, '--', pathspec, ...SECRET_PATHSPECS])
      if (found.code > 1) throw new ChannelToolError(regex ? '正则写得不对，或搜索失败' : '搜索失败')
      for (const line of found.stdout.split('\n')) {
        if (!line) continue
        total += 1
        if (lines.length < MAX_MATCHES) lines.push(`${project.name}/${line.length > MAX_MATCH_CHARS ? `${line.slice(0, MAX_MATCH_CHARS)}…` : line}`)
      }
    }
    const more = total > lines.length ? `\n（共 ${total} 处，只显示前 ${lines.length} 处；加上 path 或 glob 缩小范围）` : ''
    return done((lines.join('\n') || '没有找到') + more, `${within ? `${within.project.name}/${within.relative}`.replace(/\/$/, '') : '*'}: ${query}`)
  }
})

const ReadArgs = z.object({ path: z.string().min(1).max(2000), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() })
export const projectRead = channelTool({
  name: 'project_read',
  description: `读一个文件，带行号。path 写成「项目名/相对路径」。一次最多 ${MAX_READ_LINES} 行，用 startLine、endLine 读后面的部分。`,
  inputSchema: {
    type: 'object', required: ['path'],
    properties: {
      path: { type: 'string', description: '项目名/相对路径' },
      startLine: { type: 'integer', description: '从第几行开始，默认 1' },
      endLine: { type: 'integer', description: '读到第几行' }
    }
  },
  params: ReadArgs,
  async run(scope, { path: given, startLine = 1, endLine }) {
    const { project, relative, file } = await locate(scope, given)
    const info = await stat(file)
    if (info.isDirectory()) throw new ChannelToolError('这是目录，用 project_list 列它')
    if (!info.isFile()) throw new ChannelToolError('这个路径不提供')
    if (info.size > MAX_FILE_BYTES) throw new ChannelToolError('文件太大，用 project_search 找要看的部分')
    const handle = await open(file, 'r')
    let bytes: Buffer
    try { bytes = await handle.readFile() } finally { await handle.close() }
    if (bytes.subarray(0, 8192).includes(0)) throw new ChannelToolError('这是二进制文件，读不了')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ChannelToolError('文件不是 UTF-8 文本，读不了') }
    const all = text.split('\n')
    if (all.at(-1) === '') all.pop()
    const from = Math.min(startLine, Math.max(all.length, 1))
    const until = Math.min(endLine ?? Number.POSITIVE_INFINITY, from + MAX_READ_LINES - 1, all.length)
    const out: string[] = []
    let size = 0
    let last = from - 1
    for (let line = from; line <= until; line++) {
      const row = `${line}\t${all[line - 1] ?? ''}`
      size += Buffer.byteLength(row) + 1
      if (size > MAX_READ_BYTES && out.length > 0) break
      out.push(row)
      last = line
    }
    const target = `${project.name}/${relative}`
    const note = last < all.length || from > 1 ? `\n（${target} 共 ${all.length} 行，这是第 ${from}–${last} 行）` : ''
    return done(out.join('\n') + note, `${target}:${from}-${last}`)
  }
})
