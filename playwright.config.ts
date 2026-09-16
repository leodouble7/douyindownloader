import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  workers: 1,
  use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, baseURL: 'http://127.0.0.1:5175', viewport: { width: 1180, height: 800 }, trace: 'retain-on-failure' },
  webServer: { command: 'node_modules/.bin/vite src/renderer --host 127.0.0.1 --port 5175 --strictPort', url: 'http://127.0.0.1:5175', reuseExistingServer: false }
});
