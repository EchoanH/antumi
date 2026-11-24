import { useState, type ReactElement, type ReactNode } from 'react'
import { BackendLocation, ptyNeedsNewerLibc, type BackendLocationState, type BackendProblem } from '../../../shared/backend-location'
import { readBackendLocation, sameLocation, useBackendLocation, type RemoteLocation } from '../backend-location-state'
import { askConfirm } from '../confirm-dialog'
import { setBackendLocation } from '../desktop-bridge'
import { t, tr } from '../i18n'
import { ChatPicker, type PickerOption } from './ChatPicker'
import { CopyButton } from './CopyButton'
import { WarningIcon } from './icons'
import { SettingsRow } from './SettingsControls'

// 设置 → 后端位置, on a build that can run its backend on another Linux machine: a WSL distro on
// Windows (docs/WSL.md), a server over SSH anywhere (docs/REMOTE.md). Where it runs, where it
// should, and what to do when that machine would not take it.

const LOCAL = 'local'
const WSL_PREFIX = 'wsl:'
const SSH = 'ssh'

function valueOf(location: BackendLocation): string {
  if (location.kind === 'ssh') return SSH
  return location.kind === 'local' ? LOCAL : `${WSL_PREFIX}${location.distro}`
}

function locationLabel(location: BackendLocation): string {
  if (location.kind === 'ssh') return t('BackendLocation.ssh', { host: location.host })
  return location.kind === 'local' ? t('BackendLocation.local') : t('BackendLocation.wsl', { distro: location.distro })
}

export function backendLocationOptions(state: BackendLocationState): PickerOption[] {
  const distros = state.wsl ? state.distros ?? [] : []
  const chosen = state.chosen.kind === 'wsl' ? state.chosen.distro : null
  return [
    { value: LOCAL, label: t('BackendLocation.local'), description: t('BackendLocation.localDescription') },
    ...distros.map((distro) => ({
      value: `${WSL_PREFIX}${distro.name}`,
      label: t('BackendLocation.wsl', { distro: distro.name }),
      description: [distro.isDefault ? t('BackendLocation.distroDefault') : null, distro.version === 1 ? t('BackendLocation.distroWsl1') : 'WSL 2'].filter(Boolean).join(' · '),
      disabled: distro.version === 1
    })),
    // The chosen one stays shown when wsl.exe no longer lists it, or would not say.
    ...(chosen !== null && !distros.some((distro) => distro.name === chosen)
      ? [{ value: `${WSL_PREFIX}${chosen}`, label: t('BackendLocation.wsl', { distro: chosen }), description: state.distros ? t('BackendLocation.distroMissing') : null, disabled: true }]
      : []),
    ...(state.ssh || state.chosen.kind === 'ssh'
      ? [{ value: SSH, label: state.chosen.kind === 'ssh' ? locationLabel(state.chosen) : t('BackendLocation.sshOption'), description: t('BackendLocation.sshOptionDescription') }]
      : [])
  ]
}

function Command({ command }: { command: string }) {
  return (
    <span className="backend-location-command">
      <code>{command}</code>
      <CopyButton text={command} label={t('InstalledAgentsSettings.copyCommand')} />
    </span>
  )
}

function Detail({ text }: { text: string }) {
  return text.trim() ? <pre className="backend-location-detail">{text.trim()}</pre> : null
}

function NodeFix() {
  return (
    <>
      <p>{t('BackendLocation.problemNodeFix')}</p>
      <p>{t('BackendLocation.problemNodeNvm')}</p>
      <Command command="nvm install 24 && nvm alias default 24" />
      <p>{t('BackendLocation.problemNodeApt')}</p>
      <Command command="curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" />
      <Command command="sudo apt-get install -y nodejs" />
    </>
  )
}

function SshNodeFix() {
  return (
    <>
      <p>{t('BackendLocation.problemNodeFixSsh')}</p>
      <p>{t('BackendLocation.problemNodeNvm')}</p>
      <Command command="nvm install 24 && nvm alias default 24" />
      <p>{t('BackendLocation.problemNodeApt')}</p>
      <Command command="curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" />
      <Command command="sudo apt-get install -y nodejs" />
    </>
  )
}

type ProblemContent = { title: string; body: ReactNode; retry: boolean }

