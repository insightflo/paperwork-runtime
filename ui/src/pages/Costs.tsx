import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BudgetPolicySummary,
  CostByAgent,
  CostByAgentModel,
  CostByBiller,
  CostByProviderModel,
  CostWindowSpendRow,
  FinanceEvent,
  QuotaWindow,
} from "@paperclipai/shared";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Coins, DollarSign, Lock, ReceiptText } from "lucide-react";
import { budgetsApi } from "../api/budgets";
import { costsApi } from "../api/costs";
import { BillerSpendCard } from "../components/BillerSpendCard";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { EmptyState } from "../components/EmptyState";
import { FinanceBillerCard } from "../components/FinanceBillerCard";
import { FinanceKindCard } from "../components/FinanceKindCard";
import { FinanceTimelineCard } from "../components/FinanceTimelineCard";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProviderQuotaCard } from "../components/ProviderQuotaCard";
import { ProviderOutcomesCard } from "../components/ProviderOutcomesCard";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDateRange, PRESET_KEYS, PRESET_LABELS } from "../hooks/useDateRange";
import { queryKeys } from "../lib/queryKeys";
import { billingTypeDisplayName, cn, formatCents, formatTokens, providerDisplayName } from "../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const NO_COMPANY = "__none__";

function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6, 23, 59, 59, 999);
  return { from: mon.toISOString(), to: sun.toISOString() };
}

