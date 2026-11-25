import { afterEach, describe, expect, it } from 'vitest'
import { closeContactAuthor, contactAuthor, useContactAuthor } from './contact-author'
import { githubIssueUrl, supportError, supportReport } from './support-report'

afterEach(closeContactAuthor)

describe('problem details shared with the author', () => {
  it.each([
    'Authorization: Bearer sensitive-value\nRequest failed',
    'Cookie: session=sensitive-value; other=private\nRequest failed',
    '{"api_key": "sensitive-value with spaces", "error": "failed"}',
    'API_KEY=sensitive-value request failed',
    'https://example.test/api?access_token=sensitive-value&retry=1',
    'https://username:sensitive-value@example.test/api',
    'password: "sensitive-value"',
    'Bearer sensitive-value',
    '-----BEGIN PRIVATE KEY-----\nsensitive-value\n-----END PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----\nsensitive-value',
  ])('hides credentials in %s', (error) => {
    const report = supportReport(error, '0.22.0', 'darwin', 'zh-CN')
    expect(report).not.toContain('sensitive-value')
    expect(report).toContain('[redacted]')
  })
  it('hides standalone provider keys and tokens', () => {
    const secrets = ['sk-proj-abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz', 'xoxb-123456789012345', 'AKIAABCDEFGHIJKLMNOP', 'eyJabcdefghijk.eyJabcdefghijk.abcdefghijk']
    for (const secret of secrets) expect(supportError(`Connection failed: ${secret}`)).toBe('Connection failed: [redacted]')
  })
  it('preserves useful error details and includes only the selected error and basic environment', () => {
    expect(supportReport('Connection refused at 127.0.0.1:8787', '0.22.0', 'linux', 'en')).toBe('Antumi: 0.22.0\nOS: linux\nLanguage: en\n\nConnection refused at 127.0.0.1:8787')
    expect(supportReport('', null, 'linux', 'en')).toBe('Antumi: unknown\nOS: linux\nLanguage: en')
    expect(supportError('x'.repeat(100_000))).toHaveLength(8_000)
  })
  it('keeps an independent redacted copy after a transient error disappears', () => {
    contactAuthor('request failed: api_key=sensitive-value')
    expect(useContactAuthor.getState().request?.error).toBe('request failed: api_key=[redacted]')
    contactAuthor()
    expect(useContactAuthor.getState().request).toEqual({ error: '' })
    closeContactAuthor()
    expect(useContactAuthor.getState().request).toBeNull()
  })
  it('prefills a GitHub issue with environment details and a redacted error, leaving reproduction steps to the user', () => {
    const error = '请求失败 & timeout #1\napi_key=sensitive-value'
    const report = supportReport(error, '0.22.0', 'darwin', 'zh-CN')
    const url = new URL(githubIssueUrl(report, error, 'zh-CN'))
    expect(url.origin + url.pathname).toBe('https://github.com/flyhero/antumi/issues/new')
    expect(url.searchParams.get('title')).toBe('请求失败 & timeout #1')
    expect(url.searchParams.get('body')).toContain('    Antumi: 0.22.0\n    OS: darwin')
    expect(url.searchParams.get('body')).toContain('## 复现步骤\n1. ')
    expect(url.searchParams.get('body')).toContain('    api_key=[redacted]')
    expect(url.href).not.toContain('sensitive-value')
  })
  it('redacts a secret in the issue title and safely includes Markdown-looking errors as code', () => {
    const error = 'token=private-value\n```\n# malicious heading'
    const url = new URL(githubIssueUrl(error, error, 'en'))
    expect(url.searchParams.get('title')).toBe('token=[redacted]')
    expect(url.searchParams.get('body')).toContain('\n    ```\n    # malicious heading')
    expect(url.href).not.toContain('private-value')
  })
  it('bounds the encoded URL for long Chinese and emoji errors and indicates truncation', () => {
    const error = '连接失败😀'.repeat(2_000)
    const url = githubIssueUrl(supportReport(error, '0.22.0', 'win32', 'zh-CN'), error, 'zh-CN')
    expect(url.length).toBeLessThanOrEqual(7_500)
    const body = new URL(url).searchParams.get('body')
    expect(body).toContain('OS: win32')
    expect(body).toContain('错误信息已截短')
    expect(body).not.toContain('\uFFFD')
  })
  it('offers an empty report template without inventing an error for the permanent entry', () => {
    const url = new URL(githubIssueUrl(supportReport('', null, 'linux', 'en'), '', 'en'))
    expect(url.searchParams.get('title')).toBe('Bug report')
    expect(url.searchParams.get('body')).toContain('## Steps to reproduce')
  })
})
