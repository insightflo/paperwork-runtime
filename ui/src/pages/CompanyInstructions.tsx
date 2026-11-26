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
// Cockpit palette: panel #111622, card #151b28, hairline #242d3f, ink #e6edf7, muted #8b97ad.
const cockpitSectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-[#8b97ad]";
const cockpitPanel = "rounded-md border border-[#242d3f] bg-[#151b28]";
const CONTROL =
  "h-7 rounded-md border border-[#242d3f] bg-[#0b0e14] px-2 text-xs text-[#e6edf7] outline-none focus:border-[#5f8dff] placeholder:text-[#5c6a84]";
const PRIMARY_CTA = "h-7 bg-[#2563eb] px-2.5 text-xs text-[#f8fafc] hover:bg-[#1d4fd8]";
const GHOST_CTA = "h-7 border border-[#242d3f] bg-[#111622] px-2.5 text-xs text-[#e6edf7] hover:bg-[#1a2131]";
const MONO_SNIPPET = "whitespace-pre-wrap font-mono";
const planTemplatesCockpitOverrides =
  "[&>div]:gap-3 " +
  "[&>div>aside]:overflow-hidden [&>div>aside]:rounded-md [&>div>aside]:border [&>div>aside]:border-[#242d3f] [&>div>aside]:bg-[#151b28] " +
  "[&>div>main]:rounded-md [&>div>main]:border [&>div>main]:border-[#242d3f] [&>div>main]:bg-[#151b28] [&>div>main]:p-4 " +
  "[&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-[#8b97ad] " +
  "[&_.border-b.border-border]:border-[#242d3f] [&_.rounded-md.border.border-border]:border-[#242d3f] [&_.rounded-md.border.border-border]:bg-[#111622] " +
  "[&_textarea]:whitespace-pre-wrap [&_textarea]:border-[#242d3f] [&_textarea]:bg-[#0b0e14] [&_textarea]:font-mono [&_textarea]:text-[#e6edf7] [&_textarea]:dark:bg-[#0b0e14] [&_textarea]:dark:text-[#e6edf7]";

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
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList variant="line" className="h-8 text-[#8b97ad] [&_[data-state=active]]:text-[#e6edf7] [&_[data-state=active]]:after:bg-[#5f8dff]">
            <TabsTrigger value="files">Instruction files</TabsTrigger>
            <TabsTrigger value="plan-templates">Plan templates</TabsTrigger>
          </TabsList>
        </Tabs>
        {activeTab === "files" && (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
            <span className={cn("hidden truncate text-[11px] uppercase tracking-[0.16em] sm:block", dirty ? "text-[#fbbf24]" : "text-[#8b97ad]")}>{statusText}</span>
            <Button variant="outline" size="sm" onClick={() => deleteFile.mutate()} disabled={!activePath || deleteFile.isPending}
              className={cn(GHOST_CTA, "text-[#f87171] hover:bg-[#f87171]/10")}>
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
          <div className="cockpit-strip w-full gap-0" role="group" aria-label="Instruction files summary">
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Files</span><b className="ml-1">{bundleQuery.data ? files.length : "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-1 justify-center"><span className="truncate uppercase tracking-wide">Total size</span><b className="ml-1 font-mono">{bundleQuery.data ? `${totalBytes.toLocaleString()} B` : "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-1 justify-center">
              <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", saveFile.isPending ? "bg-[#5f8dff]" : dirty ? "bg-[#fbbf24]" : "bg-[#34d399]")} />
              <span className="truncate uppercase tracking-wide">Draft</span>
              <b className={cn("ml-1", dirty && "text-[#fbbf24]")}>{saveFile.isPending ? "Saving" : dirty ? "Unsaved" : "Saved"}</b>
            </div>
            <div className="cockpit-cell min-w-0 shrink-0"><span className="truncate uppercase tracking-wide">Company</span><b className="ml-1 truncate">{selectedCompany?.name ?? "—"}</b></div>
            <div className="cockpit-cell min-w-0 flex-[2] justify-center" title={rootPath}><span className="truncate uppercase tracking-wide">Root</span><b className="ml-1 truncate font-mono">{rootPath || "—"}</b></div>
          </div>

          <div className="grid min-h-[calc(100vh-15rem)] gap-3 xl:grid-cols-[19rem_minmax(0,1fr)]">
            <aside className={cn("flex min-w-0 flex-col overflow-hidden", cockpitPanel)}>
              <div className="border-b border-[#242d3f] bg-[#111622] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h1 className={cockpitSectionHeader}>Instructions</h1>
                    <p className="text-xs text-[#8b97ad]"><b className="font-mono font-semibold text-[#e6edf7]">{files.length}</b> company files</p>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => bundleQuery.refetch()} disabled={bundleQuery.isFetching}
                    title="Refresh company instructions" className="size-7 text-[#8b97ad] hover:text-[#e6edf7]">
                    <RefreshCw className={cn("h-3.5 w-3.5", bundleQuery.isFetching && "animate-spin")} />
                  </Button>
                </div>
                <p className={cn("mt-1.5 truncate text-[11px] text-[#8b97ad]", MONO_SNIPPET)} title={rootPath}>
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
                    title="Create instruction file" className="size-7 text-[#8b97ad] hover:text-[#e6edf7]">
                    {createFile.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>

              {bundleQuery.isLoading ? (
                <PageSkeleton variant="list" />
              ) : bundleQuery.error ? (
                <div className="px-3 py-6 text-xs text-destructive">{bundleQuery.error.message}</div>
              ) : files.length === 0 ? (
                <div className="px-3 py-6 text-xs text-[#8b97ad]">No company instructions yet.</div>
              ) : (
                <div className="divide-y divide-[#242d3f]">
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
                        "flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-xs outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#5f8dff]",
                        file.path === activePath
                          ? "bg-[#2563eb]/15 text-[#e6edf7] shadow-[inset_2px_0_0_#5f8dff]"
                          : "text-[#8b97ad] hover:bg-[#1a2131] hover:text-[#e6edf7]",
                      )}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className={cn("min-w-0 flex-1 truncate font-mono", MONO_SNIPPET)} title={file.path}>{file.path}</span>
                      <span className="shrink-0 text-[10px] text-[#5c6a84]">{file.size.toLocaleString()} B</span>
                    </button>
                  ))}
                </div>
              )}
            </aside>

            <main className={cn("flex min-w-0 flex-col", cockpitPanel)}>
              <div className="flex min-w-0 items-center gap-2 border-b border-[#242d3f] bg-[#111622] px-3 py-1.5">
                <h2 className={cn("min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[#e6edf7]", MONO_SNIPPET)} title={activePath ?? undefined}>
                  {activePath ?? "Company instructions"}
                </h2>
                <span className={cn("hidden truncate text-[11px] uppercase tracking-[0.16em] md:block", dirty ? "text-[#fbbf24]" : "text-[#8b97ad]")}>{statusText}</span>
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
                  className={cn("min-h-[calc(100vh-14rem)] flex-1 resize-none rounded-none border-0 bg-[#0b0e14] text-xs leading-5 text-[#e6edf7] shadow-none focus-visible:ring-0 focus-visible:ring-inset focus-visible:ring-[#5f8dff]", MONO_SNIPPET)}
                />
              ) : (
                <div className="px-3 py-10 text-xs text-[#8b97ad]">
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
