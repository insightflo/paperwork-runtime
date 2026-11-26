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
  api_key_env_present:
    "border-[#a3e635]/45 bg-[#a3e635]/15 text-[#3f6212] dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  credential_file_present:
    "border-[#a3e635]/45 bg-[#a3e635]/15 text-[#3f6212] dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  managed_env_present:
    "border-[#a3e635]/45 bg-[#a3e635]/15 text-[#3f6212] dark:bg-[#a3e635]/10 dark:text-[#a3e635]",
  missing:
    "border-slate-300/80 bg-slate-100 text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#8f9db3]",
  probe_error:
    "border-[#f59e0b]/45 bg-[#f59e0b]/15 text-[#92400e] dark:bg-[#f59e0b]/10 dark:text-[#f59e0b]",
};

const EVIDENCE_DOT: Record<LocalAuthEvidence, string> = {
  api_key_env_present: "bg-[#65a30d] dark:bg-[#a3e635]",
  credential_file_present: "bg-[#65a30d] dark:bg-[#a3e635]",
  managed_env_present: "bg-[#65a30d] dark:bg-[#a3e635]",
  missing: "bg-slate-400 dark:bg-[#8f9db3]",
  probe_error: "bg-[#d97706] dark:bg-[#f59e0b]",
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
    <li className="rounded-[12px] border border-slate-200/90 bg-white/85 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-colors duration-150 hover:border-[#2563eb]/35 dark:border-white/[0.08] dark:bg-[#090c12]/75 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-14px_rgba(0,0,0,0.7)] dark:hover:border-[#60a5fa]/35">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold tracking-tight text-slate-800 dark:text-[#eef2f8]">{status.provider}</span>
        <Badge variant="outline" className={EVIDENCE_BADGE[status.evidence]}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${EVIDENCE_DOT[status.evidence]}`} />
          {EVIDENCE_LABEL[status.evidence]}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto border border-[#2563eb]/35 bg-[#2563eb]/[0.07] font-semibold text-[#1d4ed8] transition-colors hover:bg-[#2563eb]/[0.12] dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/10 dark:text-[#60a5fa] dark:hover:bg-[#60a5fa]/15"
          disabled={!onRequestLoginPlan || planLoading}
          onClick={() => onRequestLoginPlan?.(status.provider)}
        >
          {planLoading ? "Preparing…" : "Login Command"}
        </Button>
      </div>
      <div className="mt-2 grid gap-1 break-all font-mono text-[11px] leading-4 text-slate-500 tabular-nums dark:text-[#8f9db3]">
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
        <div className="mt-3 rounded-[10px] border border-[#2563eb]/25 bg-[#2563eb]/[0.05] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-[#60a5fa]/25 dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <p className="text-xs font-medium text-slate-600 dark:text-[#8f9db3]">
            Run in your terminal{plan.interactive ? " (interactive sign-in)" : ""}:
          </p>
          <code className="mt-2 block break-all rounded-md border border-[#2563eb]/20 bg-white/75 px-2 py-1.5 font-mono text-xs text-[#1d4ed8] tabular-nums dark:border-[#60a5fa]/20 dark:bg-[#0e131d] dark:text-[#60a5fa]">
            {formatShellCommand(plan.command, plan.args)}
          </code>
          {plan.notes.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-xs leading-5 text-slate-500 dark:text-[#8f9db3]">
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
    <section className="tactile-card rounded-[12px] border-slate-200/90 bg-white/85 p-4 dark:border-white/[0.08] dark:bg-[#0e131d]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-700 dark:text-[#eef2f8]">Provider Auth</h2>
        <span className="text-xs text-slate-500 dark:text-[#8f9db3]">
          Local evidence only — remote sign-in state is not verified.
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto border border-slate-300/80 bg-white/70 font-semibold text-slate-600 transition-colors hover:border-[#2563eb]/35 hover:text-[#1d4ed8] dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8f9db3] dark:hover:border-[#60a5fa]/35 dark:hover:text-[#60a5fa]"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      {loading && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-slate-600 dark:text-[#8f9db3]">
          <span aria-hidden className="h-2 w-2 rounded-full bg-[#60a5fa] motion-safe:animate-pulse" />
          Checking local credentials…
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-3 rounded-[10px] border border-[#f43f5e]/30 bg-[#f43f5e]/10 px-3 py-2 text-sm font-medium text-[#be123c] dark:text-[#f43f5e]">
          Provider auth status is currently unavailable.
        </p>
      ) : null}
      <ul className="mt-4 grid gap-2.5">
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
