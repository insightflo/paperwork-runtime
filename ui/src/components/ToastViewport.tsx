import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { Check, Copy, X } from "lucide-react";
import { redactSensitiveText } from "@paperclipai/adapter-utils";
import { useToast, type ToastItem, type ToastTone } from "../context/ToastContext";
import { extractErrorReference } from "../lib/user-errors";
import { cn } from "../lib/utils";

const toneClasses: Record<ToastTone, string> = {
  info: "border-l-sky-600 dark:border-l-sky-400",
  success: "border-l-emerald-600 dark:border-l-emerald-400",
  warn: "border-l-amber-600 dark:border-l-amber-400",
  error: "border-l-red-600 dark:border-l-red-400",
};

const toneDotClasses: Record<ToastTone, string> = {
  info: "bg-sky-500 dark:bg-sky-400",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warn: "bg-amber-500 dark:bg-amber-400",
  error: "bg-red-500 dark:bg-red-400",
};

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const safeBody = toast.body ? redactSensitiveText(toast.body) : null;
  const errorRef =
    safeBody && (toast.tone === "warn" || toast.tone === "error") ? extractErrorReference(toast.body) : null;

  const handleCopyRef = async () => {
    if (!errorRef || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(errorRef);
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 1500);
    } catch {
      // Clipboard may be blocked in restricted browser contexts.
    }
  };

  return (
    <li
      className={cn(
        "pointer-events-auto rounded-sm border border-border/80 bg-card/95 backdrop-blur-md shadow-lg border-l-4 text-card-foreground transition-[transform,opacity] duration-200 ease-out tabular-nums",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        toneClasses[toast.tone],
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", toneDotClasses[toast.tone])} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">{redactSensitiveText(toast.title)}</p>
          {safeBody && <p className="mt-1 text-xs leading-4 opacity-80">{safeBody}</p>}
          {errorRef && (
            <button
              type="button"
              onClick={handleCopyRef}
              className="mt-1.5 inline-flex items-center gap-1 rounded-sm border border-border/80 bg-background/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <span>ref:{errorRef}</span>
              {copiedRef ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
            </button>
          )}
          {toast.action && (
            <Link
              to={toast.action.href}
              onClick={() => onDismiss(toast.id)}
              className="mt-2 inline-flex text-xs font-medium underline underline-offset-4 hover:opacity-90"
            >
              {toast.action.label}
            </Link>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="mt-0.5 shrink-0 rounded-sm border border-transparent p-1 text-muted-foreground transition-colors hover:border-border/80 hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <aside
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-3 left-3 z-[120] w-full max-w-sm px-1"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </ol>
    </aside>
  );
}
