import { useEffect, useMemo, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillListItem,
  CompanySkillProjectScanResult,
  CompanySkillSourceBadge,
  CompanySkillUpdateStatus,
} from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { ToolAdminPanel } from "./company-skills/ToolAdminPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Link2,
  ExternalLink,
  FileCheck2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Wrench,
} from "lucide-react";

// Cockpit primitives (approved Linear + Datadog palette; mirrors .cockpit-strip/.cockpit-toolbar).
const CARD = "tactile-card rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const STRIP_CLASS = "cockpit-strip tactile-card h-8 w-full gap-0 overflow-x-auto rounded-[12px] border-slate-200/90 bg-white/95 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const TOOLBAR_CLASS = "cockpit-toolbar tactile-card h-10 w-full overflow-x-auto rounded-[12px] border-slate-200/90 bg-white/95 px-2 dark:border-white/[0.08] dark:bg-none dark:bg-[#0e131d]";
const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]";
const CTA = "bg-blue-600 text-[#f8fafc] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]";
const TAB_CLASS =
  "h-7 cursor-pointer rounded-md px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 dark:focus-visible:ring-[#60a5fa]/30 aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-[inset_0_-2px_0_#65a30d,0_1px_2px_rgba(15,23,42,0.08)] dark:aria-pressed:bg-[#141c2b] dark:aria-pressed:text-[#edf2fb] dark:aria-pressed:shadow-[inset_0_-2px_0_#a3e635,inset_0_1px_0_rgba(255,255,255,0.08)] text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]";

type SkillTreeNode = {
  name: string;
  path: string | null;
  kind: "dir" | "file";
  fileKind?: CompanySkillFileInventoryEntry["kind"];
  children: SkillTreeNode[];
};

const SKILL_TREE_BASE_INDENT = 16;
const SKILL_TREE_STEP_INDENT = 24;
const SKILL_TREE_ROW_HEIGHT_CLASS = "min-h-9";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 4 21 19H3z" />
    </svg>
  );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string) {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function buildTree(entries: CompanySkillFileInventoryEntry[]) {
  const root: SkillTreeNode = { name: "", path: null, kind: "dir", children: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let next = current.children.find((child) => child.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: isLeaf ? entry.path : currentPath,
          kind: isLeaf ? "file" : "dir",
          fileKind: isLeaf ? entry.kind : undefined,
          children: [],
        };
        current.children.push(next);
      }
      current = next;
    }
  }

  function sortNode(node: SkillTreeNode) {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
      if (left.name === "SKILL.md") return -1;
      if (right.name === "SKILL.md") return 1;
      return left.name.localeCompare(right.name);
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

function sourceMeta(sourceBadge: CompanySkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "skills_sh":
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: "GitHub managed" };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: "URL managed" };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: "Folder managed" };
    case "paperclip":
      return { icon: FileCheck2, label: sourceLabel ?? "Paperwork", managedLabel: "Paperwork managed" };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: "Catalog managed" };
  }
}

function shortRef(ref: string | null | undefined) {
  if (!ref) return null;
  return ref.slice(0, 7);
}

function formatProjectScanSummary(result: CompanySkillProjectScanResult) {
  const parts = [
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedWorkspaces} workspace${result.scannedWorkspaces === 1 ? "" : "s"}.`;
}

function fileIcon(kind: CompanySkillFileInventoryEntry["kind"]) {
  if (kind === "script" || kind === "reference") return FileCode2;
  return FileText;
}

function encodeSkillFilePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function parseSkillRoute(routePath: string | undefined) {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  if (rawMode === "files") {
    return {
      skillId,
      filePath: decodeSkillFilePath(rest.join("/")),
    };
  }

  return { skillId, filePath: "SKILL.md" };
}

function skillRoute(skillId: string, filePath?: string | null) {
  return filePath ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}` : `/skills/${skillId}`;
}

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
}

