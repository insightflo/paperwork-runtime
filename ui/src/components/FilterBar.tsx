import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface FilterValue {
  key: string;
  label: string;
  value: string;
}

interface FilterBarProps {
  filters: FilterValue[];
  onRemove: (key: string) => void;
  onClear: () => void;
}

export function FilterBar({ filters, onRemove, onClear }: FilterBarProps) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200/90 bg-white/95 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] tabular-nums dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]">
      {filters.map((f) => (
        <Badge
          key={f.key}
          variant="secondary"
          className="gap-1 rounded-md border-slate-200/90 bg-slate-50/90 px-2 py-1 pr-1 text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.08] dark:bg-[#090d14] dark:text-[#c7d0df] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#8b97ad]">
            {f.label}:
          </span>
          <span className="font-medium text-slate-950 dark:text-[#edf2fb]">{f.value}</span>
          <button
            type="button"
            aria-label={`Remove ${f.label} filter`}
            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-slate-400 transition-[color,background-color,transform] duration-150 hover:bg-slate-200/80 hover:text-slate-950 active:scale-[0.96] dark:text-[#627089] dark:hover:bg-white/[0.08] dark:hover:text-[#edf2fb]"
            onClick={() => onRemove(f.key)}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 rounded-md px-2 text-xs font-semibold text-blue-700 transition-[color,background-color,transform] duration-150 hover:bg-blue-500/10 hover:text-blue-800 active:scale-[0.96] dark:text-[#60a5fa] dark:hover:bg-[#60a5fa]/12 dark:hover:text-[#bfdbfe]"
        onClick={onClear}
      >
        Clear all
      </Button>
    </div>
  );
}
