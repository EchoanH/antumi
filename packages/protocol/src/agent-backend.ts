import { AGENT_KINDS, type AgentKind } from './agent'
import { agentDescriptor } from './agents'
import type { ChatSettings } from './chat'

// Leaves the backend to core, which takes the first one installed.
export const AUTO_BACKEND = 'auto'

// What the user picks among for an agent with more than one backend; none for the rest.
export function backendChoices(agent: AgentKind): string[] {
  const { backendModes } = agentDescriptor(agent)
  return backendModes ? [AUTO_BACKEND, ...Object.keys(backendModes)] : []
}

// The agent's backend choice: the user's, else the one it ran on before it had a choice. A fresh
// install writes auto for each (freshBackends), so only an install from before falls back.
export function backendChoice(settings: Pick<ChatSettings, 'agentBackends'> | null | undefined, agent: AgentKind): string | null {
  const choices = backendChoices(agent)
  if (!choices.length) return null
  const chosen = settings?.agentBackends?.[agent]
  return chosen && choices.includes(chosen) ? chosen : agentDescriptor(agent).legacyBackend ?? AUTO_BACKEND
}

export function freshBackends(): Partial<Record<AgentKind, string>> {
  return Object.fromEntries(AGENT_KINDS.filter((agent) => backendChoices(agent).length).map((agent) => [agent, AUTO_BACKEND]))
}
