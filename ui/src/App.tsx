import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { NotFoundPage } from "./pages/NotFound";
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";

const OnboardingWizard = lazy(async () => ({ default: (await import("./components/OnboardingWizard")).OnboardingWizard }));
const Dashboard = lazy(async () => ({ default: (await import("./pages/Dashboard")).Dashboard }));
const Quality = lazy(async () => ({ default: (await import("./pages/Quality")).Quality }));
const Companies = lazy(async () => ({ default: (await import("./pages/Companies")).Companies }));
const Agents = lazy(async () => ({ default: (await import("./pages/Agents")).Agents }));
const AgentDetail = lazy(async () => ({ default: (await import("./pages/AgentDetail")).AgentDetail }));
const Projects = lazy(async () => ({ default: (await import("./pages/Projects")).Projects }));
const ProjectDetail = lazy(async () => ({ default: (await import("./pages/ProjectDetail")).ProjectDetail }));
const Issues = lazy(async () => ({ default: (await import("./pages/Issues")).Issues }));
const IssueDetail = lazy(async () => ({ default: (await import("./pages/IssueDetail")).IssueDetail }));
const ExecutionWorkspaceDetail = lazy(async () => ({ default: (await import("./pages/ExecutionWorkspaceDetail")).ExecutionWorkspaceDetail }));
const Inbox = lazy(async () => ({ default: (await import("./pages/Inbox")).Inbox }));
const CompanySettings = lazy(async () => ({ default: (await import("./pages/CompanySettings")).CompanySettings }));
const OrgChart = lazy(async () => ({ default: (await import("./pages/OrgChart")).OrgChart }));
const NewAgent = lazy(async () => ({ default: (await import("./pages/NewAgent")).NewAgent }));
const Missions = lazy(async () => ({ default: (await import("./pages/Missions")).Missions }));
const MissionDetail = lazy(async () => ({ default: (await import("./pages/MissionDetail")).MissionDetail }));
const Workflows = lazy(async () => ({ default: (await import("./pages/Workflows")).Workflows }));
const SchedulerConfig = lazy(async () => ({ default: (await import("./pages/SchedulerConfig")).SchedulerConfig }));
const ChannelConfig = lazy(async () => ({ default: (await import("./pages/ChannelConfig")).ChannelConfig }));
const CollabChannels = lazy(async () => ({ default: (await import("./pages/CollabChannels")).CollabChannels }));
const EnterpriseBots = lazy(async () => ({ default: (await import("./pages/EnterpriseBots")).EnterpriseBots }));
const WorktreeRules = lazy(async () => ({ default: (await import("./pages/WorktreeRules")).WorktreeRules }));
const WorktreeProposals = lazy(async () => ({ default: (await import("./pages/WorktreeProposals")).WorktreeProposals }));
const Approvals = lazy(async () => ({ default: (await import("./pages/Approvals")).Approvals }));
const ApprovalDetail = lazy(async () => ({ default: (await import("./pages/ApprovalDetail")).ApprovalDetail }));
const Costs = lazy(async () => ({ default: (await import("./pages/Costs")).Costs }));
const AgentWiki = lazy(async () => ({ default: (await import("./pages/AgentWiki")).AgentWiki }));
const Activity = lazy(async () => ({ default: (await import("./pages/Activity")).Activity }));
const CompanySkills = lazy(async () => ({ default: (await import("./pages/CompanySkills")).CompanySkills }));
const MemoryAndSkillsReview = lazy(async () => ({ default: (await import("./pages/MemoryAndSkillsReview")).MemoryAndSkillsReview }));
const PersonalEndpoints = lazy(async () => ({ default: (await import("./pages/PersonalEndpoints")).PersonalEndpoints }));
const WorkspacePrimitives = lazy(async () => ({ default: (await import("./pages/WorkspacePrimitives")).WorkspacePrimitives }));
const CompanyInstructions = lazy(async () => ({ default: (await import("./pages/CompanyInstructions")).CompanyInstructions }));
const HumanOperator = lazy(async () => ({ default: (await import("./pages/HumanOperator")).HumanOperator }));
const InstanceGeneralSettings = lazy(async () => ({ default: (await import("./pages/InstanceGeneralSettings")).InstanceGeneralSettings }));
const InstanceSettings = lazy(async () => ({ default: (await import("./pages/InstanceSettings")).InstanceSettings }));
const InstanceExperimentalSettings = lazy(async () => ({ default: (await import("./pages/InstanceExperimentalSettings")).InstanceExperimentalSettings }));

/**
 * Route chunk prefetch. Each entry is the same dynamic `import()` the lazy route element
 * above uses, so warming a route only loads and caches its chunk: no render, no data fetch.
 */
