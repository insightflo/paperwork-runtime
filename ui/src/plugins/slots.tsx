/**
 * Retired plugin slot compatibility surface.
 *
 * Plugin UI contribution discovery and rendering have been removed with the
 * plugin API. These exports preserve the public component and hook shapes used
 * by core screens while always returning an empty, non-loading result.
 */
import type {
  PluginUiSlotDeclaration,
  PluginUiSlotEntityType,
  PluginUiSlotType,
} from "@paperclipai/shared";

export type PluginSlotContext = {
  companyId?: string | null;
  companyPrefix?: string | null;
  projectId?: string | null;
  entityId?: string | null;
  entityType?: PluginUiSlotEntityType | null;
  parentEntityId?: string | null;
  projectRef?: string | null;
};

export type ResolvedPluginSlot = PluginUiSlotDeclaration & {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
};

export type SlotFilters = {
  slotTypes: PluginUiSlotType[];
  entityType?: PluginUiSlotEntityType | null;
  companyId?: string | null;
  excludePluginKeys?: string[];
  enabled?: boolean;
};

export type UsePluginSlotsResult = {
  slots: ResolvedPluginSlot[];
  isLoading: boolean;
  errorMessage: string | null;
};

const emptySlots: ResolvedPluginSlot[] = [];

export function usePluginSlots(filters: SlotFilters): UsePluginSlotsResult {
  void filters;
  return {
    slots: emptySlots,
    isLoading: false,
    errorMessage: null,
  };
}

type PluginSlotMountProps = {
  slot: ResolvedPluginSlot;
  context: PluginSlotContext;
  className?: string;
  missingBehavior?: "hidden" | "placeholder";
};

export function PluginSlotMount(props: PluginSlotMountProps) {
  void props;
  return null;
}

type PluginSlotOutletProps = {
  slotTypes: PluginUiSlotType[];
  context: PluginSlotContext;
  entityType?: PluginUiSlotEntityType | null;
  excludePluginKeys?: string[];
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
  missingBehavior?: "hidden" | "placeholder";
};

export function PluginSlotOutlet(props: PluginSlotOutletProps) {
  void props;
  return null;
}