function NewSkillForm({
  onCreate,
  isPending,
  onCancel,
}: {
  onCreate: (payload: CompanySkillCreateRequest) => void;
  isPending: boolean;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [sourceLocator, setSourceLocator] = useState("");
  const canCreate = name.trim().length > 0 || sourceLocator.trim().length > 0;

  return (
    <div className="border-b border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0e131d] px-4 py-4">
      <div className="space-y-3">
        <Input
          aria-label="Skill name" value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Skill name"
          className="h-9 rounded-none border-0 border-b border-slate-200/90 dark:border-white/[0.08] px-0 text-slate-900 dark:text-[#edf2fb] shadow-none focus-visible:ring-0"
        />
        <Input
          aria-label="Skill shortname (optional)" value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="optional-shortname"
          className="h-9 rounded-none border-0 border-b border-slate-200/90 dark:border-white/[0.08] px-0 text-slate-900 dark:text-[#edf2fb] shadow-none focus-visible:ring-0"
        />
        <Input
          aria-label="Skill source path" value={sourceLocator}
          onChange={(event) => setSourceLocator(event.target.value)}
          placeholder="/srv/papercompany/company-skills/my-skill"
          className="h-9 rounded-none border-0 border-b border-slate-200/90 dark:border-white/[0.08] px-0 text-slate-900 dark:text-[#edf2fb] shadow-none focus-visible:ring-0"
        />
        <Textarea
          aria-label="Short description" value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Short description"
          className="min-h-20 rounded-none border-0 border-b border-slate-200/90 dark:border-white/[0.08] px-0 text-slate-900 dark:text-[#edf2fb] shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            className={`h-7 text-xs ${CTA}`}
            onClick={() => onCreate({
              name: name.trim() || null,
              slug: slug.trim() || null,
              description: description.trim() || null,
              sourceLocator: sourceLocator.trim() || null,
            })}
            disabled={isPending || !canCreate}
          >
            {isPending ? "Creating..." : "Create skill"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillTree({
  nodes,
  skillId,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectPath,
  depth = 0,
}: {
  nodes: SkillTreeNode[];
  skillId: string;
  selectedPath: string;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && node.path ? expandedDirs.has(node.path) : false;
        if (node.kind === "dir") {
          return (
            <div key={node.path ?? node.name}>
              <div
                className={cn(
                  "group grid w-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  SKILL_TREE_ROW_HEIGHT_CLASS,
                )}
              >
                <button
                  type="button" aria-expanded={expanded}
                  className="flex min-w-0 items-center gap-2 py-1 text-left"
                  style={{ paddingLeft: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {expanded ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
                  </span>
                  <span className="truncate">{node.name}</span>
                </button>
                <button
                  type="button" aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`} aria-expanded={expanded}
                  className="flex h-9 w-9 items-center justify-center self-center rounded-sm text-muted-foreground opacity-70 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                  onClick={() => node.path && onToggleDir(node.path)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </div>
              {expanded && (
                <SkillTree
                  nodes={node.children}
                  skillId={skillId}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelectPath={onSelectPath}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        const FileIcon = fileIcon(node.fileKind ?? "other");
        return (
          <Link
            key={node.path ?? node.name}
            className={cn(
              "flex w-full items-center gap-2 pr-3 text-left text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              SKILL_TREE_ROW_HEIGHT_CLASS,
              node.path === selectedPath && "bg-slate-50 text-foreground shadow-[inset_2px_0_0_#65a30d] dark:bg-[#141b29] dark:shadow-[inset_2px_0_0_#a3e635]",
            )}
            style={{ paddingInlineStart: `${SKILL_TREE_BASE_INDENT + depth * SKILL_TREE_STEP_INDENT}px` }}
            to={skillRoute(skillId, node.path)}
            onClick={() => node.path && onSelectPath(node.path)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <FileIcon className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{node.name}</span>
          </Link>
        );
      })}
    </div>
  );
}

function SkillList({
  skills,
  selectedSkillId,
  skillFilter,
  expandedSkillId,
  expandedDirs,
  selectedPaths,
  onToggleSkill,
  onToggleDir,
  onSelectSkill,
  onSelectPath,
}: {
  skills: CompanySkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  expandedSkillId: string | null;
  expandedDirs: Record<string, Set<string>>;
  selectedPaths: Record<string, string>;
  onToggleSkill: (skillId: string) => void;
  onToggleDir: (skillId: string, path: string) => void;
  onSelectSkill: (skillId: string) => void;
  onSelectPath: (skillId: string, path: string) => void;
}) {
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredSkills.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No skills match this filter.
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 py-3">
      {filteredSkills.map((skill) => {
        const expanded = expandedSkillId === skill.id;
        const tree = buildTree(skill.fileInventory);
        const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
        const SourceIcon = source.icon;

        return (
          <div key={skill.id} className={`overflow-hidden ${CARD}`}>
            <div
              className={cn(
                "group grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-1 px-3 py-1.5 hover:bg-accent/30",
                skill.id === selectedSkillId && "bg-slate-50 text-foreground shadow-[inset_2px_0_0_#65a30d] dark:bg-[#141b29] dark:shadow-[inset_2px_0_0_#a3e635]",
              )}
            >
              <Link
                to={skillRoute(skill.id)}
                className="flex min-w-0 items-center self-stretch pr-2 text-left no-underline"
                onClick={() => onSelectSkill(skill.id)}
              >
                <span className="flex min-w-0 items-center gap-2 self-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-75 transition-opacity group-hover:opacity-100">
                        <SourceIcon className="h-3.5 w-3.5" />
                        <span className="sr-only">{source.managedLabel}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{source.managedLabel}</TooltipContent>
                  </Tooltip>
                  <span className="min-w-0 overflow-hidden text-[13px] font-medium leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {skill.name}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground opacity-80 transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={() => onToggleSkill(skill.id)}
                aria-label={expanded ? `Collapse ${skill.name}` : `Expand ${skill.name}`} aria-expanded={expanded}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div
              aria-hidden={!expanded} inert={!expanded}
              className={cn(
                "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <SkillTree
                  nodes={tree}
                  skillId={skill.id}
                  selectedPath={selectedPaths[skill.id] ?? "SKILL.md"}
                  expandedDirs={expandedDirs[skill.id] ?? new Set<string>()}
                  onToggleDir={(path) => onToggleDir(skill.id, path)}
                  onSelectPath={(path) => onSelectPath(skill.id, path)}
                  depth={1}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SkillPane({
  loading,
  detail,
  file,
  fileLoading,
  updateStatus,
  updateStatusLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onSave,
  savePending,
  canWrite,
}: {
  loading: boolean;
  detail: CompanySkillDetail | null | undefined;
  file: CompanySkillFileDetail | null | undefined;
  fileLoading: boolean;
  updateStatus: CompanySkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onSave: () => void;
  savePending: boolean;
  canWrite: boolean;
}) {
  const { pushToast } = useToast();

  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return <EmptyState icon={Boxes} message="Select a skill to inspect its files." />;
  }

  const source = sourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = source.icon;
  const usedBy = detail.usedByAgents;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);

  return (
    <div className="min-w-0">
      <div className="cockpit-toolbar h-10 border-b border-slate-200/90 px-3 dark:border-white/[0.08]">
        <SourceIcon className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
        <h1 className="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">{detail.name}</h1>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500 dark:text-[#8b97ad]">{detail.description ?? ""}</span>
        {detail.editable && canWrite ? (
          <button
            type="button"
            className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"
            onClick={() => setEditMode(!editMode)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {editMode ? "Stop editing" : "Edit"}
          </button>
        ) : (
          <span
            className="ml-auto min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]"
            title={detail.editable ? "Member, admin, or owner role required to edit skills" : undefined}
          >
            {detail.editable ? "Read-only (role)" : detail.editableReason}
          </span>
        )}
      </div>

      <div className="space-y-2 border-b border-slate-200/90 px-3 py-2 text-xs dark:border-white/[0.08]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={LABEL}>Source</span>
              <span className="flex min-w-0 items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
                {detail.sourcePath ? (
                  <button
                    type="button"
                    className="truncate text-slate-500 dark:text-[#8b97ad] transition-colors hover:text-slate-950 dark:hover:text-[#edf2fb] cursor-pointer"
                    onClick={() => {
                      navigator.clipboard.writeText(detail.sourcePath!);
                      pushToast({ title: "Copied path to workspace" });
                    }}
                  >
                    {source.label}
                  </button>
                ) : (
                  <span className="truncate text-slate-500 dark:text-[#8b97ad]">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "github" && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={LABEL}>Pin</span>
                <span className="font-mono text-xs text-blue-600 dark:text-[#60a5fa]">{currentPin ?? "untracked"}</span>
                {updateStatus?.trackingRef && (
                  <span className="truncate text-xs text-slate-500 dark:text-[#8b97ad]">tracking {updateStatus.trackingRef}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0e131d] text-xs text-slate-900 dark:text-[#edf2fb] hover:bg-slate-100 dark:hover:bg-[#141b29] hover:text-slate-950 dark:hover:text-[#edf2fb]"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  Check for updates
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    className={`h-7 text-xs ${CTA}`}
                    onClick={() => {
                      if (!canWrite) return;
                      onInstallUpdate();
                    }}
                    disabled={installUpdatePending || !canWrite}
                    title={!canWrite ? "Member, admin, or owner role required to install skill updates" : undefined}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    Install update{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span aria-live="polite" className="text-xs text-lime-700 dark:text-[#a3e635]">Up to date</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span aria-live="polite" className="min-w-0 truncate text-xs text-slate-500 dark:text-[#8b97ad]">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <span className={LABEL}>Key</span>
              <span className="truncate font-mono text-xs text-slate-900 dark:text-[#edf2fb]">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={LABEL}>Mode</span>
              <span className={detail.editable ? "text-lime-700 dark:text-[#a3e635]" : "text-slate-500 dark:text-[#8b97ad]"}>{detail.editable ? "Editable" : "Read only"}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
            <span className={LABEL}>Used by</span>
            {usedBy.length === 0 ? (
              <span className="text-slate-500 dark:text-[#8b97ad]">No agents attached</span>
            ) : (
              <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="min-w-0 truncate text-slate-900 dark:text-[#edf2fb] no-underline hover:underline"
                  >
                    {agent.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

      <div className="border-b border-slate-200/90 px-3 py-2 dark:border-white/[0.08]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm text-slate-900 dark:text-[#edf2fb]">{file?.path ?? "SKILL.md"}</div>
          </div>
          <div className="flex items-center gap-2">
            {file?.markdown && !editMode && (
              <div className="flex items-center overflow-hidden rounded-md border border-slate-200/90 bg-slate-100 dark:border-white/[0.08] dark:bg-[#090c12]">
                <button
                  type="button"
                  className={cn("px-3 py-1.5 text-sm", viewMode === "preview" && "bg-white text-slate-900 shadow-[inset_0_-2px_0_#65a30d] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#a3e635]", viewMode !== "preview" && "text-slate-500 dark:text-[#8b97ad]")}
                  onClick={() => setViewMode("preview")}
                >
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </span>
                </button>
                <button
                  type="button"
                  className={cn("border-l border-slate-200/90 dark:border-white/[0.08] px-3 py-1.5 text-sm", viewMode === "code" && "bg-white text-slate-900 shadow-[inset_0_-2px_0_#65a30d] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#a3e635]", viewMode !== "code" && "text-slate-500 dark:text-[#8b97ad]")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    Code
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" className="text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]" onClick={() => setEditMode(false)} disabled={savePending}>
                  Cancel
                </Button>
                <Button size="sm" className={`h-7 text-xs ${CTA}`} onClick={() => { if (!canWrite) return; onSave(); }} disabled={savePending || !canWrite} title={!canWrite ? "Member, admin, or owner role required to edit skills" : undefined}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-[560px] px-4 py-4">
        {fileLoading ? (
          <PageSkeleton variant="detail" />
        ) : !file ? (
          <div className="text-sm text-slate-500 dark:text-[#8b97ad]">Select a file to inspect.</div>
        ) : editMode && file.editable ? (
          file.markdown ? (
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              bordered={false}
              className="min-h-[520px]"
            />
          ) : (
            <Textarea aria-label="Skill file contents"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
            />
          )
        ) : file.markdown && viewMode === "preview" ? (
          <MarkdownBody>{body}</MarkdownBody>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{file.content}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export function CompanySkills() {
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId, canWrite = true, currentRole } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [surface, setSurface] = useState<"skills" | "tools">("skills");
  const [createOpen, setCreateOpen] = useState(false);
  const [emptySourceHelpOpen, setEmptySourceHelpOpen] = useState(false);
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [displayedDetail, setDisplayedDetail] = useState<CompanySkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<CompanySkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      ...(routeSkillId ? [{ label: "Detail" }] : []),
    ]);
  }, [routeSkillId, setBreadcrumbs]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const selectedSkillId = useMemo(() => {
    if (!routeSkillId) return skillsQuery.data?.[0]?.id ?? null;
    return routeSkillId;
  }, [routeSkillId, skillsQuery.data]);

  useEffect(() => {
    if (routeSkillId || !selectedSkillId) return;
    navigate(skillRoute(selectedSkillId), { replace: true });
  }, [navigate, routeSkillId, selectedSkillId]);

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(selectedCompanyId && selectedSkillId),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(selectedCompanyId ?? "", selectedSkillId ?? "", selectedPath),
    queryFn: () => companySkillsApi.file(selectedCompanyId!, selectedSkillId!, selectedPath),
    enabled: Boolean(selectedCompanyId && selectedSkillId && selectedPath),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId ?? "", selectedSkillId ?? ""),
    queryFn: () => companySkillsApi.updateStatus(selectedCompanyId!, selectedSkillId!),
    enabled: Boolean(
      selectedCompanyId
      && selectedSkillId
      && (detailQuery.data?.sourceType === "github" || displayedDetail?.sourceType === "github"),
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    setExpandedSkillId(selectedSkillId);
  }, [selectedSkillId]);

  useEffect(() => {
    if (!selectedSkillId || selectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(selectedPath);
    if (parents.length === 0) return;
    setExpandedDirs((current) => {
      const next = new Set(current[selectedSkillId] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedSkillId]: next } : current;
    });
  }, [selectedPath, selectedSkillId]);

  useEffect(() => {
    void selectedSkillId;
    setEditMode(false);
  }, [selectedSkillId]);

  useEffect(() => {
    if (detailQuery.data) {
      setDisplayedDetail(detailQuery.data);
    }
  }, [detailQuery.data]);

  useEffect(() => {
    if (fileQuery.data) {
      setDisplayedFile(fileQuery.data);
      setDraft(fileQuery.data.markdown ? splitFrontmatter(fileQuery.data.content).body : fileQuery.data.content);
    }
  }, [fileQuery.data]);

  useEffect(() => {
    if (selectedSkillId) return;
    setDisplayedDetail(null);
    setDisplayedFile(null);
  }, [selectedSkillId]);

  const activeDetail = detailQuery.data ?? displayedDetail;
  const activeFile = fileQuery.data ?? displayedFile;

  const importSkill = useMutation({
    mutationFn: (importSource: string) => companySkillsApi.importFromSource(selectedCompanyId!, importSource),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      if (result.imported[0]) navigate(skillRoute(result.imported[0].id));
      pushToast({
        tone: "success",
        title: "Skills imported",
        body: `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added.`,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Import warnings", body: result.warnings[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: error instanceof Error ? error.message : "Failed to import skill source.",
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: CompanySkillCreateRequest) => companySkillsApi.create(selectedCompanyId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      navigate(skillRoute(skill.id));
      setCreateOpen(false);
      pushToast({
        tone: "success",
        title: "Skill created",
        body: `${skill.name} is now editable in the Paperwork workspace.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  const scanProjects = useMutation({
    mutationFn: () => companySkillsApi.scanProjects(selectedCompanyId!),
    onMutate: () => {
      setScanStatusMessage("Scanning project workspaces for skills...");
    },
    onSuccess: async (result) => {
      setScanStatusMessage("Refreshing skills list...");
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) });
      const summary = formatProjectScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: "Project skill scan complete",
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: "Skill conflicts found",
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: "Scan warnings",
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: "Project skill scan failed",
        body: error instanceof Error ? error.message : "Failed to scan project workspaces.",
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: () => companySkillsApi.updateFile(
      selectedCompanyId!,
      selectedSkillId!,
      selectedPath,
      activeFile?.markdown ? mergeFrontmatter(activeFile.content, draft) : draft,
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      setDraft(result.markdown ? splitFrontmatter(result.content).body : result.content);
      setEditMode(false);
      pushToast({
        tone: "success",
        title: "Skill saved",
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save skill file.",
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => companySkillsApi.installUpdate(selectedCompanyId!, selectedSkillId!),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.updateStatus(selectedCompanyId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.file(selectedCompanyId!, selectedSkillId!, selectedPath) }),
      ]);
      navigate(skillRoute(skill.id, selectedPath));
      pushToast({
        tone: "success",
        title: "Skill updated",
        body: skill.sourceRef ? `Pinned to ${shortRef(skill.sourceRef)}` : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to install skill update.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Boxes} message="Select a company to manage skills." />;
  }

  function handleAddSkillSource() {
    if (!canWrite) return;
    const trimmedSource = source.trim();
    if (trimmedSource.length === 0) {
      setEmptySourceHelpOpen(true);
      return;
    }
    importSkill.mutate(trimmedSource);
  }

  const skillList = skillsQuery.data ?? [];
  const editableCount = skillList.filter((skill) => skill.editable).length;
  const skillStrip = [
    { label: "Skills", value: skillsQuery.data ? skillList.length : "—", dot: "bg-blue-500 dark:bg-[#60a5fa]" },
    { label: "Editable", value: skillsQuery.data ? editableCount : "—", dot: "bg-lime-500 dark:bg-[#a3e635]" },
    { label: "Read only", value: skillsQuery.data ? skillList.length - editableCount : "—", dot: "bg-slate-400 dark:bg-[#8b97ad]" },
    { label: "GitHub pinned", value: skillsQuery.data ? skillList.filter((skill) => skill.sourceBadge === "github").length : "—", dot: "bg-amber-500 dark:bg-[#f59e0b]" },
    { label: "Agent attachments", value: skillsQuery.data ? skillList.reduce((sum, skill) => sum + skill.attachedAgentCount, 0) : "—", dot: "bg-blue-500 dark:bg-[#60a5fa]" },
  ];

  return (
    <>
      <Dialog open={emptySourceHelpOpen} onOpenChange={setEmptySourceHelpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a skill source</DialogTitle>
            <DialogDescription>
              Paste a local path, GitHub URL, or `skills.sh` command into the field first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start justify-between px-3 py-3 text-slate-900 dark:text-[#edf2fb] no-underline transition-colors hover:bg-slate-100 dark:hover:bg-[#141b29] border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0e131d] rounded-md"
            >
              <span className="min-w-0">
                <span className="block font-medium">Browse skills.sh</span>
                <span className="mt-1 block text-slate-500 dark:text-[#8b97ad]">
                  Find install commands and paste one here.
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
            </a>
            <a
              href="https://github.com/search?q=SKILL.md&type=code"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start justify-between px-3 py-3 text-slate-900 dark:text-[#edf2fb] no-underline transition-colors hover:bg-slate-100 dark:hover:bg-[#141b29] border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#0e131d] rounded-md"
            >
              <span className="min-w-0">
                <span className="block font-medium">Search GitHub</span>
                <span className="mt-1 block text-slate-500 dark:text-[#8b97ad]">
                  Look for repositories with `SKILL.md`, then paste the repo URL here.
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
            </a>
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <div className="space-y-2 tabular-nums">
      {/* 1-row 5-column cockpit strip: live skill library summary */}
      <div className={STRIP_CLASS} role="group" aria-label="Skills summary">
        {skillStrip.map((cell) => (
          <div key={cell.label} className="cockpit-cell min-w-[5.5rem] flex-1 justify-center">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1 min-w-0 truncate font-semibold text-slate-950 dark:text-[#edf2fb]">{cell.value}</b>
          </div>
        ))}
      </div>

      {/* 40px unified toolbar: Skills / Tools surface switch */}
      <div className={TOOLBAR_CLASS}>
        <div role="group" aria-label="Skills surfaces" className="flex shrink-0 items-center gap-0.5 rounded-md border border-slate-200/90 dark:border-white/[0.08] bg-slate-100 dark:bg-[#090c12] p-0.5">
          {([
            { key: "skills", label: "Skills", icon: Boxes },
            { key: "tools", label: "Tools", icon: Wrench },
          ] as const).map((tab) => (
            <button key={tab.key} type="button" aria-pressed={surface === tab.key} onClick={() => setSurface(tab.key)} className={TAB_CLASS}>
              <tab.icon className="mr-1 inline h-3 w-3 align-[-2px]" aria-hidden />{tab.label}
            </button>
          ))}
        </div>
        <h1 className="ml-3 truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">Company Skills</h1>
        <span className="truncate text-xs text-slate-500 dark:text-[#8b97ad]">Skill library shared by agents in this company</span>
        {!canWrite && (
          <span
            className="ml-auto inline-flex shrink-0 items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-[#f59e0b]/35 dark:bg-[#f59e0b]/12 dark:text-[#fde68a]"
            title="Member, admin, or owner role required to import, create, edit, or update skills"
          >
            Read-only{currentRole ? ` (${currentRole})` : ""}
          </span>
        )}
      </div>

      {surface === "tools" ? (
        <ToolAdminPanel companyId={selectedCompanyId} />
      ) : (
      <div className="grid min-h-[calc(100vh-13rem)] min-w-0 gap-3 tabular-nums xl:grid-cols-[21rem_minmax(0,1fr)] 2xl:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className={cn(CARD, "min-w-0 overflow-hidden")}>
          <div className="border-b border-slate-200/90 dark:border-white/[0.08] px-4 py-3">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className={LABEL}>Skills</h2>
                <p className="truncate text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">
                  {skillsQuery.data?.length ?? 0} available
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm" type="button" aria-label="Scan project workspaces for skills"
                  className="text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]"
                  onClick={() => {
                    if (!canWrite) return;
                    scanProjects.mutate();
                  }}
                  disabled={scanProjects.isPending || !canWrite}
                  title={!canWrite ? "Member, admin, or owner role required to scan for skills" : "Scan project workspaces for skills"}
                >
                  <RefreshCw className={cn("h-4 w-4", scanProjects.isPending && "animate-spin")} />
                </Button>
                <Button variant="ghost" size="icon-sm" type="button" aria-label="Create a new skill" className="text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]" onClick={() => { if (!canWrite) return; setCreateOpen((value) => !value); }} disabled={!canWrite} title={!canWrite ? "Member, admin, or owner role required to create skills" : "Create a new skill"}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-slate-200/90 bg-white px-2 pb-2 pt-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#0e131d] dark:focus-within:border-[#60a5fa] dark:focus-within:ring-[#60a5fa]/25">
              <Search className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
              <input
                aria-label="Filter skills" value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
                placeholder="Filter skills"
                className="w-full bg-transparent text-sm text-slate-900 dark:text-[#edf2fb] outline-none placeholder:text-slate-400 dark:placeholder:text-[#8b97ad]"
              />
            </div>

            <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-slate-200/90 bg-white px-2 pb-2 pt-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#0e131d] dark:focus-within:border-[#60a5fa] dark:focus-within:ring-[#60a5fa]/25">
              <input
                aria-label="Skill source to import" value={source}
                onChange={(event) => setSource(event.target.value)}
                placeholder="Paste path, GitHub URL, or skills.sh command"
                disabled={!canWrite}
                className="w-full bg-transparent text-sm text-slate-900 dark:text-[#edf2fb] outline-none placeholder:text-slate-400 dark:placeholder:text-[#8b97ad] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <Button
                size="sm" type="button" aria-label="Add skill source"
                variant="ghost"
                className="shrink-0 text-slate-500 dark:text-[#8b97ad] hover:text-slate-950 dark:hover:text-[#edf2fb]"
                onClick={handleAddSkillSource}
                disabled={importSkill.isPending || !canWrite}
                title={!canWrite ? "Member, admin, or owner role required to import skills" : undefined}
              >
                {importSkill.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Add"}
              </Button>
            </div>
            {scanStatusMessage && (
              <p aria-live="polite" className="mt-3 truncate text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">
                {scanStatusMessage}
              </p>
            )}
          </div>

          {createOpen && (
            <NewSkillForm
              onCreate={(payload) => createSkill.mutate(payload)}
              isPending={createSkill.isPending}
              onCancel={() => setCreateOpen(false)}
            />
          )}

          {skillsQuery.isLoading ? (
            <PageSkeleton variant="list" />
          ) : skillsQuery.error ? (
            <div role="alert" className="px-4 py-6 text-sm text-destructive">{skillsQuery.error.message}</div>
          ) : (
            <SkillList
              skills={skillsQuery.data ?? []}
              selectedSkillId={selectedSkillId}
              skillFilter={skillFilter}
              expandedSkillId={expandedSkillId}
              expandedDirs={expandedDirs}
              selectedPaths={selectedSkillId ? { [selectedSkillId]: selectedPath } : {}}
              onToggleSkill={(currentSkillId) =>
                setExpandedSkillId((current) => current === currentSkillId ? null : currentSkillId)
              }
              onToggleDir={(currentSkillId, path) => {
                setExpandedDirs((current) => {
                  const next = new Set(current[currentSkillId] ?? []);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return { ...current, [currentSkillId]: next };
                });
              }}
              onSelectSkill={(currentSkillId) => setExpandedSkillId(currentSkillId)}
              onSelectPath={() => {}}
            />
          )}
        </aside>

        <div className={cn(CARD, "min-w-0 overflow-hidden")}>
          <SkillPane
            loading={skillsQuery.isLoading || detailQuery.isLoading}
            detail={activeDetail}
            file={activeFile}
            fileLoading={fileQuery.isLoading && !activeFile}
            updateStatus={updateStatusQuery.data}
            updateStatusLoading={updateStatusQuery.isLoading}
            viewMode={viewMode}
            editMode={editMode}
            draft={draft}
            setViewMode={setViewMode}
            setEditMode={setEditMode}
            setDraft={setDraft}
            onCheckUpdates={() => {
              void updateStatusQuery.refetch();
            }}
            checkUpdatesPending={updateStatusQuery.isFetching}
            onInstallUpdate={() => installUpdate.mutate()}
            installUpdatePending={installUpdate.isPending}
            onSave={() => {
              if (!canWrite) return;
              saveFile.mutate();
            }}
            savePending={saveFile.isPending}
            canWrite={canWrite}
          />
        </div>
      </div>
      )}
      </div>
    </>
  );
}
