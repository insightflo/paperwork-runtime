export interface DevinCliHealthView {
  installed: boolean;
  version: string | null;
  supportsHeadlessPrompt: boolean;
  supportsWorkspaceTrustFlag: boolean;
  supportsInProcessModel: boolean;
  supportsSessionResume: boolean;
  readyForPaperwork: boolean;
  missingFlags: string[];
}

const REQUIRED_CAPABILITIES = [
  { key: "supportsHeadlessPrompt", label: "헤드리스 프롬프트" },
  { key: "supportsWorkspaceTrustFlag", label: "워크스페이스 신뢰" },
  { key: "supportsInProcessModel", label: "인프로세스 모델" },
  { key: "supportsSessionResume", label: "세션 재개" },
] as const;

const PILL_BASE = "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium";
const PILL_READY = "border-[var(--pw-lime)] bg-[var(--pw-lime-soft)] text-[var(--pw-lime)]";
const PILL_MISSING = "border-[var(--pw-amber)] bg-[var(--pw-amber-soft)] text-[var(--pw-amber)]";
const PILL_UNINSTALLED = "border-[var(--pw-crimson)] bg-[var(--pw-crimson-soft)] text-[var(--pw-crimson)]";

export function formatDevinHealthStatus(health: DevinCliHealthView): string {
  if (!health.installed) return "미설치";
  if (health.readyForPaperwork) return "실행 준비 완료";
  return `플래그 부족 (${health.missingFlags.length})`;
}

function statusPillClass(health: DevinCliHealthView): string {
  if (!health.installed) return `${PILL_BASE} ${PILL_UNINSTALLED}`;
  if (health.readyForPaperwork) return `${PILL_BASE} ${PILL_READY}`;
  return `${PILL_BASE} ${PILL_MISSING}`;
}

export function DevinCliHealthCard({ health }: { health: DevinCliHealthView | null | undefined }) {
  if (!health) return null;

  const status = formatDevinHealthStatus(health);

  return (
    <section
      role="region"
      aria-label="Devin CLI 준비 상태"
      data-testid="devin-cli-health-card"
      className="rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Devin CLI</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            버전 <span className="font-medium text-foreground">{health.version ?? "버전 미확인"}</span>
          </p>
        </div>
        <span className={statusPillClass(health)}>{status}</span>
      </header>

      <div className="grid gap-2 px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">설치 상태</span>
          <span className="font-medium">{health.installed ? "설치됨" : "미설치"}</span>
        </div>

        <ul aria-label="필수 헤드리스 플래그" className="grid gap-1.5 sm:grid-cols-2">
          {REQUIRED_CAPABILITIES.map((capability) => {
            const supported = health[capability.key];
            return (
              <li
                key={capability.key}
                className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-1.5"
              >
                <span className="truncate text-muted-foreground">{capability.label}</span>
                <span className={supported ? "font-medium text-[var(--pw-lime)]" : "font-medium text-[var(--pw-amber)]"}>
                  {supported ? "지원" : "누락"}
                </span>
              </li>
            );
          })}
        </ul>

        {health.missingFlags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">부족한 플래그</span>
            {health.missingFlags.map((flag) => (
              <code
                key={flag}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {flag}
              </code>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
