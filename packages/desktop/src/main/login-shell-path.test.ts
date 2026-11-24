import { describe, expect, it } from 'vitest'
import { loginShellPath, markedPath, type ShellRun } from './login-shell-path'

const marked = (path: string) => `__ANTUMI_PATH__${path}__ANTUMI_PATH__`
const extras = '/opt/homebrew/bin:/usr/local/bin:/Users/me/.local/bin'

describe('markedPath', () => {
  it('reads the PATH between the marks past what rc files printed', () => {
    expect(markedPath(`Welcome back\n${marked('/a:/b')}`)).toBe('/a:/b')
  })

  it('takes nothing a shell cut off before the closing mark', () => {
    expect(markedPath('__ANTUMI_PATH__/a:/b')).toBeNull()
  })
})

describe('loginShellPath', () => {
  it('asks an interactive login shell, which reads ~/.zshrc on macOS', async () => {
    const asked: string[][] = []
    const run: ShellRun = async (shell, args) => {
      asked.push([shell, ...args.slice(0, -1)])
      return marked('/Users/me/.nvm/versions/node/v24.1.0/bin:/usr/bin')
    }
    const path = await loginShellPath('darwin', { SHELL: '/bin/zsh', PATH: '/usr/bin' }, run, '/Users/me')
    expect(asked).toEqual([['/bin/zsh', '-i', '-l', '-c']])
    expect(path).toBe(`/Users/me/.nvm/versions/node/v24.1.0/bin:/usr/bin:${extras}`)
  })

  it('falls back to a login shell alone when the interactive one gives nothing', async () => {
    const asked: string[][] = []
    const run: ShellRun = async (_shell, args) => {
      asked.push(args.slice(0, -1))
      return args.includes('-i') ? '' : marked('/opt/homebrew/bin:/usr/bin')
    }
    expect(await loginShellPath('darwin', { PATH: '/usr/bin' }, run, '/Users/me')).toBe('/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Users/me/.local/bin')
    expect(asked).toEqual([['-i', '-l', '-c'], ['-l', '-c']])
  })

  it('keeps its own PATH when neither shell answers', async () => {
    expect(await loginShellPath('linux', { PATH: '/usr/bin:/bin' }, async () => '', '/Users/me')).toBe(`/usr/bin:/bin:${extras}`)
  })
})
