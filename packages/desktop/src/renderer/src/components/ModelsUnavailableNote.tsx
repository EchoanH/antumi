import { useEffect, useState } from 'react'
import type { AgentKind } from '@antumi/protocol'
import { setSettingsOpen, useCore } from '../core-store'
import { checkStatusText } from '../environment-text'
import { t } from '../i18n'
import { reasonText } from '../labels'

// Where a picker has no models: why, and the settings that fix it. The agent's own check comes
// first, since a CLI that is missing or the wrong version is what core would refuse anyway.
export function ModelsUnavailableNote({ agent }: { agent: AgentKind }) {
  const rpc = useCore((state) => state.rpc)
  const check = useCore((state) => state.environment?.checks.find((entry) => entry.tool === agent))
  const broken = check && (check.status === 'missing' || check.problem) ? check : null
  const [problem, setProblem] = useState<{ reason: string; message: string } | null>(null)
  useEffect(() => {
    setProblem(null)
    if (broken || !rpc?.features.includes('chat-catalog-problem')) return
    let current = true
    rpc.call('conversations.chatCatalogProblem', { agent }).then((found) => { if (current) setProblem(found) }, () => {})
    return () => { current = false }
  }, [agent, rpc, broken])
  const reason = broken ? checkStatusText(broken) : problem ? reasonText(problem.reason, problem.message) : null
  if (!reason) return null
  return (
    <span className="chat-options-note models-unavailable">
      {t('ModelsUnavailable.text', { reason })}
      <button type="button" className="link-button" onClick={() => setSettingsOpen(true, 'agents')}>{t('ModelsUnavailable.openSettings')}</button>
    </span>
  )
}
