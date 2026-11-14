import { describe, expect, it } from 'vitest'
import { MAX_CHANNEL_ANSWER_CHARS } from '@antumi/protocol'
import { channelMessages, inPieces, redact, toSlack, withoutMachinePaths } from './channel-output'

describe('what is posted for an agent', () => {
  it('hides what looks like a secret, and the values it is told to', () => {
    const cases = [
      'xoxb-1234567890-abcdefghij', 'xapp-1-A0B1C2D3E4-5566778899', 'sk-ant-api03-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz012', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
    ]
    for (const secret of cases) expect(redact(`token: ${secret} end`), secret).toEqual({ text: 'token: [已隐藏] end', redacted: true })
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter').text).toBe('[已隐藏]\nafter')
    expect(redact('ask Owner@Example.com', ['owner@example.com'])).toEqual({ text: 'ask [已隐藏]', redacted: true })
    expect(redact('see auth.ts line 3')).toEqual({ text: 'see auth.ts line 3', redacted: false })
  })

  it('says a project by its name and the home folder as ~', () => {
    const roots = [{ name: 'app', root: '/Users/me/code/app' }]
    expect(withoutMachinePaths('/Users/me/code/app/src/a.ts and /Users/me/.ssh', '/Users/me', roots)).toBe('app/src/a.ts and ~/.ssh')
  })

  it('leaves nothing Slack would read as a mention or a link of its own', () => {
    expect(toSlack('<!channel> ping <@U123> & <https://evil.example|click>')).toBe('&lt;!channel&gt; ping &lt;@U123&gt; &amp; &lt;https://evil.example|click&gt;')
    expect(toSlack('```\n<!here>\n```')).toBe('```\n&lt;!here&gt;\n```')
  })

  it('writes Markdown the way Slack does', () => {
    expect(toSlack('# Title\n\n**bold** and ~~gone~~, see [docs](https://example.com/a?b=1&c=2)\n- one\n  - two `**kept**`')).toBe(
      '*Title*\n\n*bold* and ~gone~, see <https://example.com/a?b=1&amp;c=2|docs>\n• one\n  • two `**kept**`')
    expect(toSlack('[run](javascript:alert(1))')).toBe('run (javascript:alert(1))')
    expect(toSlack('| a | b |\n|---|---|\n| 1 | 2 |\nafter')).toBe('```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter')
    expect(toSlack('```ts\nconst a = **b**\n')).toBe('```\nconst a = **b**\n\n```')
  })

  it('cuts a long answer between paragraphs and keeps a code block whole in each piece', () => {
    expect(inPieces('short', 100)).toEqual(['short'])
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`
    expect(inPieces(text, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
    const code = inPieces(`\`\`\`\n${'x\n'.repeat(80)}\`\`\``, 100)
    expect(code.length).toBeGreaterThan(1)
    for (const piece of code) {
      expect(piece.length).toBeLessThanOrEqual(100)
      expect((piece.match(/```/g) ?? []).length % 2, piece).toBe(0)
    }
  })

  it('posts no more than the ceiling, whatever the agent wrote', () => {
    const { messages } = channelMessages('slack', 'x'.repeat(MAX_CHANNEL_ANSWER_CHARS + 5000), { home: '/Users/me', roots: [], hide: [] })
    expect(messages.join('').length).toBeLessThan(MAX_CHANNEL_ANSWER_CHARS + 100)
    expect(messages.at(-1)).toContain('回答过长，已截断')
    expect(messages.every((message) => message.length <= 3500)).toBe(true)
  })

  it('reports that it hid something', () => {
    expect(channelMessages('slack', 'key ghp_abcdefghijklmnopqrstuvwxyz0123', { home: '/h', roots: [], hide: [] })).toEqual({ messages: ['key [已隐藏]'], redacted: true })
  })
})
