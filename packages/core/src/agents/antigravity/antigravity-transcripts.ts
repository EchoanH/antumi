import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { antumiHome } from '@antumi/protocol/node'
import { findFiles, titleOf, type TranscriptSource, type TranscriptSummary } from '../../agent-transcripts'
import { TranscriptBuilder } from '../../transcript-builder'
import { json, object, string } from '../../transcript-values'
import { openTranscriptDb, transcriptDbModifiedAt, transcriptTables } from '../../sqlite-transcripts'
import { protoAllBytes, protoFields, protoBytes, protoNumber, protoPreview, protoText } from '../../transcript-protobuf'

export function antigravitySessionsRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = env.GEMINI_HOME || path.join(home, '.gemini')
  return path.join(configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured, 'antigravity-acp', 'conversations')
}
export function antigravityAgyCliSessionsRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(path.dirname(path.dirname(antigravitySessionsRoot(env, home))), 'antigravity-cli-acp', 'conversations')
}
export const antigravitySessionRoots = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()): readonly string[] => [antigravitySessionsRoot(env, home), antigravityAgyCliSessionsRoot(env, home)]

export async function discoverAntigravitySessionRoots(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<readonly string[]> {
  const directories = [...antigravitySessionRoots(env, home)]
  const archives = path.join(path.dirname(antigravityAgyCliSessionsRoot(env, home)), 'archived-conversations')
  const accounts = path.join(antumiHome(), 'agent-accounts', 'antigravity')
  for (const [parent, archived] of [[archives, true], [accounts, false]] as const) {
    const entries = await readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) if (entry.isDirectory()) directories.push(archived ? path.join(parent, entry.name) : path.join(parent, entry.name, 'antigravity-cli-acp', 'conversations'))
  }
  return directories
}

