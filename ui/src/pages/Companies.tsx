import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents, relativeTime } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Calendar, Check, CircleDot, DollarSign, MoreHorizontal, Pencil, Plus, Trash2, Users, X } from "lucide-react";

// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const CARD = "rounded-md border border-[#242d3f] bg-[#151b28] transition-colors";
const CARD_SELECTED = "border-[#5f8dff]/50 bg-[#111622] shadow-[inset_2px_0_0_#5f8dff]";
const CARD_IDLE = "hover:bg-[#1a2131]";
const ICON = "h-3.5 w-3.5 shrink-0 text-[#8b97ad]";
const STAT = "flex min-w-0 items-center gap-1.5 text-xs text-[#8b97ad]";
const CELL = "cockpit-cell min-w-0 flex-1 justify-center";
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium";
const STATUS_PILL: Record<string, string> = {
  active: "bg-[#34d399]/15 text-[#34d399]",
  paused: "bg-[#fbbf24]/15 text-[#fbbf24]",
};
const PILL_IDLE = "bg-[#0b0e14] text-[#8b97ad] shadow-[inset_0_0_0_1px_#242d3f]";
const HOVER_ICON = "text-[#8b97ad] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";
const PRIMARY_CTA = "h-7 shrink-0 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]";

export function Companies() {
  const { companies, selectedCompanyId, setSelectedCompanyId, loading, error } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
  });

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const editMutation = useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) => companiesApi.update(id, { name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companiesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      setConfirmDeleteId(null);
    },
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Companies" }]);
  }, [setBreadcrumbs]);

  function startEdit(companyId: string, currentName: string) {
    setEditingId(companyId);
    setEditName(currentName);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    editMutation.mutate({ id: editingId, newName: editName.trim() });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
  }

  const activeCount = companies.filter((company) => company.status === "active").length;
  const pausedCount = companies.filter((company) => company.status === "paused").length;
  const totalAgents = companies.reduce((sum, company) => sum + (stats?.[company.id]?.agentCount ?? 0), 0);
  const totalIssues = companies.reduce((sum, company) => sum + (stats?.[company.id]?.issueCount ?? 0), 0);
  const totalSpent = companies.reduce((sum, company) => sum + company.spentMonthlyCents, 0);
  const budgeted = companies.filter((company) => company.budgetMonthlyCents > 0);
  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);

  return (
    <div className="space-y-2 tabular-nums">
      {/* 1-row cockpit strip: roster, status and spend totals (selects the company when a name is shown) */}
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Companies summary">
        <div className={CELL}><span className="truncate uppercase tracking-wide">Active</span><b className="ml-1 text-[#34d399]">{activeCount}</b></div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">Paused</span><b className="ml-1 text-[#fbbf24]">{pausedCount}</b></div>
        <div className={CELL}><Users className="h-3 w-3 text-[#5f8dff]" aria-hidden /><span className="truncate uppercase tracking-wide">Agents</span><b className="ml-1">{stats ? totalAgents : "—"}</b></div>
        <div className={CELL}><CircleDot className="h-3 w-3 text-[#5f8dff]" aria-hidden /><span className="truncate uppercase tracking-wide">Work items</span><b className="ml-1">{stats ? totalIssues : "—"}</b></div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">Monthly spend</span><b className="ml-1 font-mono">{formatCents(totalSpent)}</b></div>
        <div className={cn(CELL, "shrink-0")}><span className="truncate uppercase tracking-wide">Budgeted</span><b className="ml-1">{budgeted.length}</b><span className="truncate">/ {companies.length}</span></div>
        <div className={cn(CELL, "max-w-[14rem] shrink-[2]")}><span className="truncate uppercase tracking-wide">Selected</span><b className="ml-1 truncate font-mono">{selectedCompany?.name ?? "—"}</b></div>
      </div>

      {/* Tight 40px toolbar: section title · count · primary action */}
      <div className="cockpit-toolbar h-10 w-full rounded-md border border-[#242d3f] bg-[#111622] px-3">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]">Companies</h2>
        <span className="font-mono text-sm font-semibold text-[#e6edf7]">{companies.length}</span>
        <Button size="sm" variant="outline" onClick={() => openOnboarding()} className={cn(PRIMARY_CTA, "ml-auto")}>
          <Plus className="h-3.5 w-3.5" />
          New Company
        </Button>
      </div>

      <div className="h-6 text-xs">
        {loading && <p className="text-[#8b97ad]">Loading companies...</p>}
        {error && <p className="text-destructive">{error.message}</p>}
      </div>

      <div className="grid gap-2">
        {companies.map((company) => {
          const selected = company.id === selectedCompanyId;
          const isEditing = editingId === company.id;
          const isConfirmingDelete = confirmDeleteId === company.id;
          const companyStats = stats?.[company.id];
          const agentCount = companyStats?.agentCount ?? 0;
          const issueCount = companyStats?.issueCount ?? 0;
          const budgetPct = company.budgetMonthlyCents > 0
            ? Math.round((company.spentMonthlyCents / company.budgetMonthlyCents) * 100) : 0;

          return (
            <div
              key={company.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => setSelectedCompanyId(company.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedCompanyId(company.id);
                }
              }}
              className={cn(
                "group cursor-pointer text-left outline-none focus-visible:ring-1 focus-visible:ring-[#5f8dff]",
                CARD,
                selected ? CARD_SELECTED : CARD_IDLE,
              )}
            >
              {/* Header row: name + menu */}
              <div className="flex items-start justify-between gap-3 px-4 pt-3">
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <div
                      className="flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        aria-label="Company name"
                        className="h-7 w-64 max-w-full border-[#242d3f] bg-[#0b0e14] text-sm text-[#e6edf7]"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={saveEdit}
                        disabled={editMutation.isPending}
                        aria-label="Save company name"
                      >
                        <Check className="h-3.5 w-3.5 text-[#34d399]" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={cancelEdit} aria-label="Cancel rename">
                        <X className="h-3.5 w-3.5 text-[#8b97ad]" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="min-w-0 truncate text-sm font-semibold text-[#e6edf7]">{company.name}</h3>
                      <span className={cn(PILL, STATUS_PILL[company.status] ?? PILL_IDLE)}>
                        {company.status}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={HOVER_ICON}
                        aria-label={`Rename ${company.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(company.id, company.name);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                  {company.description && !isEditing && (
                    <p className="mt-1 line-clamp-2 text-xs text-[#8b97ad]">{company.description}</p>
                  )}
                </div>

                {/* Three-dot menu */}
                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={HOVER_ICON}
                        aria-label={`Company actions for ${company.name}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => startEdit(company.id, company.name)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setConfirmDeleteId(company.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete Company
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {/* Stats row: hairline track under the name, bold tabular figures */}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-[#242d3f] px-4 py-2">
                <span className={STAT}><Users className={ICON} aria-hidden /><b className="font-semibold text-[#e6edf7]">{agentCount}</b>{agentCount === 1 ? "agent" : "agents"}</span>
                <span className={STAT}><CircleDot className={ICON} aria-hidden /><b className="font-semibold text-[#e6edf7]">{issueCount}</b>{issueCount === 1 ? "work item" : "work items"}</span>
                <span className={STAT}>
                  <DollarSign className={ICON} aria-hidden />
                  <b className="font-mono font-semibold text-[#e6edf7]">{formatCents(company.spentMonthlyCents)}</b>
                  {company.budgetMonthlyCents > 0 ? (
                    <span className="truncate font-mono text-[#8b97ad]">
                      / {formatCents(company.budgetMonthlyCents)} · {budgetPct}%
                    </span>
                  ) : (
                    <span className="truncate">Unlimited budget</span>
                  )}
                </span>
                <span className={cn(STAT, "ml-auto")}><Calendar className={ICON} aria-hidden /><span className="truncate">Created {relativeTime(company.createdAt)}</span></span>
              </div>

              {/* Delete confirmation */}
              {isConfirmingDelete && (
                <div
                  className="mt-3 flex items-center justify-between gap-4 border-t border-[#f87171]/30 bg-[#f87171]/5 px-4 py-2.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="min-w-0 truncate text-xs font-medium text-[#f87171]">
                    Delete this company and all its data? This cannot be undone.
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleteMutation.isPending}
                      className="h-7 border border-[#242d3f] text-xs text-[#e6edf7]"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => deleteMutation.mutate(company.id)}
                      disabled={deleteMutation.isPending}
                      className="h-7 bg-[#f87171] px-2.5 text-xs text-[#0b0e14]"
                    >
                      {deleteMutation.isPending ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
