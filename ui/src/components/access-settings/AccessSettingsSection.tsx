import { ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessGroupsView } from "./AccessGroupsView";
import { AccessUsersView } from "./AccessUsersView";
import { getErrorMessage } from "./utils";
import { useAccessSettingsController } from "./useAccessSettingsController";

export function AccessSettingsSection({ selectedCompanyId }: { selectedCompanyId: string | null }) {
  const access = useAccessSettingsController(selectedCompanyId);
  const {
    accessError,
    accessLoading,
    createGroup,
    createGroupPending,
    deleteSelectedGroup,
    editingGroupDescription,
    editingGroupName,
    groupById,
    groupMutationPending,
    addMemberPending,
    addSelectedMember,
    memberSearchError,
    memberSearchLoading,
    memberSearchQuery,
    memberSearchResults,
    newGroupDescription,
    newGroupName,
    permissionGroups,
    retryAccess,
    saveSelectedGroup,
    selectedGroup,
    selectedGroupDetail,
    selectedGroupDetailQuery,
    selectedGroupId,
    selectedUserId,
    setEditingGroupDescription,
    setEditingGroupName,
    setMemberSearchQuery,
    setNewGroupDescription,
    setNewGroupName,
    setSelectedUserId,
    setSelectedGroupId,
    toggleGroupGrant,
    toggleGroupMember,
    toggleGroupStatus,
    toggleUserGrant,
    updateMemberPermissionsPending,
    userMembers,
  } = access;

  return (
    <div className="space-y-2 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]">
          <ShieldCheck className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />
          Access
        </div>
        <div className="flex items-center gap-1.5 text-[11px] tabular-nums">
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 font-medium text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">
            {userMembers.length} users
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/90 bg-slate-100/80 px-2 py-0.5 font-medium text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#9aa7bd]">
            {permissionGroups.length} groups
          </span>
        </div>
      </div>
      <div
        className="tactile-card rounded-xl border border-slate-200/90 bg-white px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]"
        data-testid="access-settings"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">
              User and group permissions
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">
              Manage direct user grants and inherited group grants for this company.
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums">
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">{userMembers.length} users</span>
            <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-white/20" />
            <span className="font-medium text-slate-700 dark:text-[#cbd5e1]">{permissionGroups.length} groups</span>
          </div>
        </div>

        {accessLoading && (
          <div className="mt-4 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 text-xs text-slate-500 dark:border-white/[0.07] dark:bg-[#090c12] dark:text-[#8b97ad]">
            Loading access settings...
          </div>
        )}
        {accessError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2.5 text-xs dark:border-[#f43f5e]/30 dark:bg-[#f43f5e]/10">
            <span className="text-rose-700 dark:text-[#fda4af]">
              Access settings failed to load:{" "}
              {getErrorMessage(accessError, "Request failed.")}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-rose-500/30 bg-white text-xs text-rose-700 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#090c12] dark:text-[#fda4af] dark:hover:bg-[#f43f5e]/15"
              onClick={retryAccess}
            >
              Retry
            </Button>
          </div>
        )}

        {!accessLoading && !accessError && (
          <Tabs defaultValue="users" className="mt-4">
            <TabsList
              variant="line"
              className="w-full justify-start border-b border-slate-200/80 pb-1 dark:border-white/[0.07]"
            >
              <TabsTrigger
                value="users"
                className="flex-none gap-1.5 px-2.5 text-xs font-semibold text-slate-500 hover:text-slate-900 data-[state=active]:text-slate-950 data-[state=active]:after:bg-blue-600 dark:text-[#8b97ad] dark:hover:text-[#edf2fb] dark:data-[state=active]:text-[#edf2fb] dark:data-[state=active]:after:bg-[#60a5fa]"
              >
                <Users className="h-3.5 w-3.5" />
                Users
              </TabsTrigger>
              <TabsTrigger
                value="groups"
                className="flex-none gap-1.5 px-2.5 text-xs font-semibold text-slate-500 hover:text-slate-900 data-[state=active]:text-slate-950 data-[state=active]:after:bg-blue-600 dark:text-[#8b97ad] dark:hover:text-[#edf2fb] dark:data-[state=active]:text-[#edf2fb] dark:data-[state=active]:after:bg-[#60a5fa]"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Groups
              </TabsTrigger>
            </TabsList>

            <TabsContent value="users" className="mt-4">
              <AccessUsersView
                members={userMembers}
                groupById={groupById}
                disabled={updateMemberPermissionsPending || addMemberPending}
                onToggleGrant={toggleUserGrant}
                memberSearchQuery={memberSearchQuery}
                onMemberSearchQueryChange={setMemberSearchQuery}
                searchResults={memberSearchResults}
                searchLoading={memberSearchLoading}
                searchError={memberSearchError}
                selectedUserId={selectedUserId}
                onSelectUser={setSelectedUserId}
                addUserPending={addMemberPending}
                onAddSelectedUser={addSelectedMember}
              />
            </TabsContent>

            <TabsContent value="groups" className="mt-4">
              <AccessGroupsView
                permissionGroups={permissionGroups}
                userMembers={userMembers}
                selectedGroupId={selectedGroupId}
                selectedGroup={selectedGroup}
                selectedGroupDetail={selectedGroupDetail}
                selectedGroupDetailLoading={selectedGroupDetailQuery.isLoading}
                selectedGroupDetailError={selectedGroupDetailQuery.error}
                newGroupName={newGroupName}
                newGroupDescription={newGroupDescription}
                editingGroupName={editingGroupName}
                editingGroupDescription={editingGroupDescription}
                creating={createGroupPending}
                disabled={groupMutationPending}
                onSelectGroup={setSelectedGroupId}
                onNewGroupNameChange={setNewGroupName}
                onNewGroupDescriptionChange={setNewGroupDescription}
                onEditingGroupNameChange={setEditingGroupName}
                onEditingGroupDescriptionChange={setEditingGroupDescription}
                onCreateGroup={createGroup}
                onSaveGroup={saveSelectedGroup}
                onToggleStatus={toggleGroupStatus}
                onDeleteGroup={deleteSelectedGroup}
                onToggleMember={toggleGroupMember}
                onToggleGrant={toggleGroupGrant}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
