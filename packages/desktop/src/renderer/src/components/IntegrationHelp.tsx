import { PROJECT_GITHUB_URL } from '@antumi/protocol'
import { contactAuthor } from '../contact-author'
import { t, useLocale } from '../i18n'
import { githubIntegrationIssueUrl } from '../support-report'

export function IntegrationHelp({ kind }: { kind: 'source' | 'agent' }) {
  const locale = useLocale((state) => state.locale)
  const source = kind === 'source'
  const title = t(source ? 'IntegrationHelp.sourceTitle' : 'IntegrationHelp.agentTitle')
  const guide = `${PROJECT_GITHUB_URL}/blob/main/docs/${source ? 'PLUGINS.md' : 'ARCHITECTURE.md#新增-agent'}`
  return <div className="integration-help">
    <p className="integration-help-title">{title}</p>
    <p className="settings-row-description">{t(source ? 'IntegrationHelp.sourceDescription' : 'IntegrationHelp.agentDescription')}</p>
    <div className="integration-help-actions">
      <button type="button" className="link-button" onClick={() => contactAuthor(t(source ? 'IntegrationHelp.sourceRequest' : 'IntegrationHelp.agentRequest'))}>{t('ContactAuthor.title')}</button>
      <a className="link-button" href={githubIntegrationIssueUrl(kind, locale)} target="_blank" rel="noopener noreferrer">{t('IntegrationHelp.issue')}</a>
      <a className="link-button" href={guide} target="_blank" rel="noopener noreferrer">{t(source ? 'IntegrationHelp.developmentGuide' : 'IntegrationHelp.integrationGuide')}</a>
    </div>
  </div>
}
