import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexAuthentication, hasCodexCredentials, readCodexUsage } from './codex-usage'

describe('Codex native authentication', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'antumi-codex-auth-'))
    vi.stubEnv('CODEX_HOME', home)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network request')))
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  })

  it.each([
    { OPENAI_API_KEY: 'test-relay-key', tokens: null },
    { OPENAI_API_KEY: 'test-relay-key' }
  ])('accepts an API key without requesting ChatGPT quota: %j', async (auth) => {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(auth))
    expect(await hasCodexCredentials()).toBe(true)
    expect(await codexAuthentication()).toEqual({ signedIn: true, authSource: 'native-provider' })
    expect(await readCodexUsage()).toEqual({ signedIn: true, windows: [], plan: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['{}', '{"OPENAI_API_KEY":""}', '{"OPENAI_API_KEY":"  ","tokens":null}', '{"tokens":null}', 'invalid'])('rejects missing credential material: %s', async (raw) => {
    await writeFile(path.join(home, 'auth.json'), raw)
    expect(await hasCodexCredentials()).toBe(false)
    expect(await readCodexUsage()).toEqual({ signedIn: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  const relay = (fields: string) => `model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example/v1"\n${fields}\n`

  it.each([
    'experimental_bearer_token = "test-config-key"',
    'env_key = "ANTUMI_TEST_RELAY_KEY"',
    ''
  ])('recognizes the active native provider without an official sign-in: %s', async (fields) => {
    vi.stubEnv('ANTUMI_TEST_RELAY_KEY', 'test-env-key')
    await writeFile(path.join(home, 'config.toml'), relay(fields))
    expect(await hasCodexCredentials(home)).toBe(true)
    expect(await readCodexUsage(home)).toEqual({ signedIn: true, windows: [], plan: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not report an inactive provider or missing environment key as ready', async () => {
    await writeFile(path.join(home, 'config.toml'), relay('experimental_bearer_token = "test-key"').replace('model_provider = "relay"', 'model_provider = "openai"'))
    expect(await hasCodexCredentials(home)).toBe(false)
    vi.stubEnv('ANTUMI_TEST_RELAY_KEY', '')
    await writeFile(path.join(home, 'config.toml'), relay('env_key = "ANTUMI_TEST_RELAY_KEY"'))
    expect(await hasCodexCredentials(home)).toBe(false)
  })

  it('requires credentials when the selected provider uses OpenAI authentication', async () => {
    await writeFile(path.join(home, 'config.toml'), relay('requires_openai_auth = true'))
    expect(await hasCodexCredentials(home)).toBe(false)
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-relay-key', tokens: null }))
    expect(await readCodexUsage(home)).toEqual({ signedIn: true, windows: [], plan: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the built-in OpenAI authentication requirement when its URL is customized', async () => {
    await writeFile(path.join(home, 'config.toml'), '[model_providers.openai]\nbase_url = "https://relay.example/v1"\n')
    expect(await hasCodexCredentials(home)).toBe(false)
  })

  it('keeps ChatGPT quota requests off a native relay even if an official sign-in remains', async () => {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-official-token' } }))
    await writeFile(path.join(home, 'config.toml'), relay('experimental_bearer_token = "test-relay-key"'))
    expect(await readCodexUsage(home)).toEqual({ signedIn: true, windows: [], plan: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the provider chosen by the default profile', async () => {
    await writeFile(path.join(home, 'config.toml'), `profile = "work"\n${relay('experimental_bearer_token = "test-key"').replace('model_provider = "relay"', 'model_provider = "openai"')}\n[profiles.work]\nmodel_provider = "relay"\n`)
    expect(await hasCodexCredentials(home)).toBe(true)
  })

  it('continues to read official quota for ChatGPT authentication', async () => {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-official-token', account_id: 'test-account' } }))
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ plan_type: 'plus', rate_limit_reset_credits: { available_count: 0 } })))
    expect(await hasCodexCredentials(home)).toBe(true)
    expect(await readCodexUsage(home)).toMatchObject({ signedIn: true, plan: 'plus', windows: [] })
    expect(await codexAuthentication(home)).toEqual({ signedIn: true, authSource: 'account' })
    expect(fetch).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-official-token', 'ChatGPT-Account-Id': 'test-account' }) }))
  })

  it('uses an explicitly selected account home without borrowing the default home key', async () => {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'test-default-key' }))
    expect(await hasCodexCredentials(path.join(home, 'other-account'))).toBe(false)
  })

  it('rejects missing files and malformed TOML without throwing', async () => {
    expect(await hasCodexCredentials(home)).toBe(false)
    await writeFile(path.join(home, 'config.toml'), '[model_providers.')
    expect(await hasCodexCredentials(home)).toBe(false)
  })
})
