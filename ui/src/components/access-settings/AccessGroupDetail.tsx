import { useEffect, useState } from "react";
import type { PermissionKey } from "@paperclipai/shared";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompanyAccessMember, PermissionGroup, PermissionGroupDetail } from "../../api/access";
import { PermissionChecklist } from "./PermissionChecklist";
import { getErrorMessage, memberDisplayName, shortId } from "./utils";

const TACTILE_INPUT =
  "min-w-0 rounded-lg border border-slate-200/90 bg-slate-50/80 px-2.5 py-1.5 text-sm text-slate-900 outline-none transition-colors focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";

const TACTILE_CHECKBOX =
  "h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 focus-visible:ring-offset-1 dark:border-white/20 dark:accent-[#3b82f6] dark:focus-visible:ring-[#60a5fa]/40";

export function AccessGroupDetail({
  group,
  detail,
  detailLoading,
  detailError,
  members,
  editingName,
  editingDescription,
  disabled,
  onEditingNameChange,
  onEditingDescriptionChange,
  onSaveGroup,
  onToggleStatus,
  onDeleteGroup,
  onToggleMember,
  onToggleGrant,
}: {
  group: PermissionGroup | null;
  detail: PermissionGroupDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  members: CompanyAccessMember[];
  editingName: string;
  editingDescription: string;
  disabled: boolean;
  onEditingNameChange: (value: string) => void;
  onEditingDescriptionChange: (value: string) => void;
  onSaveGroup: () => void;
  onToggleStatus: (status: "active" | "suspended") => void;
  onDeleteGroup: () => void;
  onToggleMember: (userId: string, checked: boolean) => void;
  onToggleGrant: (permissionKey: PermissionKey, checked: boolean) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setConfirmDelete(false);
  }, [group?.id]);

  if (!group) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a group to manage members and inherited permissions.
      </div>
    );
  }

  const memberIds = new Set(detail?.members.map((member) => member.userId) ?? []);
  const groupDirty =
    editingName.trim() !== group.name ||
    editingDescription.trim() !== (group.description ?? "");
  const isActive = group.status === "active";

  return (
    <div className="space-y-4 lg:border-l lg:border-border lg:pl-4" data-testid="access-group-detail">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          className={TACTILE_INPUT}
          type="text"
          value={editingName}
          placeholder="Group name"
          disabled={disabled}
          onChange={(event) => onEditingNameChange(event.target.value)}
        />
        <input
          className={TACTILE_INPUT}
          type="text"
          value={editingDescription}
          placeholder="Description"
          disabled={disabled}
          onChange={(event) => onEditingDescriptionChange(event.target.value)}
        />
        <Button
          size="sm"
          onClick={onSaveGroup}
          disabled={disabled || !editingName.trim() || !groupDirty}
          className="bg-blue-600 text-[#f8fafc] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]"
        >
          Save
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <label
          className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
          } ${
            isActive
              ? "border-lime-500/35 bg-lime-500/[0.07] text-slate-900 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#edf2fb]"
              : "border-slate-200/85 bg-slate-50/70 text-slate-600 dark:border-white/[0.08] dark:bg-[#090c12] dark:text-[#8b97ad]"
          }`}
        >
          <input
            type="checkbox"
            className={TACTILE_CHECKBOX}
            checked={isActive}
            disabled={disabled}
            onChange={(event) => onToggleStatus(event.target.checked ? "active" : "suspended")}
          />
          <span>Active group</span>
          <span
            className={`rounded-full px-1.5 py-px font-mono text-[10px] font-semibold uppercase ${
              isActive
                ? "bg-lime-500/15 text-lime-700 dark:bg-[#a3e635]/15 dark:text-[#a3e635]"
                : "bg-slate-200/80 text-slate-600 dark:bg-white/[0.06] dark:text-[#8b97ad]"
            }`}
          >
            {isActive ? "Active" : "Suspended"}
          </span>
        </label>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-destructive">Delete “{group.name}”?</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                onDeleteGroup();
              }}
              disabled={disabled}
            >
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={disabled}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmDelete(true)}
            disabled={disabled}
            className="border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>

      {detailLoading && (
        <div className="text-sm text-muted-foreground">Loading group details...</div>
      )}
      {Boolean(detailError) && (
        <div className="text-sm text-destructive">
          {getErrorMessage(detailError, "Failed to load group details.")}
        </div>
      )}
      {!detailLoading && !detailError && (
        <div className="grid gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Members
              </div>
              <span className="rounded-full border border-slate-200/90 bg-slate-100/80 px-2 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]">
                {memberIds.size}/{members.length}
              </span>
            </div>
            {members.length === 0 ? (
              <div className="text-sm text-muted-foreground">No users can be added yet.</div>
            ) : (
              <div className="grid gap-1.5">
                {members.map((member) => {
                  const checked = memberIds.has(member.principalId);
                  return (
                    <label
                      key={member.id}
                      className={`flex min-h-10 items-center justify-between gap-3 rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      } ${
                        checked
                          ? "border-blue-500/40 bg-blue-500/[0.06] dark:border-[#60a5fa]/40 dark:bg-[#2563eb]/12"
                          : "border-slate-200/80 bg-slate-50/40 hover:border-slate-300 hover:bg-white dark:border-white/[0.07] dark:bg-[#090c12]/75 dark:hover:border-white/[0.14] dark:hover:bg-[#111724]"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900 dark:text-[#edf2fb]">
                          {memberDisplayName(member)}
                        </span>
                        <span className="block truncate text-xs text-slate-500 dark:text-[#8b97ad]">
                          {member.user?.email ?? shortId(member.principalId)}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        className={TACTILE_CHECKBOX}
                        checked={checked}
                        disabled={disabled}
                        onChange={(event) => onToggleMember(member.principalId, event.target.checked)}
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Group permissions
            </div>
            <PermissionChecklist
              grants={detail?.grants ?? []}
              disabled={disabled || !detail}
              onToggle={onToggleGrant}
            />
          </div>
        </div>
      )}
    </div>
  );
}
