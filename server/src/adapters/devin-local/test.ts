import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import {
  type RunProcessResult,
  asString,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "../utils.js";
import { DEVIN_LOCAL_DEFAULT_MODEL, DEVIN_LOCAL_MODELS } from "./models.js";

const ANSI_CSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const PROBE_TIMEOUT_SEC = 5;
const PROBE_GRACE_SEC = 1;

type ProbeOutcome =
  | { ok: true; result: RunProcessResult }
  | { ok: false; errorMessage: string };

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_RE, "");
}

function firstNonEmptyLine(text: string): string {
  return (
    stripAnsi(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function clipText(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function probeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  return raw ? clipText(raw) : null;
}

function extractVersion(stdout: string, stderr: string): { version: string; line: string } | null {
  const output = stripAnsi(`${stdout}\n${stderr}`);
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
    if (match) return { version: match[0], line: trimmed };
  }
  return null;
}

function supportsHeadlessPrint(stdout: string, stderr: string): boolean {
  const help = stripAnsi(`${stdout}\n${stderr}`);
  return /--print(?=\s|\[|=|,|$)/.test(help) || /(?:^|\s)-p(?=\s|,|\[|=|$)/m.test(help);
}

async function runProbe(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ProbeOutcome> {
  try {
    const result = await runChildProcess(
      `devin-envtest-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      args,
      {
        cwd,
        env,
        timeoutSec: PROBE_TIMEOUT_SEC,
        graceSec: PROBE_GRACE_SEC,
        onLog: async () => {},
      },
    );
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function addVersionProbeCheck(checks: AdapterEnvironmentCheck[], probe: ProbeOutcome): void {
  if (!probe.ok) {
    checks.push({
      code: "devin_version_probe_error",
      level: "warn",
      message: "Devin CLI version probe could not start.",
      detail: probe.errorMessage,
      hint: "Verify that adapterConfig.command points to a working Devin CLI executable.",
    });
    return;
  }

  const { result } = probe;
  const detail = probeDetail(result.stdout, result.stderr);
  if (result.timedOut) {
    checks.push({
      code: "devin_version_probe_timed_out",
      level: "warn",
      message: "Devin CLI version probe timed out.",
      ...(detail ? { detail } : {}),
      hint: "Retry the environment test. If this persists, run `devin --version` manually in the configured working directory.",
    });
    return;
  }

  if ((result.exitCode ?? 1) === 0) {
    const detected = extractVersion(result.stdout, result.stderr);
    if (detected) {
      checks.push({
        code: "devin_version_detected",
        level: "info",
        message: `Devin CLI version detected: ${detected.version}`,
        detail: clipText(detected.line),
      });
    } else {
      checks.push({
        code: "devin_version_probe_empty",
        level: "warn",
        message: "Devin CLI version probe succeeded but did not report a version.",
        ...(detail ? { detail } : {}),
        hint: "Run `devin --version` manually and upgrade the CLI if version output is unavailable.",
      });
    }
    return;
  }

  checks.push({
    code: "devin_version_probe_failed",
    level: "warn",
    message: "Devin CLI version probe failed.",
    ...(detail ? { detail } : {}),
    hint: "Run `devin --version` manually in the configured working directory. If the command is a wrapper, ensure it forwards `--version`.",
  });
}

function addHeadlessProbeCheck(checks: AdapterEnvironmentCheck[], probe: ProbeOutcome): void {
  if (!probe.ok) {
    checks.push({
      code: "devin_headless_probe_error",
      level: "warn",
      message: "Devin CLI headless readiness probe could not start.",
      detail: probe.errorMessage,
      hint: "Verify that adapterConfig.command points to a working Devin CLI executable.",
    });
    return;
  }

  const { result } = probe;
  const detail = probeDetail(result.stdout, result.stderr);
  if (result.timedOut) {
    checks.push({
      code: "devin_headless_probe_timed_out",
      level: "warn",
      message: "Devin CLI help probe timed out while checking headless readiness.",
      ...(detail ? { detail } : {}),
      hint: "Retry the environment test. If this persists, run `devin --help` manually in the configured working directory.",
    });
    return;
  }

  if ((result.exitCode ?? 1) !== 0) {
    checks.push({
      code: "devin_headless_probe_failed",
      level: "warn",
      message: "Devin CLI help probe failed while checking headless readiness.",
      ...(detail ? { detail } : {}),
      hint: "Paperclip runs Devin non-interactively with `-p`/`--print`. Confirm `devin --help` lists that flag.",
    });
    return;
  }

  if (supportsHeadlessPrint(result.stdout, result.stderr)) {
    checks.push({
      code: "devin_headless_ready",
      level: "info",
      message: "Devin CLI advertises non-interactive print mode (`-p`/`--print`).",
    });
    return;
  }

  checks.push({
    code: "devin_headless_flag_missing",
    level: "warn",
    message: "Devin CLI help did not advertise non-interactive print mode (`-p`/`--print`).",
    hint: "Upgrade Devin CLI or point adapterConfig.command at a build whose help lists `-p`/`--print`; Paperclip cannot use an interactive-only CLI.",
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "devin");
  const cwd = asString(config.cwd, process.cwd());
  const model = asString(config.model, DEVIN_LOCAL_DEFAULT_MODEL).trim() || DEVIN_LOCAL_DEFAULT_MODEL;
  let cwdValid = false;
  let commandResolvable = false;

  try {
    await ensureAbsoluteDirectory(cwd);
    cwdValid = true;
    checks.push({
      code: "devin_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "devin_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    commandResolvable = true;
    checks.push({
      code: "devin_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "devin_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install Devin CLI or set adapterConfig.command to the devin executable path.",
    });
  }

  const knownModel = DEVIN_LOCAL_MODELS.find((entry) => entry.id === model);
  checks.push({
    code: "devin_model_selected",
    level: "info",
    message: `Selected model: ${model}${model.startsWith("swe-2-flash") ? " (262K Free)" : ""}`,
    ...(knownModel ? { detail: knownModel.label } : {}),
  });
  if (!knownModel) {
    checks.push({
      code: "devin_model_unrecognized",
      level: "warn",
      message: `Configured model is not in the known devin_local model list: ${model}`,
      hint: `Use one of the built-in models (${DEVIN_LOCAL_MODELS.map((entry) => entry.id).join(", ")}) or verify that this custom Devin CLI model is intentional.`,
    });
  }

  if (cwdValid && commandResolvable) {
    const [versionProbe, headlessProbe] = await Promise.all([
      runProbe("version", command, ["--version"], cwd, env),
      runProbe("help", command, ["--help"], cwd, env),
    ]);
    addVersionProbeCheck(checks, versionProbe);
    addHeadlessProbeCheck(checks, headlessProbe);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
