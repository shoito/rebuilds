import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Property tests that spawn git and turbo need more than the default 5s.
    testTimeout: 300_000,
  },
});
