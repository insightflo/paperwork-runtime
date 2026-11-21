// @vitest-environment node
// Stage 1.1 parity: the paperclip-runtime-guard-core release binary vs the TS
// reference implementation in runtime-shell-command-utils.ts,
// runtime-command-extractor.ts and runtime-broad-scan-command-policy.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cleanShellToken,
  shellTokenize,
  stripShellCommentLines,
} from "../services/runtime-shell-command-utils.js";
import {
  extractRuntimeCommand,
  extractShellVariableAssignments,
  findRuntimeBroadScanCommand,
  normalizeRuntimeShellCommand,
  splitRuntimeShellSegments,
} from "../services/runtime-broad-scan-command-policy.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const bin = path.join(repoRoot, "crates/runtime-guard-core/target/release/paperclip-runtime-guard-core");

beforeAll(() => {
  const which = String(spawnSync("which", ["cargo"], { encoding: "utf8" }).stdout ?? "").trim();
  const cargo = process.env.CARGO || which || path.join(homedir(), ".cargo/bin/cargo");
  execFileSync(cargo, ["build", "--release", "--manifest-path", path.join(repoRoot, "crates/runtime-guard-core/Cargo.toml")], { encoding: "utf8" });
  if (!existsSync(bin)) throw new Error(`release binary missing: ${bin}`);
}, 120_000);

