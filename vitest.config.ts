import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/desktop/scripts/**/*.test.mjs'],
    environment: 'node',
    // Git for Windows starts several processes per worktree operation. Limit contention and
    // give those integration tests time to finish without relaxing their assertions.
    ...(process.platform === 'win32' ? { maxWorkers: 4, testTimeout: 30_000, hookTimeout: 30_000 } : {})
  }
})
