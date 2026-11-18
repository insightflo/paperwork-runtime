import { useState } from "react";
import { Check, Copy, AlertTriangle } from "lucide-react";
import { redactSensitiveText } from "@paperclipai/adapter-utils";
import { userErrorDetails } from "../lib/user-errors";
import { cn } from "../lib/utils";

interface ErrorReferenceChipProps {
  error: unknown;
  code?: string | null;
  fallback?: string;
  allowDiagnosticExpand?: boolean;
  className?: string;
}

export function ErrorReferenceChip({
  error,
  code,
  fallback = "Execution failed. Inspect the trace waterfall or retry.",
  allowDiagnosticExpand = false,
  className,
}: ErrorReferenceChipProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const details = userErrorDetails(error, fallback, code);
  const rawString = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const safeDiagnostic = allowDiagnosticExpand && rawString ? redactSensitiveText(rawString) : null;

  const handleCopy = async () => {
    if (!details.reference || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(details.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked in restricted browser contexts.
    }
  };

  return (
    <div
      className={cn("rounded-md border px-2.5 py-2 text-xs", className)}
      style={{
        borderColor: "var(--openbot-danger)",
        backgroundColor: "var(--openbot-danger-soft)",
        color: "var(--openbot-danger-text)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words font-medium">{details.message}</span>
        {details.reference && (
          <button
            type="button"
            onClick={handleCopy}
            title="Copy error reference code"
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-opacity hover:opacity-80"
            style={{
              borderColor: "var(--openbot-border-strong)",
              backgroundColor: "var(--openbot-bg-surface)",
              color: "var(--openbot-text-secondary)",
            }}
          >
            <span>ref:{details.reference}</span>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        )}
      </div>
      {safeDiagnostic && safeDiagnostic !== details.message && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            {expanded ? "Hide redacted detail" : "Show redacted detail"}
          </button>
          {expanded && (
            <pre
              className="mt-1 max-h-32 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap"
              style={{
                backgroundColor: "var(--openbot-bg-surface)",
                color: "var(--openbot-text-secondary)",
              }}
            >
              {safeDiagnostic}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
