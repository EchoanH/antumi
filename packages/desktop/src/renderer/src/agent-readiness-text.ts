import { agentDescriptor, type AgentKind, type AgentReadiness } from '@antumi/protocol'
import { t } from './i18n'

export function agentReadinessText(readiness: AgentReadiness, agent?: AgentKind): string {
  if (readiness.state === 'ready') {
    if (readiness.via === 'provider') return t('Readiness.providerReady')
    if (readiness.authSource === 'native-provider') return t('Readiness.nativeProviderReady')
    if (readiness.authSource === 'account') return t('Readiness.signedInReady')
    return t('Readiness.accountReady')
  }
  if (readiness.state === 'provider-failed') return t('SetupGuide.providerFailed')
  if (readiness.state === 'unknown-auth' && agent && agentDescriptor(agent).setup === 'provider') return t('Readiness.unknownProvider')
  return t(`Readiness.${readiness.state}`)
}
