import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { missionsApi, type CreateMissionInput, type MissionStatus } from "../api/missions";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Folder, Maximize2, Minimize2, User } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

const statusOptions: { value: MissionStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

export function NewMissionDialog() {
  const titleId = useId();
  const { newMissionOpen, closeNewMission, newMissionDefaults } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MissionStatus>("planning");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  // [목적] new mission의 project 선택. optional → 빈 문자열 = 미지정.
  const [projectId, setProjectId] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newMissionOpen,
  });

  // [목적] project selector 옵션. owner와 달리 auto-select 하지 않는다(optional).
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newMissionOpen,
  });

  useEffect(() => {
    if (!newMissionOpen || ownerAgentId || !agents || agents.length === 0) return;
    setOwnerAgentId(agents[0]!.id);
  }, [agents, newMissionOpen, ownerAgentId]);

  // [수정 요청 미션] 사전 채움 값 반영 — 다이얼로그가 열릴 때 1회.
  useEffect(() => {
    if (!newMissionOpen || !newMissionDefaults) return;
    if (newMissionDefaults.title) setTitle(newMissionDefaults.title);
    if (newMissionDefaults.description) setDescription(newMissionDefaults.description);
    if (newMissionDefaults.ownerAgentId) setOwnerAgentId(newMissionDefaults.ownerAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newMissionOpen, newMissionDefaults]);

  const createMission = useMutation({
    mutationFn: (data: CreateMissionInput) =>
      missionsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId!) });
      reset();
      closeNewMission();
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planning");
    setOwnerAgentId("");
    setProjectId("");
    setExpanded(false);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !title.trim()) return;
    createMission.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      ownerAgentId: ownerAgentId || (agents?.[0]?.id ?? ""),
      projectId: projectId || undefined,
      sourceMissionId: newMissionDefaults?.sourceMissionId,
      sourceWorkflowRunId: newMissionDefaults?.sourceWorkflowRunId,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedOwner = agents?.find((a) => a.id === ownerAgentId);
  const selectedProject = projects?.find((p) => p.id === projectId);

  return (
    <Dialog
      open={newMissionOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewMission();
        }
      }}
    >
      <DialogContent
        showCloseButton={false} aria-modal="true" aria-labelledby={titleId} aria-describedby={undefined}
        className={cn(
          "tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_50px_rgba(15,23,42,0.16)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.48)] p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)] overflow-hidden",
          expanded ? "sm:max-w-2xl h-[calc(100dvh-2rem)]" : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200/80 bg-slate-50/70 shrink-0 dark:border-white/10 dark:bg-[#07090d]">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-600 tabular-nums dark:border-white/10 dark:bg-[#0e131d] dark:text-slate-300">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span id={titleId} className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">New Mission</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button" aria-label={expanded ? "Collapse dialog" : "Expand dialog"} variant="ghost"
              size="icon-xs"
              className="text-slate-500 hover:text-[#2563eb] dark:text-slate-400 dark:hover:text-[#60a5fa]"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button" aria-label="Close dialog" variant="ghost"
              size="icon-xs"
              className="text-slate-500 hover:text-[#2563eb] dark:text-slate-400 dark:hover:text-[#60a5fa]"
              onClick={() => { reset(); closeNewMission(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input
            className="w-full text-lg font-semibold bg-transparent text-slate-950 caret-[#65a30d] outline-none placeholder:text-slate-400 dark:text-slate-50 dark:caret-[#a3e635] dark:placeholder:text-slate-500"
            aria-label="Mission title" placeholder="Mission title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
            }}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className={cn("px-4 pb-2 min-h-0", expanded ? "flex-1" : "shrink-0")}>
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            className="min-w-0 max-w-full overflow-hidden"
            contentClassName={cn(
              "text-sm text-slate-600 dark:text-slate-300 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
              expanded
                ? "min-h-[220px] max-h-[calc(100dvh-15rem)]"
                : "min-h-[120px] max-h-[42dvh]"
            )}
          />
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-slate-200/80 bg-slate-50/50 flex-wrap dark:border-white/10 dark:bg-[#07090d]">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/20 dark:hover:bg-[#111827]">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_rgba(0,0,0,0.42)] w-40 p-1" align="start">
              {statusOptions.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-white/5 capitalize",
                    s.value === status && "bg-[var(--pw-cobalt-soft)] text-slate-950 dark:text-slate-50"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Main executor */}
          <Popover open={ownerOpen} onOpenChange={setOwnerOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/20 dark:hover:bg-[#111827]">
                <User className="h-3 w-3 text-[#2563eb] dark:text-[#60a5fa]" />
                {selectedOwner ? selectedOwner.name : "Main executor"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_rgba(0,0,0,0.42)] w-48 p-1" align="start">
              {(agents ?? []).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-white/5 truncate",
                    a.id === ownerAgentId && "bg-[var(--pw-cobalt-soft)] text-slate-950 dark:text-slate-50"
                  )}
                  onClick={() => { setOwnerAgentId(a.id); setOwnerOpen(false); }}
                >
                  {a.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Project (optional) */}
          <Popover open={projectOpen} onOpenChange={setProjectOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/20 dark:hover:bg-[#111827]">
                <Folder className="h-3 w-3 text-[#2563eb] dark:text-[#60a5fa]" />
                {selectedProject ? selectedProject.name : "Project"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_rgba(0,0,0,0.42)] w-48 p-1" align="start">
              {(projects ?? []).length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No projects</div>
              ) : (
                (projects ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-white/5 truncate",
                      p.id === projectId && "bg-[var(--pw-cobalt-soft)] text-slate-950 dark:text-slate-50"
                    )}
                    onClick={() => { setProjectId(p.id); setProjectOpen(false); }}
                  >
                    <span
                      className="shrink-0 h-3 w-3 rounded-sm"
                      style={{ backgroundColor: p.color ?? "#6366f1" }}
                    />
                    {p.name}
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-2.5 border-t border-slate-200/80 bg-slate-50/50 dark:border-white/10 dark:bg-[#07090d]">
          <Button
            type="button" size="sm" className="bg-[#4d7c0f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] hover:bg-[#3f6212] dark:bg-[#a3e635] dark:text-[#07090d] dark:hover:bg-[#bef264] tabular-nums"
            disabled={!title.trim() || createMission.isPending || (agents ?? []).length === 0}
            onClick={handleSubmit}
          >
            {createMission.isPending ? "Creating…" : "Create mission"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
