import { useState } from 'react'
import { AGENT_KINDS } from '@antumi/protocol'
import { receivePlugins, setSettingsOpen, upgradeAgentCli, useCore } from '../core-store'
import { cliErrorText, cliStatusText } from '../agent-cli-text'
import { agentLabel } from '../labels'
import { t } from '../i18n'
import { checkMaintenanceUpdates, useMaintenanceUpdates } from '../maintenance-updates'
import { checkForUpdate, skipUpdate, useUpdate, updateOffered } from '../update-state'
import { pluginName } from '../plugin-name'
import { useBackendLocation } from '../backend-location-state'
import { Popover } from './Popover'
import { UpdateActions } from './UpdateNotice'
import { ChatMarkdown } from './ChatMarkdown'
import { ArrowUpIcon } from './icons'

export function UpdatesButton() {
  const state = useUpdate((s) => s.state)
  const rpc = useCore((s) => s.rpc)
  const plugins = useCore((s) => s.plugins)
  const statuses = useCore((s) => s.agentCli)
  const conversations = useCore((s) => s.conversations)
  const backend = useBackendLocation((s) => s.state)
  const checking = useMaintenanceUpdates((s) => s.checking)
  const checkError = useMaintenanceUpdates((s) => s.error)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pluginUpdates = plugins?.filter((plugin) => plugin.update?.availability === 'available') ?? []
  const agentUpdates = AGENT_KINDS.flatMap((kind) => {
    const status = statuses[kind]
    return status && (status.availability === 'available' || status.phase === 'starting' || status.phase === 'running') ? [status] : []
  })
  const appUpdate = updateOffered(state)
  const count = Number(appUpdate) + pluginUpdates.length + agentUpdates.length
  const details = (section: string) => { setOpen(false); setSettingsOpen(true, section) }
  const backendLabel = backend?.running === 'ssh' && backend.chosen.kind === 'ssh' ? t('BackendLocation.ssh', { host: backend.chosen.host })
    : backend?.running === 'wsl' && backend.chosen.kind === 'wsl' ? t('BackendLocation.wsl', { distro: backend.chosen.distro }) : t('BackendLocation.local')
  const updateAgent = async (agent: Parameters<typeof upgradeAgentCli>[0]) => {
    if (pending) return
    setPending(`agent:${agent}`)
    try { await upgradeAgentCli(agent) } finally { setPending(null) }
  }
  const updatePlugin = async (id: string) => {
    if (!rpc || pending) return
    setPending(id)
    setError(null)
    try {
      await rpc.call('plugins.update', { id })
      const next = await rpc.call('plugins.list', {})
      if (useCore.getState().rpc === rpc) receivePlugins(next)
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setPending(null) }
  }
  if (count === 0 && !open) return null
  const appBusy = state?.status === 'downloading' || state?.status === 'installing'
  const label = appBusy ? state.status === 'downloading' ? t('AppUpdate.downloading', { percent: Math.round((state.progress ?? 0) * 100) }) : t('AppUpdate.installing') : t('Updates.availableCount', { count })
  return <span className="menu-anchor statusbar-update-anchor maintenance-anchor">
    <button type="button" className="tool-button statusbar-update" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ArrowUpIcon /><span>{label}</span>
    </button>
    {open && <Popover label={t('Updates.title')} onClose={() => setOpen(false)}>
      <div className="update-card maintenance-card">
        <div className="maintenance-heading"><span className="update-title">{t('Updates.title')}</span><button className="button ghost" disabled={checking || state?.status === 'checking'} onClick={() => { checkForUpdate(); void checkMaintenanceUpdates(true) }}>{checking || state?.status === 'checking' ? t('AppUpdate.checking') : t('AppUpdate.checkNow')}</button></div>
        {checkError && <p className="update-error" role="status">{t('Updates.checkFailed')} · {checkError}</p>}
        {error && <p className="update-error" role="alert">{error}</p>}
        {count === 0 && <p className="muted">{t('Updates.none')}</p>}
        {appUpdate && state?.latest && <section className="maintenance-group">
          <div className="maintenance-heading"><strong>Antumi</strong><span className="muted">{state.current} → {state.latest.version}</span></div>
          {state.latest.notes && <div className="update-notes"><ChatMarkdown text={state.latest.notes} highlight={false} /></div>}
          <UpdateActions state={state} onSkip={() => skipUpdate(state.latest?.version ?? null)} />
        </section>}
        {pluginUpdates.length > 0 && <section className="maintenance-group">
          <div className="maintenance-heading"><strong>{t('SettingsPage.plugins')}</strong><button className="button ghost" onClick={() => details('plugins')}>{t('InstalledAgentsSettings.details')}</button></div>
          {pluginUpdates.map((plugin) => <div className="maintenance-row" key={plugin.id}>
            <div><span>{pluginName(plugin)}</span><p className="update-hint">{plugin.version} → {plugin.update?.latestVersion}</p></div>
            <button className="button" disabled={pending !== null || !rpc} onClick={() => void updatePlugin(plugin.id)}>{pending === plugin.id ? t('PluginSettings.checkingAndUpdating') : t('SettingsPage.update')}</button>
          </div>)}
        </section>}
        {agentUpdates.length > 0 && <section className="maintenance-group">
          <div className="maintenance-heading"><strong>Agent</strong><button className="button ghost" onClick={() => details('agents')}>{t('InstalledAgentsSettings.details')}</button></div>
          <p className="update-hint">{t('Updates.backendAgents')} · {backendLabel}</p>
          {agentUpdates.map((status) => {
            const running = status.phase === 'starting' || status.phase === 'running'
            const inUse = status.blockers.length > 0 || Object.values(conversations).some((conversation) => conversation.agent === status.agent && conversation.sessionId !== null)
            return <div className="maintenance-row" key={status.agent}>
              <div><span>{agentLabel(status.agent)}</span><p className="update-hint">{status.currentVersion} → {status.latestVersion}</p>
                {(running || inUse) && <p className="update-hint">{running ? cliStatusText(status) : t('Updates.agentInUse')}</p>}
                {status.error && <p className="update-error">{cliErrorText(status.error)}</p>}
              </div>
              {status.canUpgrade ? <button className="button" disabled={pending !== null || running || inUse || status.phase === 'checking' || !rpc} onClick={() => void updateAgent(status.agent)}>{t('agentCli.upgrade')}</button> : <button className="button" onClick={() => details('agents')}>{t('Updates.upgradeInstructions')}</button>}
            </div>
          })}
        </section>}
        <div className="update-actions"><button className="button ghost" onClick={() => details('about')}>{t('Updates.settings')}</button></div>
      </div>
    </Popover>}
  </span>
}
