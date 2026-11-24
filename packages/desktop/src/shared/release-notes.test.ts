import { expect, it } from 'vitest'
import { releaseHighlights, releaseNotes, shouldAnnounceRelease } from './release-notes'

it('embeds only the running release, excluding unreleased and adjacent versions', () => {
  const changelog = '# 更新日志\n\n## 未发布\n\n- future\n\n## 1.2.0 — 2026-11-25\n\n### 新功能\n\n- shipped\n\n## 1.1.0\n\n- older'
  expect(releaseNotes(changelog, 'v1.2.0')).toBe('### 新功能\n\n- shipped')
  expect(releaseNotes(changelog, '1.3.0')).toBe('')
  expect(releaseHighlights('- a\n- b\n- c\n- d\n- e\n- f')).toEqual(['a', 'b', 'c', 'd', 'e'])
})

it('announces upgrades once, and never a fresh install, ordinary restart or downgrade', () => {
  expect(shouldAnnounceRelease(null, '1.2.0')).toBe(false)
  expect(shouldAnnounceRelease(null, '1.2.0', true)).toBe(true)
  expect(shouldAnnounceRelease('1.2.0', '1.2.0', true)).toBe(false)
  expect(shouldAnnounceRelease('1.2.0', '1.1.0')).toBe(false)
  expect(shouldAnnounceRelease('1.1.0', '1.2.0')).toBe(true)
  expect(shouldAnnounceRelease('1.2.0-beta.2', '1.2.0-beta.3')).toBe(true)
  expect(shouldAnnounceRelease('1.2.0', '1.2.0-beta.3')).toBe(false)
  expect(shouldAnnounceRelease('broken', '1.2.0')).toBe(false)
})
