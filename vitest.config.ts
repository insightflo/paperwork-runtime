import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/shared",
      "packages/adapter-utils",
      "packages/adapters/pi-local",
      "packages/adapters/commandcode-local",
      "server",
      "ui",
      "cli",
    ],
  },
});
