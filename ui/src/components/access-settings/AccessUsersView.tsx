import type { CompanyUserSearchResult, PermissionKey } from "@paperclipai/shared";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CompanyAccessMember } from "../../api/access";
import { PermissionChecklist } from "./PermissionChecklist";
import { getErrorMessage, memberDisplayName, shortId } from "./utils";
import type { CompanyMemberRole } from "./useAccessSettingsController";

const MEMBER_ROLES: CompanyMemberRole[] = ["owner", "admin", "member", "viewer"];
const selectClass =
  "h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-xs font-medium text-slate-900 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-55 dark:border-white/[0.09] dark:bg-[#090c12] dark:text-[#edf2fb] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";

function memberRole(value: string | null): CompanyMemberRole {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer" ? value : "member";
}

type AccessUsersViewProps = {
  members: CompanyAccessMember[];
  groupById: Map<string, { id: string; name: string }>;
  inheritedPermissionKeysByMemberId?: ReadonlyMap<string, ReadonlySet<string>>;
  inheritedPermissionKeys?: ReadonlySet<string>;
  disabled: boolean;
  onToggleGrant: (member: CompanyAccessMember, permissionKey: PermissionKey, checked: boolean) => void;
  memberSearchQuery: string;
  onMemberSearchQueryChange: (value: string) => void;
  searchResults: CompanyUserSearchResult[];
  searchLoading: boolean;
  searchError: unknown;
  selectedUserId: string | null;
  onSelectUser: (userId: string) => void;
  addUserPending: boolean;
  onAddSelectedUser: () => void;
  memberLifecyclePending?: boolean;
  onMemberRoleChange?: (member: CompanyAccessMember, role: CompanyMemberRole) => void;
  onMemberStatusToggle?: (member: CompanyAccessMember) => void;
  onRemoveMember?: (member: CompanyAccessMember) => void;
};

