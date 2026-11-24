import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderImportPreview, ProviderImportResult } from '@antumi/protocol'
import { CcSwitchImport } from './cc-switch-import'
import { CredentialStore } from './credential-store'
import { ModelProviderStore } from './model-providers'

const KEY = 'test-cc-switch-private-key'
const claude = (extra: object = {}) => ({ env: { ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_MODEL: 'claude-test', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-test', ...extra } })
const codex = (extra = '') => ({ auth: { OPENAI_API_KEY: KEY }, config: `model_provider = "relay"\nmodel = "gpt-test"\nmodel_reasoning_effort = "high"\nmodel_context_window = 200000\n[model_providers.relay]\nbase_url = "https://relay.example/v1"\nwire_api = "responses"\n${extra}` })

describe('CC Switch provider import', () => {
  let dir: string
  let store: ModelProviderStore
  let importer: CcSwitchImport
  let now: number
  const source = () => path.join(dir, 'cc-switch.db')

  async function database(entries: { id: string; app: string; config: unknown; name?: string; category?: string; meta?: object }[]) {
    const db = new DatabaseSync(source())
    db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, meta TEXT, is_current INTEGER)')
    const insert = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const entry of entries) insert.run(entry.id, entry.app, entry.name ?? entry.id, JSON.stringify(entry.config), entry.category ?? null, JSON.stringify(entry.meta ?? {}), 0)
    db.close()
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'antumi-cc-switch-'))
    const credentials = new CredentialStore(path.join(dir, 'credentials.json'))
    await credentials.load()
    let seq = 0
    store = new ModelProviderStore(path.join(dir, 'model-providers.json'), credentials, () => {}, () => `cc-import-${++seq}`)
    await store.load()
    now = 0
    importer = new CcSwitchImport(store, () => dir, () => now)
  })
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })

  it('previews inactive Claude and Codex entries without keys, and copies only the selected provider', async () => {
    await database([{ id: 'Claude relay', app: 'claude', config: claude() }, { id: 'Codex relay', app: 'codex', config: codex() }])
    const bytes = await readFile(source())
    const preview = ProviderImportPreview.parse(await importer.preview(dir))
    expect(preview.candidates).toHaveLength(2)
    expect(JSON.stringify(preview)).not.toContain(KEY)
    expect(store.list()).toEqual([])
    const chosen = preview.candidates.find((entry) => entry.app === 'codex')
    if (!chosen) throw new Error('missing Codex candidate')
    const result = ProviderImportResult.parse(await importer.import(preview.token, [chosen.id]))
    expect(result.items).toEqual([{ id: chosen.id, name: 'Codex relay', status: 'imported', issue: null }])
    const saved = store.list()[0]
    if (!saved) throw new Error('missing imported provider')
    expect(saved).toMatchObject({ agents: ['codex'], smallJobs: 'off', openai: { responsesUrl: 'https://relay.example/v1' }, models: [{ id: 'gpt-test', contextWindow: 200000, efforts: ['high'] }] })
    expect(store.resolve(saved.id)?.apiKey).toBe(KEY)
    expect(await readFile(source())).toEqual(bytes)
    expect(await readFile(path.join(dir, 'model-providers.json'), 'utf8')).not.toContain(KEY)
    expect(JSON.stringify(store.list())).not.toContain(KEY)
    if (process.platform !== 'win32') expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600)
  })

  it('finds the default data directory and expands a home-relative custom directory', async () => {
    const directory = path.join(dir, '.cc-switch')
    await mkdir(directory)
    await writeFile(path.join(directory, 'config.json'), JSON.stringify({ providers: { c: { name: 'Relay', settingsConfig: claude() } } }))
    expect((await importer.preview()).directory).toBe(directory)
    expect((await importer.preview('~/.cc-switch')).candidates).toHaveLength(1)
  })

  it('reads uncheckpointed providers while CC Switch keeps its WAL database open', async () => {
    await database([{ id: 'first', app: 'claude', config: claude() }])
    const db = new DatabaseSync(source())
    try {
      db.exec('PRAGMA journal_mode=WAL')
      db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)').run('second', 'codex', 'Second', JSON.stringify(codex()), null, '{}', 0)
      expect((await importer.preview(dir)).candidates).toHaveLength(2)
    } finally { db.close() }
  })

  it('maps Claude aliases and auth headers, and serializes repeated imports without overwriting', async () => {
    await database([{ id: 'Relay', app: 'claude', config: claude({ ANTHROPIC_CUSTOM_HEADERS: 'X-Client: antumi', API_TIMEOUT_MS: '300000' }) }])
    const preview = await importer.preview(dir)
    const ids = preview.candidates.map((entry) => entry.id)
    const results = await Promise.all([importer.import(preview.token, ids), importer.import(preview.token, ids)])
    expect(results.map((result) => result.items[0]?.status)).toEqual(['imported', 'skipped'])
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ anthropic: { auth: 'auth_token', env: { API_TIMEOUT_MS: '300000' } }, smallModel: 'haiku-test', headers: { 'X-Client': 'antumi' } })
    expect((await importer.preview(dir)).candidates[0]?.issue).toBe('duplicate')
  })

  it('supports legacy JSON without changing it and reads an active TOML profile or environment key', async () => {
    vi.stubEnv('ANTUMI_TEST_CC_KEY', KEY)
    const file = path.join(dir, 'config.json')
    const config = codex('env_key = "ANTUMI_TEST_CC_KEY"\n[profiles.work]\nmodel = "profile-model"')
    config.config = `profile = "work"\n${config.config}`
    const raw = JSON.stringify({ claude: { providers: { c: { name: 'Claude', settingsConfig: claude({ ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: KEY }) } } }, codex: { providers: { x: { name: 'Codex', settingsConfig: config } } } })
    await writeFile(file, raw)
    const preview = await importer.preview(dir)
    await importer.import(preview.token, preview.candidates.map((entry) => entry.id))
    expect(store.list()).toHaveLength(2)
    expect(store.list().find((entry) => entry.agents.includes('claude'))?.anthropic?.auth).toBe('api_key')
    expect(store.list().find((entry) => entry.agents.includes('codex'))?.defaultModel).toBe('profile-model')
    expect(await readFile(file, 'utf8')).toBe(raw)
  })

  it('explains unsupported, managed, keyless and malformed rows without leaking configuration', async () => {
    await database([
      { id: 'official', app: 'codex', config: codex(), category: 'official' },
      { id: 'oauth', app: 'claude', config: claude(), meta: { providerType: 'github_copilot' } },
      { id: 'other', app: 'gemini', config: {} },
      { id: 'keyless', app: 'claude', config: claude({ ANTHROPIC_AUTH_TOKEN: '' }) },
      { id: 'unsafe', app: 'claude', config: claude({ ANTHROPIC_BASE_URL: `https://relay.example/v1?key=${KEY}` }) },
      { id: 'bad-toml', app: 'codex', config: { config: '[' } },
      { id: 'good', app: 'claude', config: claude() }
    ])
    const preview = await importer.preview(dir)
    expect(Object.fromEntries(preview.candidates.map((entry) => [entry.name, entry.issue]))).toMatchObject({ official: 'managed-account', oauth: 'managed-account', other: 'unsupported', keyless: 'missing-key', unsafe: 'invalid-config', 'bad-toml': 'invalid-config', good: null })
    expect(JSON.stringify(preview)).not.toContain(KEY)
    const result = await importer.import(preview.token, preview.candidates.map((entry) => entry.id))
    expect(result.items.filter((entry) => entry.status === 'imported')).toHaveLength(1)
    expect(store.list()).toHaveLength(1)
  })

  it('does not copy a key into public request headers, names or URL paths', async () => {
    await database([
      { id: 'Headers', app: 'claude', config: claude({ ANTHROPIC_CUSTOM_HEADERS: `X-Route: ${KEY}` }) },
      { id: 'Path', app: 'claude', config: claude({ ANTHROPIC_BASE_URL: `https://relay.example/${KEY}/v1` }) },
      { id: 'Name', name: `Relay ${KEY}`, app: 'codex', config: codex() }
    ])
    const preview = await importer.preview(dir)
    expect(preview.candidates.every((entry) => entry.issue === 'invalid-config')).toBe(true)
    expect(JSON.stringify(preview)).not.toContain(KEY)
    const result = await importer.import(preview.token, preview.candidates.map((entry) => entry.id))
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(store.list()).toEqual([])
  })

  it('lists unknown models only after selection and reports individual failures', async () => {
    await database([{ id: 'No model', app: 'claude', config: claude({ ANTHROPIC_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '' }) }, { id: 'Known model', app: 'codex', config: codex() }])
    const listing = vi.spyOn(store, 'fetchModels').mockResolvedValue({ models: [], endpoints: [] })
    const preview = await importer.preview(dir)
    expect(listing).not.toHaveBeenCalled()
    const result = await importer.import(preview.token, preview.candidates.map((entry) => entry.id))
    expect(result.items.find((entry) => entry.name === 'No model')).toMatchObject({ status: 'failed', issue: 'models-unavailable' })
    expect(store.list()).toHaveLength(1)
    const found = preview.candidates.find((entry) => entry.name === 'No model')
    if (!found) throw new Error('missing candidate')
    listing.mockResolvedValue({ models: [{ id: 'listed-model', label: null, contextWindow: 100000, maxOutput: null, efforts: [] }], endpoints: [] })
    expect((await importer.import(preview.token, [found.id])).items[0]?.status).toBe('imported')
    expect(store.list().find((entry) => entry.name === 'No model')?.defaultModel).toBe('listed-model')
  })

  it('rejects expired or invented selections and does not create a missing source database', async () => {
    await expect(importer.preview(dir)).rejects.toMatchObject({ reason: 'cc-switch-not-found' })
    await expect(stat(source())).rejects.toMatchObject({ code: 'ENOENT' })
    await database([{ id: 'Relay', app: 'claude', config: claude() }])
    const preview = await importer.preview(dir)
    await expect(importer.import(preview.token, ['invented'])).rejects.toMatchObject({ reason: 'cc-switch-selection-invalid' })
    now = 11 * 60_000
    await expect(importer.import(preview.token, preview.candidates.map((entry) => entry.id))).rejects.toMatchObject({ reason: 'cc-switch-preview-expired' })
    expect(store.list()).toEqual([])
  })
})
