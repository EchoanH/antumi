import { PROJECT_GITHUB_URL } from '@antumi/protocol'

const HIDDEN = '[redacted]'

export function githubIntegrationIssueUrl(kind: 'source' | 'agent', locale: string): string {
  const zh = locale === 'zh-CN'
  const source = kind === 'source'
  const title = zh
    ? source ? '来源接入请求：' : 'Agent 接入请求：'
    : source ? 'Task source integration request: ' : 'Agent integration request: '
  const body = zh
    ? `## ${source ? '任务来源' : 'Agent'}名称\n\n## 官方网站或项目地址\n\n## 使用场景\n<!-- 你希望在 Antumi 中如何使用它？ -->\n\n## 相关文档\n<!-- 如有 API、CLI 或协议文档，请附上链接。 -->\n`
    : `## ${source ? 'Task source' : 'Agent'} name\n\n## Official website or repository\n\n## Use case\n<!-- How would you like to use it in Antumi? -->\n\n## Documentation\n<!-- Link API, CLI or protocol documentation, if available. -->\n`
  return `${PROJECT_GITHUB_URL}/issues/new?${new URLSearchParams({ title, body })}`
}

// Reports contain the selected error only, never settings, conversation history or logs.
export function supportError(text: string): string {
  return text.slice(0, 64_000)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, HIDDEN)
    .replace(/((?:authorization|(?:set-)?cookie)\s*["']?\s*[:=]\s*)[^\r\n]+/gi, `$1${HIDDEN}`)
    .replace(/(\b(?:[\w-]*(?:token|password|passwd|secret|api[-_]?key|credential)[\w-]*)["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi, `$1${HIDDEN}`)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${HIDDEN}@`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, HIDDEN)
    .slice(0, 8_000)
}

export function supportReport(error: string, version: string | null, platform: string, locale: string): string {
  return [`Antumi: ${version ?? 'unknown'}`, `OS: ${platform}`, `Language: ${locale}`, ...(error ? ['', supportError(error)] : [])].join('\n')
}

// Keep the encoded URL short enough for browsers and GitHub, including non-ASCII errors.
export function githubIssueUrl(report: string, error: string, locale: string): string {
  const zh = locale === 'zh-CN'
  const summary = Array.from(supportError(error).split('\n')[0]?.trim() ?? '').slice(0, 100).join('')
  const chars = Array.from(supportError(report))
  const urlFor = (length: number) => {
    const truncated = length < chars.length ? (zh ? '\n\n（错误信息已截短，可从 Antumi 复制完整问题信息后补充。）' : '\n\n(Error shortened. Copy the full problem details from Antumi to add them here.)') : ''
    // This field's id belongs to bug_report.yml; GitHub passes it through the chooser too.
    const params = new URLSearchParams({ environment: chars.slice(0, length).join('') + truncated })
    if (error) {
      params.set('template', 'bug_report.yml')
      params.set('title', summary || (zh ? '问题反馈' : 'Bug report'))
    }
    return `${PROJECT_GITHUB_URL}/issues/new${error ? '' : '/choose'}?${params}`
  }
  const full = urlFor(chars.length)
  if (full.length <= 7_500) return full
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (urlFor(mid).length <= 7_500) low = mid
    else high = mid - 1
  }
  return urlFor(low)
}
