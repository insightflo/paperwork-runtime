import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.resolve(testDir, "../index.ts"), "utf8");

describe("Paperwork CLI branding", () => {
  it("uses Paperwork for program metadata", () => {
    expect(indexSource).toContain('.name("paperwork")');
    expect(indexSource).toContain(
      '.description("Paperwork CLI — setup, diagnose, and configure your instance")',
    );
    expect(indexSource).not.toContain('.name("paperclipai")');
    expect(indexSource).not.toContain('.description("Paperclip CLI');
  });

  it("uses Paperwork in key user-facing help descriptions", () => {
    const paperworkHelpText = [
      "Paperwork data directory root",
      "Start Paperwork immediately after saving config",
      "Run diagnostic checks on your Paperwork setup",
      "Bootstrap local setup (onboard + doctor) and run Paperwork",
      "Base URL for the Paperwork server API",
    ];

    for (const text of paperworkHelpText) {
      expect(indexSource).toContain(text);
    }

    const legacyHelpText = [
      "Paperclip data directory root",
      "Start Paperclip immediately after saving config",
      "Run diagnostic checks on your Paperclip setup",
      "Bootstrap local setup (onboard + doctor) and run Paperclip",
      "Base URL for the Paperclip server API",
    ];

    for (const text of legacyHelpText) {
      expect(indexSource).not.toContain(text);
    }
  });
});
