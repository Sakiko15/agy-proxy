import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential execution: spawn tests share the fake-agy argv record file
    // pattern and process-tree kill assertions are timing sensitive.
    fileParallelism: false,
  },
})
