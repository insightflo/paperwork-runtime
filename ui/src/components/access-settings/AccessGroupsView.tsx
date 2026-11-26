import type { PermissionKey } from "@paperclipai/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompanyAccessMember, PermissionGroup, PermissionGroupDetail } from "../../api/access";
import { cn } from "../../lib/utils";
import { AccessGroupDetail } from "./AccessGroupDetail";

export function AccessGroupsView({
  permissionGroups,
  userMembers,
  selectedGroupId,
  selectedGroup,
  selectedGroupDetail,
  selectedGroupDetailLoading,
  selectedGroupDetailError,
  newGroupName,
  newGroupDescription,
  editingGroupName,
  editingGroupDescription,
  creating,
  disabled,
  onSelectGroup,
  onNewGroupNameChange,
  onNewGroupDescriptionChange,
  onEditingGroupNameChange,
  onEditingGroupDescriptionChange,
  onCreateGroup,
  onSaveGroup,
  onToggleStatus,
  onDeleteGroup,
  onToggleMember,
  onToggleGrant,
}: {
  permissionGroups: PermissionGroup[];
  userMembers: CompanyAccessMember[];
  selectedGroupId: string | null;
  selectedGroup: PermissionGroup | null;
  selectedGroupDetail: PermissionGroupDetail | null;
  selectedGroupDetailLoading: boolean;
  selectedGroupDetailError: unknown;
  newGroupName: string;
  newGroupDescription: string;
  editingGroupName: string;
  editingGroupDescription: string;
  creating: boolean;
  disabled: boolean;
  onSelectGroup: (groupId: string) => void;
  onNewGroupNameChange: (value: string) => void;
  onNewGroupDescriptionChange: (value: string) => void;
  onEditingGroupNameChange: (value: string) => void;
  onEditingGroupDescriptionChange: (value: string) => void;
  onCreateGroup: () => void;
  onSaveGroup: () => void;
  onToggleStatus: (status: "active" | "suspended") => void;
  onDeleteGroup: () => void;
  onToggleMember: (userId: string, checked: boolean) => void;
  onToggleGrant: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  return (
    <div className="space-y-4 tabular-nums" data-testid="access-groups-view">
      <div className="grid gap-2 rounded-lg border border-slate-200/90 bg-slate-50/75 p-2.5 dark:border-white/[0.07] dark:bg-[#090c12] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          className="h-8 min-w-0 rounded-md border border-slate-200/90 bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#5c687f] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25"
          type="text"
          value={newGroupName}
          placeholder="New group name"
          onChange={(event) => onNewGroupNameChange(event.target.value)}
        />
        <input
          className="h-8 min-w-0 rounded-md border border-slate-200/90 bg-white px-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#5c687f] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25"
          type="text"
          value={newGroupDescription}
          placeholder="Description"
          onChange={(event) => onNewGroupDescriptionChange(event.target.value)}
        />
        <Button
          size="sm"
          className="h-8 bg-blue-600 text-xs text-[#f8fafc] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
          onClick={onCreateGroup}
          disabled={creating || !newGroupName.trim()}
        >
          <Plus className="h-3.5 w-3.5" />
          {creating ? "Creating..." : "Create"}
        </Button>
      </div>

      {permissionGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200/90 bg-slate-50/50 px-3 py-4 text-xs text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12]/60 dark:text-[#8b97ad]">
          No permission groups yet. Create a group to manage inherited access.
        </div>
      ) : (
        <div className="grid gap-4 border-t border-slate-200/80 pt-4 dark:border-white/[0.07] lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {permissionGroups.map((group) => {
              const memberCount = userMembers.filter((member) =>
                member.groupMemberships.some((membership) => membership.groupId === group.id)
              ).length;
              const isSelected = selectedGroupId === group.id;
              const isActive = group.status === "active";
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => onSelectGroup(group.id)}
                  className={cn(
                    "w-full rounded-lg border px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:focus-visible:ring-[#60a5fa]/40",
                    isSelected
                      ? "border-blue-500/35 bg-blue-50/80 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/12 dark:text-[#edf2fb] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                      : "border-slate-200/80 bg-slate-50/60 text-slate-700 hover:border-slate-300 hover:bg-slate-100/80 hover:text-slate-950 dark:border-white/[0.06] dark:bg-[#090c12]/80 dark:text-[#8b97ad] dark:hover:border-white/[0.12] dark:hover:bg-[#141b29] dark:hover:text-[#edf2fb]"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{group.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                        isSelected
                          ? "border-blue-500/30 bg-blue-500/15 text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/20 dark:text-[#60a5fa]"
                          : "border-slate-200/90 bg-white text-slate-600 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#9aa7bd]"
                      )}
                    >
                      {memberCount}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 truncate text-[11px]">
                    <span
                      aria-hidden
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        isActive
                          ? "bg-lime-600 dark:bg-[#a3e635]"
                          : "bg-amber-500 dark:bg-[#f59e0b]"
                      )}
                    />
                    <span
                      className={cn(
                        isActive
                          ? "text-lime-700 dark:text-[#a3e635]"
                          : "text-amber-700 dark:text-[#f59e0b]"
                      )}
                    >
                      {isActive ? "Active" : "Suspended"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <AccessGroupDetail
            group={selectedGroup}
            detail={selectedGroupDetail}
            detailLoading={selectedGroupDetailLoading}
            detailError={selectedGroupDetailError}
            members={userMembers}
            editingName={editingGroupName}
            editingDescription={editingGroupDescription}
            onEditingNameChange={onEditingGroupNameChange}
            onEditingDescriptionChange={onEditingGroupDescriptionChange}
            onSaveGroup={onSaveGroup}
            onToggleStatus={onToggleStatus}
            onDeleteGroup={onDeleteGroup}
            onToggleMember={onToggleMember}
            onToggleGrant={onToggleGrant}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
