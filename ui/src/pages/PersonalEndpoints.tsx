import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { endpointBotsApi, type EndpointAuditEventRecord, type EndpointBotRecord } from "../api/endpointBots";
import { useCompany } from "../context/CompanyContext";
import { EndpointAuditFeed, type EndpointAuditItem } from "../components/EndpointAuditFeed";
import { EndpointBotPairingCard } from "../components/EndpointBotPairingCard";
import { EndpointBotStatusList, type EndpointBotSummary } from "../components/EndpointBotStatusList";
import { EndpointLocalTaskCard, type EndpointLocalTaskInput } from "../components/EndpointLocalTaskCard";
import { PageSkeleton } from "../components/PageSkeleton";

const DEFAULT_BOT_NAME = "my-bot";
const DEFAULT_FOLDER = "~/Projects";

const inputClass = "h-9 rounded-md border border-border bg-background px-3 text-foreground";
const buttonClass =
  "inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

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

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">개인 단말 봇 · 로컬 실행기</h1>
        <p className="text-sm text-muted-foreground">
          내 컴퓨터에서 직접 도는 개인 단말 봇을 설치하고, 페어링 코드를 발급받아 연결 상태를 확인하세요.
        </p>
      </header>

      <EndpointBotPairingCard />

      <section aria-label="페어링 코드 발급" className="space-y-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-sm">
        <h2 className="text-base font-semibold">페어링 코드 발급</h2>
        <p className="text-sm text-muted-foreground">
          설치한 봇이 서버에 등록할 때 쓰는 일회용 코드입니다.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm font-medium">
            봇 이름
            <input
              aria-label="페어링 봇 이름"
              value={botName}
              onChange={(event) => setBotName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            허용 폴더
            <input
              aria-label="페어링 허용 폴더"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            폴더 권한
            <select
              aria-label="페어링 폴더 권한"
              value={folderMode}
              onChange={(event) => setFolderMode(event.target.value === "rw" ? "rw" : "ro")}
              className={inputClass}
            >
              <option value="ro">읽기 전용</option>
              <option value="rw">읽기·쓰기</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
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
              <div data-pairing-code className="flex flex-wrap items-baseline gap-2">
                <code className="text-2xl font-bold tracking-[0.3em]">{pairingMutation.data.code}</code>
                <span className="text-xs text-muted-foreground">
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
          <p role="alert" className="text-sm text-destructive">
            페어링 코드 발급에 실패했습니다: {errorMessage(pairingMutation.error)}
          </p>
        )}
      </section>

      <section aria-label="연결된 단말 봇" className="space-y-3">
        <h2 className="text-base font-semibold">연결 상태</h2>
        {endpointsQuery.isLoading && <div role="status" aria-live="polite" aria-label="단말 봇 불러오는 중"><PageSkeleton /></div>}
        {endpointsQuery.error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            단말 봇 목록을 불러오지 못했습니다: {errorMessage(endpointsQuery.error)}
          </p>
        )}
        {endpointsQuery.data && <EndpointBotStatusList endpoints={endpointsQuery.data.map(toSummary)} />}
        {endpointsQuery.data && (
          <EndpointLocalTaskCard
            endpoints={endpointsQuery.data.map((record) => ({
              deviceId: record.deviceId,
              botName: record.botName,
              online: record.online,
            }))}
            onDispatch={dispatchLocalTask}
          />
        )}
      </section>
      <section aria-label="최근 로컬 작업 기록" className="space-y-3">
        <h2 className="text-base font-semibold">최근 로컬 작업 기록</h2>
        {auditQuery.isLoading && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">기록을 불러오는 중…</p>}
        {auditQuery.error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            로컬 작업 기록을 불러오지 못했습니다: {errorMessage(auditQuery.error)}
          </p>
        )}
        {auditQuery.data && <EndpointAuditFeed items={toAuditItems(auditQuery.data.items)} />}
      </section>
    </div>
  );
}
