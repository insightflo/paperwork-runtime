import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Work" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your work." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = (issues ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  return (
    <div className="space-y-4 tabular-nums">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/80 bg-card/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            My Work Queue
          </span>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            Unassigned active work items
          </span>
        </div>
        <div className="flex shrink-0 items-baseline gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Open
          </span>
          <span className="font-mono text-lg font-semibold leading-none text-foreground tabular-nums">
            {myIssues.length}
          </span>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No work items assigned to you." />
      )}

      {myIssues.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border/80 bg-card/60 tabular-nums">
          {myIssues.map((issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issue.title}
              to={`/issues/${issue.identifier ?? issue.id}`}
              leading={
                <>
                  <PriorityIcon priority={issue.priority} />
                  <StatusIcon status={issue.status} />
                </>
              }
              trailing={
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(issue.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
