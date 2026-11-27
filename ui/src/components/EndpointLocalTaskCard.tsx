import { useEffect, useMemo, useState, type FormEvent } from "react";

/** Endpoint bot target shown in the local task card. */
export interface EndpointLocalTaskTarget {
  deviceId: string;
  botName: string;
  online: boolean;
}

/** Payload passed to `onDispatch`; matches `EnqueueLocalTaskInput` for the supported kinds. */
export interface EndpointLocalTaskInput {
  kind: "list_dir" | "read_file" | "shell_exec";
  targetPath: string;
  command?: string;
}

export interface EndpointLocalTaskCardProps {
  /** Endpoint bots to choose from; only online ones are selectable. */
  endpoints: Array<EndpointLocalTaskTarget>;
  /** Dispatches the task and resolves with `{ taskId }` (or nothing) on success. */
  onDispatch: (deviceId: string, input: EndpointLocalTaskInput) => Promise<{ taskId: string } | void>;
  /** External submitting state; when omitted, the card tracks its own pending state. */
  submitting?: boolean;
}

const KIND_OPTIONS = [
  { value: "list_dir", label: "폴더 목록" },
  { value: "read_file", label: "파일 읽기" },
  { value: "shell_exec", label: "로컬 명령 실행" },
] as const;

const inputClass = "h-9 rounded-md border border-border bg-background px-3 text-foreground";
const buttonClass =
  "inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

/** Client-side guard: non-empty path, no `..` traversal, command required for shell_exec. */
function validate(kind: EndpointLocalTaskInput["kind"], targetPath: string, command: string): string | null {
  const trimmedPath = targetPath.trim();
  if (!trimmedPath) return "대상 경로를 입력하세요.";
  if (trimmedPath.split(/[\\/]+/).includes("..")) {
    return "상위 폴더로 올라가는 경로(..)는 허용되지 않습니다.";
  }
  if (kind === "shell_exec" && !command.trim()) return "실행할 명령을 입력하세요.";
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function EndpointLocalTaskCard({ endpoints, onDispatch, submitting }: EndpointLocalTaskCardProps) {
  const onlineEndpoints = useMemo(() => endpoints.filter((endpoint) => endpoint.online), [endpoints]);
  const [deviceId, setDeviceId] = useState("");
  const [kind, setKind] = useState<EndpointLocalTaskInput["kind"]>("list_dir");
  const [targetPath, setTargetPath] = useState("");
  const [command, setCommand] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 선택한 봇이 목록에서 사라지거나 오프라인이 되면 첫 온라인 봇으로 되돌린다.
  useEffect(() => {
    if (!onlineEndpoints.some((endpoint) => endpoint.deviceId === deviceId)) {
      setDeviceId(onlineEndpoints[0]?.deviceId ?? "");
    }
  }, [onlineEndpoints, deviceId]);

  const isSubmitting = submitting ?? busy;
  const canSubmit = onlineEndpoints.length > 0 && deviceId !== "" && !isSubmitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const error = validate(kind, targetPath, command);
    setValidationError(error);
    setDispatchError(null);
    setTaskId(null);
    if (error) return;
    setBusy(true);
    try {
      const input: EndpointLocalTaskInput = { kind, targetPath: targetPath.trim() };
      if (kind === "shell_exec") input.command = command.trim();
      const result = await onDispatch(deviceId, input);
      setTaskId(result && typeof result === "object" && "taskId" in result ? result.taskId : null);
    } catch (error) {
      setDispatchError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="로컬 작업 접수" className="space-y-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-sm">
      <h2 className="text-base font-semibold">로컬 작업 접수</h2>
      <p className="text-sm text-muted-foreground">
        온라인 상태인 개인 단말 봇에 폴더 목록 조회, 파일 읽기, 로컬 명령 실행 작업을 보냅니다.
      </p>

      <form onSubmit={handleSubmit} noValidate className="grid gap-3">
        <label className="grid gap-1 text-sm font-medium">
          대상 봇
          <select
            aria-label="작업을 보낼 봇"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            className={inputClass}
            disabled={endpoints.length === 0}
          >
            {endpoints.map((endpoint) => (
              <option key={endpoint.deviceId} value={endpoint.deviceId} disabled={!endpoint.online}>{endpoint.botName} {endpoint.online ? "· 온라인" : "· 오프라인"}</option>
            ))}
          </select>
        </label>

        {onlineEndpoints.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            온라인 상태인 개인 단말 봇이 없습니다
          </p>
        )}

        <label className="grid gap-1 text-sm font-medium">
          작업 종류
          <select
            aria-label="로컬 작업 종류"
            value={kind}
            onChange={(event) => setKind(event.target.value as EndpointLocalTaskInput["kind"])}
            className={inputClass}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-sm font-medium">
          대상 경로
          <input aria-label="대상 경로" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} className={inputClass} placeholder="~/Projects" />
        </label>

        {kind === "shell_exec" && (
          <label className="grid gap-1 text-sm font-medium">
            실행할 명령
            <input aria-label="실행할 명령" value={command} onChange={(event) => setCommand(event.target.value)} className={inputClass} placeholder="git status" />
          </label>
        )}

        {validationError && <p role="alert" className="text-sm text-destructive">{validationError}</p>}

        {dispatchError && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            작업 접수에 실패했습니다: {dispatchError}
          </p>
        )}

        {taskId && <p role="status" className="text-sm text-foreground">작업이 접수되었습니다. 작업 ID: <code>{taskId}</code></p>}

        <button type="submit" disabled={!canSubmit} className={buttonClass}>
          {isSubmitting ? "접수 중…" : "로컬 작업 접수"}
        </button>
      </form>
    </section>
  );
}
