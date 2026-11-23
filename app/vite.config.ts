import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// Served from https://<user>.github.io/racket-coach/ on GitHub Pages.
export default defineConfig({
  base: '/racket-coach/',
  plugins: [preact()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**', 'src/main.tsx', 'src/**/*.d.ts'],
    },
  },
});
