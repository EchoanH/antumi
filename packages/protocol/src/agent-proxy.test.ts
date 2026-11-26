import { describe, expect, it } from 'vitest'
import { AGENT_KINDS } from './agent'
import { AgentProxySettings, DEFAULT_AGENT_PROXY_SETTINGS, agentProxyPolicy, formatCliNoProxy, hasEffectiveManualProxy, normalizeProxyUrl, parseNoProxyEntries, redactProxyUrl, sanitizeProxyErrorMessage, validateAgentProxySettings } from './agent-proxy'

describe('proxy addresses', () => {
  it.each(['http', 'https', 'socks5', 'socks5h', 'socks'])('preserves %s addresses and credentials', (scheme) => {
    const url = scheme + '://user:secret@127.0.0.1:7897'
    expect(normalizeProxyUrl('  ' + url + '  ')).toEqual({ ok: true, url })
    expect(redactProxyUrl(url)).toBe(scheme + '://***@127.0.0.1:7897')
  })
  it.each(['localhost:7897', 'proxy.example:80', '[::1]:1080'])('accepts bare %s', (url) => expect(normalizeProxyUrl(url)).toEqual({ ok: true, url: 'http://' + url }))
  it.each(['gibberish', ':123', 'localhost', 'http://', 'http://host:0', 'http://host:65536', 'http://host:abc', 'http://bad host:80', 'http://host:80\n', 'http://ho\tst:80', 'http://host\0:80', 'javascript:alert(1)'])('rejects invalid %j', (url) => expect(normalizeProxyUrl(url)).toEqual({ ok: false, error: 'invalid-proxy-url' }))
  it.each(['ftp://host:21', 'javascript://host:80', 'file://host/path'])('rejects unsupported %s', (url) => expect(normalizeProxyUrl(url)).toEqual({ ok: false, error: 'unsupported-protocol' }))
  it('handles empty addresses and masks credentials in malformed URLs and errors', () => {
    expect(normalizeProxyUrl('  ')).toEqual({ ok: true, url: null })
    expect(redactProxyUrl(null)).toBeNull()
    expect(redactProxyUrl('user:secret@host:8080')).toBe('***@host:8080')
    expect(redactProxyUrl('')).toBeNull()
    expect(redactProxyUrl('http://user:secret@host:bad')).toBe('http://***@host:bad')
    expect(redactProxyUrl('http://user:se@cret@host:80')).toBe('http://***@host:80')
    expect(redactProxyUrl('http://user:secret@host:80/')).toBe('http://***@host:80/')
    expect(sanitizeProxyErrorMessage('failed http://u:p@host:80 and socks5://u:p@host:1080')).toBe('failed http://***@host:80 and socks5://***@host:1080')
  })
  it('defaults policies and identifies effective manual settings', () => {
    const settings = AgentProxySettings.parse({ mode: 'none' })
    expect(settings).toEqual({ ...DEFAULT_AGENT_PROXY_SETTINGS, mode: 'none' })
    expect(validateAgentProxySettings(settings)).toEqual({ ok: true })
    expect(hasEffectiveManualProxy({ ...settings.manual, url: 'bad' })).toBe(false)
    expect(hasEffectiveManualProxy({ ...settings.manual, url: 'localhost:80' })).toBe(true)
    expect(hasEffectiveManualProxy({ ...settings.manual, advanced: true, allProxy: 'socks5h://localhost:1080' })).toBe(true)
    for (const agent of AGENT_KINDS) expect(agentProxyPolicy(undefined, agent)).toBe('followGlobal')
  })
})
it('normalizes CLI bypass entries and always protects loopback', () => {
  expect(parseNoProxyEntries('EXAMPLE.com; example.COM localhost\t.local')).toEqual(['EXAMPLE.com', 'localhost', '.local'])
  expect(formatCliNoProxy(['<local>', '127.*', '*.example.com', '.EXAMPLE.com', 'LOCALHOST', '::1'])).toBe('localhost,127.0.0.1,::1,.example.com')
})

it.each(['none', 'system', 'manual'] as const)('validates only active manual URLs in %s mode', (mode) => {
  for (const advanced of [false, true]) {
    const settings = AgentProxySettings.parse({ mode, manual: { advanced, url: 'http://valid:80', httpProxy: 'http://valid:80', httpsProxy: 'http://valid:80', allProxy: 'socks5://valid:1080' } })
    for (const field of ['url', 'httpProxy', 'httpsProxy', 'allProxy'] as const) {
      const active = mode === 'manual' && (advanced ? field !== 'url' : field === 'url')
      for (const invalid of ['bad', 'ftp://host:21', 'x\n']) {
        const result = validateAgentProxySettings({ ...settings, manual: { ...settings.manual, [field]: invalid } })
        if (active) expect(result).toMatchObject({ ok: false, field })
        else expect(result).toEqual({ ok: true })
      }
    }
    for (const noProxy of ['host\r', 'host\n', 'host\0']) expect(validateAgentProxySettings({ ...settings, manual: { ...settings.manual, noProxy } })).toEqual({ ok: false, field: 'noProxy', error: 'invalid-proxy-url' })
  }
})
