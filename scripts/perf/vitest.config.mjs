// The main-process benchmark (not part of `npm test`): see README.md.
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@shared': resolve(repo, 'src/shared'),
      '@': resolve(repo, 'src/renderer/src')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: [process.env.CSD_BENCH_FILE ?? 'bench-main.bench.ts'],
    testTimeout: 900_000
  }
})
