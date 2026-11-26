import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Plus, RefreshCw, Save, Trash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { companyInstructionsApi } from "../api/companyInstructions";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PlanTemplatesPanel } from "../components/PlanTemplatesPanel";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const DEFAULT_FILE_PATH = "company-common.md";
// Combo 1 tactile cockpit primitives: light-legible cards over obsidian dark surfaces.
const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]";
const cockpitPanel = "tactile-card dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]";
const CONTROL =
  "h-7 rounded-lg border border-slate-200/90 bg-white px-2 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const PRIMARY_CTA = "h-7 rounded-lg bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";
const GHOST_CTA = "h-7 rounded-lg border border-slate-200/90 bg-white px-2.5 text-xs text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29]";
const MONO_SNIPPET = "whitespace-pre-wrap font-mono";
const planTemplatesCockpitOverrides =
  "[&>div]:gap-3 " +
  "[&>div>aside]:overflow-hidden [&>div>aside]:rounded-xl [&>div>aside]:border [&>div>aside]:border-slate-200/90 [&>div>aside]:bg-white [&>div>aside]:shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:[&>div>aside]:border-white/[0.08] dark:[&>div>aside]:bg-[#0e131d] " +
  "[&>div>main]:rounded-xl [&>div>main]:border [&>div>main]:border-slate-200/90 [&>div>main]:bg-white [&>div>main]:p-4 dark:[&>div>main]:border-white/[0.08] dark:[&>div>main]:bg-[#0e131d] " +
  "[&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-slate-500 dark:[&_h2]:text-[#8b97ad] " +
  "[&_.border-b.border-border]:border-slate-200/90 dark:[&_.border-b.border-border]:border-white/[0.08] [&_.rounded-md.border.border-border]:border-slate-200/90 dark:[&_.rounded-md.border.border-border]:border-white/[0.08] [&_.rounded-md.border.border-border]:bg-slate-50/95 dark:[&_.rounded-md.border.border-border]:bg-[#090c12] " +
  "[&_textarea]:whitespace-pre-wrap [&_textarea]:border-slate-200/90 [&_textarea]:bg-white [&_textarea]:font-mono [&_textarea]:text-slate-900 dark:[&_textarea]:border-white/[0.1] dark:[&_textarea]:bg-[#090c12] dark:[&_textarea]:text-[#eef2f8]";

function normalizeDraftPath(value: string) {
  return value.trim().replace(/^\/+/, "");
}

