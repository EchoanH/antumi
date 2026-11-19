import { useState, type ReactElement, type ReactNode } from 'react'
import type { BackendLocation, BackendLocationState, WslBackendProblem } from '../../../shared/backend-location'
import { readBackendLocation, sameLocation, useBackendLocation } from '../backend-location-state'
import { askConfirm } from '../confirm-dialog'
import { setBackendLocation } from '../desktop-bridge'
import { t, tr } from '../i18n'
import { ChatPicker, type PickerOption } from './ChatPicker'
import { CopyButton } from './CopyButton'
import { WarningIcon } from './icons'
import { SettingsRow } from './SettingsControls'

// 设置 → 后端位置, on a Windows build that can run its backend in WSL (docs/WSL.md): where it runs,
// where it should, and what to do when the distro would not take it.

const LOCAL = 'local'
const WSL_PREFIX = 'wsl:'

function valueOf(location: BackendLocation): string {
  return location.kind === 'local' ? LOCAL : `${WSL_PREFIX}${location.distro}`
}

function locationOf(value: string): BackendLocation {
  return value.startsWith(WSL_PREFIX) ? { kind: 'wsl', distro: value.slice(WSL_PREFIX.length) } : { kind: 'local' }
}

function locationLabel(location: BackendLocation): string {
  return location.kind === 'local' ? t('BackendLocation.local') : t('BackendLocation.wsl', { distro: location.distro })
}

export function backendLocationOptions(state: BackendLocationState): PickerOption[] {
  const distros = state.distros ?? []
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

// What went wrong, as a title, and what to do about it. `distro` is the chosen one, which most
// problems are about without naming it.
export function problemContent(problem: WslBackendProblem, distro: string): { title: string; body: ReactNode; retry: boolean } {
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
    case 'install':
      return { title: t('BackendLocation.problemInstall', { distro }), body: <Detail text={problem.detail} />, retry: true }
    case 'pty':
      return { title: t('BackendLocation.problemPty', { distro }), body: <><p>{t('BackendLocation.problemPtyFix')}</p><Detail text={problem.detail} /></>, retry: true }
    case 'start':
      return { title: t('BackendLocation.problemStart', { distro }), body: <><p>{tr('BackendLocation.problemStartFix', { log: <code>~/.antumi/logs/core.log</code> })}</p><Detail text={problem.detail} /></>, retry: true }
  }
}

// The other place has its own tasks, conversations and settings, and the app restarts at once:
// neither is something to find out after the fact.
export function confirmSwitch(location: BackendLocation): Promise<boolean> {
  const question = location.kind === 'local' ? t('BackendLocation.confirmLocal') : t('BackendLocation.confirmWsl', { distro: location.distro })
  return askConfirm({ message: `${question} ${t('BackendLocation.confirmBody')}`, confirm: t('BackendLocation.confirmAction') })
}

// Empty where the app cannot run its backend in WSL; the page lists the section only where it can.
export function BackendLocationSettings(): ReactElement {
  const state = useBackendLocation((s) => s.state)
  return state?.supported ? <BackendLocationRows state={state} /> : <></>
}

function BackendLocationRows({ state }: { state: BackendLocationState }) {
  const reading = useBackendLocation((s) => s.reading)
  const [switching, setSwitching] = useState(false)
  const [failed, setFailed] = useState(false)

  const apply = async (location: BackendLocation) => {
    setSwitching(true)
    setFailed(false)
    // Main restarts the app once it has saved the choice; only a refusal comes back.
    if (await setBackendLocation(location)) return
    setSwitching(false)
    setFailed(true)
  }
  const choose = async (value: string) => {
    const location = locationOf(value)
    if (switching || sameLocation(location, state.chosen) || !await confirmSwitch(location)) return
    await apply(location)
  }

  const chosenDistro = state.chosen.kind === 'wsl' ? state.chosen.distro : null
  const fellBack = chosenDistro !== null && state.running === 'local'
  const problem = state.problem && chosenDistro !== null ? problemContent(state.problem, chosenDistro) : null
  const recheck = (
    <button type="button" className="button" disabled={reading} onClick={() => void readBackendLocation()}>
      {reading ? t('BackendLocation.rechecking') : t('BackendLocation.recheck')}
    </button>
  )
  return (
    <>
      <SettingsRow
        label={t('BackendLocation.choose')}
        description={t('BackendLocation.chooseDescription')}
        control={() => (
          <ChatPicker
            label={t('BackendLocation.choose')}
            value={valueOf(state.chosen)}
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
      {state.distros === null && <div className="backend-location-block"><p>{t('BackendLocation.unlisted')}</p><div>{recheck}</div></div>}
      {state.distros?.length === 0 && (
        <div className="backend-location-block">
          <p>{t('BackendLocation.noDistros')}</p>
          <Command command="wsl --install" />
          <div>{recheck}</div>
        </div>
      )}
      <SettingsRow
        label={t('BackendLocation.running')}
        description={fellBack ? t('BackendLocation.fellBack', { distro: chosenDistro }) : undefined}
        control={() => (
          <span className="backend-location-running" data-fell-back={fellBack || undefined}>
            {fellBack && <WarningIcon />}
            {state.running === 'wsl' && chosenDistro !== null ? locationLabel(state.chosen) : t('BackendLocation.local')}
          </span>
        )}
      />
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
      <p className="backend-location-block">{t('BackendLocation.notYet')}</p>
    </>
  )
}
