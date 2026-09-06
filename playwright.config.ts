import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 60000,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "EVALUATOR_PRIVATE_KEY='' bun --env-file=.env.anvil index.ts",
    url: "http://localhost:3000",
    reuseExistingServer: false,
  },
});
