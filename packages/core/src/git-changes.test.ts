import { afterEach, describe, expect, it, vi } from 'vitest'

const running: Array<() => void> = []
let peak = 0
vi.mock('./hidden-exec', () => ({
  execFileAsync: () => new Promise((resolve) => {
    running.push(() => resolve({ stdout: 'out', stderr: '' }))
    peak = Math.max(peak, running.length)
  })
}))

const { git } = await import('./git-changes')

describe('git reads', () => {
  afterEach(() => { running.length = 0; peak = 0 })

  it('runs at most eight at once and starts the rest as earlier ones finish', async () => {
    const reads = Array.from({ length: 20 }, () => git('/repo', ['status']))
    await vi.waitFor(() => expect(running).toHaveLength(8))
    let finished = 0
    while (finished < 20) {
      await vi.waitFor(() => expect(running.length).toBeGreaterThan(0))
      running.shift()?.()
      finished++
    }
    expect(await Promise.all(reads)).toEqual(Array(20).fill('out'))
    expect(peak).toBe(8)
  })
})