function metadataCwd(data: Uint8Array): string {
  // Decode length-delimited fields before scanning, so adjacent protobuf tags cannot enter the URI.
  let fields: ReturnType<typeof protoFields> = []
  try { fields = protoFields(data) } catch { /* A leaf field is a UTF-8 string. */ }
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) continue
    const cwd = metadataCwd(field.value)
    if (cwd) return cwd
  }
  const uri = Buffer.from(data).toString('utf8').match(/file:\/\/[^\s\x00-\x1f"<>]+/)?.[0]
  if (!uri) return ''
  try { return fileURLToPath(uri) } catch { return '' }
}
async function sessionCwd(file: string): Promise<string> {
  let meta: Record<string, unknown> = {}
  try { meta = object(json(await readFile(file.replace(/\.db$/, '.meta'), 'utf8'))) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  if (string(meta.cwd)) return string(meta.cwd)
  const db = openTranscriptDb(file)
  try {
    if (!transcriptTables(db).has('trajectory_metadata_blob')) return ''
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob ORDER BY id = 'main' DESC LIMIT 1").get()
    return row?.data instanceof Uint8Array ? metadataCwd(row.data) : ''
  } finally { db.close() }
}

const TOOL_FIELDS: Readonly<Record<number, string>> = { 13: 'grep_search', 14: 'view_file', 15: 'list_directory', 23: 'write_to_file', 28: 'run_command', 40: 'read_url_content', 42: 'search_web', 47: 'mcp', 98: 'file_change', 116: 'agency_tool_call', 154: 'ask_question' }
const EMPTY = new Uint8Array()

function protoTime(metadata: Uint8Array, fallback: number): number {
  const stamp = protoBytes(metadata, 1)
  return stamp ? (protoNumber(stamp, 1) ?? 0) * 1000 + (protoNumber(stamp, 2) ?? 0) / 1_000_000 : fallback
}
function readSteps(file: string, modifiedAt: number, summaryOnly = false) {
  const db = openTranscriptDb(file)
  const builder = new TranscriptBuilder()
  try {
    if (!transcriptTables(db).has('steps')) return builder.build()
    const rows = db.prepare('SELECT idx, step_payload FROM steps ORDER BY idx').iterate()
    for (const row of rows) {
      if (!(row.step_payload instanceof Uint8Array)) continue
      const step = row.step_payload
      const metadata = protoBytes(step, 5) ?? EMPTY
      const at = protoTime(metadata, modifiedAt)
      const id = String(row.idx)
      const user = protoBytes(step, 19)
      if (user) {
        builder.user(id, protoText(user, 1) || protoAllBytes(user, 3).map((item) => protoText(item, 1)).join('') || protoText(user, 2), at)
        if (summaryOnly && builder.transcript.messages.length) break
      }
      const response = protoBytes(step, 20)
      if (response) {
        builder.assistant(id, protoText(response, 1), at)
        builder.assistant(id, protoText(response, 3), at, true)
        for (const call of protoAllBytes(response, 7)) builder.tool(protoText(call, 1), protoText(call, 2), json(protoText(call, 3)) ?? protoText(call, 3), null, at, 'pending')
      }
      const call = protoBytes(metadata, 4)
      for (const [fieldText, label] of Object.entries(TOOL_FIELDS)) {
        const field = Number(fieldText)
        const payload = protoBytes(step, field)
        if (!payload) continue
        const callId = call ? protoText(call, 1) || id : id
        const name = call ? protoText(call, 2) || label : label
        let input: unknown = call ? json(protoText(call, 3)) ?? protoText(call, 3) : protoPreview(payload)
        let output: unknown = protoPreview(payload)
        let failed = protoNumber(step, 4) === 7
        if (field === 28) {
          input = { command: protoText(payload, 23) || protoText(payload, 1) }
          const combined = protoBytes(payload, 21)
          output = combined ? protoText(combined, 1) || protoText(combined, 2) : [protoText(payload, 4), protoText(payload, 5)].filter(Boolean).join('\n')
          failed ||= (protoNumber(payload, 6) ?? 0) !== 0
        } else if (field === 14) { input = { path: protoText(payload, 1) }; output = protoText(payload, 4) }
        else if (field === 47) {
          const mcpCall = protoBytes(payload, 2)
          if (mcpCall) input = json(protoText(mcpCall, 3)) ?? protoText(mcpCall, 3)
          output = protoText(payload, 3)
          failed ||= protoNumber(payload, 7) === 1
        } else if (field === 116) {
          output = protoAllBytes(payload, 4).map((any) => {
            const type = protoText(any, 1).split('/').at(-1)
            const body = protoBytes(any, 2)
            return type === 'antigravity.localharness.ToolResponse' && body ? json(protoText(body, 2)) ?? protoText(body, 2) : protoPreview(any)
          })
        }
        builder.tool(callId, name, input, output, at, failed ? 'failed' : 'completed')
      }
    }
    return builder.build()
  } finally { db.close() }
}

function originOf(directory: string): { backend: 'managed-acp' | 'agy-cli' | null; account: string | null; archived: boolean } {
  const segments = path.resolve(directory).split(/[\\/]+/)
  if (segments.at(-2) === 'antigravity-acp' && segments.at(-1) === 'conversations') {
    return { backend: 'managed-acp', account: 'default', archived: false }
  }
  if (segments.at(-5) === 'agent-accounts' && segments.at(-4) === 'antigravity' && segments.at(-2) === 'antigravity-cli-acp' && segments.at(-1) === 'conversations') {
    return { backend: 'agy-cli', account: segments.at(-3) ?? null, archived: false }
  }
  if (segments.at(-2) === 'antigravity-cli-acp' && segments.at(-1) === 'conversations') {
    return { backend: 'agy-cli', account: 'default', archived: false }
  }
  if (segments.at(-3) === 'antigravity-cli-acp' && segments.at(-2) === 'archived-conversations') {
    return { backend: 'agy-cli', account: null, archived: true }
  }
  return { backend: null, account: null, archived: false }
}

export function antigravityTranscripts(roots: () => string | readonly string[] | Promise<string | readonly string[]> = () => discoverAntigravitySessionRoots()): TranscriptSource {
  const warnings: string[] = []
  return {
    diagnostics: () => [...warnings],
    async scan() {
      warnings.length = 0
      const summaries = new Map<string, TranscriptSummary>()
      const selected = await roots()
      const directories = typeof selected === 'string' ? [selected] : selected
      for (const directory of directories) {
        const origin = originOf(directory)
        for (const file of await findFiles(directory, 0, (name) => name.endsWith('.db'))) {
          if (file.size === 0) continue
          try {
            const cwd = await sessionCwd(file.file)
            const modifiedAt = await transcriptDbModifiedAt(file.file)
            const transcript = readSteps(file.file, modifiedAt, true)
            const first = transcript.messages.find((message) => message.role === 'user')
            if (!first || !cwd) continue
            const sessionId = path.basename(file.file, '.db')
            if ((summaries.get(sessionId)?.modifiedAt ?? -Infinity) >= modifiedAt) continue
            summaries.set(sessionId, { sessionId, cwd, title: titleOf(first.text), named: false,
              firstPrompt: titleOf(first.text, 200), startedAt: first.at, modifiedAt, file: file.file,
              ...(origin.backend ? { backend: origin.backend } : {}),
              ...(origin.account ? { account: origin.account } : {}),
              ...(origin.archived ? { nativeSessionId: null } : {}) })
          } catch { warnings.push(`无法读取 Antigravity ACP 会话：${file.file}`) }
        }
      }
      return [...summaries.values()]
    },
    async read(file) { return readSteps(file, await transcriptDbModifiedAt(file)) }
  }
}
