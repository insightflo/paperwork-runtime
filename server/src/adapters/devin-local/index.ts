import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { devinLocalSessionCodec } from "./parse.js";
import { DEVIN_LOCAL_MODELS, listDevinLocalModels } from "./models.js";

export const devinLocalAdapter: ServerAdapterModule = {
  type: "devin_local",
  execute,
  testEnvironment,
  sessionCodec: devinLocalSessionCodec,
  models: DEVIN_LOCAL_MODELS,
  listModels: listDevinLocalModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: `# devin_local agent configuration

Adapter: devin_local

Core fields:
- command (string, optional): Devin CLI executable; defaults to "devin"
- cwd (string, optional): absolute working directory
- model (string, optional): defaults to "swe-2-flash-medium"
- permissionMode (string, optional): Devin permission mode; defaults to "dangerous"
- extraArgs (string[], optional): additional Devin CLI arguments
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
