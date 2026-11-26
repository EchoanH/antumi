import type { ChatImage, ChatItem } from '@antumi/protocol'

export type ChatDelivery = {
  ref: string
  text: string
  images: ChatImage[]
  at: number
  phase: 'sending' | 'sent' | 'failed'
  error: string | null
}

// A submitted receipt wins even if the request timed out. A bare user item may still fail.
export function reconcileDeliveries(messages: readonly ChatDelivery[], items: readonly ChatItem[]): ChatDelivery[] {
  const submitted = new Set(items.flatMap((item) => item.kind === 'user' && item.delivery === 'submitted' ? [item.id] : []))
  const queued = new Set(items.flatMap((item) => item.kind === 'state' ? item.queue.map((entry) => entry.ref) : []))
  const users = new Set(items.filter((item) => item.kind === 'user').map((item) => item.id))
  return messages.filter((message) => !submitted.has(`u:${message.ref}`) && !queued.has(message.ref) && !(message.phase === 'sent' && users.has(`u:${message.ref}`)))
}

export function withDeliveries(items: readonly ChatItem[], messages: readonly ChatDelivery[]): readonly ChatItem[] {
  if (!messages.length) return items
  const present = new Set(items.filter((item) => item.kind === 'user').map((item) => item.id))
  return [...items, ...messages.filter((message) => !present.has(`u:${message.ref}`)).map((message): ChatItem => ({
    kind: 'user', id: `u:${message.ref}`, stageId: 'local', revision: 0,
    at: message.at, text: message.text, images: message.images
  }))]
}
