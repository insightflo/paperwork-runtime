import type { ServerAdapterModule } from "@paperclipai/adapter-utils";

export const RETIRED_HERMES_MESSAGE =
  "The hermes_local adapter has been retired. Migrate existing agents to OpenBot or a supported local adapter (codex_local, claude_local, pi_local, commandcode_local).";

export const hermesRetiredAdapter: ServerAdapterModule = {
  type: "hermes_local",
  async execute(ctx) {
    await ctx.onLog("stderr", `${RETIRED_HERMES_MESSAGE}\n`);
    await ctx.onMeta?.({
      adapterType: "hermes_local",
      command: "hermes_local-retired",
      commandNotes: [RETIRED_HERMES_MESSAGE],
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: RETIRED_HERMES_MESSAGE,
      errorCode: "hermes_local_retired",
      provider: "hermes",
      summary: RETIRED_HERMES_MESSAGE,
    };
  },
  async testEnvironment() {
    return {
      adapterType: "hermes_local",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: "hermes_local_retired",
          level: "error",
          message: RETIRED_HERMES_MESSAGE,
          hint: "Migrate this agent to OpenBot or a supported local adapter.",
        },
      ],
    };
  },
  models: [],
  supportsLocalAgentJwt: false,
  requiresMaterializedRuntimeSkills: false,
  getConfigSchema: () => ({ fields: [] }),
  agentConfigurationDoc: `# hermes_local retired\n\n${RETIRED_HERMES_MESSAGE}`,
};
