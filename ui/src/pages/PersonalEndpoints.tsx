import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { endpointBotsApi, type EndpointAuditEventRecord, type EndpointBotRecord } from "../api/endpointBots";
import { useCompany } from "../context/CompanyContext";
import { EndpointAuditFeed, type EndpointAuditItem } from "../components/EndpointAuditFeed";
import { EndpointBotPairingCard } from "../components/EndpointBotPairingCard";
import { EndpointBotStatusList, type EndpointBotSummary } from "../components/EndpointBotStatusList";
import { EndpointLocalTaskCard, type EndpointLocalTaskInput } from "../components/EndpointLocalTaskCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";

const DEFAULT_BOT_NAME = "my-bot";
const DEFAULT_FOLDER = "~/Projects";

const CARD_SURFACE =
  "tactile-card rounded-xl border border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.7)]";
const EMBEDDED_CARD_RESET =
  "[&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0 [&>section]:shadow-none";
const ENDPOINT_CARD_OVERRIDES =
  "[&_li.space-y-4]:rounded-xl [&_li.space-y-4]:border-slate-200/90 [&_li.space-y-4]:bg-white [&_li.space-y-4]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] [&_li.space-y-4]:tabular-nums " +
  "dark:[&_li.space-y-4]:border-white/[0.08] dark:[&_li.space-y-4]:bg-[#0e131d] dark:[&_li.space-y-4]:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_36px_-18px_rgba(0,0,0,0.7)] " +
  "[&_input]:border-slate-200/90 [&_input]:bg-white [&_input]:text-slate-900 [&_input]:placeholder:text-slate-400 dark:[&_input]:border-white/[0.1] dark:[&_input]:bg-[#090c12] dark:[&_input]:text-[#eef2f8] dark:[&_input]:placeholder:text-[#627089] " +
  "[&_select]:border-slate-200/90 [&_select]:bg-white [&_select]:text-slate-900 dark:[&_select]:border-white/[0.1] dark:[&_select]:bg-[#090c12] dark:[&_select]:text-[#eef2f8] " +
  "[&_pre]:border [&_pre]:border-slate-200/90 [&_pre]:bg-slate-50/85 [&_pre]:shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:[&_pre]:border-white/[0.07] dark:[&_pre]:bg-[#090c12] dark:[&_pre]:shadow-none " +
  "[&_.border-dashed]:rounded-xl [&_.border-dashed]:border-slate-300/90 [&_.border-dashed]:bg-white/70 dark:[&_.border-dashed]:border-white/[0.12] dark:[&_.border-dashed]:bg-white/[0.03]";
const inputClass =
  "h-9 rounded-lg border border-slate-200/90 bg-white px-3 text-sm text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const buttonClass =
  "inline-flex h-9 items-center rounded-lg border border-blue-600/20 bg-blue-600 px-3 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors hover:bg-blue-500 disabled:opacity-50 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";

/** Map an API endpoint-bot record to the display-only summary the status list expects. */
function toSummary(record: EndpointBotRecord): EndpointBotSummary {
  return {
    deviceId: record.deviceId,
    botName: record.botName,
    os: record.os,
    arch: record.arch,
    online: record.online,
    lastSeenAt: new Date(record.lastSeenMs).toISOString(),
    detectedClis: record.detectedClis.map((cli) => (typeof cli === "string" ? cli : cli.id)),
    allowedFolders: record.allowedFolders.map((grant) => ({ path: grant.path, mode: grant.mode })),
    pendingOutboxCount: record.pendingOutboxCount,
  };
}

function isAuditKind(kind: string): kind is EndpointAuditItem["kind"] {
  return kind === "read_file" || kind === "write_file" || kind === "list_dir" || kind === "shell_exec";
}

