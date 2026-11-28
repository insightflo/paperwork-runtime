import { useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Bot,
  Code,
  Gem,
  MousePointer2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

type AdvancedAdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "opencode_local"
  | "cursor";

const ADVANCED_ADAPTER_OPTIONS: Array<{
  value: AdvancedAdapterType;
  label: string;
  desc: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
}> = [
  {
    value: "claude_local",
    label: "Claude Code",
    icon: Sparkles,
    desc: "Local Claude agent",
    recommended: true,
  },
  {
    value: "codex_local",
    label: "Codex",
    icon: Code,
    desc: "Local Codex agent",
    recommended: true,
  },
  {
    value: "gemini_local",
    label: "Gemini CLI",
    icon: Gem,
    desc: "Local Gemini agent",
  },
  {
    value: "opencode_local",
    label: "OpenCode",
    icon: OpenCodeLogoIcon,
    desc: "Local multi-provider agent",
  },
  {
    value: "cursor",
    label: "Cursor",
    icon: MousePointer2,
    desc: "Local Cursor agent",
  },
];

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [showAdvancedCards, setShowAdvancedCards] = useState(false);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: "Create a new agent",
      description: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedConfig() {
    setShowAdvancedCards(true);
  }

  function handleAdvancedAdapterPick(adapterType: AdvancedAdapterType) {
    closeNewAgent();
    setShowAdvancedCards(false);
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          setShowAdvancedCards(false);
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="tactile-card gap-0 overflow-hidden overscroll-contain rounded-[12px] border-slate-200/90 p-0 dark:border-white/[0.08] dark:bg-[#0e131d] sm:max-w-md"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-white/70 px-4 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/[0.08] dark:bg-[#090c12]/85 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600 dark:text-[#8f9db3]">Add a new agent</span>
          <Button type="button" aria-label="Close new agent dialog"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground dark:hover:bg-white/[0.06]"
            onClick={() => {
              setShowAdvancedCards(false);
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="space-y-5 bg-transparent p-5">
          {!showAdvancedCards ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[#a3e635]/35 bg-[#a3e635]/15 shadow-[0_0_24px_rgba(163,230,53,0.18)]">
                  <Sparkles className="h-6 w-6 text-[#4d7c0f] dark:text-[#a3e635]" />
                </div>
                <p className="text-sm leading-6 text-slate-600 dark:text-[#8f9db3]">
                  We recommend letting your CEO handle agent setup — they know the
                  org structure and can configure reporting, permissions, and
                  adapters.
                </p>
              </div>

              <Button type="button" aria-label="Ask the CEO to create a new agent"
                className="w-full border border-[#2563eb]/50 bg-[#2563eb] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(37,99,235,0.65)] transition-colors hover:bg-[#1d4ed8] dark:border-[#60a5fa]/45 dark:bg-[#60a5fa] dark:text-[#08111f] dark:hover:bg-[#7db4fb]"
                size="lg"
                onClick={handleAskCeo}
              >
                <Bot className="h-4 w-4 mr-2" />
                Ask the CEO to create a new agent
              </Button>

              {/* Advanced link */}
              <div className="text-center">
                <button aria-label="I want advanced configuration myself"
                  type="button"
                  className="text-xs font-medium text-slate-500 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-[#2563eb] hover:decoration-[#2563eb] dark:text-[#8f9db3] dark:decoration-[#42506a] dark:hover:text-[#60a5fa] dark:hover:decoration-[#60a5fa]"
                  onClick={handleAdvancedConfig}
                >
                  I want advanced configuration myself
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <button aria-label="Back"
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-[#2563eb] dark:text-[#8f9db3] dark:hover:text-[#60a5fa]"
                  onClick={() => setShowAdvancedCards(false)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <p className="text-sm text-slate-600 dark:text-[#8f9db3]">
                  Choose your adapter type for advanced setup.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {ADVANCED_ADAPTER_OPTIONS.map((opt) => (
                  <button aria-label={`Configure ${opt.label}: ${opt.desc}`}
                    type="button"
                    key={opt.value}
                    className={cn(
                      "relative flex flex-col items-center gap-1.5 rounded-[12px] border border-slate-200/90 bg-white/85 p-3 text-xs text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] transition-colors duration-150 hover:border-[#2563eb]/40 hover:bg-[#2563eb]/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/45 dark:border-white/[0.08] dark:bg-[#090c12]/80 dark:text-[#eef2f8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-14px_rgba(0,0,0,0.7)] dark:hover:border-[#60a5fa]/45 dark:hover:bg-[#60a5fa]/10 dark:focus-visible:ring-[#60a5fa]/55"
                    )}
                    onClick={() => handleAdvancedAdapterPick(opt.value)}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 rounded-full border border-[#a3e635]/50 bg-[#a3e635]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-[#4d7c0f] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] dark:bg-[#a3e635]/12 dark:text-[#a3e635]">
                        Recommended
                      </span>
                    )}
                    <opt.icon className="h-4 w-4 text-[#2563eb] dark:text-[#60a5fa]" />
                    <span className="font-semibold tracking-tight">{opt.label}</span>
                    <span className="text-center text-[10px] leading-4 text-slate-500 dark:text-[#8f9db3]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
