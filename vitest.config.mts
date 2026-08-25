import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // e2e/ is Playwright's; its `test` import is a different runner.
    exclude: ['e2e/**', 'node_modules/**'],
    setupFiles: ['./tests/setup.ts'],
    // Integration tests talk to a real database and must not run
    // concurrently with each other — they share one synthetic user.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // src/core is pure, framework-free logic — it is the part that must stay
      // covered. UI and framework glue are exercised by Playwright in phase 9.
      include: ['src/core/**', 'src/lib/**'],
    },
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
})