// What went wrong on a server, as a title, and what to do about it; null for a problem only WSL has.
function sshProblemContent(problem: BackendProblem, host: string): ProblemContent | null {
  switch (problem.kind) {
    case 'ssh-unavailable':
      return { title: t('BackendLocation.problemSshUnavailable'), body: <p>{t('BackendLocation.problemSshUnavailableFix')}</p>, retry: true }
    case 'ssh-host-key':
      return { title: t('BackendLocation.problemSshHostKey', { host }), body: <><p>{t('BackendLocation.problemSshHostKeyFix')}</p><Command command={`ssh ${host}`} /><Detail text={problem.detail} /></>, retry: true }
    case 'ssh-auth':
      return { title: t('BackendLocation.problemSshAuth', { host }), body: <><p>{t('BackendLocation.problemSshAuthFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'ssh-unreachable':
      return { title: t('BackendLocation.problemSshUnreachable', { host }), body: <><p>{t('BackendLocation.problemSshUnreachableFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'os':
      return { title: t('BackendLocation.problemOs', { host, os: problem.os }), body: null, retry: false }
    case 'arch':
      return { title: t('BackendLocation.problemArchSsh', { host, arch: problem.arch }), body: null, retry: false }
    case 'linger':
      return { title: t('BackendLocation.problemLinger', { host }), body: <><p>{t('BackendLocation.problemLingerFix')}</p><Command command="sudo loginctl enable-linger $USER" /></>, retry: true }
    case 'login-environment':
      return { title: t('BackendLocation.problemLoginSsh', { host }), body: <><p>{t('BackendLocation.problemLoginSshFix')}</p><Command command={`ssh ${host}`} /></>, retry: true }
    case 'node-missing':
      return { title: t('BackendLocation.problemNodeMissingSsh', { host }), body: <SshNodeFix />, retry: true }
    case 'node-old':
      return { title: t('BackendLocation.problemNodeOldSsh', { host, version: problem.version }), body: <><p>{tr('BackendLocation.problemNodeFound', { path: <code>{problem.path}</code> })}</p><SshNodeFix /></>, retry: true }
    case 'node-download':
      return { title: t('BackendLocation.problemNodeDownloadSsh', { host }), body: <><p>{t('BackendLocation.problemNodeDownloadFix')}</p><Detail text={problem.detail} /><SshNodeFix /></>, retry: true }
    case 'install':
      return { title: t('BackendLocation.problemInstallSsh', { host }), body: <Detail text={problem.detail} />, retry: true }
    case 'pty':
      return ptyNeedsNewerLibc(problem.detail)
        ? { title: t('BackendLocation.problemPtySsh', { host }), body: <><p>{t('BackendLocation.problemPtySshFix')}</p><Detail text={problem.detail} /></>, retry: true }
        : { title: t('BackendLocation.problemPtyLoadSsh', { host }), body: <><p>{t('BackendLocation.problemPtyLoadFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'start':
      return { title: t('BackendLocation.problemStartSsh', { host }), body: <><p>{tr('BackendLocation.problemStartSshFix', { log: <code>~/.antumi/logs/core.log</code> })}</p><Detail text={problem.detail} /></>, retry: true }
    default:
      return null
  }
}

// What went wrong in a distro, as a title, and what to do about it; null for a problem only a
// server has. `distro` is the chosen one, which most problems are about without naming it.
function wslProblemContent(problem: BackendProblem, distro: string): ProblemContent | null {
  switch (problem.kind) {
    case 'wsl-unavailable':
      return { title: t('BackendLocation.problemWslUnavailable'), body: <><p>{t('BackendLocation.problemWslUnavailableFix')}</p><Command command="wsl --install" /></>, retry: true }
    case 'wsl-unknown':
      return { title: t('BackendLocation.problemWslUnknown', { distro }), body: <><p>{t('BackendLocation.problemWslUnknownFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'distro-missing':
      return { title: t('BackendLocation.problemDistroMissing', { distro: problem.distro }), body: <p>{t('BackendLocation.problemDistroMissingFix')}</p>, retry: false }
    case 'distro-wsl1':
      return { title: t('BackendLocation.problemWsl1', { distro: problem.distro }), body: <><p>{t('BackendLocation.problemWsl1Fix')}</p><Command command={`wsl --set-version ${problem.distro} 2`} /></>, retry: true }
    case 'arch':
      return { title: t('BackendLocation.problemArch', { distro, arch: problem.arch }), body: null, retry: false }
    case 'login-environment':
      return { title: t('BackendLocation.problemLogin', { distro }), body: <><p>{t('BackendLocation.problemLoginFix')}</p><Command command={`wsl -d ${distro}`} /></>, retry: true }
    case 'node-missing':
      return { title: t('BackendLocation.problemNodeMissing', { distro }), body: <NodeFix />, retry: true }
    case 'node-old':
      return { title: t('BackendLocation.problemNodeOld', { distro, version: problem.version }), body: <><p>{tr('BackendLocation.problemNodeFound', { path: <code>{problem.path}</code> })}</p><NodeFix /></>, retry: true }
    case 'node-download':
      return { title: t('BackendLocation.problemNodeDownload', { distro }), body: <><p>{t('BackendLocation.problemNodeDownloadFix')}</p><Detail text={problem.detail} /><NodeFix /></>, retry: true }
    case 'install':
      return { title: t('BackendLocation.problemInstall', { distro }), body: <Detail text={problem.detail} />, retry: true }
    case 'pty':
      return ptyNeedsNewerLibc(problem.detail)
        ? { title: t('BackendLocation.problemPty', { distro }), body: <><p>{t('BackendLocation.problemPtyFix')}</p><Detail text={problem.detail} /></>, retry: true }
        : { title: t('BackendLocation.problemPtyLoad', { distro }), body: <><p>{t('BackendLocation.problemPtyLoadFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'start':
      return { title: t('BackendLocation.problemStart', { distro }), body: <><p>{tr('BackendLocation.problemStartFix', { log: <code>~/.antumi/logs/core.log</code> })}</p><Detail text={problem.detail} /></>, retry: true }
    default:
      return null
  }
}

// What went wrong where the user chose, as a title, and what to do about it.
export function problemContent(problem: BackendProblem, where: RemoteLocation): ProblemContent | null {
  return where.kind === 'ssh' ? sshProblemContent(problem, where.host) : wslProblemContent(problem, where.distro)
}

// The other place has its own tasks, conversations and settings, and the app restarts at once:
// neither is something to find out after the fact.
export function confirmSwitch(location: BackendLocation): Promise<boolean> {
  const question = location.kind === 'local'
    ? t('BackendLocation.confirmLocal')
    : location.kind === 'ssh' ? t('BackendLocation.confirmSsh', { host: location.host }) : t('BackendLocation.confirmWsl', { distro: location.distro })
  return askConfirm({ message: `${question} ${t('BackendLocation.confirmBody')}`, confirm: t('BackendLocation.confirmAction') })
}

// Empty where the app cannot run its backend elsewhere; the page lists the section only where it can.
export function BackendLocationSettings(): ReactElement {
  const state = useBackendLocation((s) => s.state)
  return state && (state.wsl || state.ssh) ? <BackendLocationRows state={state} /> : <></>
}

// The server as typed: what ssh takes as a destination, or null with why not.
export function sshLocation(typed: string): RemoteLocation | null {
  const parsed = BackendLocation.safeParse({ kind: 'ssh', host: typed.trim() })
  return parsed.success && parsed.data.kind === 'ssh' ? parsed.data : null
}

function fellBackText(where: RemoteLocation): string {
  return where.kind === 'ssh' ? t('BackendLocation.fellBackSsh', { host: where.host }) : t('BackendLocation.fellBack', { distro: where.distro })
}

function BackendLocationRows({ state }: { state: BackendLocationState }) {
  const reading = useBackendLocation((s) => s.reading)
  const [switching, setSwitching] = useState(false)
  const [failed, setFailed] = useState(false)
  // The server row shows once the user picks a server, or while one is chosen.
  const [askingHost, setAskingHost] = useState(false)
  const [typedHost, setTypedHost] = useState(state.chosen.kind === 'ssh' ? state.chosen.host : '')

  const apply = async (location: BackendLocation) => {
    setSwitching(true)
    setFailed(false)
    // Main restarts the app once it has saved the choice; only a refusal comes back.
    if (await setBackendLocation(location)) return
    setSwitching(false)
    setFailed(true)
  }
  const switchTo = async (location: BackendLocation) => {
    if (switching || sameLocation(location, state.chosen) || !await confirmSwitch(location)) return
    await apply(location)
  }
  const choose = async (value: string) => {
    if (value === SSH) {
      setAskingHost(true)
      return
    }
    setAskingHost(false)
    await switchTo(value.startsWith(WSL_PREFIX) ? { kind: 'wsl', distro: value.slice(WSL_PREFIX.length) } : { kind: 'local' })
  }
  const server = sshLocation(typedHost)

  const chosen = state.chosen.kind === 'local' ? null : state.chosen
  const fellBack = chosen !== null && state.running === 'local'
  const problem = state.problem && chosen !== null ? problemContent(state.problem, chosen) : null
  const showsWsl = state.wsl && (state.chosen.kind !== 'ssh')
  const showsHost = askingHost || state.chosen.kind === 'ssh'
  const recheck = (
    <button type="button" className="button" disabled={reading} onClick={() => void readBackendLocation()}>
      {reading ? t('BackendLocation.rechecking') : t('BackendLocation.recheck')}
    </button>
  )
  return (
    <>
      <SettingsRow
        label={t('BackendLocation.choose')}
        description={[state.wsl ? t('BackendLocation.chooseDescription') : null, state.ssh ? t('BackendLocation.chooseDescriptionSsh') : null].filter(Boolean).join(' ')}
        control={() => (
          <ChatPicker
            label={t('BackendLocation.choose')}
            value={askingHost ? SSH : valueOf(state.chosen)}
            placeholder={locationLabel(state.chosen)}
            options={backendLocationOptions(state)}
            disabled={switching}
            size="large"
            placement="below"
            align="end"
            onChange={(value) => void choose(value)}
          />
        )}
      />
      {showsHost && (
        <SettingsRow
          label={t('BackendLocation.sshHost')}
          description={typedHost.trim() && !server ? t('BackendLocation.sshHostInvalid') : t('BackendLocation.sshHostDescription')}
          control={() => (
            <form className="backend-location-host" onSubmit={(event) => { event.preventDefault(); if (server) void switchTo(server) }}>
              <input
                className="input mono"
                aria-label={t('BackendLocation.sshHost')}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="user@example.com"
                maxLength={255}
                value={typedHost}
                disabled={switching}
                onChange={(event) => setTypedHost(event.target.value)}
              />
              <button type="submit" className="button" disabled={switching || !server || sameLocation(server, state.chosen)}>{t('BackendLocation.sshConnect')}</button>
            </form>
          )}
        />
      )}
      {showsWsl && state.distros === null && <div className="backend-location-block"><p>{t('BackendLocation.unlisted')}</p><div>{recheck}</div></div>}
      {showsWsl && state.distros?.length === 0 && (
        <div className="backend-location-block">
          <p>{t('BackendLocation.noDistros')}</p>
          <Command command="wsl --install" />
          <div>{recheck}</div>
        </div>
      )}
      <SettingsRow
        label={t('BackendLocation.running')}
        description={fellBack ? fellBackText(chosen) : undefined}
        control={() => (
          <span className="backend-location-running" data-fell-back={fellBack || undefined}>
            {fellBack && <WarningIcon />}
            {state.running !== 'local' ? locationLabel(state.chosen) : t('BackendLocation.local')}
          </span>
        )}
      />
      {state.newerBackend && state.running === 'ssh' && (
        <div className="backend-location-block backend-location-problem" role="status">
          <p className="backend-location-problem-title"><WarningIcon />{t('BackendLocation.newerBackend', { version: state.newerBackend })}</p>
        </div>
      )}
      {problem && (
        <div className="backend-location-block backend-location-problem" role="alert">
          <p className="backend-location-problem-title"><WarningIcon />{problem.title}</p>
          {problem.body}
          {problem.retry && (
            <div>
              <button type="button" className="button" disabled={switching} onClick={() => void apply(state.chosen)}>{t('BackendLocation.restart')}</button>
            </div>
          )}
        </div>
      )}
      {(switching || failed) && (
        <p className="backend-location-block" role="status" data-failed={failed || undefined}>
          {failed ? t('BackendLocation.switchFailed') : t('BackendLocation.restarting')}
        </p>
      )}
      <p className="backend-location-block">{state.chosen.kind === 'ssh' ? t('BackendLocation.notYetSsh') : t('BackendLocation.notYet')}</p>
    </>
  )
}