const ROUTE_CHUNK_LOADERS: Record<string, () => Promise<unknown>> = {
  "/missions": () => import("./pages/Missions"),
  "/dashboard": () => import("./pages/Dashboard"),
  "/inbox": () => import("./pages/Inbox"),
  "/issues": () => import("./pages/Issues"),
  "/agents": () => import("./pages/Agents"),
  "/workflows": () => import("./pages/Workflows"),
  "/costs": () => import("./pages/Costs"),
  "/projects": () => import("./pages/Projects"),
  "/approvals": () => import("./pages/Approvals"),
  "/activity": () => import("./pages/Activity"),
  "/quality": () => import("./pages/Quality"),
  "/human-operator": () => import("./pages/HumanOperator"),
  "/company/settings": () => import("./pages/CompanySettings"),
  "/skills": () => import("./pages/CompanySkills"),
  "/learning-review": () => import("./pages/MemoryAndSkillsReview"),
  "/personal-endpoints": () => import("./pages/PersonalEndpoints"),
  "/workspace-primitives": () => import("./pages/WorkspacePrimitives"),
  "/scheduler": () => import("./pages/SchedulerConfig"),
  "/channel-config": () => import("./pages/ChannelConfig"),
  "/channels": () => import("./pages/CollabChannels"),
  "/bots": () => import("./pages/EnterpriseBots"),
};
/** Top sidebar routes warmed once the first paint is done, in likely-visit order. */
const IDLE_PREFETCH_ROUTES = ["/missions", "/dashboard", "/inbox", "/issues", "/agents"];
const IDLE_PREFETCH_TIMEOUT_MS = 3000;
const IDLE_PREFETCH_FALLBACK_DELAY_MS = 2000;
const prefetchedRoutes = new Set<string>();

/** `/:companyPrefix/missions`, `/missions/123` and `/missions?tab=x` all resolve to `/missions`. */
function resolvePrefetchableRoute(to: string): string | null {
  if (typeof to !== "string") return null;
  const pathname = to.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const unprefixed = pathname.replace(/^\/[^/]+(?=\/)/, "");
  for (const candidate of unprefixed === pathname ? [pathname] : [pathname, unprefixed]) {
    if (ROUTE_CHUNK_LOADERS[candidate]) return candidate;
    const parent = candidate.slice(0, candidate.lastIndexOf("/"));
    if (ROUTE_CHUNK_LOADERS[parent]) return parent;
  }
  return null;
}

function warmRoute(to: string): Promise<void> {
  const route = resolvePrefetchableRoute(to);
  if (!route || prefetchedRoutes.has(route)) return Promise.resolve();
  prefetchedRoutes.add(route);
  return ROUTE_CHUNK_LOADERS[route]().then(
    () => undefined,
    () => {
      prefetchedRoutes.delete(route);
    },
  );
}

/**
 * Warm a route chunk before the click (sidebar hover/focus). Fire-and-forget: a failed load
 * is swallowed and retried on the next hover, so the navigation path itself never changes.
 */
export function prefetchRoute(to: string): void {
  void warmRoute(to);
}

function prefetchRoutesSequentially(routes: readonly string[]): Promise<void> {
  const [next, ...rest] = routes;
  return next ? warmRoute(next).then(() => prefetchRoutesSequentially(rest)) : Promise.resolve();
}

function scheduleWhenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: IDLE_PREFETCH_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, IDLE_PREFETCH_FALLBACK_DELAY_MS);
  return () => window.clearTimeout(handle);
}
function lazyRoute(element: ReactNode) {
  return (
    <Suspense fallback={<div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>}>
      {element}
    </Suspense>
  );
}

