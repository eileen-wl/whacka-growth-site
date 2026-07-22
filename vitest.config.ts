import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["growth/**/*.test.ts", "src/**/*.test.ts"],
  },
});
