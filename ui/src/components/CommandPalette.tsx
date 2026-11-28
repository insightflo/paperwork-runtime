import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { ACTIVE_ISSUE_STATUS_FILTER, issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { missionsApi } from "../api/missions";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  CircleDot,
  Bot,
  Hexagon,
  Rocket,
  LayoutDashboard,
  Inbox,
  BookOpen,
  DollarSign,
  History,
  SquarePen,
  Plus,
  UserRoundCheck,
  Workflow,
  CalendarClock,
  Boxes,
  ListChecks,
  Settings,
  Cpu,
} from "lucide-react";
import { Identity } from "./Identity";
import { agentUrl, projectUrl } from "../lib/utils";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { selectedCompanyId, canWrite } = useCompany();
  const { openNewMission, openNewIssue, openNewAgent, openNewProject } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const searchQuery = query.trim();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        if (isMobile) setSidebarOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, setSidebarOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { data: issues = [] } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: ACTIVE_ISSUE_STATUS_FILTER }),
    enabled: !!selectedCompanyId && open,
  });

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, searchQuery),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: searchQuery }),
    enabled: !!selectedCompanyId && open && searchQuery.length > 0,
  });

  const { data: missions = [] } = useQuery({
    queryKey: queryKeys.missions.list(selectedCompanyId!),
    queryFn: () => missionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open,
  });
  const projects = useMemo(
    () => allProjects.filter((p) => !p.archivedAt),
    [allProjects],
  );

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  const visibleIssues = useMemo(
    () => (searchQuery.length > 0 ? searchedIssues : issues),
    [issues, searchedIssues, searchQuery],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v && isMobile) setSidebarOpen(false);
      }}
      title="Paperwork command palette"
      description="Search Paperwork missions, work, agents, and work contexts"
      className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white/95 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_50px_rgba(15,23,42,0.18)] backdrop-blur-md dark:border-white/10 dark:bg-card dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.48)] [&>div:first-child]:bg-transparent [&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:border-[var(--pw-hairline)] [&_[data-slot=command-input-wrapper]]:bg-slate-50/75 dark:[&_[data-slot=command-input-wrapper]]:bg-background [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.18em] [&_[cmdk-group-heading]]:text-slate-500 dark:[&_[cmdk-group-heading]]:text-slate-400 [&_[data-slot=command-item]]:rounded-[10px] [&_[data-slot=command-item]]:tabular-nums [&_[data-slot=command-item][data-selected=true]]:bg-[var(--pw-cobalt-soft)] [&_[data-slot=command-item][data-selected=true]]:text-slate-950 dark:[&_[data-slot=command-item][data-selected=true]]:text-slate-50"
    >
      <CommandInput
        placeholder="Search missions, work, agents, work contexts..." aria-label="Search missions, work, agents, work contexts"
        value={query}
        onValueChange={setQuery}
        className="tabular-nums text-slate-900 placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
      />
      <CommandList className="scrollbar-auto-hide max-h-[360px] pb-1">
        <CommandEmpty>No results found.</CommandEmpty>

        {canWrite !== false && (
          <>
            <CommandGroup heading="Actions">
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  openNewMission();
                }}
              >
                <Rocket className="mr-2 h-4 w-4 text-primary" />
                Create new mission
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  openNewIssue();
                }}
              >
                <SquarePen className="mr-2 h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                Create new work item
                <kbd aria-hidden="true" className="ml-auto rounded-md border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] leading-none text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] tabular-nums dark:border-white/10 dark:bg-background dark:text-primary dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  C
                </kbd>
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  openNewAgent();
                }}
              >
                <Plus className="mr-2 h-4 w-4 text-primary" />
                Create new agent
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  openNewProject();
                }}
              >
                <Plus className="mr-2 h-4 w-4 text-primary" />
                Create new work context
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go("/missions")}>
            <Rocket className="mr-2 h-4 w-4" />
            Missions
          </CommandItem>
          <CommandItem onSelect={() => go("/issues")}>
            <CircleDot className="mr-2 h-4 w-4" />
            Work
          </CommandItem>
          <CommandItem onSelect={() => go("/inbox")}>
            <Inbox className="mr-2 h-4 w-4" />
            Inbox
          </CommandItem>
          <CommandItem onSelect={() => go("/human-operator")}>
            <UserRoundCheck className="mr-2 h-4 w-4" />
            Human Operator
          </CommandItem>
          <CommandItem onSelect={() => go("/agents")}>
            <Cpu className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => go("/bots")}>
            <Bot className="mr-2 h-4 w-4" />
            Bots
          </CommandItem>
          <CommandItem onSelect={() => go("/workflows")}>
            <Workflow className="mr-2 h-4 w-4" />
            Workflows
          </CommandItem>
          <CommandItem onSelect={() => go("/scheduler")}>
            <CalendarClock className="mr-2 h-4 w-4" />
            Scheduler
          </CommandItem>
          <CommandItem onSelect={() => go("/skills")}>
            <Boxes className="mr-2 h-4 w-4" />
            Skills
          </CommandItem>
          <CommandItem onSelect={() => go("/quality")}>
            <ListChecks className="mr-2 h-4 w-4" />
            Quality
          </CommandItem>
          <CommandItem onSelect={() => go("/projects")}>
            <Hexagon className="mr-2 h-4 w-4" />
            Work Contexts
          </CommandItem>
          <CommandItem onSelect={() => go("/instructions")}>
            <BookOpen className="mr-2 h-4 w-4" />
            Instructions
          </CommandItem>
          <CommandItem onSelect={() => go("/costs")}>
            <DollarSign className="mr-2 h-4 w-4 text-[#b45309] dark:text-[#f59e0b]" />
            Costs
          </CommandItem>
          <CommandItem onSelect={() => go("/activity")}>
            <History className="mr-2 h-4 w-4" />
            Activity
          </CommandItem>
          <CommandItem onSelect={() => go("/company/settings")}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </CommandItem>
        </CommandGroup>

        {missions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Missions">
              {missions.slice(0, 10).map((mission) => (
                <CommandItem
                  key={mission.id}
                  value={`${mission.title} ${mission.status} ${mission.id}`}
                  onSelect={() => go(`/missions/${mission.id}`)}
                >
                  <Rocket className="mr-2 h-4 w-4 text-primary" />
                  <span className="flex-1 truncate">{mission.title}</span>
                  <span className="ml-2 font-mono text-[10px] uppercase text-slate-500 tabular-nums dark:text-slate-400">
                    {mission.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {visibleIssues.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Work">
              {visibleIssues.slice(0, 10).map((issue) => (
                <CommandItem
                  key={issue.id}
                  value={
                    searchQuery.length > 0
                      ? `${searchQuery} ${issue.identifier ?? ""} ${issue.title}`
                      : undefined
                  }
                  onSelect={() => go(`/issues/${issue.identifier ?? issue.id}`)}
                >
                  <CircleDot className="mr-2 h-4 w-4" />
                  <span className="mr-2 font-mono text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span className="flex-1 truncate">{issue.title}</span>
                  {issue.assigneeAgentId && (() => {
                    const name = agentName(issue.assigneeAgentId);
                    return name ? <Identity name={name} size="sm" className="ml-2 hidden sm:inline-flex" /> : null;
                  })()}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {agents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.slice(0, 10).map((agent) => (
                <CommandItem key={agent.id} onSelect={() => go(agentUrl(agent))}>
                  <Bot className="mr-2 h-4 w-4" />
                  {agent.name}
                  <span className="ml-2 text-xs text-slate-500 tabular-nums dark:text-slate-400">{agent.role}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Work Contexts">
              {projects.slice(0, 10).map((project) => (
                <CommandItem key={project.id} onSelect={() => go(projectUrl(project))}>
                  <Hexagon className="mr-2 h-4 w-4" />
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