function OnboardingWizardMount() {
  const { onboardingOpen } = useDialog();
  const location = useLocation();
  const shouldMount = onboardingOpen || /(^|\/)onboarding$/.test(location.pathname);

  if (!shouldMount) return null;

  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Paperwork startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Paperwork environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`paperwork auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app state"}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return <Outlet />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="missions" replace />} />
      <Route path="dashboard" element={lazyRoute(<Dashboard />)} />
      <Route path="quality" element={lazyRoute(<Quality />)} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={lazyRoute(<Companies />)} />
      <Route path="company/settings" element={lazyRoute(<CompanySettings />)} />
      <Route path="skills/*" element={lazyRoute(<CompanySkills />)} />
      <Route path="learning-review" element={lazyRoute(<MemoryAndSkillsReview />)} />
      <Route path="personal-endpoints" element={lazyRoute(<PersonalEndpoints />)} />
      <Route path="workspace-primitives" element={lazyRoute(<WorkspacePrimitives />)} />
      <Route path="instructions" element={lazyRoute(<CompanyInstructions />)} />
      <Route path="human-operator" element={lazyRoute(<HumanOperator />)} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="org" element={lazyRoute(<OrgChart />)} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={lazyRoute(<Agents />)} />
      <Route path="agents/active" element={lazyRoute(<Agents />)} />
      <Route path="agents/paused" element={lazyRoute(<Agents />)} />
      <Route path="agents/error" element={lazyRoute(<Agents />)} />
      <Route path="agents/new" element={lazyRoute(<NewAgent />)} />
      <Route path="agents/:agentId" element={lazyRoute(<AgentDetail />)} />
      <Route path="agents/:agentId/:tab" element={lazyRoute(<AgentDetail />)} />
      <Route path="agents/:agentId/runs/:runId" element={lazyRoute(<AgentDetail />)} />
      <Route path="projects" element={lazyRoute(<Projects />)} />
      <Route path="projects/:projectId" element={lazyRoute(<ProjectDetail />)} />
      <Route path="projects/:projectId/overview" element={lazyRoute(<ProjectDetail />)} />
      <Route path="projects/:projectId/issues" element={lazyRoute(<ProjectDetail />)} />
      <Route path="projects/:projectId/issues/:filter" element={lazyRoute(<ProjectDetail />)} />
      <Route path="projects/:projectId/configuration" element={lazyRoute(<ProjectDetail />)} />
      <Route path="projects/:projectId/budget" element={lazyRoute(<ProjectDetail />)} />
      <Route path="issues" element={lazyRoute(<Issues />)} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={lazyRoute(<IssueDetail />)} />
      <Route path="workflows" element={lazyRoute(<Workflows />)} />
      <Route path="execution-workspaces/:workspaceId" element={lazyRoute(<ExecutionWorkspaceDetail />)} />
      <Route path="missions" element={lazyRoute(<Missions />)} />
      <Route path="missions/:missionId" element={lazyRoute(<MissionDetail />)} />
      <Route path="scheduler" element={lazyRoute(<SchedulerConfig />)} />
      {/* Legacy prefixed channel-config URL → 전역(프리픽스 없는) /channel-config 로 유도한다. */}
      <Route path="channels" element={<Navigate to="/channel-config" replace />} />
      <Route path="bots" element={lazyRoute(<EnterpriseBots />)} />
      <Route path="worktree/rules" element={lazyRoute(<WorktreeRules />)} />
      <Route path="worktree/proposals" element={lazyRoute(<WorktreeProposals />)} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={lazyRoute(<Approvals />)} />
      <Route path="approvals/all" element={lazyRoute(<Approvals />)} />
      <Route path="approvals/:approvalId" element={lazyRoute(<ApprovalDetail />)} />
      <Route path="costs" element={lazyRoute(<Costs />)} />
      <Route path="agent-wiki" element={lazyRoute(<AgentWiki />)} />
      <Route path="activity" element={lazyRoute(<Activity />)} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/recent" element={lazyRoute(<Inbox />)} />
      <Route path="inbox/unread" element={lazyRoute(<Inbox />)} />
      <Route path="inbox/all" element={lazyRoute(<Inbox />)} />
      <Route path="inbox/new" element={<Navigate to="/inbox/recent" replace />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <Navigate to={`/instance/settings/general${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { companies } = useCompany();
  const { openOnboarding } = useDialog();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter work item for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/missions`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to="/onboarding" replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage() {
  const { openOnboarding } = useDialog();

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Create your first company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Get started by creating a company.
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>New Company</Button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  // After the first paint, quietly warm the top sidebar routes one at a time so the first
  // click on them does not wait for a chunk download.
  useEffect(
    () => scheduleWhenIdle(() => void prefetchRoutesSequentially(IDLE_PREFETCH_ROUTES)),
    [],
  );

  return (
    <>
      <Routes>
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={lazyRoute(<InstanceGeneralSettings />)} />
            <Route path="heartbeats" element={lazyRoute(<InstanceSettings />)} />
            <Route path="experimental" element={lazyRoute(<InstanceExperimentalSettings />)} />
          </Route>
          <Route path="channel-config" element={<Layout />}>
            <Route index element={lazyRoute(<ChannelConfig />)} />
          </Route>
          <Route path="channels" element={<Layout />}>
            <Route index element={lazyRoute(<CollabChannels />)} />
            <Route path=":channelId" element={lazyRoute(<CollabChannels />)} />
          </Route>
          <Route path="scheduler" element={<Layout />}>
            <Route index element={lazyRoute(<SchedulerConfig />)} />
          </Route>
          <Route path="worktree" element={<Layout />}>
            <Route path="rules" element={lazyRoute(<WorktreeRules />)} />
            <Route path="proposals" element={lazyRoute(<WorktreeProposals />)} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="quality" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="workflows" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="instructions" element={<UnprefixedBoardRedirect />} />
          <Route path="human-operator" element={<UnprefixedBoardRedirect />} />
          <Route path="bots" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      <OnboardingWizardMount />
    </>
  );
}
