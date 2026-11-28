import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
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
import {
  Maximize2,
  Minimize2,
  Calendar,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";
import { ChoosePathButton } from "./PathInstructionsModal";

const projectStatuses = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export function NewProjectDialog() {
  const { newProjectOpen, closeNewProject } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [targetDate, setTargetDate] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [workspaceLocalPath, setWorkspaceLocalPath] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  const createProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.create(selectedCompanyId!, data),
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "projects/drafts");
    },
  });

  function reset() {
    setName("");
    setDescription("");
    setStatus("planned");
    setTargetDate("");
    setExpanded(false);
    setWorkspaceLocalPath("");
    setWorkspaceRepoUrl("");
    setWorkspaceError(null);
  }

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const isGitHubRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const deriveWorkspaceNameFromPath = (value: string) => {
    const normalized = value.trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "Local folder";
  };

  const deriveWorkspaceNameFromRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
      return repo || "GitHub repo";
    } catch {
      return "GitHub repo";
    }
  };

  async function handleSubmit() {
    if (!selectedCompanyId || !name.trim()) return;
    const localPath = workspaceLocalPath.trim();
    const repoUrl = workspaceRepoUrl.trim();

    if (localPath && !isAbsolutePath(localPath)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    if (repoUrl && !isGitHubRepoUrl(repoUrl)) {
      setWorkspaceError("Repo must use a valid GitHub repo URL.");
      return;
    }

    setWorkspaceError(null);

    try {
      const created = await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        status,
        color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
        ...(targetDate ? { targetDate } : {}),
      });

      if (localPath || repoUrl) {
        const workspacePayload: Record<string, unknown> = {
          name: localPath
            ? deriveWorkspaceNameFromPath(localPath)
            : deriveWorkspaceNameFromRepo(repoUrl),
          ...(localPath ? { cwd: localPath } : {}),
          ...(repoUrl ? { repoUrl } : {}),
        };
        await projectsApi.createWorkspace(created.id, workspacePayload);
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(created.id) });
      reset();
      closeNewProject();
    } catch {
      // surface through createProject.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog
      open={newProjectOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeNewProject();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn("tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_18px_50px_rgba(15,23,42,0.16)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_50px_rgba(0,0,0,0.48)] p-0 gap-0", expanded ? "sm:max-w-2xl" : "sm:max-w-lg")}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200/80 bg-slate-50/70 dark:border-white/10 dark:bg-[#07090d]">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {selectedCompany && (
              <span className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-600 tabular-nums dark:border-white/10 dark:bg-[#0e131d] dark:text-slate-300">
                {selectedCompany.name.slice(0, 3).toUpperCase()}
              </span>
            )}
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">New work context</span>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" aria-label={expanded ? "Collapse work context dialog" : "Expand work context dialog"}
              variant="ghost"
              type="button" aria-label={expanded ? "Collapse dialog" : "Expand dialog"} size="icon-xs"
              className="text-slate-500 hover:text-[#2563eb] dark:text-slate-400 dark:hover:text-[#60a5fa]"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button type="button" aria-label="Close work context dialog"
              variant="ghost"
              type="button" aria-label="Close dialog" size="icon-xs"
              className="text-slate-500 hover:text-[#2563eb] dark:text-slate-400 dark:hover:text-[#60a5fa]"
              onClick={() => { reset(); closeNewProject(); }}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Name */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <input aria-label="Work context name"
            className="w-full text-lg font-semibold bg-transparent text-slate-950 caret-[#65a30d] outline-none placeholder:text-slate-400 dark:text-slate-50 dark:caret-[#a3e635] dark:placeholder:text-slate-500"
            placeholder="Work context name" aria-label="Work context name"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
        <div className="px-4 pb-2">
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            contentClassName={cn("text-sm text-slate-600 dark:text-slate-300", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
        </div>

        <div className="px-4 pt-3 pb-3 space-y-3 border-t border-slate-200/80 bg-slate-50/40 dark:border-white/10 dark:bg-[#07090d]/60">
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label htmlFor="new-project-repo-url" className="block text-xs text-muted-foreground">Repo URL</label>
              <span className="text-xs font-medium text-[#b45309] dark:text-[#f59e0b]">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="GitHub repo help" className="inline-flex h-3 w-3 text-muted-foreground/50 cursor-help"><HelpCircle className="h-3 w-3" /></button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Link a GitHub repository so agents can clone, read, and push code for this work context.
                </TooltipContent>
              </Tooltip>
            </div>
            <input id="new-project-repo-url"
              className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
              value={workspaceRepoUrl} aria-label="GitHub repo"
              onChange={(e) => { setWorkspaceRepoUrl(e.target.value); setWorkspaceError(null); }}
              placeholder="https://github.com/org/repo"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label htmlFor="new-project-local-folder" className="block text-xs text-muted-foreground">Local folder</label>
              <span className="text-xs font-medium text-[#b45309] dark:text-[#f59e0b]">optional</span>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="Local folder help" className="inline-flex h-3 w-3 text-muted-foreground/50 cursor-help"><HelpCircle className="h-3 w-3" /></button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[240px] text-xs">
                  Set an absolute path on this machine where local agents will read and write files for this work context.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <input id="new-project-local-folder"
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-[#2563eb] focus:ring-2 focus:ring-[#2563eb]/15 tabular-nums dark:border-white/10 dark:bg-[#07090d] dark:text-slate-200 dark:placeholder:text-slate-500 dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/20"
                value={workspaceLocalPath} aria-label="Local folder"
                onChange={(e) => { setWorkspaceLocalPath(e.target.value); setWorkspaceError(null); }}
                placeholder="/absolute/path/to/execution-context"
              />
              <ChoosePathButton />
            </div>
          </div>

          {workspaceError && (
            <p role="alert" className="text-xs text-destructive">{workspaceError}</p>
          )}
        </div>

        {/* Property chips */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-slate-200/80 bg-slate-50/50 flex-wrap dark:border-white/10 dark:bg-[#07090d]">
          {/* Status */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button type="button" aria-label={`Status: ${projectStatuses.find((option) => option.value === status)?.label ?? status}`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-[#07090d] dark:text-slate-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:border-white/20 dark:hover:bg-[#111827]">
                <StatusBadge status={status} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="tactile-card rounded-[12px] border-[var(--pw-hairline)] bg-white text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_28px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#0e131d] dark:bg-none dark:text-slate-100 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_28px_rgba(0,0,0,0.42)] w-40 p-1" align="start">
              {projectStatuses.map((s) => (
                <button type="button" aria-label={`Status: ${s.label}`}
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-white/5",
                    s.value === status && "bg-[var(--pw-cobalt-soft)] text-slate-950 dark:text-slate-50"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Target date */}
          <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-2 py-1 text-xs text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/10 dark:bg-[#0e131d] dark:text-slate-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <Calendar className="h-3 w-3 text-[#b45309] dark:text-[#f59e0b]" />
            <input aria-label="Target date"
              type="date"
              className="w-24 bg-transparent text-xs text-slate-700 outline-none tabular-nums dark:text-slate-200"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder="Target date"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-200/80 bg-slate-50/50 dark:border-white/10 dark:bg-[#07090d]">
          {createProject.isError ? (
            <p role="alert" className="text-xs text-destructive">Failed to create work context.</p>
          ) : (
            <span />
          )}
          <Button type="button" aria-label="Create work context"
            size="sm" className="bg-[#4d7c0f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] hover:bg-[#3f6212] dark:bg-[#a3e635] dark:text-[#07090d] dark:hover:bg-[#bef264] tabular-nums"
            disabled={!name.trim() || createProject.isPending}
            onClick={handleSubmit}
          >
            {createProject.isPending ? "Creating…" : "Create work context"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
