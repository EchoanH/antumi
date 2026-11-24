import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { BackendLocationState, BackendProblem } from '../../../shared/backend-location'
import { notStarted, sameLocation, useBackendLocation } from '../backend-location-state'
import { setLocale } from '../i18n'
import { BackendLocationNotice } from './BackendLocationNotice'
import { backendLocationOptions, BackendLocationSettings, confirmSwitch, sshLocation } from './BackendLocationSettings'

vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
const askConfirm = vi.hoisted(() => vi.fn(async () => false))
vi.mock('../confirm-dialog', () => ({ askConfirm }))

const DISTROS = [
  { name: 'Ubuntu', version: 2 as const, isDefault: true },
  { name: 'Legacy', version: 1 as const, isDefault: false }
]
const LOCAL: BackendLocationState = { wsl: true, ssh: false, chosen: { kind: 'local' }, running: 'local', distros: DISTROS, problem: null }
const failed = (problem: BackendProblem): BackendLocationState => ({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, problem })
const settings = (state: BackendLocationState | null) => {
  useBackendLocation.setState({ state })
  return renderToStaticMarkup(createElement(BackendLocationSettings))
}
const notice = (state: BackendLocationState | null) => {
  useBackendLocation.setState({ state })
  return renderToStaticMarkup(createElement(BackendLocationNotice))
}

beforeEach(() => useBackendLocation.setState(useBackendLocation.getInitialState(), true))
afterEach(() => setLocale('zh-CN'))

describe('backend location settings', () => {
  it('shows nothing where the app cannot run its backend elsewhere', () => {
    expect(settings(null)).toBe('')
    expect(settings({ ...LOCAL, wsl: false, distros: [] })).toBe('')
  })

  it('offers this machine and each distro, marking the default and keeping WSL 1 out of reach', () => {
    const options = backendLocationOptions(LOCAL)
    expect(options.map((option) => option.label)).toEqual(['本机', 'WSL 里的 Ubuntu', 'WSL 里的 Legacy'])
    expect(options[1]).toMatchObject({ value: 'wsl:Ubuntu', description: '默认发行版 · WSL 2' })
    expect(options[1]?.disabled).toBe(false)
    expect(options[2]).toMatchObject({ disabled: true, description: 'WSL 1，要转成 WSL 2 才能选' })
  })

  it('keeps a chosen distro wsl.exe no longer lists, or would not say', () => {
    const gone = backendLocationOptions({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Arch' } })
    expect(gone.at(-1)).toMatchObject({ value: 'wsl:Arch', description: '找不到这个发行版', disabled: true })
    const unknown = backendLocationOptions({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Arch' }, distros: null })
    expect(unknown.map((option) => option.value)).toEqual(['local', 'wsl:Arch'])
    expect(unknown.at(-1)?.description).toBeNull()
  })

  it('says where it runs now and what WSL does not have yet', () => {
    const html = settings(LOCAL)
    expect(html).toContain('现在运行在')
    expect(html).toContain('后端在 WSL 里时暂时没有：手机在局域网里直连，以及保持电脑唤醒。')
    expect(html).not.toContain('role="alert"')
    expect(settings({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, running: 'wsl' })).toContain('>WSL 里的 Ubuntu</span>')
  })

  it('offers a retry when wsl.exe could not be asked, and the install when there is no distro', () => {
    const unlisted = settings({ ...LOCAL, distros: null })
    expect(unlisted).toContain('没能从 wsl.exe 读到发行版列表。')
    expect(unlisted).toContain('重新检测')
    const none = settings({ ...LOCAL, distros: [] })
    expect(none).toContain('还没有 WSL 发行版')
    expect(none).toContain('<code>wsl --install</code>')
  })

  it('says the distro did not start and that this machine runs instead', () => {
    const html = settings(failed({ kind: 'node-missing' }))
    expect(html).toContain('「Ubuntu」里的后端没能启动，这次先用本机的')
    expect(html).toContain('role="alert"')
    expect(html).toContain('重启 Antumi 再试')
  })

  it('gives the commands that install Node 24 as the default', () => {
    const html = settings(failed({ kind: 'node-old', version: 'v22.11.0', path: '/usr/bin/node' }))
    expect(html).toContain('「Ubuntu」里的 Node 是 v22.11.0，需要 24 以上。')
    expect(html).toContain('<code>/usr/bin/node</code>')
    expect(html).toContain('装了新版但没设成默认')
    expect(html).toContain('<code>nvm install 24 &amp;&amp; nvm alias default 24</code>')
    expect(html).toContain('<code>curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -</code>')
    expect(html).toContain('<code>sudo apt-get install -y nodejs</code>')
    expect(settings(failed({ kind: 'node-missing' }))).toContain('nvm alias default 24')
  })

  it('says what to do for each problem', () => {
    const cases: [BackendProblem, string[]][] = [
      [{ kind: 'wsl-unavailable' }, ['这台电脑没有装 WSL。', '<code>wsl --install</code>']],
      [{ kind: 'wsl-unknown', detail: 'E_ACCESSDENIED' }, ['wsl.exe 没有回答', '<pre class="backend-location-detail">E_ACCESSDENIED</pre>']],
      [{ kind: 'distro-missing', distro: 'Arch' }, ['找不到发行版「Arch」。', '改回本机']],
      [{ kind: 'distro-wsl1', distro: 'Legacy' }, ['「Legacy」是 WSL 1 的发行版。', '<code>wsl --set-version Legacy 2</code>']],
      [{ kind: 'arch', arch: 'arm64' }, ['「Ubuntu」是 arm64 的发行版，目前只支持 x64。']],
      [{ kind: 'login-environment' }, ['登录 shell 没有回应', '<code>wsl -d Ubuntu</code>']],
      [{ kind: 'install', detail: 'tar: no space left' }, ['没能把后端装进「Ubuntu」。', 'tar: no space left']],
      [{ kind: 'pty', detail: "libc.so.6: version `GLIBC_2.31' not found" }, ['「Ubuntu」的系统库太旧。', 'Ubuntu 20.04', 'GLIBC_2.31']],
      [{ kind: 'pty', detail: 'Cannot find module pty.node' }, ['「Ubuntu」里的后端没能加载终端组件。', '与这台机器无关', 'Cannot find module pty.node']],
      [{ kind: 'start', detail: 'exited with 1' }, ['「Ubuntu」里的后端没能启动。', '<code>~/.antumi/logs/core.log</code>', 'exited with 1']]
    ]
    for (const [problem, expected] of cases) {
      const html = settings(failed(problem))
      for (const text of expected) expect(html, problem.kind).toContain(text)
    }
    expect(settings(failed({ kind: 'arch', arch: 'arm64' }))).not.toContain('重启 Antumi 再试')
    expect(settings(failed({ kind: 'distro-missing', distro: 'Arch' }))).not.toContain('重启 Antumi 再试')
  })

  it('reads in English', () => {
    setLocale('en')
    const html = settings(failed({ kind: 'node-old', version: 'v20.0.0', path: '/usr/bin/node' }))
    expect(html).toContain('Node in Ubuntu is v20.0.0; 24 or later is needed.')
    expect(html).toContain('Not yet available with the backend in WSL')
  })

  it('asks before switching, saying the app restarts and the other place has its own data', async () => {
    askConfirm.mockResolvedValueOnce(true)
    expect(await confirmSwitch({ kind: 'wsl', distro: 'Ubuntu' })).toBe(true)
    expect(await confirmSwitch({ kind: 'local' })).toBe(false)
    expect(askConfirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: expect.stringMatching(/^把后端换到 WSL 里的「Ubuntu」？ Antumi 会立即重启。那边有自己的一份任务、会话和设置/), confirm: '切换并重启' }))
    expect(askConfirm).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: expect.stringMatching(/^把后端换到本机？/) }))
  })
})

