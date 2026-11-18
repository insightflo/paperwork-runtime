export const type = "antigravity_local";
export const label = "Antigravity (local)";

export const models: Array<{ id: string; label: string }> = [
  { id: "auto", label: "Auto (Antigravity settings)" },
];

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "auto";

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run Google's Antigravity CLI (agy) locally as the agent runtime
- You want one-shot headless print-mode runs with Antigravity's local auth/session state

Don't use when:
- agy is not installed or not authenticated on the host
- You need structured JSONL/token events; agy stdout is treated as plain text for now

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): markdown instructions file path resolved from the effective cwd and prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "agy"
- printTimeout (string, optional): passed to --print-timeout, defaults to "180s"
- bypassPermissions / dangerouslySkipPermissions (boolean, optional): passes --dangerously-skip-permissions
- sandbox (boolean, optional): passes --sandbox when true
- model (string, optional): passed to --model when set to a value other than "auto" (defaults to "auto", which uses Antigravity settings)
- effort (string, optional): passed to --effort (low|medium|high|xhigh|max) unless the selected model id already encodes a different effort suffix
- chrome (boolean, optional): stored for compatibility with common local-agent Enable Chrome UI; current agy has no chrome flag
- extraArgs (string[], optional): additional CLI flags inserted before --print
- env (object, optional): KEY=VALUE environment variables

Skills:
- Papercompany skill selections are supplied as on-demand run context.
- For a matching task, Antigravity reads the selected skill's SKILL.md from its managed source path.
- This does not write to Antigravity's shared global skills directory, so one agent's selection cannot change another agent's skills.

Operational notes:
- Flags are placed before --print because agy treats args after --print as prompt text.
- Paperclip always passes --add-dir <cwd> so file/tool actions use the intended workspace.
- Sessions are restored with --conversation when a saved conversation id matches the current cwd.
- Model selection uses Antigravity settings when set to "auto" (default), or passes --model <id> before --print for explicit models.
`;
