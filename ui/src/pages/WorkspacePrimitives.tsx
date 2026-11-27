import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentOpenWaitsBanner, type AgentOpenWaitItem } from "../components/AgentOpenWaitsBanner";
import { AgentSharedTablesPanel } from "../components/AgentSharedTablesPanel";
import { Skeleton } from "../components/ui/skeleton";
import { workspacePrimitivesApi } from "../api/workspacePrimitives";
import { useCompany } from "../context/CompanyContext";

const waitsKey = (companyId: string) => ["workspace-primitives", companyId, "open-waits"] as const;
const tablesKey = (companyId: string) => ["workspace-primitives", companyId, "shared-tables"] as const;

function isoDate(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function mapWait(wait: Awaited<ReturnType<typeof workspacePrimitivesApi.listOpenWaits>>[number]): AgentOpenWaitItem {
  return {
    id: wait.id,
    kind: "pending-question",
    summary: wait.note,
    createdAt: isoDate(wait.createdAtMs),
    expiresAt: wait.expiresAtMs == null ? undefined : isoDate(wait.expiresAtMs),
    targetLabel: wait.agentId,
  };
}

export function WorkspacePrimitives() {
  const { selectedCompanyId: companyId } = useCompany();
  const queryClient = useQueryClient();
  const waitsQuery = useQuery({
    queryKey: companyId ? waitsKey(companyId) : ["workspace-primitives", null, "open-waits"],
    queryFn: () => workspacePrimitivesApi.listOpenWaits(companyId!),
    enabled: Boolean(companyId),
    retry: false,
  });
  const tablesQuery = useQuery({
    queryKey: companyId ? tablesKey(companyId) : ["workspace-primitives", null, "shared-tables"],
    queryFn: () => workspacePrimitivesApi.listSharedTables(companyId!),
    enabled: Boolean(companyId),
    retry: false,
  });
  const resolveMutation = useMutation({
    mutationFn: ({ companyId: id, waitId }: { companyId: string; waitId: string }) =>
      workspacePrimitivesApi.resolveOpenWait(id, waitId),
    onSuccess: (_result, variables) => queryClient.invalidateQueries({ queryKey: waitsKey(variables.companyId) }),
  });
  const createMutation = useMutation({
    mutationFn: ({ companyId: id, input }: {
      companyId: string;
      input: { name: string; columns: { name: string; type: "string" }[] };
    }) => workspacePrimitivesApi.createSharedTable(id, input),
    onSuccess: (_result, variables) => queryClient.invalidateQueries({ queryKey: tablesKey(variables.companyId) }),
  });

  async function resolveWait(waitId: string) {
    if (!companyId) return;
    try {
      await resolveMutation.mutateAsync({ companyId, waitId });
    } catch {
      // The mutation state below supplies a localized alert; keep the banner callback handled.
    }
  }

  async function createTable(input: { name: string; columns: string[] }) {
    if (!companyId) return;
    await createMutation.mutateAsync({
      companyId,
      input: { name: input.name, columns: input.columns.map((name) => ({ name, type: "string" })) },
    });
  }

  const loading = Boolean(companyId) && (waitsQuery.isLoading || tablesQuery.isLoading);
  const waits = (waitsQuery.data ?? []).map(mapWait);
  const tables = (tablesQuery.data ?? []).map((table) => ({
    id: table.id,
    name: table.name,
    columns: table.columns.map((column) => column.name),
    rows: [],
    updatedAt: table.updatedAt,
  }));
  const resolvingId = resolveMutation.isPending && resolveMutation.variables?.companyId === companyId
    ? resolveMutation.variables.waitId
    : null;

  return (
    <main className="space-y-5 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">작업 공간 · 공유 표 &amp; 대기 요청</h1>
        <p className="text-sm text-muted-foreground">요청 상태와 에이전트가 함께 쓰는 표를 확인합니다.</p>
      </header>
      {!companyId ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          회사를 선택하면 작업 공간을 볼 수 있습니다.
        </p>
      ) : (
        <>
          {waitsQuery.isError && <p role="alert" className="text-sm text-destructive">대기 요청을 불러오지 못했습니다. 다시 시도해 주세요.</p>}
          {tablesQuery.isError && <p role="alert" className="text-sm text-destructive">공유 표를 불러오지 못했습니다. 다시 시도해 주세요.</p>}
          {resolveMutation.isError && resolveMutation.variables?.companyId === companyId && (
            <p role="alert" className="text-sm text-destructive">대기 요청을 해결하지 못했습니다. 다시 시도해 주세요.</p>
          )}
          {loading ? (
            <div role="status" aria-label="작업 공간 불러오는 중" className="space-y-4">
              <Skeleton className="h-24 w-full" /><Skeleton className="h-56 w-full" />
            </div>
          ) : (
            <>
              <AgentOpenWaitsBanner waits={waits} onResolve={resolveWait} resolvingId={resolvingId} />
              <AgentSharedTablesPanel tables={tables} onCreateTable={createTable} creating={createMutation.isPending} />
            </>
          )}
        </>
      )}
    </main>
  );
}
