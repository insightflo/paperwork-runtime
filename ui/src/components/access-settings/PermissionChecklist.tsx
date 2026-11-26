import { PERMISSION_KEYS, type PermissionKey } from "@paperclipai/shared";
import {
  hasGrant,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  type GrantLike,
} from "./utils";

export function PermissionChecklist({
  grants,
  disabled,
  onToggle,
}: {
  grants: readonly GrantLike[] | undefined;
  disabled: boolean;
  onToggle: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  const grantedCount = PERMISSION_KEYS.filter((key) => hasGrant(grants, key)).length;
  const totalCount = PERMISSION_KEYS.length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-slate-500 dark:text-[#8b97ad]">
          Toggle permissions granted to this principal
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums ${
            grantedCount > 0
              ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#2563eb]/15 dark:text-[#60a5fa]"
              : "border-slate-200/90 bg-slate-100/80 text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]"
          }`}
        >
          {grantedCount}/{totalCount} granted
        </span>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {PERMISSION_KEYS.map((permissionKey) => {
          const checked = hasGrant(grants, permissionKey);
          return (
            <label
              key={permissionKey}
              className={`flex min-h-10 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                checked
                  ? "border-blue-500/40 bg-blue-500/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] dark:border-[#60a5fa]/40 dark:bg-[#2563eb]/12 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "border-slate-200/85 bg-slate-50/50 hover:border-slate-300 hover:bg-white dark:border-white/[0.07] dark:bg-[#090c12]/80 dark:hover:border-white/[0.14] dark:hover:bg-[#111724]"
              }`}
            >
              <input
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 focus-visible:ring-offset-1 dark:border-white/20 dark:accent-[#3b82f6] dark:focus-visible:ring-[#60a5fa]/40"
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggle(permissionKey, event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-slate-900 dark:text-[#edf2fb]">
                  {PERMISSION_LABELS[permissionKey]}
                </span>
                <span className="block text-xs text-slate-500 dark:text-[#8b97ad]">
                  {PERMISSION_DESCRIPTIONS[permissionKey]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
