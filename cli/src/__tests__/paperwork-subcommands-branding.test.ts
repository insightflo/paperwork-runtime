import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWorktreeCommands } from "../commands/worktree.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.resolve(testDir, "../commands");

const excludedFiles = new Set([
  "auth-bootstrap-ceo.ts",
  "configure.ts",
  "doctor.ts",
  "env.ts",
  "onboard.ts",
  "run.ts",
  "client/auth.ts",
  "client/common.ts",
  "client/context.ts",
]);

function collectCommandFiles(dir: string = commandsDir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectCommandFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function relativeCommandPath(filePath: string): string {
  return path.relative(commandsDir, filePath).split(path.sep).join("/");
}

function sourceWithoutPackageSpecifiers(filePath: string): string {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => !line.includes("@paperclipai"))
    .join("\n");
}

function collectHelpText(command: Command): string {
  return [
    command.helpInformation(),
    ...command.commands.map((child) => collectHelpText(child)),
  ].join("\n");
}

describe("Paperwork subcommand branding", () => {
  it("uses Paperwork in registered worktree help text", () => {
    const program = new Command();
    registerWorktreeCommands(program);

    const helpText = collectHelpText(program);
    expect(helpText).toContain("Paperwork");
    expect(helpText).not.toContain("Paperclip");
    expect(helpText).not.toContain("paperclipai");
  });

  it("does not expose paperclipai outside package specifiers in scoped command files", () => {
    const offenders = collectCommandFiles()
      .map((filePath) => ({ filePath, relativePath: relativeCommandPath(filePath) }))
      .filter(({ relativePath }) => !excludedFiles.has(relativePath))
      .filter(({ filePath }) => sourceWithoutPackageSpecifiers(filePath).includes("paperclipai"))
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });
});
