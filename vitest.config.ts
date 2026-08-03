import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Only needed to compile the `.test.tsx` component tests.
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Unit tests are fast; the model integration test talks to a real gateway.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      LUMO_CONFIG_PATH: process.env.LUMO_CONFIG_PATH ?? '',
    },
    // Component tests opt into jsdom with a `@vitest-environment` docblock; the
    // rest stay on node. `setupFiles` only patches globals when a DOM exists.
    setupFiles: ['./tests/helpers/dom-setup.ts'],
  },
});
