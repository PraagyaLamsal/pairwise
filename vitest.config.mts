import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@ui': resolve(import.meta.dirname, 'src/renderer/ui'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    pool: 'forks',
  },
});
