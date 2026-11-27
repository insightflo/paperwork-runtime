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

// Combo 1 cockpit palette: light slate surfaces, obsidian #0e131d/#090c12 dark surfaces, cobalt/lime/amber signals.
const CARD = "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 transition-colors dark:border-white/[0.08] dark:bg-[#0e131d]";
const CARD_SELECTED = "border-blue-500/60 bg-blue-50/80 shadow-[inset_2px_0_0_#2563eb,inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.05)] dark:border-[#60a5fa]/50 dark:bg-[#111a2a] dark:shadow-[inset_2px_0_0_#60a5fa,inset_0_1px_0_rgba(255,255,255,0.07),0_10px_28px_rgba(0,0,0,0.36)]";
const CARD_IDLE = "hover:border-slate-300 hover:bg-slate-50/80 dark:hover:border-white/[0.12] dark:hover:bg-[#111a2a]";
const ICON = "h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-[#8b97ad]";
const STAT = "flex min-w-0 items-center gap-1.5 text-xs text-slate-500 dark:text-[#8b97ad]";
const CELL = "cockpit-cell min-w-0 flex-1 justify-center";
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium";
const STATUS_PILL: Record<string, string> = {
  active: "bg-lime-600/10 text-lime-700 dark:bg-[#a3e635]/12 dark:text-[#a3e635]",
  paused: "bg-amber-500/15 text-amber-700 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]",
};
const PILL_IDLE = "bg-slate-100 text-slate-500 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08)] dark:bg-[#090c12] dark:text-[#8b97ad] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]";
const HOVER_ICON = "text-slate-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 dark:text-[#8b97ad]";
const PRIMARY_CTA = "h-7 shrink-0 bg-blue-600 px-2.5 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]";

