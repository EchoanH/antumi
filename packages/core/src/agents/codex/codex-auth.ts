import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import { z } from 'zod'
import { parseJson } from '../../usage-source'
import { codexDefaultHome } from './codex-account'

const Key = z.string().trim().min(1)
const Tokens = z.object({ access_token: Key, account_id: z.string().nullish() })
const Auth = z.object({
  OPENAI_API_KEY: Key.nullish().catch(null),
  tokens: Tokens.nullish().catch(null)
})
const Provider = z.object({
  base_url: Key.optional(),
  env_key: Key.optional(),
  experimental_bearer_token: Key.optional(),
  requires_openai_auth: z.boolean().optional()
})
const Config = z.object({
  model_provider: z.string().optional(),
  profile: z.string().optional(),
  profiles: z.record(z.string(), z.object({ model_provider: z.string().optional() })).optional(),
  model_providers: z.record(z.string(), Provider).optional()
})

export type CodexTokens = z.infer<typeof Tokens>
type CodexAuth = { type: 'chatgpt'; tokens: CodexTokens } | { type: 'api-key' }

async function nativeProvider(home: string) {
  try {
    const config = Config.parse(parse(await readFile(path.join(home, 'config.toml'), 'utf8')))
    const profile = config.profile ? config.profiles?.[config.profile] : undefined
    const id = profile?.model_provider ?? config.model_provider ?? 'openai'
    const provider = config.model_providers?.[id]
    return provider ? { ...provider, requires_openai_auth: provider.requires_openai_auth ?? id === 'openai' } : null
  } catch {
    return null
  }
}

// Inspect Codex's active native configuration; never copy keys or change its files.
export async function readCodexAuth(home = codexDefaultHome()): Promise<CodexAuth | null> {
  const [raw, provider] = await Promise.all([
    readFile(path.join(home, 'auth.json'), 'utf8').catch(() => null),
    nativeProvider(home)
  ])
  if (provider && !provider.requires_openai_auth) {
    if (provider.env_key) return process.env[provider.env_key]?.trim() ? { type: 'api-key' } : null
    if (provider.experimental_bearer_token || provider.base_url) return { type: 'api-key' }
  }
  const auth = Auth.safeParse(parseJson(raw))
  if (!auth.success) return null
  if (auth.data.OPENAI_API_KEY) return { type: 'api-key' }
  return auth.data.tokens ? { type: 'chatgpt', tokens: auth.data.tokens } : null
}