export function CompanyInstructions() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newPath, setNewPath] = useState(DEFAULT_FILE_PATH);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState("files");

  useEffect(() => {
    setBreadcrumbs([{ label: "Instructions" }]);
  }, [setBreadcrumbs]);

  const bundleQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companyInstructions.bundle(selectedCompanyId) : ["company-instructions", "none"],
    queryFn: () => companyInstructionsApi.bundle(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const files = bundleQuery.data?.files ?? [];
  const activePath = selectedPath ?? files[0]?.path ?? null;

  useEffect(() => {
    if (!selectedPath && files[0]?.path) setSelectedPath(files[0].path);
  }, [files, selectedPath]);

  const fileQuery = useQuery({
    queryKey: selectedCompanyId && activePath ? queryKeys.companyInstructions.file(selectedCompanyId, activePath) : ["company-instructions", "file", "none"],
    queryFn: () => companyInstructionsApi.file(selectedCompanyId!, activePath!),
    enabled: Boolean(selectedCompanyId && activePath),
  });

  useEffect(() => {
    if (fileQuery.data && !dirty) setDraft(fileQuery.data.content);
  }, [dirty, fileQuery.data]);

  const selectedFile = fileQuery.data;
  const rootPath = bundleQuery.data?.rootPath ?? "";

  const invalidateBundle = () => queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(selectedCompanyId!) });
  const errorBody = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

  const saveFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !activePath) throw new Error("Select a company instruction file first.");
      return companyInstructionsApi.updateFile(selectedCompanyId, activePath, draft);
    },
    onSuccess: async (file) => {
      setDirty(false);
      await Promise.all([
        invalidateBundle(),
        queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.file(selectedCompanyId!, file.path) }),
      ]);
      pushToast({ tone: "success", title: "Instruction saved", body: file.path });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Save failed", body: errorBody(error, "Failed to save company instruction.") });
    },
  });

  const createFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      const path = normalizeDraftPath(newPath);
      if (!path) throw new Error("Enter a file path.");
      return companyInstructionsApi.updateFile(selectedCompanyId, path, `# ${path.replace(/\.md$/i, "").replaceAll("-", " ")}\n\n`);
    },
    onSuccess: async (file) => {
      setSelectedPath(file.path);
      setDraft(file.content);
      setDirty(false);
      await invalidateBundle();
      pushToast({ tone: "success", title: "Instruction file created", body: file.path });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Create failed", body: errorBody(error, "Failed to create company instruction.") });
    },
  });

  const deleteFile = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !activePath) throw new Error("Select a company instruction file first.");
      return companyInstructionsApi.deleteFile(selectedCompanyId, activePath);
    },
    onSuccess: async () => {
      setSelectedPath(null);
      setDraft("");
      setDirty(false);
      await invalidateBundle();
      pushToast({ tone: "success", title: "Instruction file deleted" });
    },
    onError: (error) => {
      pushToast({ tone: "error", title: "Delete failed", body: errorBody(error, "Failed to delete company instruction.") });
    },
  });

  const statusText = useMemo(() => {
    if (saveFile.isPending) return "Saving...";
    if (dirty) return "Unsaved changes";
    if (selectedFile) return `${selectedFile.size.toLocaleString()} bytes`;
    return "No file selected";
  }, [dirty, saveFile.isPending, selectedFile]);

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to manage instructions." />;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="space-y-2">
      {/* Tight 40px toolbar: section tabs · file status · delete/save actions (files tab only) */}
      <div className="cockpit-toolbar tactile-card h-10 rounded-xl px-2 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList variant="line" className="h-8 text-slate-500 dark:text-[#8b97ad] [&_[data-state=active]]:text-slate-950 dark:[&_[data-state=active]]:text-[#eef2f8] [&_[data-state=active]]:after:bg-blue-600 dark:[&_[data-state=active]]:after:bg-[#60a5fa]">
            <TabsTrigger value="files">Instruction files</TabsTrigger>
            <TabsTrigger value="plan-templates">Plan templates</TabsTrigger>
          </TabsList>
        </Tabs>
        {activeTab === "files" && (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
            <span className={cn("hidden truncate text-[11px] uppercase tracking-[0.16em] sm:block", dirty ? "text-amber-700 dark:text-[#f59e0b]" : "text-slate-500 dark:text-[#8b97ad]")}>{statusText}</span>
            <Button variant="outline" size="sm" onClick={() => deleteFile.mutate()} disabled={!activePath || deleteFile.isPending}
              className={cn(GHOST_CTA, "text-rose-600 dark:text-[#fb7185] hover:bg-rose-500/10 dark:hover:bg-[#fb7185]/10")}>
              <Trash className="h-3.5 w-3.5" /> Delete
            </Button>
            <Button size="sm" onClick={() => saveFile.mutate()} disabled={!activePath || saveFile.isPending || !dirty} className={PRIMARY_CTA}>
              {saveFile.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </Button>
          </div>
        )}
      </div>

      {activeTab === "plan-templates" ? (
        <div className={planTemplatesCockpitOverrides}>
          <PlanTemplatesPanel companyId={selectedCompanyId} />
        </div>
      ) : (
        <div className="space-y-2">
          {/* 1-row cockpit strip: file roster · total size · save state · bundle root */}
          <div className="cockpit-strip h-10 w-full gap-0 overflow-hidden rounded-xl border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]" role="group" aria-label="Instruction files summary">
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Files</span><b className="ml-1">{bundleQuery.data ? files.length : "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Total size</span><b className="ml-1 font-mono">{bundleQuery.data ? `${totalBytes.toLocaleString()} B` : "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-1 justify-center">
              <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", saveFile.isPending ? "bg-blue-600 dark:bg-[#60a5fa]" : dirty ? "bg-amber-500 dark:bg-[#f59e0b]" : "bg-lime-500 dark:bg-[#a3e635]")} />
              <span className="truncate uppercase tracking-wide">Draft</span>
              <b className={cn("ml-1", dirty && "text-amber-700 dark:text-[#f59e0b]")}>{saveFile.isPending ? "Saving" : dirty ? "Unsaved" : "Saved"}</b>
            </div>
            <div className="cockpit-cell min-w-0 shrink-0"><span className="truncate uppercase tracking-wide">Company</span><b className="ml-1 truncate">{selectedCompany?.name ?? "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-[2] justify-center" title={rootPath}><span className="truncate uppercase tracking-wide">Root</span><b className="ml-1 truncate font-mono">{rootPath || "—"}</b></div>
          </div>

          <div className="grid min-h-[calc(100vh-15rem)] gap-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
            <aside className={cn("flex min-w-0 flex-col overflow-hidden", cockpitPanel)}>
              <div className="border-b border-slate-200/90 bg-slate-50/95 dark:border-white/[0.08] dark:bg-[#090c12] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h1 className={cockpitSectionHeader}>Instructions</h1>
                    <p className="text-xs text-slate-500 dark:text-[#8b97ad]"><b className="font-mono font-semibold text-slate-950 dark:text-[#eef2f8]">{files.length}</b> company files</p>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => bundleQuery.refetch()} disabled={bundleQuery.isFetching}
                    title="Refresh company instructions" className="size-7 text-slate-500 dark:text-[#8b97ad] hover:text-slate-900 dark:hover:text-[#eef2f8]">
                    <RefreshCw className={cn("h-3.5 w-3.5", bundleQuery.isFetching && "animate-spin")} />
                  </Button>
                </div>
                <p className={cn("mt-1.5 truncate text-[11px] text-slate-500 dark:text-[#8b97ad]", MONO_SNIPPET)} title={rootPath}>
                  {rootPath || selectedCompany?.name}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Input
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                    placeholder="common/research.md"
                    aria-label="New instruction file path"
                    className={cn(CONTROL, "h-7 flex-1 font-mono")}
                  />
                  <Button variant="ghost" size="icon-sm" onClick={() => createFile.mutate()} disabled={createFile.isPending}
                    title="Create instruction file" className="size-7 text-slate-500 dark:text-[#8b97ad] hover:text-slate-900 dark:hover:text-[#eef2f8]">
                    {createFile.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>

              {bundleQuery.isLoading ? (
                <PageSkeleton variant="list" />
              ) : bundleQuery.error ? (
                <div className="px-3 py-6 text-xs text-destructive">{bundleQuery.error.message}</div>
              ) : files.length === 0 ? (
                <div className="px-3 py-6 text-xs text-slate-500 dark:text-[#8b97ad]">No company instructions yet.</div>
              ) : (
                <div className="divide-y divide-slate-200/90 dark:divide-white/[0.06]">
                  {files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      aria-pressed={file.path === activePath}
                      onClick={() => {
                        setSelectedPath(file.path);
                        setDirty(false);
                      }}
                      className={cn(
                        "flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-[#60a5fa]",
                        file.path === activePath
                          ? "bg-blue-500/10 text-slate-950 shadow-[inset_2px_0_0_#2563eb] dark:bg-[#60a5fa]/12 dark:text-[#eef2f8] dark:shadow-[inset_2px_0_0_#60a5fa]"
                          : "text-slate-500 dark:text-[#8b97ad] hover:bg-slate-50 dark:hover:bg-[#141b29] hover:text-slate-900 dark:hover:text-[#eef2f8]",
                      )}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className={cn("min-w-0 flex-1 truncate font-mono", MONO_SNIPPET)} title={file.path}>{file.path}</span>
                      <span className="shrink-0 text-[10px] text-slate-400 dark:text-[#627089]">{file.size.toLocaleString()} B</span>
                    </button>
                  ))}
                </div>
              )}
            </aside>

            <main className={cn("flex min-w-0 flex-col", cockpitPanel)}>
              <div className="flex min-w-0 items-center gap-2 border-b border-slate-200/90 bg-slate-50/95 dark:border-white/[0.08] dark:bg-[#090c12] px-3 py-1.5">
                <h2 className={cn("min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-950 dark:text-[#eef2f8]", MONO_SNIPPET)} title={activePath ?? undefined}>
                  {activePath ?? "Company instructions"}
                </h2>
                <span className={cn("hidden truncate text-[11px] uppercase tracking-[0.16em] md:block", dirty ? "text-amber-700 dark:text-[#f59e0b]" : "text-slate-500 dark:text-[#8b97ad]")}>{statusText}</span>
              </div>

              {fileQuery.isLoading && activePath ? (
                <PageSkeleton variant="detail" />
              ) : fileQuery.error ? (
                <div className={cn("px-3 py-6 font-mono text-xs text-destructive", MONO_SNIPPET)}>
                  {fileQuery.error.message}
                </div>
              ) : activePath ? (
                <Textarea
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                  aria-label={`Instruction file ${activePath}`}
                  className={cn("min-h-[calc(100vh-14rem)] flex-1 resize-none rounded-none border-0 bg-white dark:bg-[#090c12] text-xs leading-5 text-slate-950 dark:text-[#eef2f8] shadow-none focus-visible:ring-0 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-[#60a5fa]", MONO_SNIPPET)}
                />
              ) : (
                <div className="px-3 py-10 text-xs text-slate-500 dark:text-[#8b97ad]">
                  Create or select a company instruction file.
                </div>
              )}
            </main>
          </div>
        </div>
      )}
    </div>
  );
}