const MAC: BackendLocationState = { wsl: false, ssh: true, chosen: { kind: 'local' }, running: 'local', distros: [], problem: null }
const sshFailed = (problem: BackendProblem): BackendLocationState => ({ ...MAC, chosen: { kind: 'ssh', host: 'dev@box' }, problem })

describe('backend location on a server', () => {
  it('offers a server beside this machine where there is no WSL', () => {
    expect(backendLocationOptions(MAC).map((option) => [option.value, option.label])).toEqual([['local', '本机'], ['ssh', '远程服务器（SSH）…']])
    expect(backendLocationOptions({ ...MAC, chosen: { kind: 'ssh', host: 'dev@box' }, running: 'ssh' }).at(-1)?.label).toBe('服务器 dev@box')
    const html = settings(MAC)
    expect(html).toContain('ssh 能不输密码登录')
    expect(html).not.toContain('WSL 发行版')
  })

  it('shows the server it runs on, with what it does not have yet', () => {
    const html = settings({ ...MAC, chosen: { kind: 'ssh', host: 'dev@box' }, running: 'ssh' })
    expect(html).toContain('>服务器 dev@box</span>')
    expect(html).toContain('value="dev@box"')
    expect(html).toContain('后端在服务器上时暂时没有')
  })

  it('asks to update this app when the server keeps a newer backend', () => {
    const html = settings({ ...MAC, chosen: { kind: 'ssh', host: 'dev@box' }, running: 'ssh', newerBackend: '0.23.0' })
    expect(html).toContain('服务器上的后端是 0.23.0，比这个应用新')
    expect(settings({ ...MAC, chosen: { kind: 'ssh', host: 'dev@box' }, running: 'ssh', newerBackend: null })).not.toContain('比这个应用新')
  })

  it('takes what ssh takes as a destination, and nothing that reads as an option', () => {
    expect(sshLocation(' dev@box ')).toEqual({ kind: 'ssh', host: 'dev@box' })
    expect(sshLocation('my-alias')).toEqual({ kind: 'ssh', host: 'my-alias' })
    expect(sshLocation('-oProxyCommand=x')).toBeNull()
    expect(sshLocation('dev@box rm')).toBeNull()
    expect(sshLocation('')).toBeNull()
    expect(sameLocation({ kind: 'ssh', host: 'a' }, { kind: 'ssh', host: 'a' })).toBe(true)
    expect(sameLocation({ kind: 'ssh', host: 'a' }, { kind: 'wsl', distro: 'a' })).toBe(false)
    expect(sameLocation({ kind: 'local' }, { kind: 'ssh', host: 'a' })).toBe(false)
  })

  it('says what to do for each problem on a server', () => {
    const cases: [BackendProblem, string[]][] = [
      [{ kind: 'ssh-unavailable' }, ['这台电脑上找不到 ssh。', 'OpenSSH 客户端']],
      [{ kind: 'ssh-host-key', detail: 'Host key verification failed.' }, ['还没有确认过「dev@box」的主机密钥', '<code>ssh dev@box</code>', 'Host key verification failed.']],
      [{ kind: 'ssh-auth', detail: 'Permission denied (publickey).' }, ['登录「dev@box」要输入密码或口令。', 'ssh-add', 'Permission denied (publickey).']],
      [{ kind: 'ssh-unreachable', detail: 'Could not resolve hostname box' }, ['连不上「dev@box」。', 'Could not resolve hostname box']],
      [{ kind: 'os', os: 'Darwin' }, ['「dev@box」运行的是 Darwin，后端只能运行在 Linux 上。']],
      [{ kind: 'arch', arch: 'riscv64' }, ['「dev@box」是 riscv64，后端只有 x86_64 和 aarch64 的。']],
      [{ kind: 'linger' }, ['ssh 断开时结束你的所有进程', '<code>sudo loginctl enable-linger $USER</code>']],
      [{ kind: 'node-old', version: 'v20.1.0', path: '/usr/bin/node' }, ['「dev@box」上的 Node 是 v20.1.0，需要 24 以上。', '后端用服务器上的 Node']],
      [{ kind: 'pty', detail: "libstdc++.so.6: version `GLIBCXX_3.4.28' not found" }, ['「dev@box」的系统库太旧。', 'Ubuntu 20.04', 'C++ 系统库', 'GLIBCXX_3.4.28']],
      [{ kind: 'pty', detail: 'invalid ELF header' }, ['「dev@box」上的后端没能加载终端组件。', '更新 Antumi', 'invalid ELF header']],
      [{ kind: 'start', detail: 'exited with 1' }, ['「dev@box」上的后端没能启动。', '服务器上的', 'exited with 1']],
      [{ kind: 'node-download', detail: 'the machine could not download it' }, ['没能在「dev@box」上装好 Node 24。', '国内镜像', 'the machine could not download it', 'nvm install 24']]
    ]
    for (const [problem, expected] of cases) {
      const html = settings(sshFailed(problem))
      expect(html, problem.kind).toContain('服务器「dev@box」上的后端没能启动，这次先用本机的')
      for (const text of expected) expect(html, problem.kind).toContain(text)
    }
    expect(settings(sshFailed({ kind: 'os', os: 'Darwin' }))).not.toContain('重启 Antumi 再试')
  })

  it('asks before moving to a server', async () => {
    askConfirm.mockResolvedValueOnce(true)
    expect(await confirmSwitch({ kind: 'ssh', host: 'dev@box' })).toBe(true)
    expect(askConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringMatching(/^把后端换到服务器「dev@box」？ Antumi 会立即重启。/) }))
  })
})

describe('backend location notice', () => {
  it('shows only when a chosen distro did not start, until dismissed', () => {
    expect(notice(null)).toBe('')
    expect(notice(LOCAL)).toBe('')
    expect(notice({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, running: 'wsl' })).toBe('')
    expect(notice({ ...failed({ kind: 'node-missing' }), problem: null })).toBe('')
    const html = notice(failed({ kind: 'start', detail: '' }))
    expect(html).toContain('「Ubuntu」里的后端没能启动，现在显示的是本机的任务和会话。')
    expect(html).toContain('aria-label="关闭提示"')
    useBackendLocation.setState({ dismissed: true })
    expect(renderToStaticMarkup(createElement(BackendLocationNotice))).toBe('')
  })

  it('names the place the user chose', () => {
    expect(notStarted(failed({ kind: 'login-environment' }))).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(notStarted({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' } })).toBeNull()
  })

  it('names the server when the one there did not start', () => {
    expect(notice(sshFailed({ kind: 'ssh-unreachable', detail: '' }))).toContain('服务器「dev@box」上的后端没能启动，现在显示的是本机的任务和会话。')
  })
})
