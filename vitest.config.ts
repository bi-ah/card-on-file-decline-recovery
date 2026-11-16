import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node", testTimeout: 120_000 } },
      { test: { name: "functional", include: ["test/functional/**/*.test.ts"], environment: "node", testTimeout: 900_000, hookTimeout: 900_000 } },
    ],
  },
});