export function AccessUsersView({
  members,
  groupById,
  inheritedPermissionKeysByMemberId,
  inheritedPermissionKeys,
  disabled,
  onToggleGrant,
  memberSearchQuery,
  onMemberSearchQueryChange,
  searchResults,
  searchLoading,
  searchError,
  selectedUserId,
  onSelectUser,
  addUserPending,
  onAddSelectedUser,
  memberLifecyclePending = false,
  onMemberRoleChange,
  onMemberStatusToggle,
  onRemoveMember,
}: AccessUsersViewProps) {
  const lifecycleDisabled = disabled || memberLifecyclePending;
  return (
    <div className="space-y-4 tabular-nums" data-testid="access-users-view">
      <div className="space-y-2.5 rounded-lg border border-slate-200/90 bg-slate-50/75 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">Add user</span>
            <Input
              className="h-8 min-w-0 rounded-md border-slate-200/90 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:border-blue-500 focus-visible:ring-blue-500/20 dark:border-white/[0.08] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#5c687f] dark:focus-visible:border-[#60a5fa] dark:focus-visible:ring-[#60a5fa]/25"
              type="search"
              value={memberSearchQuery}
              placeholder="Search active users by name or email"
              onChange={(event) => onMemberSearchQueryChange(event.target.value)}
            />
          </label>
          <Button size="sm" className="h-8 bg-blue-600 text-xs text-[#f8fafc] hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" onClick={onAddSelectedUser} disabled={disabled || addUserPending || !selectedUserId}>
            <UserPlus className="h-3.5 w-3.5" />
            {addUserPending ? "Adding..." : "Add"}
          </Button>
        </div>
        {memberSearchQuery.trim().length === 0 ? null : searchLoading ? (
          <div className="text-xs text-slate-500 dark:text-[#8b97ad]">Searching users...</div>
        ) : searchError ? (
          <div className="text-xs text-rose-600 dark:text-[#f43f5e]">{getErrorMessage(searchError, "User search failed.")}</div>
        ) : searchResults.length === 0 ? (
          <div className="text-xs text-slate-500 dark:text-[#8b97ad]">No matching users available.</div>
        ) : (
          <div className="divide-y divide-slate-200/80 overflow-hidden rounded-lg border border-slate-200/90 bg-white dark:divide-white/[0.06] dark:border-white/[0.08] dark:bg-[#0e131d]">
            {searchResults.map((user) => {
              const isSelected = selectedUserId === user.id;
              return (
                <button
                  key={user.id}
                  type="button"
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-[#60a5fa] ${isSelected ? "bg-blue-50/80 dark:bg-[#60a5fa]/12" : "hover:bg-slate-50 dark:hover:bg-white/[0.04]"}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectUser(user.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900 dark:text-[#edf2fb]">{user.name || user.email || shortId(user.id)}</span>
                    <span className="block truncate text-xs text-slate-500 dark:text-[#8b97ad]">{user.email ?? shortId(user.id)}</span>
                  </span>
                  {isSelected && <span className="shrink-0 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:border-[#60a5fa]/35 dark:bg-[#60a5fa]/15 dark:text-[#60a5fa]">Selected</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {members.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200/90 bg-slate-50/50 px-3 py-4 text-xs text-slate-500 dark:border-white/[0.08] dark:bg-[#090c12]/60 dark:text-[#8b97ad]">
          No human users have access to this company yet.
        </div>
      ) : (
        <div className="divide-y divide-slate-200/80 dark:divide-white/[0.06]">
          {members.map((member) => {
            const isActive = member.status === "active";
            const role = memberRole(member.membershipRole);
            const canManageLifecycle = !!(onMemberRoleChange || onMemberStatusToggle || onRemoveMember);
            return (
              <div key={member.id} className="grid gap-3 py-3 first:pt-1 last:pb-0 md:grid-cols-[minmax(190px,260px)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">{memberDisplayName(member)}</div>
                  <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-[#8b97ad]">{member.user?.email ?? shortId(member.principalId)}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">{role}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${isActive ? "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/10 dark:text-[#a3e635]" : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-[#f59e0b]/30 dark:bg-[#f59e0b]/12 dark:text-[#f59e0b]"}`}>{member.status}</span>
                    {member.groupMemberships.length === 0 ? (
                      <span className="rounded-full border border-slate-200/90 bg-slate-100/80 px-2 py-0.5 text-[11px] text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#8b97ad]">no groups</span>
                    ) : (
                      member.groupMemberships.map((membership) => (
                        <span key={membership.groupId} className="rounded-full border border-slate-200/90 bg-slate-100/80 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#cbd5e1]">
                          {groupById.get(membership.groupId)?.name ?? shortId(membership.groupId)}
                        </span>
                      ))
                    )}
                  </div>
                  {canManageLifecycle && (
                    <div className="mt-3 space-y-2 rounded-lg border border-slate-200/90 bg-white/75 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-white/[0.07] dark:bg-[#090c12]/90 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                      <label className="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">
                        Role
                        <select
                          aria-label={`Role for ${memberDisplayName(member)}`}
                          className={`${selectClass} mt-1`}
                          value={role}
                          disabled={lifecycleDisabled || !onMemberRoleChange}
                          onChange={(event) => onMemberRoleChange?.(member, event.target.value as CompanyMemberRole)}
                        >
                          {MEMBER_ROLES.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        <Button type="button" size="sm" variant="outline" className="h-7 border-slate-200/90 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#cbd5e1] dark:hover:bg-[#141b29]" disabled={lifecycleDisabled || !onMemberStatusToggle} onClick={() => onMemberStatusToggle?.(member)}>
                          {isActive ? "Suspend" : "Reactivate"}
                        </Button>
                        <Button type="button" size="sm" variant="outline" className="h-7 border-rose-500/30 bg-white px-2 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#0e131d] dark:text-[#fda4af] dark:hover:bg-[#f43f5e]/12" disabled={lifecycleDisabled || !onRemoveMember} onClick={() => onRemoveMember?.(member)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <PermissionChecklist
                  grants={member.grants}
                  inheritedKeys={inheritedPermissionKeysByMemberId?.get(member.id) ?? inheritedPermissionKeys}
                  disabled={disabled}
                  onToggle={(permissionKey, checked) => onToggleGrant(member, permissionKey, checked)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
