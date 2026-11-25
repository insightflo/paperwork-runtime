/**
 * Retired plugin launcher compatibility surface.
 *
 * Launcher discovery and activation depended on the removed plugin API. The
 * provider, hooks, and outlets remain as inert compatibility shims so existing
 * core screens can compose them without network requests or plugin rendering.
 */
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type {
  PluginLauncherDeclaration,
  PluginLauncherPlacementZone,
  PluginUiSlotDeclaration,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";

export type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt?: string;
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

export type PluginLauncherContext = {
  companyId?: string | null;
  companyPrefix?: string | null;
  projectId?: string | null;
  projectRef?: string | null;
  entityId?: string | null;
  entityType?: PluginUiSlotEntityType | null;
};

export type ResolvedPluginLauncher = PluginLauncherDeclaration & {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
  uiEntryFile: string;
};

type UsePluginLaunchersFilters = {
  placementZones: PluginLauncherPlacementZone[];
  entityType?: PluginUiSlotEntityType | null;
  companyId?: string | null;
  enabled?: boolean;
};

type UsePluginLaunchersResult = {
  launchers: ResolvedPluginLauncher[];
  contributionsByPluginId: Map<string, PluginUiContribution>;
  isLoading: boolean;
  errorMessage: string | null;
};

type PluginLauncherRuntimeContextValue = {
  activateLauncher(
    launcher: ResolvedPluginLauncher,
    hostContext: PluginLauncherContext,
    contribution: PluginUiContribution,
    sourceEl?: HTMLElement | null,
  ): Promise<void>;
};

const emptyLaunchers: ResolvedPluginLauncher[] = [];
const emptyContributions = new Map<string, PluginUiContribution>();

const PluginLauncherRuntimeContext = createContext<PluginLauncherRuntimeContextValue | null>(null);

export function usePluginLaunchers(
  filters: UsePluginLaunchersFilters,
): UsePluginLaunchersResult {
  void filters;
  return {
    launchers: emptyLaunchers,
    contributionsByPluginId: emptyContributions,
    isLoading: false,
    errorMessage: null,
  };
}

async function retiredActivateLauncher(): Promise<void> {
  // Plugin launcher activation is retired with the plugin API.
}

export function PluginLauncherProvider({ children }: { children: ReactNode }) {
  const value = useMemo<PluginLauncherRuntimeContextValue>(
    () => ({ activateLauncher: retiredActivateLauncher }),
    [],
  );

  return (
    <PluginLauncherRuntimeContext.Provider value={value}>
      {children}
    </PluginLauncherRuntimeContext.Provider>
  );
}

export function usePluginLauncherRuntime(): PluginLauncherRuntimeContextValue {
  const value = useContext(PluginLauncherRuntimeContext);
  if (!value) {
    throw new Error("usePluginLauncherRuntime must be used within PluginLauncherProvider");
  }
  return value;
}

type PluginLauncherOutletProps = {
  placementZones: PluginLauncherPlacementZone[];
  context: PluginLauncherContext;
  entityType?: PluginUiSlotEntityType | null;
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
};

export function PluginLauncherOutlet(props: PluginLauncherOutletProps) {
  void props;
  return null;
}

type PluginLauncherButtonProps = {
  launcher: ResolvedPluginLauncher;
  context: PluginLauncherContext;
  contribution: PluginUiContribution;
  className?: string;
  onActivated?: () => void;
};

export function PluginLauncherButton(props: PluginLauncherButtonProps) {
  void props;
  return null;
}
