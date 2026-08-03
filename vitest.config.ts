import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Unit tests are fast; the model integration test talks to a real gateway.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      LUMO_CONFIG_PATH: process.env.LUMO_CONFIG_PATH ?? '',
    },
  },
});
