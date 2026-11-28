import type {
  AdapterConfigFieldsProps,
  CreateConfigValues,
} from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

const devinModelHints = [
  "swe-2-flash-medium",
  "swe-2-flash-high",
  "swe-2-flash-max",
  "swe-2-1-low",
  "swe-2-1-medium",
  "swe-2-1-high",
  "swe-2-1-max",
] as const;

const permissionModeOptions = [
  { id: "normal", label: "Normal (prompts for writes and commands)" },
  { id: "accept-edits", label: "Accept edits (workspace edits auto-approved)" },
  { id: "smart", label: "Smart (safe actions auto-approved)" },
  { id: "dangerous", label: "Dangerous (non-interactive automation default)" },
] as const;

type DevinLocalCreateConfigValues = CreateConfigValues & {
  permissionMode?: string;
};

function createPermissionModePatch(value: string): Partial<CreateConfigValues> {
  return { permissionMode: value } as unknown as Partial<CreateConfigValues>;
}

export function DevinLocalConfigFields(props: AdapterConfigFieldsProps) {
  const {
    isCreate,
    values,
    set,
    config,
    eff,
    mark,
    hideInstructionsFile,
  } = props;
  const createValues = values as DevinLocalCreateConfigValues | null;
  const permissionMode = isCreate
    ? createValues?.permissionMode || "dangerous"
    : eff(
        "adapterConfig",
        "permissionMode",
        String(config.permissionMode ?? "dangerous"),
      );

  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}

      <Field
        label="Permission mode"
        hint="Devin CLI permission mode for unattended print-mode runs. Dangerous auto-approves every tool and is the default because interactive approval prompts cannot be answered by the runtime."
      >
        <select
          className={inputClass}
          value={permissionMode}
          onChange={(event) => {
            const next = event.target.value;
            if (isCreate) {
              set!(createPermissionModePatch(next));
            } else {
              mark("adapterConfig", "permissionMode", next);
            }
          }}
          aria-label="Devin permission mode"
        >
          {permissionModeOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {permissionMode === "dangerous" && (
        <p className="rounded-[10px] border border-amber-600/25 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]">
          Dangerous mode auto-approves all Devin tools. Use it only for trusted workspaces; choose Smart or Accept edits when the run should be more constrained.
        </p>
      )}

      <div className="rounded-[10px] border border-slate-200/80 bg-slate-50 px-3 py-2 text-xs dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="font-medium text-slate-700 dark:text-[#eef2f8]">Devin model hints</div>
        <div className="mt-1 font-mono text-[11px] leading-5 text-slate-600 dark:text-[#8f9db3]">
          {devinModelHints.join(" · ")}
        </div>
        <p className="mt-1 text-slate-500 dark:text-[#8f9db3]">
          SWE-2 Flash tiers are free-context automation models; SWE-2.1 tiers expose low through max reasoning levels.
        </p>
      </div>

      <LocalWorkspaceRuntimeFields {...props} />
    </>
  );
}