const rust = (sub: string, payload: unknown): unknown => {
  const res = spawnSync(bin, [sub], { input: JSON.stringify(payload), encoding: "utf8" });
  if (res.status !== 0) throw new Error(`rust ${sub} failed(${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout);
};
const eq = (sub: string, payload: unknown, ts: unknown, expected: unknown) => {
  expect(ts).toEqual(expected);
  expect(rust(sub, payload)).toEqual(expected);
};

type ScanIn = {
  command: string;
  allowedPaths?: string[];
  allowedDirectories?: string[];
  workingDirectory?: string | null;
  repoSearchRoot?: string | null;
  shellVariables?: Record<string, string>;
  stdinFromPipe?: boolean;
};
const tsScan = (i: ScanIn) =>
  findRuntimeBroadScanCommand({
    command: i.command,
    allowedPaths: i.allowedPaths ?? [],
    allowedDirectories: i.allowedDirectories ?? [],
    workingDirectory: i.workingDirectory ?? null,
    repoSearchRoot: i.repoSearchRoot ?? null,
    shellVariables: new Map(Object.entries(i.shellVariables ?? {})),
    stdinFromPipe: i.stdinFromPipe ?? false,
  });
const j = JSON.stringify;

describe("shell command utils parity", () => {
  it.each<[string, string[]]>([
    ["", []],
    ["ls -la /tmp", ["ls", "-la", "/tmp"]],
    ["echo 'hello world'", ["echo", "hello world"]],
    ['echo "a b" \'c d\'', ["echo", "a b", "c d"]],
    ["echo `uname -r` x", ["echo", "uname -r", "x"]],
    ["echo 'unclosed", ["echo", "unclosed"]],
    ["a'b'c\"d\"e", ["abcde"]],
    ["a\tb\nc", ["a", "b", "c"]],
    ["a\ufeffb", ["a", "b"]],
    ["a\u0085b", ["a\u0085b"]],
    ["find . -name '*.ts'", ["find", ".", "-name", "*.ts"]],
    ["  pad  pad2 ", ["pad", "pad2"]],
  ])("tokenize %#", (command, expected) =>
    eq("tokenize", { command }, shellTokenize(command), expected));

  it.each<[string, string]>([
    ["ls -R", "ls -R"],
    ["# comment\nls", "ls"],
    ["   # indented\nfind .", "find ."],
    ["ls # inline note", "ls # inline note"],
    ["#!/bin/sh\nls", "ls"],
    ["sh -c # note\nreal", "sh -c \nreal"],
    ["sh -c x # note", "sh -c x # note"],
  ])("strip-comments %#", (command, expected) =>
    eq("strip-comments", { command }, stripShellCommentLines(command), expected));

  it.each<[string, string]>([
    ["  ls -R  ", "ls -R"],
    [" # c\n ls -la ", "ls -la"],
    ["\n\n# x\nfind . -type f\n", "find . -type f"],
  ])("normalize %#", (command, expected) =>
    eq("normalize", { command }, normalizeRuntimeShellCommand(command), expected));

  it.each<[string, string]>([
    ["'quoted'", "quoted"],
    ['"dbl",', "dbl"],
    ["`tick`;", "tick"],
    ["trail?!", "trail"],
    ["':;,'", ""],
    ["$PWD,", "$PWD"],
    ['"a/b":', "a/b"],
    ["plain", "plain"],
  ])("clean-token %#", (token, expected) =>
    eq("clean-token", { token }, cleanShellToken(token), expected));

  it.each<[string, Record<string, string>]>([
    ["foo=bar cmd", { foo: "bar" }],
    ["a=1 b='two x' run", { a: "1", b: "two x" }],
    ['a="q v" go', { a: "q v" }],
    ["a=b;c=d", { a: "b", c: "d" }],
    ["x= echo", {}],
    ["_v=1 ok", { _v: "1" }],
    ["x='a;b'", { x: "a" }],
    ["p=/a/b.txt", { p: "/a/b.txt" }],
    ["9x=1", {}],
  ])("variables %#", (command, expected) =>
    eq("variables", { command }, Object.fromEntries(extractShellVariableAssignments(command)), expected));

  type Seg = { command: string; stdinFromPipe: boolean };
  it.each<[string, Seg[]]>([
    ["a && b", [{ command: "a", stdinFromPipe: false }, { command: "b", stdinFromPipe: false }]],
    ["a | b", [{ command: "a", stdinFromPipe: false }, { command: "b", stdinFromPipe: true }]],
    ["a;b", [{ command: "a", stdinFromPipe: false }, { command: "b", stdinFromPipe: false }]],
    ["a||b", [{ command: "a||b", stdinFromPipe: false }]],
    ["a || b", [{ command: "a", stdinFromPipe: false }, { command: "b", stdinFromPipe: false }]],
    ["grep x | wc -l && rg y", [{ command: "grep x", stdinFromPipe: false }, { command: "wc -l", stdinFromPipe: true }, { command: "rg y", stdinFromPipe: false }]],
    ["echo $(ls -la) | cat", [{ command: "echo $(ls -la)", stdinFromPipe: false }, { command: "cat", stdinFromPipe: true }]],
    [";lead;trail;", [{ command: "lead", stdinFromPipe: false }, { command: "trail", stdinFromPipe: false }]],
    ["a && | b", [{ command: "a", stdinFromPipe: false }, { command: "| b", stdinFromPipe: false }]],
    ["x |", [{ command: "x |", stdinFromPipe: false }]],
  ])("segments %#", (command, expected) =>
    eq("segments", { command }, splitRuntimeShellSegments(command), expected));
});

describe("extract-command parity", () => {
  it.each<[string, string, string | null]>([
    ["codex_local", j({ type: "item.started", item: { type: "command_execution", command: "ls -R /tmp" } }), "ls -R /tmp"],
    ["codex_local", j({ type: "item.started", item: { type: "file", command: "x" } }), null],
    ["claude_local", j({ type: "assistant", message: { content: [{ type: "tool_use", name: "bash", input: { command: "grep -R x" } }] } }), "grep -R x"],
    ["claude_local", j({ type: "assistant", message: { content: [{ type: "tool_use", name: "read", input: { command: "x" } }] } }), null],
    ["cursor", j({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "find ." } } } }), "find ."],
    ["gemini_local", j({ type: "tool_call", subtype: "start", toolCall: { shell: { input: { command: "rg foo" } } } }), "rg foo"],
    ["cursor", j({ type: "tool_call", subtype: "finished", tool_call: { shellToolCall: { args: { command: "x" } } } }), null],
    ["hermes_local", "┊ 💻 $ ls -R /srv", "ls -R /srv"],
    ["hermes_local", "\u001b[32m┊ 💻 $ echo hi\u001b[0m", "echo hi"],
    ["hermes_local", "┊ plain text", null],
    ["opencode_local", j({ type: "tool_use", part: { tool: "bash", state: { input: { command: "ls" } } } }), "ls"],
    ["pi_local", j({ type: "tool_execution_start", toolName: "shell", args: { command: "pwd" } }), "pwd"],
    ["commandcode_local", j({ type: "event", event: { type: "tool_queued", toolName: "shell_command", input: { command: "tree" } } }), "tree"],
    ["codex_local", "not json", null],
    ["codex_local", "[1]", null],
    ["codex_local", j({ type: "item.started", item: { type: "command_execution", command: "" } }), null],
  ])("extract %#", (adapterType, line, expected) =>
    eq("extract-command", { adapterType, line }, extractRuntimeCommand(adapterType, line), expected));
});

describe("broad-scan policy parity", () => {
  it.each<[ScanIn, string | null]>([
    [{ command: "find . -type f" }, "find ."],
    [{ command: "find . -type f", repoSearchRoot: "/repo" }, "find ."],
    [{ command: "find /repo/src -type f", repoSearchRoot: "/repo" }, null],
    [{ command: "find" }, null],
    [{ command: "find", repoSearchRoot: "/repo" }, null],
    [{ command: "find -type f" }, "find ."],
    [{ command: "find -type f", repoSearchRoot: "/repo" }, null],
    [{ command: "find src -name '*.ts'" }, null],
    [{ command: "find .." }, "find ."],
    [{ command: "find /" }, "find ."],
    [{ command: "find -- ." }, "find ."],
    [{ command: "find /w", workingDirectory: "/w" }, "find ."],
    [{ command: "find $d", shellVariables: { d: "." } }, "find ."],
    [{ command: "find ${D}", shellVariables: { D: "/" } }, null],
    [{ command: "find ${PWD}" }, "find ."],
    [{ command: "sudo find /tmp -type f" }, null],
    [{ command: "git ls-files" }, "git ls-files"],
    [{ command: "git ls-files", repoSearchRoot: "/r" }, null],
    [{ command: "git status" }, null],
    [{ command: "tree" }, "tree"],
    [{ command: "tree", repoSearchRoot: "/r" }, null],
    [{ command: "tree /r/x.txt", repoSearchRoot: "/r" }, null],
    [{ command: "ls -R" }, "ls -R"],
    [{ command: "ls -la" }, null],
    [{ command: "ls -lR" }, "ls -R"],
    [{ command: "ls -R /r/dir", repoSearchRoot: "/r" }, null],
    [{ command: "ls -R /r/dir", repoSearchRoot: "/other" }, "ls -R"],
    [{ command: "ls -R a.txt", allowedPaths: ["/w/a.txt"], workingDirectory: "/w" }, null],
    [{ command: "ls -R a.txt" }, "ls -R"],
    [{ command: "rg TODO" }, null],
    [{ command: "rg TODO ." }, "rg with a root target"],
    [{ command: "rg TODO /" }, "rg with a root target"],
    [{ command: "rg TODO /r", repoSearchRoot: "/r" }, "rg with a root target"],
    [{ command: "rg TODO /r/sub", repoSearchRoot: "/r" }, null],
    [{ command: "rg -e TODO src" }, null],
    [{ command: "rg TODO /w", workingDirectory: "/w" }, "rg with a root target"],
    [{ command: "rg TODO $d", shellVariables: { d: "/" } }, null],
    [{ command: "rg -f pats.txt /" }, "rg with a root target"],
    [{ command: 'rg \\"pat\\"/w', workingDirectory: "/w" }, "rg with a root target"],
    [{ command: "grep -R needle" }, "grep -R without path"],
    [{ command: "grep -R needle", stdinFromPipe: true }, null],
    [{ command: "grep -r needle" }, "grep -R without path"],
    [{ command: "grep -Rn needle" }, "grep -R without path"],
    [{ command: "grep -R needle a.txt", allowedPaths: ["/w/a.txt"], workingDirectory: "/w" }, null],
    [{ command: "grep -R needle a.txt" }, "grep -R without path"],
    [{ command: "grep -R needle ." }, "grep -R without path"],
    [{ command: "grep -R -f pats x.txt" }, "grep -R without path"],
    [{ command: "cat f | grep -R n", stdinFromPipe: true }, null],
  ])("broad-scan %#", (input, expected) => {
    expect(tsScan(input)).toEqual(expected);
    expect(rust("broad-scan", input)).toEqual(expected);
  });
});