function ProviderTabLabel({ provider, rows }: { provider: string; rows: CostByProviderModel[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(provider)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

function BillerTabLabel({ biller, rows }: { biller: string; rows: CostByBiller[] }) {
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.costCents, 0);
  return (
    <span className="flex items-center gap-1.5">
      <span>{providerDisplayName(biller)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTokens(totalTokens)}</span>
      <span className="text-xs text-muted-foreground">{formatCents(totalCost)}</span>
    </span>
  );
}

const TACTILE_CARD_CLASS =
  "tactile-card rounded-xl border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-none dark:bg-card";

function MetricTile({
  label,
  value,
  subtitle,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-xl border border-slate-200/80 bg-slate-50/75 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-white/[0.07] dark:bg-muted/40 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{value}</div>
          <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-[#8b97ad]">{subtitle}</div>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200/90 bg-white dark:border-white/[0.08] dark:bg-card">
          <Icon className="h-4 w-4 text-slate-500 dark:text-[#8b97ad]" />
        </div>
      </div>
    </div>
  );
}

/** One cell of the 1-row cost telemetry strip. Any mini bar/sparkline sits in the header row (shrink-0, right) so it never overlaps value/subtext. */
function TelemetryCell({ label, value, sub, dot, visual }: { label: string; value: string; sub: string; dot: string; visual?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="truncate">{label}</span>
        </span>
        {visual && <span className="shrink-0">{visual}</span>}
      </div>
      <span className="truncate text-xl font-bold leading-tight tabular-nums text-slate-950 dark:text-[#edf2fb]">{value}</span>
      <span className="truncate text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">{sub}</span>
    </div>
  );
}

function MiniBar({ percent, tone = "bg-blue-500 dark:bg-primary" }: { percent: number; tone?: string }) {
  return (
    <span className="block h-1.5 w-16 overflow-hidden rounded-full border border-slate-200/90 bg-slate-100 dark:border-white/[0.08] dark:bg-background">
      <span className={cn("block h-full rounded-full transition-[width] duration-150", tone)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </span>
  );
}

/** Combo 1 tactile cockpit breakdown card with 1px specular top highlight in dark mode and crisp light legibility. */
function CockpitCard({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn(TACTILE_CARD_CLASS, "flex min-w-0 flex-col overflow-hidden")}>
      <header className="flex items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5 dark:border-white/[0.06] dark:bg-muted/40">
        <div className="min-w-0">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-[#8b97ad]">{title}</h2>
          <p className="truncate text-[11px] text-slate-500 dark:text-[#8b97ad]">{description}</p>
        </div>
        {action}
      </header>
      <div className="divide-y divide-slate-200/75 dark:divide-white/[0.06]">{children}</div>
    </section>
  );
}

function FinanceSummaryCard({
  debitCents,
  creditCents,
  netCents,
  estimatedDebitCents,
  eventCount,
}: {
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
}) {
  return (
    <Card className={TACTILE_CARD_CLASS}>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Finance ledger</CardTitle>
        <CardDescription>
          Account-level charges that do not map to a single inference request.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Debits"
          value={formatCents(debitCents)}
          subtitle={`${eventCount} total event${eventCount === 1 ? "" : "s"} in range`}
          icon={ArrowUpRight}
        />
        <MetricTile
          label="Credits"
          value={formatCents(creditCents)}
          subtitle="Refunds, offsets, and credit returns"
          icon={ArrowDownLeft}
        />
        <MetricTile
          label="Net"
          value={formatCents(netCents)}
          subtitle="Debit minus credit for the selected period"
          icon={ReceiptText}
        />
        <MetricTile
          label="Estimated"
          value={formatCents(estimatedDebitCents)}
          subtitle="Estimated debits that are not yet invoice-authoritative"
          icon={Coins}
        />
      </CardContent>
    </Card>
  );
}

export function Costs() {
  const { selectedCompanyId, canAdmin = true, currentRole } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [mainTab, setMainTab] = useState<"overview" | "budgets" | "providers" | "billers" | "finance">("overview");
  const [activeProvider, setActiveProvider] = useState("all");
  const [activeBiller, setActiveBiller] = useState("all");

  const {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    from,
    to,
    customReady,
  } = useDateRange();

  useEffect(() => {
    setBreadcrumbs([{ label: "Costs" }]);
  }, [setBreadcrumbs]);

  const [today, setToday] = useState(() => new Date().toDateString());
  const todayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const schedule = () => {
      const now = new Date();
      const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
      todayTimerRef.current = setTimeout(() => {
        setToday(new Date().toDateString());
        schedule();
      }, ms);
    };
    schedule();
    return () => {
      if (todayTimerRef.current != null) clearTimeout(todayTimerRef.current);
    };
  }, []);

  const weekRange = useMemo(() => currentWeekRange(), [today]);
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const { data: budgetData, isLoading: budgetLoading, error: budgetError } = useQuery({
    queryKey: queryKeys.budgets.overview(companyId),
    queryFn: () => budgetsApi.overview(companyId),
    enabled: !!selectedCompanyId && customReady,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const invalidateBudgetViews = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
  };

  const policyMutation = useMutation({
    mutationFn: (input: {
      scopeType: BudgetPolicySummary["scopeType"];
      scopeId: string;
      amount: number;
      windowKind: BudgetPolicySummary["windowKind"];
    }) =>
      budgetsApi.upsertPolicy(companyId, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        amount: input.amount,
        windowKind: input.windowKind,
      }),
    onSuccess: invalidateBudgetViews,
  });

  const incidentMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, input.incidentId, input),
    onSuccess: invalidateBudgetViews,
  });

  const { data: spendData, isLoading: spendLoading, error: spendError } = useQuery({
    queryKey: queryKeys.costs(companyId, from || undefined, to || undefined),
    queryFn: async () => {
      const [summary, byAgent, byProject, byAgentModel] = await Promise.all([
        costsApi.summary(companyId, from || undefined, to || undefined),
        costsApi.byAgent(companyId, from || undefined, to || undefined),
        costsApi.byProject(companyId, from || undefined, to || undefined),
        costsApi.byAgentModel(companyId, from || undefined, to || undefined),
      ]);
      return { summary, byAgent, byProject, byAgentModel };
    },
    enabled: !!selectedCompanyId && customReady,
  });

  const { data: financeData, isLoading: financeLoading, error: financeError } = useQuery({
    queryKey: [
      queryKeys.financeSummary(companyId, from || undefined, to || undefined),
      queryKeys.financeByBiller(companyId, from || undefined, to || undefined),
      queryKeys.financeByKind(companyId, from || undefined, to || undefined),
      queryKeys.financeEvents(companyId, from || undefined, to || undefined, 18),
    ],
    queryFn: async () => {
      const [summary, byBiller, byKind, events] = await Promise.all([
        costsApi.financeSummary(companyId, from || undefined, to || undefined),
        costsApi.financeByBiller(companyId, from || undefined, to || undefined),
        costsApi.financeByKind(companyId, from || undefined, to || undefined),
        costsApi.financeEvents(companyId, from || undefined, to || undefined, 18),
      ]);
      return { summary, byBiller, byKind, events };
    },
    enabled: !!selectedCompanyId && customReady,
  });

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    setExpandedAgents(new Set());
  }, [companyId, from, to]);

  function toggleAgent(agentId: string) {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const agentModelRows = useMemo(() => {
    const map = new Map<string, CostByAgentModel[]>();
    for (const row of spendData?.byAgentModel ?? []) {
      const rows = map.get(row.agentId) ?? [];
      rows.push(row);
      map.set(row.agentId, rows);
    }
    for (const [agentId, rows] of map) {
      map.set(agentId, rows.slice().sort((a, b) => b.costCents - a.costCents));
    }
    return map;
  }, [spendData?.byAgentModel]);

  const { data: providerData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.byProvider(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: billerData } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.byBiller(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekData } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byProvider(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && (mainTab === "providers" || mainTab === "billers"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: weekBillerData } = useQuery({
    queryKey: queryKeys.usageByBiller(companyId, weekRange.from, weekRange.to),
    queryFn: () => costsApi.byBiller(companyId, weekRange.from, weekRange.to),
    enabled: !!selectedCompanyId && mainTab === "billers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: providerOutcomeData } = useQuery({
    queryKey: queryKeys.providerModelOutcomes(companyId, from || undefined, to || undefined),
    queryFn: () => costsApi.providerModelOutcomes(companyId, from || undefined, to || undefined),
    enabled: !!selectedCompanyId && customReady && mainTab === "providers",
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: windowData } = useQuery({
    queryKey: queryKeys.usageWindowSpend(companyId),
    queryFn: () => costsApi.windowSpend(companyId),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: quotaData, isLoading: quotaLoading } = useQuery({
    queryKey: queryKeys.usageQuotaWindows(companyId),
    queryFn: () => costsApi.quotaWindows(companyId),
    enabled: !!selectedCompanyId && mainTab === "providers",
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  const byProvider = useMemo(() => {
    const map = new Map<string, CostByProviderModel[]>();
    for (const row of providerData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [providerData]);

  const byBiller = useMemo(() => {
    const map = new Map<string, CostByBiller[]>();
    for (const row of billerData ?? []) {
      const rows = map.get(row.biller) ?? [];
      rows.push(row);
      map.set(row.biller, rows);
    }
    return map;
  }, [billerData]);

  const weekSpendByProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekData ?? []) {
      map.set(row.provider, (map.get(row.provider) ?? 0) + row.costCents);
    }
    return map;
  }, [weekData]);

  const weekSpendByBiller = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of weekBillerData ?? []) {
      map.set(row.biller, (map.get(row.biller) ?? 0) + row.costCents);
    }
    return map;
  }, [weekBillerData]);

  const windowSpendByProvider = useMemo(() => {
    const map = new Map<string, CostWindowSpendRow[]>();
    for (const row of windowData ?? []) {
      const rows = map.get(row.provider) ?? [];
      rows.push(row);
      map.set(row.provider, rows);
    }
    return map;
  }, [windowData]);

  const quotaWindowsByProvider = useMemo(() => {
    const map = new Map<string, QuotaWindow[]>();
    for (const result of quotaData ?? []) {
      if (result.ok && result.windows.length > 0) {
        map.set(result.provider, result.windows);
      }
    }
    return map;
  }, [quotaData]);

  const quotaErrorsByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (!result.ok && result.error) map.set(result.provider, result.error);
    }
    return map;
  }, [quotaData]);

  const quotaSourcesByProvider = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of quotaData ?? []) {
      if (typeof result.source === "string" && result.source.length > 0) {
        map.set(result.provider, result.source);
      }
    }
    return map;
  }, [quotaData]);

  const deficitNotchByProvider = useMemo(() => {
    const map = new Map<string, boolean>();
    if (preset !== "mtd") return map;
    const budget = spendData?.summary.budgetCents ?? 0;
    if (budget <= 0) return map;
    const totalSpend = spendData?.summary.spendCents ?? 0;
    const now = new Date();
    const daysElapsed = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (const [providerKey, rows] of byProvider) {
      const providerCostCents = rows.reduce((sum, row) => sum + row.costCents, 0);
      const providerShare = totalSpend > 0 ? providerCostCents / totalSpend : 0;
      const providerBudget = budget * providerShare;
      if (providerBudget <= 0) {
        map.set(providerKey, false);
        continue;
      }
      const burnRate = providerCostCents / Math.max(daysElapsed, 1);
      map.set(providerKey, providerCostCents + burnRate * (daysInMonth - daysElapsed) > providerBudget);
    }
    return map;
  }, [preset, spendData, byProvider]);

  const providers = useMemo(() => Array.from(byProvider.keys()), [byProvider]);
  const billers = useMemo(() => Array.from(byBiller.keys()), [byBiller]);

  const effectiveProvider =
    activeProvider === "all" || providers.includes(activeProvider) ? activeProvider : "all";
  useEffect(() => {
    if (effectiveProvider !== activeProvider) setActiveProvider("all");
  }, [effectiveProvider, activeProvider]);

  const effectiveBiller =
    activeBiller === "all" || billers.includes(activeBiller) ? activeBiller : "all";
  useEffect(() => {
    if (effectiveBiller !== activeBiller) setActiveBiller("all");
  }, [effectiveBiller, activeBiller]);

  const providerTabItems = useMemo(() => {
    const providerKeys = Array.from(byProvider.keys());
    const allTokens = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0) ?? 0),
      0,
    );
    const allCents = providerKeys.reduce(
      (sum, provider) => sum + (byProvider.get(provider)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All providers</span>
            {providerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...providerKeys.map((provider) => ({
        value: provider,
        label: <ProviderTabLabel provider={provider} rows={byProvider.get(provider) ?? []} />,
      })),
    ];
  }, [byProvider]);

  const billerTabItems = useMemo(() => {
    const billerKeys = Array.from(byBiller.keys());
    const allTokens = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + row.inputTokens + row.cachedInputTokens + row.outputTokens, 0) ?? 0),
      0,
    );
    const allCents = billerKeys.reduce(
      (sum, biller) => sum + (byBiller.get(biller)?.reduce((acc, row) => acc + row.costCents, 0) ?? 0),
      0,
    );
    return [
      {
        value: "all",
        label: (
          <span className="flex items-center gap-1.5">
            <span>All billers</span>
            {billerKeys.length > 0 ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">{formatTokens(allTokens)}</span>
                <span className="text-xs text-muted-foreground">{formatCents(allCents)}</span>
              </>
            ) : null}
          </span>
        ),
      },
      ...billerKeys.map((biller) => ({
        value: biller,
        label: <BillerTabLabel biller={biller} rows={byBiller.get(biller) ?? []} />,
      })),
    ];
  }, [byBiller]);

  const inferenceTokenTotal =
    (spendData?.byAgent ?? []).reduce(
      (sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.outputTokens,
      0,
    );

  const spendCents = spendData?.summary.spendCents ?? 0;
  const budgetCents = spendData?.summary.budgetCents ?? 0;
  const utilization = spendData?.summary.utilizationPercent ?? 0;

  // Spend rate: cents per day over the elapsed days of the selected range (unknown for unbounded ranges).
  const rangeDays = useMemo(() => {
    if (!from) return null;
    const start = new Date(from).getTime();
    const end = Math.min(to ? new Date(to).getTime() : Date.now(), Date.now());
    return Math.max(1, Math.ceil((end - start) / 86_400_000));
  }, [from, to]);
  const dailyCents = rangeDays ? spendCents / rangeDays : 0;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projectedMonthCents = dailyCents * daysInMonth;

  // Provider / model totals across all agents, derived from the already-fetched per-agent model rows.
  const modelTotals = useMemo(() => {
    const map = new Map<string, { provider: string; model: string; costCents: number; tokens: number }>();
    for (const row of spendData?.byAgentModel ?? []) {
      const key = `${row.provider}\u0000${row.model}`;
      const entry = map.get(key) ?? { provider: row.provider, model: row.model, costCents: 0, tokens: 0 };
      entry.costCents += row.costCents;
      entry.tokens += row.inputTokens + row.cachedInputTokens + row.outputTokens;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.costCents - a.costCents);
  }, [spendData?.byAgentModel]);

  const topAgent = useMemo(
    () => (spendData?.byAgent ?? []).reduce<CostByAgent | null>((top, row) => (!top || row.costCents > top.costCents ? row : top), null),
    [spendData?.byAgent],
  );

  const topFinanceEvents = (financeData?.events ?? []) as FinanceEvent[];
  const budgetPolicies = budgetData?.policies ?? [];
  const activeBudgetIncidents = budgetData?.activeIncidents ?? [];
  const budgetPoliciesByScope = useMemo(() => ({
    company: budgetPolicies.filter((policy) => policy.scopeType === "company"),
    agent: budgetPolicies.filter((policy) => policy.scopeType === "agent"),
    project: budgetPolicies.filter((policy) => policy.scopeType === "project"),
  }), [budgetPolicies]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view costs." />;
  }

  const showCustomPrompt = preset === "custom" && !customReady;
  const showOverviewLoading = (spendLoading || financeLoading) && customReady;
  const overviewError = spendError ?? financeError;

  return (
    <div className="space-y-3 tabular-nums">
      <div className="space-y-2">
          <div className="cockpit-toolbar tactile-card h-10 w-full rounded-xl border-slate-200/90 bg-white pl-2 pr-1.5 dark:border-white/[0.08] dark:bg-none dark:bg-card">
            <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
              <h1 className="truncate text-sm font-semibold tracking-tight text-slate-950 dark:text-[#eef2f8]">Costs</h1>
              <p className="hidden truncate text-xs text-slate-500 dark:text-[#8b97ad] sm:block">
                Inference spend, platform fees, credits, and live quota windows.
              </p>
            </div>
            <div role="group" aria-label="Cost date range presets" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 bg-slate-100/80 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]">
              {PRESET_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={preset === key}
                  className={cn(
                    "h-6 cursor-pointer whitespace-nowrap rounded-md px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-primary/35",
                    preset === key
                      ? "bg-white font-semibold text-slate-950 shadow-sm dark:bg-[#151d2b] dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                      : "text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#eef2f8]",
                  )}
                  onClick={() => setPreset(key)}
                >
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          {preset === "custom" ? (
            <div className="tactile-card flex min-h-10 flex-wrap items-center gap-2 rounded-xl py-1 border-slate-200/90 bg-white px-2 dark:border-white/[0.08] dark:bg-none dark:bg-card">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#8b97ad]">Custom range</span>
              <input
                type="date"
                aria-label="Custom start date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="h-7 rounded-md border border-slate-200/90 bg-white px-2 text-xs text-slate-950 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#eef2f8] dark:focus:border-primary dark:focus:ring-primary/25"
              />
              <span className="text-xs text-slate-500 dark:text-[#8b97ad]">to</span>
              <input
                type="date"
                aria-label="Custom end date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="h-7 rounded-md border border-slate-200/90 bg-white px-2 text-xs text-slate-950 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#eef2f8] dark:focus:border-primary dark:focus:ring-primary/25"
              />
            </div>
          ) : null}

          {/* 1-row 4-column Combo 1 cost telemetry strip; mini bars live in each cell's header-right, never over subtext */}
          <section
            aria-label="Cost telemetry"
            className={cn(
              TACTILE_CARD_CLASS,
              "grid grid-cols-2 divide-x divide-slate-200/80 overflow-hidden dark:divide-white/[0.06] lg:grid-cols-4",
            )}
          >
            <TelemetryCell
              label={preset === "mtd" ? "MTD spend" : `${PRESET_LABELS[preset]} spend`}
              value={formatCents(spendCents)}
              sub={`${formatTokens(inferenceTokenTotal)} tokens · ${rangeDays ? `${rangeDays}d elapsed` : "all time"}`}
              dot="bg-blue-500 shadow-[0_0_6px_rgba(96,165,250,0.5)] dark:bg-primary"
            />
            <TelemetryCell
              label="Budget utilization"
              value={budgetCents > 0 ? `${utilization}%` : "Open"}
              sub={activeBudgetIncidents.length > 0
                ? `${activeBudgetIncidents.length} budget incident${activeBudgetIncidents.length === 1 ? "" : "s"} · ${budgetData?.pausedAgentCount ?? 0} agents paused`
                : budgetCents > 0 ? `${formatCents(spendCents)} of ${formatCents(budgetCents)} monthly cap` : "No monthly cap configured"}
              dot={
                activeBudgetIncidents.length > 0
                  ? "bg-rose-500 shadow-[0_0_8px_rgba(248,113,113,0.75)] animate-pulse dark:bg-[#f87171]"
                  : budgetCents <= 0
                    ? "bg-slate-400 dark:bg-[#64748b]"
                    : utilization > 90
                      ? "bg-rose-500 shadow-[0_0_8px_rgba(248,113,113,0.65)] dark:bg-[#f87171]"
                      : utilization > 70
                        ? "bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)] dark:bg-[#f59e0b]"
                        : "bg-emerald-700 dark:bg-emerald-300"
              }
              visual={
                budgetCents > 0 ? (
                  <MiniBar
                    percent={utilization}
                    tone={
                      utilization > 90
                        ? "bg-rose-500 dark:bg-[#f87171]"
                        : utilization > 70
                          ? "bg-amber-500 dark:bg-[#f59e0b]"
                          : "bg-emerald-700 dark:bg-emerald-300"
                    }
                  />
                ) : undefined
              }
            />
            <TelemetryCell
              label="Active spend rate"
              value={rangeDays ? `${formatCents(dailyCents)} / day` : "—"}
              sub={budgetCents > 0 && preset === "mtd" ? `~${formatCents(projectedMonthCents)} by month end` : `${formatCents(spendCents)} over ${rangeDays ? `${rangeDays}d` : "all time"}`}
              dot="bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)] dark:bg-[#f59e0b]"
              visual={
                budgetCents > 0 ? (
                  <MiniBar
                    percent={(projectedMonthCents / budgetCents) * 100}
                    tone={
                      projectedMonthCents > budgetCents
                        ? "bg-rose-500 dark:bg-[#f87171]"
                        : projectedMonthCents > budgetCents * 0.8
                          ? "bg-amber-500 dark:bg-[#f59e0b]"
                          : "bg-emerald-700 dark:bg-emerald-300"
                    }
                  />
                ) : undefined
              }
            />
            <TelemetryCell
              label="Top cost driver"
              value={topAgent ? topAgent.agentName ?? topAgent.agentId : "—"}
              sub={topAgent ? `${formatCents(topAgent.costCents)} · ${spendCents > 0 ? Math.round((topAgent.costCents / spendCents) * 100) : 0}% of spend` : "No cost events yet"}
              dot="bg-blue-500 dark:bg-primary"
              visual={topAgent ? <MiniBar percent={spendCents > 0 ? (topAgent.costCents / spendCents) * 100 : 0} tone="bg-blue-500 dark:bg-primary" /> : undefined}
            />
          </section>
      </div>

      <Tabs value={mainTab} onValueChange={(value) => setMainTab(value as typeof mainTab)}>
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="billers">Billers</TabsTrigger>
          <TabsTrigger value="finance">Finance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : showOverviewLoading ? (
            <PageSkeleton variant="costs" />
          ) : overviewError ? (
            <p role="alert" className="text-sm text-destructive">{(overviewError as Error).message}</p>
          ) : (
            <>
              {activeBudgetIncidents.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {activeBudgetIncidents.slice(0, 2).map((incident) => (
                    <div
                      key={incident.id}
                      className={!canAdmin ? "[&_input]:pointer-events-none [&_input]:opacity-60" : undefined}
                      title={!canAdmin ? "Admin or owner role required to resolve budget incidents" : undefined}
                    >
                      <BudgetIncidentCard
                        incident={incident}
                        isMutating={!canAdmin || incidentMutation.isPending}
                        onKeepPaused={() => {
                          if (!canAdmin) return;
                          incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" });
                        }}
                        onRaiseAndResume={(amount) => {
                          if (!canAdmin) return;
                          incidentMutation.mutate({
                            incidentId: incident.id,
                            action: "raise_budget_and_resume",
                            amount,
                          });
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              {/* 2-column Combo 1 cockpit breakdown grid */}
              <div className="grid gap-3.5 xl:grid-cols-2">
                <CockpitCard
                  title="Spend by agent"
                  description="What each agent consumed in the selected period."
                  action={<span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">{spendData?.byAgent.length ?? 0} agents</span>}
                >
                  {(spendData?.byAgent.length ?? 0) === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">No cost events yet.</p>
                  ) : (
                    spendData?.byAgent.map((row) => {
                      const modelRows = agentModelRows.get(row.agentId) ?? [];
                      const isExpanded = expandedAgents.has(row.agentId);
                      const hasBreakdown = modelRows.length > 0;
                      const sharePct = spendCents > 0 ? Math.round((row.costCents / spendCents) * 100) : 0;
                      return (
                        <div key={row.agentId}>
                          <button
                            type="button"
                            disabled={!hasBreakdown}
                            onClick={() => hasBreakdown && toggleAgent(row.agentId)}
                            className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 px-4 py-2.5 text-left transition-colors hover:bg-slate-50/90 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-[#141b29]"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {hasBreakdown ? (
                                isExpanded
                                  ? <ChevronDown className="h-3 w-3 shrink-0 text-slate-400 dark:text-[#8b97ad]" />
                                  : <ChevronRight className="h-3 w-3 shrink-0 text-slate-400 dark:text-[#8b97ad]" />
                              ) : (
                                <span className="h-3 w-3 shrink-0" />
                              )}
                              <Identity name={row.agentName ?? row.agentId} size="sm" />
                              {row.agentStatus === "terminated" ? <StatusBadge status="terminated" /> : null}
                            </div>
                            <div className="text-right text-xs tabular-nums">
                              <div className="text-sm font-semibold text-slate-950 dark:text-[#edf2fb]">
                                {formatCents(row.costCents)}
                                <span className="ml-1 font-mono text-xs font-normal text-slate-500 dark:text-[#8b97ad]">{sharePct}%</span>
                              </div>
                              <div className="text-slate-500 dark:text-[#8b97ad]">
                                in {formatTokens(row.inputTokens + row.cachedInputTokens)} · out {formatTokens(row.outputTokens)}
                                {(row.apiRunCount > 0 || row.subscriptionRunCount > 0)
                                  ? ` · ${row.apiRunCount} api · ${row.subscriptionRunCount} sub`
                                  : ""}
                              </div>
                            </div>
                          </button>
                          <div className="h-0.5 bg-slate-100 dark:bg-background">
                            <div className="h-full bg-blue-500 dark:bg-primary" style={{ width: `${sharePct}%` }} />
                          </div>

                          {isExpanded && modelRows.length > 0 ? (
                            <div className="space-y-1.5 border-t border-slate-200/75 bg-slate-50/80 px-4 py-2.5 dark:border-white/[0.06] dark:bg-muted/40">
                              {modelRows.map((modelRow) => {
                                const modelSharePct = row.costCents > 0 ? Math.round((modelRow.costCents / row.costCents) * 100) : 0;
                                return (
                                  <div
                                    key={`${modelRow.provider}:${modelRow.model}:${modelRow.billingType}`}
                                    className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 text-xs"
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate font-medium text-slate-900 dark:text-[#edf2fb]">
                                        {providerDisplayName(modelRow.provider)}
                                        <span className="mx-1 text-slate-400 dark:text-[#4a5670]">/</span>
                                        <span className="font-mono">{modelRow.model}</span>
                                      </div>
                                      <div className="truncate text-slate-500 dark:text-[#8b97ad]">
                                        {providerDisplayName(modelRow.biller)} · {billingTypeDisplayName(modelRow.billingType)}
                                      </div>
                                    </div>
                                    <div className="text-right tabular-nums">
                                      <div className="font-medium text-slate-950 dark:text-[#edf2fb]">
                                        {formatCents(modelRow.costCents)}
                                        <span className="ml-1 font-mono font-normal text-slate-500 dark:text-[#8b97ad]">({modelSharePct}%)</span>
                                      </div>
                                      <div className="text-slate-500 dark:text-[#8b97ad]">
                                        {formatTokens(modelRow.inputTokens + modelRow.cachedInputTokens + modelRow.outputTokens)} tok
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </CockpitCard>

                <CockpitCard
                  title="Spend by model"
                  description="Provider / model totals across all agents in the selected period."
                  action={<span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">{modelTotals.length} models</span>}
                >
                  {modelTotals.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">No cost events yet.</p>
                  ) : (
                    modelTotals.map((row) => {
                      const sharePct = spendCents > 0 ? Math.round((row.costCents / spendCents) * 100) : 0;
                      return (
                        <div
                          key={`${row.provider}:${row.model}`}
                          className="grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-x-3 px-4 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-slate-900 dark:text-[#edf2fb]">
                              {providerDisplayName(row.provider)}
                              <span className="mx-1 text-slate-400 dark:text-[#4a5670]">/</span>
                              <span className="font-mono">{row.model}</span>
                            </div>
                            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full border border-slate-200/80 bg-slate-100 dark:border-white/[0.06] dark:bg-background">
                              <div className="h-full rounded-full bg-blue-500 dark:bg-primary" style={{ width: `${sharePct}%` }} />
                            </div>
                          </div>
                          <div className="text-right tabular-nums">
                            <div className="font-semibold text-slate-950 dark:text-[#edf2fb]">
                              {formatCents(row.costCents)}
                              <span className="ml-1 font-mono font-normal text-slate-500 dark:text-[#8b97ad]">{sharePct}%</span>
                            </div>
                            <div className="text-slate-500 dark:text-[#8b97ad]">{formatTokens(row.tokens)} tok</div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CockpitCard>
              </div>

              <div className="grid gap-3.5 xl:grid-cols-2">
                <div className="space-y-3.5">
                  <CockpitCard
                    title="By work context"
                    description="Run costs attributed through work-context-linked items."
                    action={<span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-[#8b97ad]">{spendData?.byProject.length ?? 0} contexts</span>}
                  >
                    {(spendData?.byProject.length ?? 0) === 0 ? (
                      <p className="px-4 py-3 text-sm text-muted-foreground">No work-context-attributed run costs yet.</p>
                    ) : (
                      spendData?.byProject.map((row, index) => (
                        <div
                          key={row.projectId ?? `unattributed-${index}`}
                          className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs"
                        >
                          <span className="truncate text-slate-800 dark:text-[#cbd5e1]">{row.projectName ?? row.projectId ?? "Unattributed"}</span>
                          <span className="font-mono font-semibold tabular-nums text-slate-950 dark:text-[#edf2fb]">{formatCents(row.costCents)}</span>
                        </div>
                      ))
                    )}
                  </CockpitCard>

                  <FinanceTimelineCard rows={topFinanceEvents.slice(0, 6)} emptyMessage="No finance events yet. Add account-level charges once biller invoices or credits land." />
                </div>

                <FinanceSummaryCard
                  debitCents={financeData?.summary.debitCents ?? 0}
                  creditCents={financeData?.summary.creditCents ?? 0}
                  netCents={financeData?.summary.netCents ?? 0}
                  estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                  eventCount={financeData?.summary.eventCount ?? 0}
                />
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="budgets" className="mt-4 space-y-4">
          {budgetLoading ? (
            <PageSkeleton variant="costs" />
          ) : budgetError ? (
            <p role="alert" className="text-sm text-destructive">{(budgetError as Error).message}</p>
          ) : (
            <>
              <Card className={TACTILE_CARD_CLASS}>
                <CardHeader className="px-5 pt-5 pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">Budget control plane</CardTitle>
                    {!canAdmin && (
                      <span
                        className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#fde68a]"
                        title="Admin or owner role required to edit budget policies or resolve incidents"
                      >
                        <Lock className="h-3 w-3 shrink-0" />
                        Read-only{currentRole ? ` (${currentRole})` : ""} · Admin or owner role required
                      </span>
                    )}
                  </div>
                  <CardDescription>
                    Hard-stop spend limits for agents and work contexts. Provider subscription quota stays separate and appears under Providers.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-4">
                  <MetricTile
                    label="Active incidents"
                    value={String(activeBudgetIncidents.length)}
                    subtitle="Open soft or hard threshold crossings"
                    icon={ReceiptText}
                  />
                  <MetricTile
                    label="Pending approvals"
                    value={String(budgetData?.pendingApprovalCount ?? 0)}
                    subtitle="Budget override approvals awaiting board action"
                    icon={ArrowUpRight}
                  />
                  <MetricTile
                    label="Paused agents"
                    value={String(budgetData?.pausedAgentCount ?? 0)}
                    subtitle="Agent heartbeats blocked by budget"
                    icon={Coins}
                  />
                  <MetricTile
                    label="Paused work contexts"
                    value={String(budgetData?.pausedProjectCount ?? 0)}
                    subtitle="Work-context execution blocked by budget"
                    icon={DollarSign}
                  />
                </CardContent>
              </Card>

              {activeBudgetIncidents.length > 0 ? (
                <div className="space-y-3">
                  <div>
                    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Active incidents</h2>
                    <p className="text-sm text-muted-foreground">
                      Resolve hard stops here by raising the budget or explicitly keeping the scope paused.
                    </p>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {activeBudgetIncidents.map((incident) => (
                      <div
                        key={incident.id}
                        className={!canAdmin ? "[&_input]:pointer-events-none [&_input]:opacity-60" : undefined}
                        title={!canAdmin ? "Admin or owner role required to resolve budget incidents" : undefined}
                      >
                        <BudgetIncidentCard
                          incident={incident}
                          isMutating={!canAdmin || incidentMutation.isPending}
                          onKeepPaused={() => {
                            if (!canAdmin) return;
                            incidentMutation.mutate({ incidentId: incident.id, action: "keep_paused" });
                          }}
                          onRaiseAndResume={(amount) => {
                            if (!canAdmin) return;
                            incidentMutation.mutate({
                              incidentId: incident.id,
                              action: "raise_budget_and_resume",
                              amount,
                            });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="space-y-5">
                {(["company", "agent", "project"] as const).map((scopeType) => {
                  const rows = budgetPoliciesByScope[scopeType];
                  if (rows.length === 0) return null;
                  return (
                    <section key={scopeType} className="space-y-3">
                      <div>
                        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{scopeType === "project" ? "Work context budgets" : `${scopeType} budgets`}</h2>
                        <p className="text-sm text-muted-foreground">
                          {scopeType === "company"
                            ? "Company-wide monthly policy."
                            : scopeType === "agent"
                              ? "Recurring monthly spend policies for individual agents."
                              : "Lifetime spend policies for execution-bound work contexts."}
                        </p>
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        {rows.map((summary) => (
                          <BudgetPolicyCard
                            key={summary.policyId}
                            summary={summary}
                            isSaving={policyMutation.isPending}
                            onSave={
                              canAdmin
                                ? (amount) =>
                                    policyMutation.mutate({
                                      scopeType: summary.scopeType,
                                      scopeId: summary.scopeId,
                                      amount,
                                      windowKind: summary.windowKind,
                                    })
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}

                {budgetPolicies.length === 0 ? (
                  <Card className={TACTILE_CARD_CLASS}>
                    <CardContent className="px-5 py-8 text-sm text-muted-foreground">
                      No budget policies yet. Set agent and work-context budgets from their detail pages, or use the existing company monthly budget control.
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="providers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <ProviderOutcomesCard rows={providerOutcomeData ?? []} />
              <Tabs value={effectiveProvider} onValueChange={setActiveProvider}>
                <PageTabBar items={providerTabItems} value={effectiveProvider} />

                <TabsContent value="all" className="mt-4">
                  {providers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No cost events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {providers.map((provider) => (
                        <ProviderQuotaCard
                          key={provider}
                          provider={provider}
                          rows={byProvider.get(provider) ?? []}
                          budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                          totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                          weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                          windowRows={windowSpendByProvider.get(provider) ?? []}
                          showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                          quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                          quotaError={quotaErrorsByProvider.get(provider) ?? null}
                          quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                          quotaLoading={quotaLoading}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                {providers.map((provider) => (
                  <TabsContent key={provider} value={provider} className="mt-4">
                    <ProviderQuotaCard
                      provider={provider}
                      rows={byProvider.get(provider) ?? []}
                      budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                      totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                      weekSpendCents={weekSpendByProvider.get(provider) ?? 0}
                      windowRows={windowSpendByProvider.get(provider) ?? []}
                      showDeficitNotch={deficitNotchByProvider.get(provider) ?? false}
                      quotaWindows={quotaWindowsByProvider.get(provider) ?? []}
                      quotaError={quotaErrorsByProvider.get(provider) ?? null}
                      quotaSource={quotaSourcesByProvider.get(provider) ?? null}
                      quotaLoading={quotaLoading}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="billers" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : (
            <>
              <Tabs value={effectiveBiller} onValueChange={setActiveBiller}>
                <PageTabBar items={billerTabItems} value={effectiveBiller} />

                <TabsContent value="all" className="mt-4">
                  {billers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No billable events in this period.</p>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2">
                      {billers.map((biller) => {
                        const row = (byBiller.get(biller) ?? [])[0];
                        if (!row) return null;
                        const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                        return (
                          <BillerSpendCard
                            key={biller}
                            row={row}
                            weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                            budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                            totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                            providerRows={providerRows}
                          />
                        );
                      })}
                    </div>
                  )}
                </TabsContent>

                {billers.map((biller) => {
                  const row = (byBiller.get(biller) ?? [])[0];
                  if (!row) return null;
                  const providerRows = (providerData ?? []).filter((entry) => entry.biller === biller);
                  return (
                    <TabsContent key={biller} value={biller} className="mt-4">
                      <BillerSpendCard
                        row={row}
                        weekSpendCents={weekSpendByBiller.get(biller) ?? 0}
                        budgetMonthlyCents={spendData?.summary.budgetCents ?? 0}
                        totalCompanySpendCents={spendData?.summary.spendCents ?? 0}
                        providerRows={providerRows}
                      />
                    </TabsContent>
                  );
                })}
              </Tabs>
            </>
          )}
        </TabsContent>

        <TabsContent value="finance" className="mt-4 space-y-4">
          {showCustomPrompt ? (
            <p className="text-sm text-muted-foreground">Select a start and end date to load data.</p>
          ) : financeLoading ? (
            <PageSkeleton variant="costs" />
          ) : financeError ? (
            <p role="alert" className="text-sm text-destructive">{(financeError as Error).message}</p>
          ) : (
            <>
              <FinanceSummaryCard
                debitCents={financeData?.summary.debitCents ?? 0}
                creditCents={financeData?.summary.creditCents ?? 0}
                netCents={financeData?.summary.netCents ?? 0}
                estimatedDebitCents={financeData?.summary.estimatedDebitCents ?? 0}
                eventCount={financeData?.summary.eventCount ?? 0}
              />

              <div className="grid gap-4 xl:grid-cols-[minmax(0,55%)_minmax(0,45%)]">
                <div className="space-y-4">
                  <Card className={TACTILE_CARD_CLASS}>
                    <CardHeader className="px-5 pt-5 pb-2">
                      <CardTitle className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-[#8b97ad]">By biller</CardTitle>
                      <CardDescription>Account-level financial events grouped by who charged or credited them.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 px-5 pb-5 pt-2 md:grid-cols-2">
                      {(financeData?.byBiller.length ?? 0) === 0 ? (
                        <p className="text-sm text-muted-foreground">No finance events yet.</p>
                      ) : (
                        financeData?.byBiller.map((row) => <FinanceBillerCard key={row.biller} row={row} />)
                      )}
                    </CardContent>
                  </Card>
                  <FinanceTimelineCard rows={topFinanceEvents} />
                </div>

                <FinanceKindCard rows={financeData?.byKind ?? []} />
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
