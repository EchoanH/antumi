import type { AgentKind } from './agent'
import type { AgentProxyPolicy, AgentProxySettings } from './agent-proxy'
import { agentDescriptor } from './agents'

// Kept apart from agent-proxy.ts, which chat.ts imports: the descriptors import chat.ts.
export function defaultAgentProxyPolicy(agent: AgentKind): AgentProxyPolicy {
  return agentDescriptor(agent).proxyPolicy ?? 'followGlobal'
}

export function agentProxyPolicy(settings: AgentProxySettings | undefined, agent: AgentKind): AgentProxyPolicy {
  return settings?.agents[agent] ?? defaultAgentProxyPolicy(agent)
}
