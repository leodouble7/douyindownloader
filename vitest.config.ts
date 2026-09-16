import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'renderer',
          include: ['tests/unit/**/*.test.tsx'],
          environment: 'jsdom'
        }
      },
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node'
        }
      }
    ]
  }
});
