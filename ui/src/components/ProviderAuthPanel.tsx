import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ProviderAuthId = "claude" | "codex" | "pi" | "commandcode" | "devin";

export type LocalAuthEvidence =
  | "api_key_env_present"
  | "credential_file_present"
  | "managed_env_present"
  | "missing"
  | "probe_error";

export interface FileProbeMeta {
  exists: boolean;
  isSymlink: boolean;
  sizeBytes: number;
  mtimeEpochMs: number;
  inode: number;
}

export interface ProviderAuthStatus {
  provider: ProviderAuthId;
  evidence: LocalAuthEvidence;
  envVar?: string;
  credentialPath?: string;
  credentialMeta?: FileProbeMeta;
  errorPath?: string;
  auxiliaryPresent?: string[];
}

export interface LoginActionPlan {
  provider: ProviderAuthId;
  command: string;
  args: string[];
  interactive: boolean;
  notes: string[];
}

export interface ProviderAuthPanelProps {
  providers: ProviderAuthStatus[];
  loading?: boolean;
  error?: string | null;
  loginPlans?: Partial<Record<ProviderAuthId, LoginActionPlan>>;
  selectedLoginProvider?: ProviderAuthId | null;
  loginPlanLoadingProvider?: ProviderAuthId | null;
  onRefresh?: () => void;
  onRequestLoginPlan?: (provider: ProviderAuthId) => void;
}

const POSIX_SAFE_UNQUOTED = /^[A-Za-z0-9_./:@+-]+$/;

const POSIX_RESERVED_WORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "do", "done", "case", "esac",
  "while", "until", "in", "time", "!", "{", "}", "[[", "]]", "select",
  "function", "coproc",
]);

function shellToken(token: string, commandPosition: boolean): string {
  if (POSIX_SAFE_UNQUOTED.test(token) && !(commandPosition && POSIX_RESERVED_WORDS.has(token))) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map((token, index) => shellToken(token, index === 0)).join(" ");
}

const EVIDENCE_LABEL: Record<LocalAuthEvidence, string> = {
  api_key_env_present: "API key env detected (local)",
  credential_file_present: "Credential file detected (local)",
  managed_env_present: "Managed env detected (local)",
  missing: "No local credentials detected",
  probe_error: "Local probe error",
};

const EVIDENCE_BADGE: Record<LocalAuthEvidence, string> = {
  api_key_env_present: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  credential_file_present:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  managed_env_present: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  missing: "bg-muted text-muted-foreground",
  probe_error: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

function ProviderRow({
  status,
  plan,
  planLoading,
  selectedLoginProvider,
  onRequestLoginPlan,
}: {
  status: ProviderAuthStatus;
  plan?: LoginActionPlan;
  planLoading: boolean;
  selectedLoginProvider: ProviderAuthId | null;
  onRequestLoginPlan?: (provider: ProviderAuthId) => void;
}) {
  const meta = status.credentialMeta;
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{status.provider}</span>
        <Badge variant="outline" className={EVIDENCE_BADGE[status.evidence]}>
          {EVIDENCE_LABEL[status.evidence]}
        </Badge>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-auto"
          disabled={!onRequestLoginPlan || planLoading}
          onClick={() => onRequestLoginPlan?.(status.provider)}
        >
          {planLoading ? "Preparing…" : "Login Command"}
        </Button>
      </div>
      <div className="mt-2 grid gap-1 break-all font-mono text-xs text-muted-foreground">
        {status.envVar && <p>env: {status.envVar}</p>}
        {status.credentialPath && (
          <p>
            credential: {status.credentialPath}
            {meta ? ` (${meta.isSymlink ? "symlink · " : ""}${meta.sizeBytes} B)` : ""}
          </p>
        )}
        {status.errorPath && <p>error at: {status.errorPath}</p>}
      </div>
      {plan && plan.provider === selectedLoginProvider && (
        <div className="mt-2 rounded-md bg-muted p-2">
          <p className="text-xs text-muted-foreground">
            Run in your terminal{plan.interactive ? " (interactive sign-in)" : ""}:
          </p>
          <code className="mt-1 block break-all font-mono text-xs">
            {formatShellCommand(plan.command, plan.args)}
          </code>
          {plan.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function ProviderAuthPanel({
  providers,
  loading = false,
  error = null,
  loginPlans,
  selectedLoginProvider = null,
  loginPlanLoadingProvider = null,
  onRefresh,
  onRequestLoginPlan,
}: ProviderAuthPanelProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Provider Auth</h2>
        <span className="text-xs text-muted-foreground">
          Local evidence only — remote sign-in state is not verified.
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-auto"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      {loading && (
        <p role="status" className="mt-3 text-sm">
          Checking local credentials…
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Provider auth status is currently unavailable.
        </p>
      ) : null}
      <ul className="mt-4 grid gap-3">
        {providers.map((status) => (
          <ProviderRow
            key={status.provider}
            status={status}
            plan={loginPlans?.[status.provider]}
            planLoading={loginPlanLoadingProvider === status.provider}
            selectedLoginProvider={selectedLoginProvider}
            onRequestLoginPlan={onRequestLoginPlan}
          />
        ))}
      </ul>
    </section>
  );
}
