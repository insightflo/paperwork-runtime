import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPaperworkEngineClient, type PaperworkEngineClient } from "./paperwork-engine-client.js";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveDefaultPaperworkEngineBin(options?: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}): string | null {
  const { repoRoot = DEFAULT_REPO_ROOT, env = process.env, existsSync: exists = existsSync } = options ?? {};
  if (env.PAPERWORK_ENGINE_BIN !== undefined) {
    const bin = env.PAPERWORK_ENGINE_BIN.trim();
    return bin && path.isAbsolute(bin) && !bin.includes("\0") && exists(bin) ? bin : null;
  }
  if (!path.isAbsolute(repoRoot)) return null;
  const candidates = [
    path.join(repoRoot, "target", "release", "paperwork-engine"),
    path.join(repoRoot, "crates", "paperwork-engine", "target", "release", "paperwork-engine"),
    path.join(repoRoot, "target", "debug", "paperwork-engine"),
  ];
  return candidates.find((bin) => exists(bin)) ?? null;
}

type EngineState =
  | { phase: "idle" }
  | { phase: "active"; client: PaperworkEngineClient }
  | { phase: "closing"; closePromise: Promise<void> }
  | { phase: "closed" };

let state: EngineState = { phase: "idle" };

export function getSharedPaperworkEngineClient(
  factory = (bin: string): PaperworkEngineClient => createPaperworkEngineClient({ bin }),
): PaperworkEngineClient | null {
  if (state.phase === "active") return state.client;
  if (state.phase !== "idle") return null;
  const bin = resolveDefaultPaperworkEngineBin();
  if (bin === null) return null;
  const client = factory(bin);
  state = { phase: "active", client };
  return client;
}

/**
 * Publish the shared close promise before invoking client.close(), so synchronous
 * throws and non-awaiting re-entry observe a consistent state. client.close()
 * must not await or return closeSharedPaperworkEngineClient(): that would deadlock.
 */
export function closeSharedPaperworkEngineClient(): Promise<void> {
  if (state.phase === "closing") return state.closePromise;
  if (state.phase === "active") {
    const { client } = state;
    const closePromise = Promise.resolve().then(() => client.close()).finally(() => {
      state = { phase: "closed" };
    });
    state = { phase: "closing", closePromise };
    return closePromise;
  }
  state = { phase: "closed" };
  return Promise.resolve();
}

export async function resetSharedPaperworkEngineForTests(): Promise<void> {
  await closeSharedPaperworkEngineClient().catch(() => {});
  state = { phase: "idle" };
}

export async function runOrderedShutdownSteps(steps: ReadonlyArray<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Ordered shutdown failed");
}
