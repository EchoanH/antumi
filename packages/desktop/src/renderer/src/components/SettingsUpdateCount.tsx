import { useCore } from '../core-store'
import { t } from '../i18n'
import { updateOffered, useUpdate } from '../update-state'

export function SettingsUpdateCount({ section }: { section: string }) {
  const agents = useCore((s) => Object.values(s.agentCli).filter((status) => status?.availability === 'available').length)
  const plugins = useCore((s) => s.plugins?.filter((plugin) => plugin.update?.availability === 'available').length ?? 0)
  const app = useUpdate((s) => Number(updateOffered(s.state)))
  const count = section === 'agents' ? agents : section === 'plugins' ? plugins : section === 'about' ? app : 0
  return count > 0 ? <span className="settings-update-count" aria-label={t('Updates.badge', { count })}>{count}</span> : null
}
