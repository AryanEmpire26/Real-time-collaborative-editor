import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: process.env.TEST_WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
});
