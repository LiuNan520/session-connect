import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared/index.ts', import.meta.url)) } },
  test: { include: ['server/test/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'], testTimeout: 15000, hookTimeout: 15000 }
});
