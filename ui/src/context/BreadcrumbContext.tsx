import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface BreadcrumbContextValue {
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState(crumbs);
  }, []);

  useEffect(() => {
    if (breadcrumbs.length === 0) {
      document.title = "Paperwork";
    } else {
      const lastLabel = breadcrumbs[breadcrumbs.length - 1].label;
      const label = breadcrumbs.length > 1
        ? `${breadcrumbs[0].label} · ${lastLabel}`
        : lastLabel;
      const suffix = " — Paperwork";
      const maxLabelLength = 80 - suffix.length;
      const conciseLabel = label.length > maxLabelLength
        ? `${label.slice(0, maxLabelLength - 1)}…`
        : label;
      document.title = `${conciseLabel}${suffix}`;
    }
  }, [breadcrumbs]);

  return (
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbs() {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error("useBreadcrumbs must be used within BreadcrumbProvider");
  }
  return ctx;
}