function toAuditItems(records: EndpointAuditEventRecord[]): EndpointAuditItem[] {
  return records.flatMap((record) => {
    if (!isAuditKind(record.kind)) return [];
    return [{
      id: record.id,
      botName: record.botName,
      kind: record.kind,
      targetPath: record.targetPath,
      outcome: record.outcome,
      summary: record.summary,
      createdAt: new Date(record.createdAtMs).toISOString(),
    }];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PersonalEndpointsProps {
  /** Optional company id override; defaults to the board-selected company. */
  companyId?: string;
}

export function PersonalEndpoints({ companyId: companyIdProp }: PersonalEndpointsProps) {
  const { selectedCompanyId } = useCompany();
  const companyId = companyIdProp ?? selectedCompanyId;
  const [botName, setBotName] = useState(DEFAULT_BOT_NAME);
  const [folderPath, setFolderPath] = useState(DEFAULT_FOLDER);
  const [folderMode, setFolderMode] = useState<"ro" | "rw">("ro");
  const queryClient = useQueryClient();

  const endpointsQuery = useQuery({
    queryKey: ["endpoint-bots", companyId],
    queryFn: () => endpointBotsApi.list(companyId!),
    enabled: !!companyId,
  });

  const auditQueryKey = ["endpoint-bot-audit", companyId] as const;
  const auditQuery = useQuery({
    queryKey: [...auditQueryKey, { limit: 20 }],
    queryFn: () => endpointBotsApi.listAudit(companyId!, { limit: 20 }),
    enabled: !!companyId,
  });

  const pairingMutation = useMutation({
    mutationFn: () =>
      endpointBotsApi.issuePairingCode(companyId!, {
        botName: botName.trim() || DEFAULT_BOT_NAME,
        requestedFolders: [{ path: folderPath.trim() || DEFAULT_FOLDER, mode: folderMode }],
      }),
  });

  /** Dispatch a local task to the chosen endpoint bot; the card renders the returned task id. */
  const dispatchLocalTask = (deviceId: string, input: EndpointLocalTaskInput) => {
    if (!companyId) return Promise.reject(new Error("먼저 회사를 선택하세요."));
    return endpointBotsApi.enqueueTask(companyId, deviceId, input).finally(() => {
      void queryClient.invalidateQueries({ queryKey: auditQueryKey });
    });
  };

  const endpointCount = endpointsQuery.data?.length ?? 0;
  const onlineCount = endpointsQuery.data?.filter((record) => record.online).length ?? 0;
  const auditCount = auditQuery.data?.stats.total ?? 0;

  return (
    <div className={cn("mx-auto w-full max-w-4xl space-y-4 px-4 py-6 tabular-nums sm:px-6", ENDPOINT_CARD_OVERRIDES)}>
      <div className={cn("cockpit-strip h-8 w-full gap-0 overflow-hidden px-0", CARD_SURFACE)} role="group" aria-label="개인 단말 봇 요약">
        <span className="cockpit-cell min-w-0 flex-1 justify-center text-[11px] text-slate-500 dark:text-[#8b97ad]">
          <span className="truncate uppercase tracking-wide">Endpoint cockpit</span>
        </span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center text-[11px] text-slate-500 dark:text-[#8b97ad]">
          Connected <b className="ml-1 font-mono text-slate-950 dark:text-[#eef2f8]">{endpointCount}</b>
        </span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center text-[11px] text-slate-500 dark:text-[#8b97ad]">
          Online <b className="ml-1 font-mono text-slate-950 dark:text-[#eef2f8]">{onlineCount}</b>
        </span>
        <span className="cockpit-cell min-w-0 flex-1 justify-center text-[11px] text-slate-500 dark:text-[#8b97ad]">
          Audit <b className="ml-1 font-mono text-slate-950 dark:text-[#eef2f8]">{auditCount}</b>
        </span>
      </div>

      <header className="space-y-1 px-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Local execution</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-[#eef2f8]">개인 단말 봇 · 로컬 실행기</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 dark:text-[#8b97ad]">
          내 컴퓨터에서 직접 도는 개인 단말 봇을 설치하고, 페어링 코드를 발급받아 연결 상태를 확인하세요.
        </p>
      </header>

      <div className={cn(CARD_SURFACE, EMBEDDED_CARD_RESET, "p-4 sm:p-5")}>
        <EndpointBotPairingCard />
      </div>

      <section aria-label="페어링 코드 발급" className={cn(CARD_SURFACE, "space-y-4 p-4 text-slate-950 dark:text-[#eef2f8] sm:p-5")}>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Pairing</p>
          <h2 className="mt-1 text-base font-semibold">페어링 코드 발급</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-[#8b97ad]">
            설치한 봇이 서버에 등록할 때 쓰는 일회용 코드입니다.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-[#8b97ad]">
            봇 이름
            <input
              aria-label="페어링 봇 이름"
              value={botName}
              onChange={(event) => setBotName(event.target.value)}
              className={cn(inputClass, "font-medium normal-case tracking-normal")}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-[#8b97ad]">
            허용 폴더
            <input
              aria-label="페어링 허용 폴더"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              className={cn(inputClass, "font-medium normal-case tracking-normal")}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-[#8b97ad]">
            폴더 권한
            <select
              aria-label="페어링 폴더 권한"
              value={folderMode}
              onChange={(event) => setFolderMode(event.target.value === "rw" ? "rw" : "ro")}
              className={cn(inputClass, "font-medium normal-case tracking-normal")}
            >
              <option value="ro">읽기 전용</option>
              <option value="rw">읽기·쓰기</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200/70 pt-4 dark:border-white/[0.07]">
          <button
            type="button"
            onClick={() => pairingMutation.mutate()}
            disabled={pairingMutation.isPending}
            className={buttonClass}
          >
            {pairingMutation.isPending ? "발급 중…" : "6자리 페어링 코드 발급"}
          </button>
          <div aria-live="polite" aria-atomic="true">
            {pairingMutation.data && (
              <div data-pairing-code className="flex flex-wrap items-baseline gap-2 tabular-nums">
                <code className="text-2xl font-bold tracking-[0.3em] text-slate-950 dark:text-[#eef2f8]">{pairingMutation.data.code}</code>
                <span className="text-xs text-slate-500 dark:text-[#8b97ad]">
                  <time dateTime={new Date(pairingMutation.data.expiresAtMs).toISOString()}>
                    {new Date(pairingMutation.data.expiresAtMs).toLocaleString("ko-KR")}
                  </time>{" "}
                  까지 사용 가능
                </span>
              </div>
            )}
          </div>
        </div>

        {pairingMutation.error && (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            페어링 코드 발급에 실패했습니다: {errorMessage(pairingMutation.error)}
          </p>
        )}
      </section>

      <section aria-label="연결된 단말 봇" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Endpoint health</p>
            <h2 className="mt-1 text-base font-semibold text-slate-950 dark:text-[#eef2f8]">연결 상태</h2>
          </div>
          <span className="text-xs tabular-nums text-slate-500 dark:text-[#8b97ad]">
            <b className="font-mono text-slate-950 dark:text-[#eef2f8]">{onlineCount}</b>/{endpointCount} online
          </span>
        </div>
        {endpointsQuery.isLoading && <div role="status" aria-live="polite" aria-label="단말 봇 불러오는 중"><PageSkeleton /></div>}
        {endpointsQuery.error && (
          <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            단말 봇 목록을 불러오지 못했습니다: {errorMessage(endpointsQuery.error)}
          </p>
        )}
        {endpointsQuery.data && <EndpointBotStatusList endpoints={endpointsQuery.data.map(toSummary)} />}
        {endpointsQuery.data && (
          <div className={cn(CARD_SURFACE, EMBEDDED_CARD_RESET, "p-4 sm:p-5")}>
            <EndpointLocalTaskCard
              endpoints={endpointsQuery.data.map((record) => ({
                deviceId: record.deviceId,
                botName: record.botName,
                online: record.online,
              }))}
              onDispatch={dispatchLocalTask}
            />
          </div>
        )}
      </section>
      <section aria-label="최근 로컬 작업 기록" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Local execution audit</p>
            <h2 className="mt-1 text-base font-semibold text-slate-950 dark:text-[#eef2f8]">최근 로컬 작업 기록</h2>
          </div>
          <span className="text-xs tabular-nums text-slate-500 dark:text-[#8b97ad]">
            <b className="font-mono text-slate-950 dark:text-[#eef2f8]">{auditCount}</b> events
          </span>
        </div>
        {auditQuery.isLoading && <p role="status" aria-live="polite" className="text-sm text-slate-500 dark:text-[#8b97ad]">기록을 불러오는 중…</p>}
        {auditQuery.error && (
          <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-300">
            로컬 작업 기록을 불러오지 못했습니다: {errorMessage(auditQuery.error)}
          </p>
        )}
        {auditQuery.data && <EndpointAuditFeed items={toAuditItems(auditQuery.data.items)} className={cn(CARD_SURFACE, "overflow-hidden tabular-nums")} />}
      </section>
    </div>
  );
}
