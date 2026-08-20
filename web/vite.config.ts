import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative assets let the same build work on any GitHub Pages repository path.
  base: './',
  build: {
    target: 'safari16.4',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
