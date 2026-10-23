import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one database schema.
    fileParallelism: false,
  },
});
