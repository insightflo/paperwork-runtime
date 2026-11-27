import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export interface EndpointBotSummary {
  deviceId: string;
  botName: string;
  os: string;
  arch: string;
  online: boolean;
  lastSeenAt: string;
  detectedClis: string[];
  allowedFolders: { path: string; mode: "ro" | "rw" }[];
  pendingOutboxCount?: number;
}

interface EndpointBotStatusListProps {
  endpoints: EndpointBotSummary[];
  onRevoke?: (deviceId: string) => void | Promise<void>;
  revokingId?: string | null;
}

export function EndpointBotStatusList({
  endpoints,
  onRevoke,
  revokingId,
}: EndpointBotStatusListProps) {
  if (endpoints.length === 0) {
    return (
      <p role="status" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        연결된 개인 단말 봇이 아직 없습니다
      </p>
    );
  }

  return (
    <ul aria-label="개인 단말 봇" className="space-y-3">
      {endpoints.map((endpoint) => {
        const revoking = revokingId === endpoint.deviceId;
        return (
          <li key={endpoint.deviceId} className="space-y-4 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <h3 className="break-words text-sm font-semibold">{endpoint.botName}</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge role="status" variant="outline" className={endpoint.online
                    ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "text-muted-foreground"}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                    {endpoint.online ? "온라인" : "오프라인"}
                  </Badge>
                  <Badge variant="secondary">{endpoint.os} / {endpoint.arch}</Badge>
                  {(endpoint.pendingOutboxCount ?? 0) > 0 && (
                    <Badge variant="outline">전송 대기 {endpoint.pendingOutboxCount}건</Badge>
                  )}
                </div>
              </div>
              {onRevoke && (
                <Button type="button" variant="outline" size="sm"
                  aria-label={`${endpoint.botName} 연결 해제`} aria-busy={revoking}
                  disabled={revoking} onClick={() => onRevoke(endpoint.deviceId)}>
                  {revoking ? "연결 해제 중…" : "연결 해제"}
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">감지된 CLI</p>
              {endpoint.detectedClis.length > 0 ? (
                <ul aria-label="감지된 CLI" className="flex flex-wrap gap-1.5">
                  {endpoint.detectedClis.map((cli, index) => (
                    <li key={`${cli}-${index}`}><Badge variant="secondary">{cli}</Badge></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">감지된 CLI가 없습니다</p>}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">허용된 폴더</p>
              {endpoint.allowedFolders.length > 0 ? (
                <ul aria-label="허용된 폴더" className="space-y-2">
                  {endpoint.allowedFolders.map((folder, index) => (
                    <li key={`${folder.path}-${index}`} className="flex flex-wrap items-center gap-2">
                      <code className="min-w-0 break-all text-xs">{folder.path}</code>
                      <Badge variant="outline">{folder.mode === "ro" ? "읽기 전용" : "읽기·쓰기"}</Badge>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted-foreground">허용된 폴더가 없습니다</p>}
            </div>

            <p className="text-xs text-muted-foreground">
              마지막 연결: <time dateTime={endpoint.lastSeenAt}>
                {new Date(endpoint.lastSeenAt).toLocaleString("ko-KR")}
              </time>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