export function Companies() {
  const { companies, selectedCompanyId, setSelectedCompanyId, loading, error, canAdmin = true } = useCompany();
  // [RBAC] 회사명 수정·삭제는 관리자 이상(canAdmin)만 가능 — Approvals/Agents 목록과 동일 기준.
  const adminRequiredTitle = "Admin or owner role required to manage companies";
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
    if (!canAdmin) return;
    setEditingId(companyId);
    setEditName(currentName);
  }

  function saveEdit() {
    if (!canAdmin) return;
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
    <div className="space-y-3 tabular-nums">
      {/* 1-row cockpit strip: roster, status and spend totals (selects the company when a name is shown) */}
      <div className="cockpit-strip tactile-card w-full gap-0 border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-[#0e131d]" role="group" aria-label="Companies summary">
        <div className={CELL}><span className="truncate uppercase tracking-wide">Active</span><b className="ml-1 font-mono text-lime-700 dark:text-[#a3e635]">{activeCount}</b></div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">Paused</span><b className="ml-1 font-mono text-amber-700 dark:text-[#f59e0b]">{pausedCount}</b></div>
        <div className={CELL}><Users className="h-3 w-3 text-blue-600 dark:text-[#60a5fa]" aria-hidden /><span className="truncate uppercase tracking-wide">Agents</span><b className="ml-1 font-mono">{stats ? totalAgents : "—"}</b></div>
        <div className={CELL}><CircleDot className="h-3 w-3 text-blue-600 dark:text-[#60a5fa]" aria-hidden /><span className="truncate uppercase tracking-wide">Work items</span><b className="ml-1 font-mono">{stats ? totalIssues : "—"}</b></div>
        <div className={CELL}><span className="truncate uppercase tracking-wide">Monthly spend</span><b className="ml-1 font-mono">{formatCents(totalSpent)}</b></div>
        <div className={cn(CELL, "shrink-0")}><span className="truncate uppercase tracking-wide">Budgeted</span><b className="ml-1 font-mono">{budgeted.length}</b><span className="truncate">/ {companies.length}</span></div>
        <div className={cn(CELL, "max-w-[14rem] shrink-[2]")}><span className="truncate uppercase tracking-wide">Selected</span><b className="ml-1 truncate font-mono">{selectedCompany?.name ?? "—"}</b></div>
      </div>

      {/* Tight 40px toolbar: section title · count · primary action */}
      <div className="cockpit-toolbar tactile-card h-10 w-full rounded-[12px] border-slate-200/90 bg-white/95 px-3 dark:border-white/[0.08] dark:bg-[#0e131d]">
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">Companies</h2>
        <span className="font-mono text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">{companies.length}</span>
        <Button size="sm" variant="outline" onClick={() => openOnboarding()} className={cn(PRIMARY_CTA, "ml-auto")}>
          <Plus className="h-3.5 w-3.5" />
          New Company
        </Button>
      </div>

      <div className="h-6 text-xs">
        {loading && <p className="text-slate-500 dark:text-[#8b97ad]">Loading companies...</p>}
        {error && <p className="text-destructive">{error.message}</p>}
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
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
                "group cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:focus-visible:ring-[#60a5fa]/40",
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
                        className="h-7 w-64 max-w-full border-slate-200/90 bg-white text-sm text-slate-900 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb]"
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
                        disabled={!canAdmin || editMutation.isPending}
                        title={!canAdmin ? adminRequiredTitle : undefined}
                        aria-label="Save company name"
                      >
                        <Check className="h-3.5 w-3.5 text-lime-600 dark:text-[#a3e635]" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={cancelEdit} aria-label="Cancel rename">
                        <X className="h-3.5 w-3.5 text-slate-500 dark:text-[#8b97ad]" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">{company.name}</h3>
                      <span className={cn(PILL, STATUS_PILL[company.status] ?? PILL_IDLE)}>
                        {company.status}
                      </span>
                      {canAdmin && (
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
                      )}
                    </div>
                  )}
                  {company.description && !isEditing && (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-[#8b97ad]">{company.description}</p>
                  )}
                </div>

                {/* Three-dot menu: rename/delete are admin-only, so the menu itself hides for viewers. */}
                {canAdmin && (
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
                )}
              </div>

              {/* Stats row: hairline track under the name, bold tabular figures */}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-slate-200/90 px-4 py-2 dark:border-white/[0.08]">
                <span className={STAT}><Users className={ICON} aria-hidden /><b className="font-semibold text-slate-900 dark:text-[#edf2fb]">{agentCount}</b>{agentCount === 1 ? "agent" : "agents"}</span>
                <span className={STAT}><CircleDot className={ICON} aria-hidden /><b className="font-semibold text-slate-900 dark:text-[#edf2fb]">{issueCount}</b>{issueCount === 1 ? "work item" : "work items"}</span>
                <span className={STAT}>
                  <DollarSign className={ICON} aria-hidden />
                  <b className="font-mono font-semibold text-slate-900 dark:text-[#edf2fb]">{formatCents(company.spentMonthlyCents)}</b>
                  {company.budgetMonthlyCents > 0 ? (
                    <span className="truncate font-mono text-slate-500 dark:text-[#8b97ad]">
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
                  className="mt-3 flex items-center justify-between gap-4 border-t border-rose-500/25 bg-rose-500/5 px-4 py-2.5 dark:border-[#f87171]/30 dark:bg-[#f87171]/5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="min-w-0 truncate text-xs font-medium text-rose-700 dark:text-[#f87171]">
                    Delete this company and all its data? This cannot be undone.
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleteMutation.isPending}
                      className="h-7 border border-slate-200/90 text-xs text-slate-900 dark:border-white/[0.09] dark:text-[#edf2fb]"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => { if (!canAdmin) return; deleteMutation.mutate(company.id); }}
                      disabled={!canAdmin || deleteMutation.isPending}
                      title={!canAdmin ? adminRequiredTitle : undefined}
                      className="h-7 bg-rose-600 px-2.5 text-xs text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#f87171] dark:text-[#090c12] dark:hover:bg-[#fca5a5]"
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
