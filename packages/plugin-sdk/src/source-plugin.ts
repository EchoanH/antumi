import type { LoginNotice, LoginPrompt, SourceIssue } from '../../protocol/src/source.js'
import type { SourceCommentOptions, SourceCommentPage } from '../../protocol/src/source-comments.js'
import type { PluginCredential, PluginResult } from '../../protocol/src/plugin.js'
import type { SourceCommentResult, SourceStatusResult, SourceTransitions } from '../../protocol/src/source-writeback.js'

export type SourceSettings = Readonly<Record<string, string>>
export type SourceCredential = PluginCredential
export type SourceIssueDetail = Omit<PluginResult<'fetch'>, 'images'> & { images?: readonly { name: string; bytes: Uint8Array }[] }
export type SourceFetchOptions = { images: boolean }
export type LoginSession = {
  prompt(prompt: LoginPrompt): Promise<string>
  notify(notice: LoginNotice): void
}

export type SourcePlugin = {
  readonly id: string
  comments?(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal, options: SourceCommentOptions): Promise<SourceCommentPage>
  // The bytes of an image a comment names in its images, asked for when Antumi sends the comment to
  // an agent. Required once comments name images.
  image?(settings: SourceSettings, credential: SourceCredential, key: string, id: string, signal: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>
  // Writing back, for a source declaring writeback: 1 (SDK 0.5.0): the statuses the issue can move
  // to now, a move to one of them by the id transitions gave, and a comment in Markdown. writeId is
  // unique per write; pass it on where the tracker can dedupe by it. A tracker that takes no comments
  // through its API declares writebackComment: false and leaves comment out.
  // From SDK 0.7.0 the answer may also say who the issue is with and what it is (viewer, assignees,
  // reporter, type, scope, statusId): Antumi writes back by rule only to an issue that is the user's.
  transitions?(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal): Promise<SourceTransitions>
  transition?(settings: SourceSettings, credential: SourceCredential, key: string, id: string, signal: AbortSignal): Promise<SourceStatusResult>
  comment?(settings: SourceSettings, credential: SourceCredential, key: string, comment: { markdown: string; writeId: string }, signal: AbortSignal): Promise<SourceCommentResult>
  normalizeSettings(values: SourceSettings): Record<string, string> | Promise<Record<string, string>>
  normalizeKey?(key: string): string | Promise<string>
  envCredential?(env: Readonly<Record<string, string | undefined>>): SourceCredential | null
  login(session: LoginSession, settings: SourceSettings, signal: AbortSignal): Promise<{ credential: SourceCredential; account: string }>
  list(settings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]>
  // images false: Antumi wants the issue's text at once and asks for the images in a later call; a
  // plugin that honours it leaves them out and counts them in imagesDeferred. Absent means true.
  fetch(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal, options?: SourceFetchOptions): Promise<SourceIssueDetail>
}
