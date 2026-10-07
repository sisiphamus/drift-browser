import { defineConfig } from 'vitest/config'

// Real Electron instances: one file at a time, generous timeouts.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
