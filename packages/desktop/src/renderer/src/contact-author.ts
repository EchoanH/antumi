import { create } from 'zustand'
import { supportError } from './support-report'

export const useContactAuthor = create<{ request: { error: string } | null; version: string | null }>(() => ({ request: null, version: null }))

export function contactAuthor(error = ''): void {
  useContactAuthor.setState({ request: { error: supportError(error) } })
}

export function closeContactAuthor(): void {
  useContactAuthor.setState({ request: null })
}
