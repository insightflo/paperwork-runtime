import { useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { channelApi, type ChannelConfig } from "../api/channel";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import { cn } from "../lib/utils";
import { ChannelCollaborationBoard } from "../components/ChannelCollaborationBoard";

type ConnectionStatus = "unknown" | "checking" | "connected" | "error";

// Combo 1 tactile cockpit primitives: light-legible cards over obsidian dark surfaces.
const CARD = "tactile-card dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]";
const FIELD = "border-slate-200/90 bg-white text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:placeholder:text-[#627089] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const CTA = "bg-blue-600 text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:text-[#f8fafc] dark:hover:bg-[#3b82f6]";
const TAB_CLASS =
  "h-6 cursor-pointer rounded-md px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-white aria-pressed:text-slate-950 aria-pressed:shadow-sm dark:aria-pressed:bg-[#151d2b] dark:aria-pressed:text-[#eef2f8] dark:aria-pressed:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] text-slate-600 hover:text-slate-950 dark:text-[#8b97ad] dark:hover:text-[#eef2f8]";
const STATUS_DOT: Record<ConnectionStatus, string> = { unknown: "bg-slate-400 dark:bg-[#64748b]", checking: "bg-amber-500 dark:bg-[#f59e0b]", connected: "bg-lime-500 dark:bg-[#a3e635]", error: "bg-rose-500 dark:bg-[#fb7185]" };
const STATUS_LABEL: Record<ConnectionStatus, string> = { unknown: "Not tested", checking: "Testing", connected: "Connected", error: "Failed" };

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

interface StatusIndicatorProps {
  status: ConnectionStatus;
  errorMessage?: string;
  botUsername?: string;
}

function StatusIndicator({ status, errorMessage, botUsername }: StatusIndicatorProps) {
  if (status === "unknown") {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-[#8b97ad]">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Not tested</span>
      </div>
    );
  }

  if (status === "checking") {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-[#8b97ad]">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
        <span>Testing connection...</span>
      </div>
    );
  }

  if (status === "connected") {
    return (
      <div className="flex items-center gap-2 text-sm text-lime-700 dark:text-[#a3e635]">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Connected
          {botUsername && (
            <span className="min-w-0 truncate text-slate-500 dark:text-[#8b97ad] ml-1">(@{botUsername})</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm text-destructive">
        <XCircle className="h-4 w-4 shrink-0" />
        <span>Connection failed</span>
      </div>
      {errorMessage && (
        <p className="pl-6 text-xs text-slate-500 dark:text-[#8b97ad]">{errorMessage}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TelegramSection
// ---------------------------------------------------------------------------

interface TelegramSectionProps {
  companyId: string;
  config: ChannelConfig | null;
  onStatusChange?: (status: ConnectionStatus, botUsername?: string) => void;
}

function TelegramSection({ companyId, config, onStatusChange }: TelegramSectionProps) {
  const queryClient = useQueryClient();

  // Form state
  const [botToken, setBotToken] = useState("");
  const [botUsername, setBotUsername] = useState(config?.botUsername ?? "");
  const [secretName, setSecretName] = useState("telegram_bot_token");
  const [formError, setFormError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Connection test state
  const [testStatus, setTestStatus] = useState<ConnectionStatus>(
    config?.botTokenSecretId ? "unknown" : "unknown",
  );
  const [testBotUsername, setTestBotUsername] = useState<string | undefined>();
  const [testError, setTestError] = useState<string | undefined>();

  // Existing secrets for secret selector
  const { data: secrets } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: !!companyId,
  });

  const createSecretMutation = useMutation({
    mutationFn: (value: string) =>
      secretsApi.create(companyId, {
        name: secretName,
        value,
        description: "Telegram bot token",
      }),
  });

  const updateConfigMutation = useMutation({
    mutationFn: (data: { botUsername: string; botTokenSecretId: string }) =>
      channelApi.updateConfig(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channel.config(companyId) });
      setBotToken("");
      setSaveSuccess(true);
      setFormError(null);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Failed to save config");
    },
  });

  const testMutation = useMutation({
    mutationFn: () => channelApi.test(companyId),
    onMutate: () => {
      setTestStatus("checking");
      setTestBotUsername(undefined);
      setTestError(undefined);
    },
    onSuccess: (result) => {
      if (result.ok) {
        setTestStatus("connected");
        setTestBotUsername(result.botUsername);
      } else {
        setTestStatus("error");
        setTestError(result.error ?? "Unknown error");
      }
    },
    onError: (err) => {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : "Test failed");
    },
  });

  const isConfigured = !!config?.botTokenSecretId;
  // Lifted so the page-level cockpit strip can show the live connection-test state.
  useEffect(() => {
    onStatusChange?.(testStatus, testBotUsername);
  }, [onStatusChange, testStatus, testBotUsername]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaveSuccess(false);

    if (!botUsername.trim()) {
      setFormError("Bot username is required");
      return;
    }

    try {
      let secretId = config?.botTokenSecretId ?? null;

      // If a new token was entered, store it as a secret first
      if (botToken.trim()) {
        const existingSecret = secrets?.find((s) => s.name === secretName);
        if (existingSecret) {
          await secretsApi.rotate(existingSecret.id, { value: botToken });
          secretId = existingSecret.id;
        } else {
          const created = await createSecretMutation.mutateAsync(botToken);
          secretId = created.id;
        }
      }

      if (!secretId) {
        setFormError("A bot token is required to configure the channel");
        return;
      }

      updateConfigMutation.mutate({ botUsername: botUsername.trim(), botTokenSecretId: secretId });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const isSaving =
    createSecretMutation.isPending || updateConfigMutation.isPending;

  return (
    <div className="space-y-5">
      {/* Status row */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate">
          <StatusIndicator
            status={testStatus}
            errorMessage={testError}
            botUsername={testBotUsername}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 border-slate-200/90 bg-white text-xs text-slate-700 hover:border-blue-500/40 hover:bg-slate-50 hover:text-slate-950 dark:border-white/[0.1] dark:bg-[#090c12] dark:text-[#eef2f8] dark:hover:border-[#60a5fa]/40 dark:hover:bg-[#141b29] dark:hover:text-[#eef2f8]"
          onClick={() => testMutation.mutate()}
          disabled={!isConfigured || testMutation.isPending}
          title={!isConfigured ? "Save a configuration first" : undefined}
        >
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", testMutation.isPending && "animate-spin")} />
          Test Connection
        </Button>
      </div>

      <Separator className="bg-slate-200 dark:bg-white/[0.08]" />

      {/* Config form */}
      <form onSubmit={handleSave} className="space-y-4 rounded-xl border border-slate-200/90 bg-slate-50/95 p-4 dark:border-white/[0.08] dark:bg-[#090c12]">
        {/* Bot username */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-500 dark:text-[#8b97ad]">
            Bot username
          </label>
          <Input
            className={`h-8 text-sm ${FIELD}`}
            value={botUsername}
            onChange={(e) => setBotUsername(e.target.value)}
            placeholder="e.g. papercompanyBot"
          />
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
            The Telegram username of your bot (without @).
          </p>
        </div>

        {/* Bot token */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-500 dark:text-[#8b97ad]">
            Bot token
            {isConfigured && (
              <span className="ml-2 font-normal text-lime-700 dark:text-[#a3e635]">
                (token stored — enter new value to rotate)
              </span>
            )}
          </label>
          <Input
            className={`h-8 text-sm font-mono ${FIELD}`}
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={isConfigured ? "Leave blank to keep existing token" : "123456789:ABCdef..."}
            autoComplete="off"
          />
          <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
            Obtain from @BotFather on Telegram. Stored encrypted in company secrets.
          </p>
        </div>

        {/* Secret name (only shown when not yet configured) */}
        {!isConfigured && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 dark:text-[#8b97ad]">
              Secret name
            </label>
            <Input
              className={`h-8 text-sm ${FIELD}`}
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              placeholder="telegram_bot_token"
            />
            <p className="text-xs text-slate-500 dark:text-[#8b97ad]">
              The name under which the token will be saved in company secrets.
            </p>
          </div>
        )}

        {/* Existing secret selector (if token already stored) */}
        {isConfigured && config?.botTokenSecretId && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-500 dark:text-[#8b97ad]">
              Stored secret
            </label>
            <p className="truncate font-mono text-xs text-slate-500 dark:text-[#8b97ad]">
              {secrets?.find((s) => s.id === config.botTokenSecretId)?.name ?? config.botTokenSecretId}
            </p>
          </div>
        )}

        {formError && (
          <p className="text-xs text-destructive">{formError}</p>
        )}

        {saveSuccess && (
          <p className="flex items-center gap-1.5 text-xs text-lime-700 dark:text-[#a3e635]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Configuration saved.
          </p>
        )}

        <div className="flex items-center justify-end pt-1">
          <Button
            type="submit"
            size="sm"
            className={`h-7 text-xs ${CTA}`}
            disabled={isSaving}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelConfig page
// ---------------------------------------------------------------------------

export function ChannelConfig() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [channelTab, setChannelTab] = useState<"board" | "telegram">("board");
  const [testStatus, setTestStatus] = useState<ConnectionStatus>("unknown");
  const [testedBotUsername, setTestedBotUsername] = useState<string | undefined>();
  const handleStatusChange = useCallback((status: ConnectionStatus, botUsername?: string) => {
    setTestStatus(status);
    setTestedBotUsername(botUsername);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Channel" }]);
  }, [setBreadcrumbs]);

  const { data: config, isLoading, error } = useQuery({
    queryKey: queryKeys.channel.config(selectedCompanyId!),
    queryFn: () => channelApi.getConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessageSquare} message="Select a company to configure channels." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  const isConfigured = !!config?.botTokenSecretId;
  const strip = [
    { label: "Telegram", value: !config ? "—" : config.enabled ? "Enabled" : "Disabled", dot: !config ? "bg-slate-400 dark:bg-[#64748b]" : config.enabled ? "bg-lime-500 dark:bg-[#a3e635]" : "bg-amber-500 dark:bg-[#f59e0b]" },
    { label: "Bot", value: !config ? "—" : config.botUsername ? `@${config.botUsername}` : "Not set", dot: "bg-blue-600 dark:bg-[#60a5fa]" },
    { label: "Token secret", value: !config ? "—" : isConfigured ? "Stored" : "Missing", dot: !config ? "bg-slate-400 dark:bg-[#64748b]" : isConfigured ? "bg-lime-500 dark:bg-[#a3e635]" : "bg-rose-500 dark:bg-[#fb7185]" },
    { label: "Connection test", value: STATUS_LABEL[testStatus], dot: STATUS_DOT[testStatus] },
  ];

  return (
    <div className="space-y-2 tabular-nums">
      {error && (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {/* 1-row 4-column cockpit strip; the Telegram cells jump to the Telegram tab */}
      <div className="cockpit-strip h-10 w-full gap-0 overflow-hidden rounded-xl border-slate-200/90 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_20px_-8px_rgba(0,0,0,0.65)]" role="group" aria-label="Channel summary">
        {strip.map((cell) => (
          <button
            key={cell.label}
            type="button"
            onClick={() => setChannelTab("telegram")}
            className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors ${channelTab === "telegram" ? "bg-slate-100/90 text-slate-950 shadow-[inset_0_-2px_0_#2563eb] dark:bg-[#151d2b] dark:text-[#edf2fb] dark:shadow-[inset_0_-2px_0_#60a5fa]" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-[#8b97ad] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"}`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1 truncate">{cell.value}</b>
          </button>
        ))}
      </div>

      {/* 40px unified toolbar: title · segmented tabs */}
      <div className="cockpit-toolbar tactile-card h-10 rounded-xl px-2 dark:bg-none dark:border-white/[0.08] dark:bg-[#0e131d]">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-sm font-semibold text-slate-950 dark:text-[#eef2f8]">Channel Configuration</h1>
          <span className="hidden truncate text-xs text-slate-500 dark:text-[#8b97ad] md:inline">Configure external messaging channels for agent notifications.</span>
        </div>
        <div role="group" aria-label="Channel views" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200/90 bg-slate-100/90 p-0.5 dark:border-white/[0.08] dark:bg-[#090c12]">
          {([
            { id: "board", label: "협업 채널 보드" },
            { id: "telegram", label: "Telegram 연동 설정" },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={channelTab === tab.id}
              onClick={() => setChannelTab(tab.id)}
              className={TAB_CLASS}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {channelTab === "board" && (
        <ChannelCollaborationBoard companyId={selectedCompanyId} />
      )}

      {channelTab === "telegram" && (
        /* Telegram section */
        <div className={`w-full max-w-4xl space-y-4 p-4 ${CARD}`}>
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-slate-500 dark:text-[#8b97ad]" />
            <h2 className="truncate text-sm font-medium text-slate-950 dark:text-[#eef2f8]">Telegram</h2>
            {config?.enabled && (
              <span className="rounded-full border border-lime-500/30 bg-lime-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]">
                Enabled
              </span>
            )}
            {config && !config.enabled && (
              <span className="rounded-full border border-slate-200/90 bg-slate-100/80 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]">
                Disabled
              </span>
            )}
          </div>

          <TelegramSection companyId={selectedCompanyId} config={config ?? null} onStatusChange={handleStatusChange} />
        </div>
      )}
    </div>
  );
}
