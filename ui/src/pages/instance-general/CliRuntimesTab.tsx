import { useState } from "react";
import { Input } from "@/components/ui/input";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { cn } from "@/lib/utils";
import {
  chip, cockpitInset, cockpitPanel, cockpitSectionHeader, INPUT, MONO_SNIPPET, PILL_NEUTRAL, PILL_OK, PILL_WARN,
  piCliVersionLabel, usePiCliAction, usePiCliStatus,
} from "./shared";

const copyModelRef = (ref: string) => {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(ref).catch(() => undefined);
};

/** Tab 4 — CLI Runtimes: 설치된 코딩 에이전트 CLI 그리드 + Pi CLI 동기화/업데이트 + 모델 카탈로그. */
export function CliRuntimesTab({ canApplyModel, onApplyModel }: {
  canApplyModel: boolean; onApplyModel: (modelRef: string) => void;
}) {
  const statusQuery = usePiCliStatus();
  const { busy, mutation, run, isPending } = usePiCliAction();
  const [modelFilter, setModelFilter] = useState("");
  const [checkPendingId, setCheckPendingId] = useState<string | null>(null);
  const status = statusQuery.data;
  const runtimes = Array.isArray(status?.runtimes) ? status.runtimes : [];
  const installedCount = runtimes.filter((rt) => rt.installed).length;
  const catalogModels = Array.isArray(status?.catalogModels) ? status.catalogModels : [];
  const filteredModels = catalogModels.filter((ref) =>
    ref.toLowerCase().includes(modelFilter.trim().toLowerCase()));
  const runUpdateCheck = (runtimeId: string) => {
    setCheckPendingId(runtimeId);
    void statusQuery.refetch().finally(() =>
      setCheckPendingId((current) => (current === runtimeId ? null : current)));
  };

  return (
    <div role="tabpanel" id="panel-runtimes" aria-labelledby="tab-runtimes" tabIndex={0}>
      <section className={cn(cockpitPanel, "p-4")}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={cockpitSectionHeader}>멀티 CLI · 모델 런타임 관리</h2>
          {runtimes.length > 0 && (
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium tabular-nums">
              {`${installedCount} / ${runtimes.length} CLI 설치됨`}
            </span>
          )}
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", status?.installed ? PILL_OK : PILL_WARN)}>
            {status?.installed ? `Pi CLI ${piCliVersionLabel(status.version)}` : "Pi CLI not detected"}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">{`총 ${catalogModels.length}개 모델`}</span>
        </div>
        <p className={cn("mt-1.5 text-xs text-muted-foreground", MONO_SNIPPET)}>{`${status?.executablePath ?? "pi"} · ${status?.agentDir ?? "~/.pi/agent"}`}</p>
        {status?.error && <p role="alert" className={cn("mt-2 text-xs text-[var(--pw-amber)]", MONO_SNIPPET)}>{status.error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={chip} disabled={busy}
            onClick={() => run({ kind: "sync" }, () => instanceSettingsApi.syncPiCli({ direction: "both" }))}>
            {isPending("sync") ? "동기화 중…" : "Pi CLI ↔ 웹 설정 동기화"}</button>
          <button type="button" className={chip} disabled={busy || !status?.installed}
            onClick={() => run({ kind: "models", runtimeId: "pi" }, () => instanceSettingsApi.updatePiCli({ runtimeId: "pi", target: "models" }))}>
            {isPending("models", "pi") ? "모델 업데이트 중…" : "모델 카탈로그 새로고침 (pi update --models)"}</button>
          <button type="button" className={chip} disabled={busy || !status?.installed}
            onClick={() => run({ kind: "self", runtimeId: "pi" }, () => instanceSettingsApi.updatePiCli({ runtimeId: "pi", target: "self" }))}>
            {isPending("self", "pi") ? "CLI 업데이트 중…" : "CLI 버전 업데이트 (pi update --self)"}</button>
          <button type="button" className={chip} disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}>상태 새로고침</button>
        </div>
        {mutation.data && (
          <p role="status" className={cn("mt-3 text-xs", MONO_SNIPPET, mutation.data.ok ? "text-[var(--pw-lime)]" : "text-destructive")}>
            {mutation.data.message}
          </p>
        )}
        {mutation.error && (
          <p role="alert" className={cn("mt-3 text-xs text-destructive", MONO_SNIPPET)}>
            {mutation.error instanceof Error ? mutation.error.message : "CLI 런타임 작업에 실패했습니다."}
          </p>
        )}

        {runtimes.length > 0 && (
          <>
            <h3 className={cn("mt-5", cockpitSectionHeader)}>Installed Coding Agent CLIs</h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {runtimes.map((rt) => {
                const modelsPending = isPending("models", rt.id);
                const selfPending = isPending("self", rt.id);
                const checkPending = checkPendingId === rt.id;
                const canSelfUpdate = rt.installed && rt.supportsSelfUpdate;
                return (
                <li key={rt.id} className={cn("grid gap-1.5 px-3 py-2.5", cockpitInset)}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{rt.name}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs tabular-nums", rt.installed ? PILL_OK : PILL_NEUTRAL)}>
                      {rt.installed ? piCliVersionLabel(rt.version) : "미설치"}
                    </span>
                    {rt.updateAvailable && <span className={PILL_WARN}>업데이트 가능</span>}
                    {canSelfUpdate && !rt.updateAvailable && rt.latestVersion && <span className={PILL_OK}>최신 버전</span>}
                    <span className={cn("rounded-full px-2 py-0.5 text-xs", rt.authConfigured ? PILL_OK : PILL_WARN)}>{rt.authConfigured ? "인증됨" : "미인증"}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{`모델 ${rt.modelCount}개`}</span>
                  </div>
                  <p className={cn("text-xs text-muted-foreground", MONO_SNIPPET)}>
                    {rt.executablePath ?? rt.adapterType}{rt.authSource ? ` · ${rt.authSource}` : ""}
                  </p>
                  {rt.updateAvailable && rt.latestVersion && (
                    <p className={cn("text-xs text-[var(--pw-amber)]", MONO_SNIPPET)}>{`${piCliVersionLabel(rt.version)} → v${rt.latestVersion}`}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={busy}
                      onClick={() => run({ kind: "models", runtimeId: rt.id }, () => instanceSettingsApi.updatePiCli({ runtimeId: rt.id, target: "models" }))}>
                      {modelsPending ? "새로고침 중…" : "모델 새로고침"}</button>
                    {canSelfUpdate && rt.updateAvailable && (
                      <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={busy}
                        onClick={() => run({ kind: "self", runtimeId: rt.id }, () => instanceSettingsApi.updatePiCli({ runtimeId: rt.id, target: "self" }))}>
                        {selfPending ? "업데이트 중…" : "CLI 업데이트"}</button>
                    )}
                    {canSelfUpdate && !rt.updateAvailable && (
                      <button type="button" className={cn(chip, "px-2 py-0.5 text-muted-foreground")}
                        disabled={checkPending || statusQuery.isFetching} onClick={() => runUpdateCheck(rt.id)}>
                        {checkPending ? "확인 중…" : "업데이트 확인"}</button>
                    )}
                  </div>
                  {modelsPending && <p role="status" className="text-xs text-muted-foreground">모델 목록 새로고침 중…</p>}
                </li>
                );
              })}
            </ul>
          </>
        )}

        <h3 className={cn("mt-5", cockpitSectionHeader)}>Live Pi Model Catalog</h3>
        <Input aria-label="pi 모델 카탈로그 검색" placeholder="모델 검색..." value={modelFilter}
          onChange={(event) => setModelFilter(event.target.value)} className={cn(INPUT, "mt-2 max-w-sm")} />
        <div className={cn("mt-2 max-h-48 overflow-y-auto", cockpitInset)}>
          {filteredModels.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {catalogModels.length === 0 ? "카탈로그가 비어 있습니다." : "검색 결과가 없습니다."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--pw-hairline)]">
              {filteredModels.map((ref) => (
                <li key={ref} className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent">
                  <span className={cn("min-w-0 flex-1 text-xs text-foreground", MONO_SNIPPET)}>{ref}</span>
                  <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")}
                    onClick={() => copyModelRef(ref)}>복사</button>
                  <button type="button" className={cn(chip, "px-2 py-0.5 text-xs")} disabled={!canApplyModel}
                    onClick={() => onApplyModel(ref)}>적용</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
