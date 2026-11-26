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

// Cockpit primitives (approved Linear + Datadog palette; mirrors .cockpit-strip/.cockpit-toolbar).
const CARD = "rounded-md border border-[#242d3f] bg-[#151b28]";
const FIELD = "border-[#242d3f] bg-[#111622] text-[#e6edf7] outline-none focus:border-[#5f8dff] focus:ring-[#5f8dff]/40";
const CTA = "bg-[#2563eb] text-[#f8fafc] hover:bg-[#5f8dff]";
const TAB_CLASS =
  "h-6 cursor-pointer rounded px-2 text-xs whitespace-nowrap transition-colors aria-pressed:bg-[#151b28] aria-pressed:text-[#e6edf7] aria-pressed:shadow-[inset_0_0_0_1px_#242d3f] text-[#8b97ad] hover:text-[#e6edf7]";
const STATUS_DOT: Record<ConnectionStatus, string> = { unknown: "bg-[#8b97ad]", checking: "bg-[#fbbf24]", connected: "bg-[#34d399]", error: "bg-[#f87171]" };
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
      <div className="flex items-center gap-2 text-sm text-[#8b97ad]">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Not tested</span>
      </div>
    );
  }

  if (status === "checking") {
    return (
      <div className="flex items-center gap-2 text-sm text-[#8b97ad]">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
        <span>Testing connection...</span>
      </div>
    );
  }

  if (status === "connected") {
    return (
      <div className="flex items-center gap-2 text-sm text-[#34d399]">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Connected
          {botUsername && (
            <span className="min-w-0 truncate text-[#8b97ad] ml-1">(@{botUsername})</span>
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
        <p className="pl-6 text-xs text-[#8b97ad]">{errorMessage}</p>
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
          className="h-7 shrink-0 text-xs border-[#242d3f] bg-[#111622] text-[#e6edf7] hover:bg-[#1a2131] hover:text-[#e6edf7]"
          onClick={() => testMutation.mutate()}
          disabled={!isConfigured || testMutation.isPending}
          title={!isConfigured ? "Save a configuration first" : undefined}
        >
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", testMutation.isPending && "animate-spin")} />
          Test Connection
        </Button>
      </div>

      <Separator className="bg-[#242d3f]" />

      {/* Config form */}
      <form onSubmit={handleSave} className={`space-y-4 ${CARD} p-4`}>
        {/* Bot username */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[#8b97ad]">
            Bot username
          </label>
          <Input
            className={`h-8 text-sm ${FIELD}`}
            value={botUsername}
            onChange={(e) => setBotUsername(e.target.value)}
            placeholder="e.g. papercompanyBot"
          />
          <p className="text-xs text-[#8b97ad]">
            The Telegram username of your bot (without @).
          </p>
        </div>

        {/* Bot token */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[#8b97ad]">
            Bot token
            {isConfigured && (
              <span className="ml-2 font-normal text-[#34d399]">
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
          <p className="text-xs text-[#8b97ad]">
            Obtain from @BotFather on Telegram. Stored encrypted in company secrets.
          </p>
        </div>

        {/* Secret name (only shown when not yet configured) */}
        {!isConfigured && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8b97ad]">
              Secret name
            </label>
            <Input
              className={`h-8 text-sm ${FIELD}`}
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              placeholder="telegram_bot_token"
            />
            <p className="text-xs text-[#8b97ad]">
              The name under which the token will be saved in company secrets.
            </p>
          </div>
        )}

        {/* Existing secret selector (if token already stored) */}
        {isConfigured && config?.botTokenSecretId && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8b97ad]">
              Stored secret
            </label>
            <p className="truncate font-mono text-xs text-[#8b97ad]">
              {secrets?.find((s) => s.id === config.botTokenSecretId)?.name ?? config.botTokenSecretId}
            </p>
          </div>
        )}

        {formError && (
          <p className="text-xs text-destructive">{formError}</p>
        )}

        {saveSuccess && (
          <p className="flex items-center gap-1.5 text-xs text-[#34d399]">
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
    { label: "Telegram", value: !config ? "—" : config.enabled ? "Enabled" : "Disabled", dot: !config ? "bg-[#8b97ad]" : config.enabled ? "bg-[#34d399]" : "bg-[#fbbf24]" },
    { label: "Bot", value: !config ? "—" : config.botUsername ? `@${config.botUsername}` : "Not set", dot: "bg-[#5f8dff]" },
    { label: "Token secret", value: !config ? "—" : isConfigured ? "Stored" : "Missing", dot: !config ? "bg-[#8b97ad]" : isConfigured ? "bg-[#34d399]" : "bg-[#f87171]" },
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
      <div className="cockpit-strip w-full gap-0" role="group" aria-label="Channel summary">
        {strip.map((cell) => (
          <button
            key={cell.label}
            type="button"
            onClick={() => setChannelTab("telegram")}
            className={`cockpit-cell min-w-0 flex-1 justify-center transition-colors ${channelTab === "telegram" ? "bg-[#151b28] text-[#e6edf7] shadow-[inset_0_-1px_0_#5f8dff]" : "hover:bg-[#151b28] hover:text-[#e6edf7]"}`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${cell.dot}`} />
            <span className="truncate uppercase tracking-wide">{cell.label}</span>
            <b className="ml-1 truncate">{cell.value}</b>
          </button>
        ))}
      </div>

      {/* 40px unified toolbar: title · segmented tabs */}
      <div className="cockpit-toolbar h-10 rounded-md border border-[#242d3f] bg-[#111622] px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-sm font-semibold text-[#e6edf7]">Channel Configuration</h1>
          <span className="hidden truncate text-xs text-[#8b97ad] md:inline">Configure external messaging channels for agent notifications.</span>
        </div>
        <div role="group" aria-label="Channel views" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-[#242d3f] bg-[#0b0e14] p-0.5">
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
        <div className={`max-w-2xl space-y-4 p-4 ${CARD}`}>
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-[#8b97ad]" />
            <h2 className="truncate text-sm font-medium text-[#e6edf7]">Telegram</h2>
            {config?.enabled && (
              <span className="rounded border border-[#242d3f] bg-[#0b0e14] px-1.5 py-0.5 text-[11px] font-medium text-[#34d399]">
                Enabled
              </span>
            )}
            {config && !config.enabled && (
              <span className="rounded border border-[#242d3f] bg-[#0b0e14] px-1.5 py-0.5 text-[11px] font-medium text-[#8b97ad]">
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
