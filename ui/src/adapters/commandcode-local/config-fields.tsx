import type { AdapterConfigFieldsProps } from "../types";
import { Field, ToggleField, DraftInput, DraftNumberInput } from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Folded into the run prompt at runtime.";

export function CommandCodeLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  if (hideInstructionsFile) return null;
  return (
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
  );
}

export function CommandCodeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Skip permissions"
        hint="Run Command Code with --yolo (skip all permission prompts) instead of the safe --permission-mode auto-accept default. Required for unattended runs that need unrestricted tool actions."
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions === true,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field
        label="Max turns per run"
        hint="Maximum agentic turns (tool calls) per run before Command Code stops with a partial response. 0 or blank = CLI default (no cap). The partial session is preserved, so the next wake resumes from it."
      >
        {isCreate ? (
          <input
            type="number"
            min={0}
            className={inputClass}
            value={values!.maxTurns ? values!.maxTurns : ""}
            onChange={(e) =>
              set!({ maxTurns: Number(e.target.value) })
            }
            placeholder="CLI default (no cap)"
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "maxTurns", Number(config.maxTurns ?? 0))}
            onCommit={(v) => mark("adapterConfig", "maxTurns", v > 0 ? v : undefined)}
            onEmpty={() => mark("adapterConfig", "maxTurns", undefined)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
