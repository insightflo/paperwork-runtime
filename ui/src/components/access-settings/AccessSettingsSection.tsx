import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Mail, MonitorSmartphone, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authApi, authErrorMessage } from "../../api/auth";
import { AccessGroupsView } from "./AccessGroupsView";
import { AccessUsersView } from "./AccessUsersView";
import { getErrorMessage, shortId } from "./utils";
import { useAccessSettingsController, type CompanyInvite } from "./useAccessSettingsController";

const tabTriggerClass =
  "flex-none gap-1.5 px-2.5 text-xs font-semibold text-slate-500 hover:text-slate-900 data-[state=active]:text-slate-950 data-[state=active]:after:bg-blue-600 dark:text-[#8b97ad] dark:hover:text-[#edf2fb] dark:data-[state=active]:text-[#edf2fb] dark:data-[state=active]:after:bg-[#60a5fa]";
const panelClass =
  "rounded-lg border border-slate-200/90 bg-slate-50/75 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/[0.07] dark:bg-[#090c12] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
const rowClass =
  "rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";
const inputClass =
  "h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#edf2fb] dark:placeholder:text-[#5c687f] dark:focus:border-[#60a5fa] dark:focus:ring-[#60a5fa]/25";
const AUTH_SESSIONS_KEY = ["auth", "sessions"] as const;
const AUTH_SESSION_KEY = ["auth", "session"] as const;

function formatDateTime(value: string | null) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function inviteIsActive(invite: CompanyInvite) {
  if (invite.revokedAt || invite.acceptedAt) return false;
  if (!invite.expiresAt) return true;
  const expiry = new Date(invite.expiresAt).getTime();
  return Number.isNaN(expiry) || expiry > Date.now();
}

function InvitesPanel({ invites, loading, error, retry, revoking, onRevoke }: {
  invites: CompanyInvite[]; loading: boolean; error: unknown; retry: () => void; revoking: boolean; onRevoke: (inviteId: string) => void;
}) {
  const activeInvites = invites.filter(inviteIsActive);
  return (
    <div className="space-y-3 tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-[#edf2fb]"><Mail className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />Active invites</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">Open company invitations and their expiry times.</p>
        </div>
        <span className="rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">{activeInvites.length} active</span>
      </div>
      {loading ? <div className={`${panelClass} text-xs text-slate-500 dark:text-[#8b97ad]`}>Loading invites...</div> : error ? (
        <div className={`${panelClass} flex flex-wrap items-center justify-between gap-2 border-rose-500/30 text-xs dark:border-[#f43f5e]/30`}>
          <span className="text-rose-700 dark:text-[#fda4af]">Invites failed to load: {getErrorMessage(error, "Request failed.")}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={retry}>Retry</Button>
        </div>
      ) : activeInvites.length === 0 ? (
        <div className={`${panelClass} border-dashed text-xs text-slate-500 dark:text-[#8b97ad]`}>No active invites for this company.</div>
      ) : (
        <div className="space-y-2">
          {activeInvites.map((invite) => (
            <div key={invite.id} className={rowClass}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-[#edf2fb]">
                    <span>{invite.inviteType === "bootstrap_ceo" ? "Bootstrap CEO invite" : "Company invite"}</span>
                    <span className="rounded-full border border-slate-200/90 bg-slate-100/80 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#9aa7bd]">{invite.allowedJoinTypes}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-[#8b97ad]">Expires {formatDateTime(invite.expiresAt)} <span className="font-mono text-[10.5px]">#{shortId(invite.id)}</span></div>
                  {invite.inviteMessage && <div className="mt-1 truncate text-xs text-slate-500 dark:text-[#8b97ad]">{invite.inviteMessage}</div>}
                </div>
                <Button type="button" size="sm" variant="outline" className="h-7 border-rose-500/30 bg-white px-2 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#090c12] dark:text-[#fda4af] dark:hover:bg-[#f43f5e]/12" disabled={revoking} onClick={() => onRevoke(invite.id)}>Revoke</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SecurityPanel() {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOthersAfterChange, setRevokeOthersAfterChange] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionsQuery = useQuery({ queryKey: AUTH_SESSIONS_KEY, queryFn: () => authApi.listSessions(), retry: false });
  const currentSessionQuery = useQuery({ queryKey: AUTH_SESSION_KEY, queryFn: () => authApi.getSession(), retry: false });
  const invalidateSessions = () => void queryClient.invalidateQueries({ queryKey: AUTH_SESSIONS_KEY });
  const revokeSessionMutation = useMutation({ mutationFn: (sessionId: string) => authApi.revokeSession(sessionId), onSuccess: invalidateSessions });
  const revokeOthersMutation = useMutation({ mutationFn: () => authApi.revokeOtherSessions(), onSuccess: invalidateSessions });
  const changePasswordMutation = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: () => {
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setFormError(null);
      setNotice("Password updated. Other devices were signed out when requested.");
      invalidateSessions();
    },
  });
  const sessions = useMemo(() => (sessionsQuery.data ?? []).map((session) => ({
    ...session,
    current: session.current || session.id === currentSessionQuery.data?.session.id,
  })), [sessionsQuery.data, currentSessionQuery.data?.session.id]);
  const otherSessionCount = sessions.filter((session) => !session.current).length;
  const sessionActionError = revokeSessionMutation.error ?? revokeOthersMutation.error;
  const passwordError = formError ?? (changePasswordMutation.error ? authErrorMessage(changePasswordMutation.error, "Unable to change password.") : null);
  const submitPasswordChange = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    if (!currentPassword || !newPassword || !confirmPassword) return setFormError("Please fill in all password fields.");
    if (newPassword.length < 10) return setFormError("New password must be at least 10 characters.");
    if (newPassword !== confirmPassword) return setFormError("Passwords do not match.");
    setFormError(null);
    changePasswordMutation.mutate({ currentPassword, newPassword, revokeOtherSessions: revokeOthersAfterChange });
  };

  return (
    <div className="space-y-4 tabular-nums">
      <section className={panelClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-[#edf2fb]"><MonitorSmartphone className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />Active sessions</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">Review signed-in devices and revoke access you do not recognize.</p>
          </div>
          <Button type="button" size="sm" variant="outline" className="h-7 border-slate-200/90 bg-white text-[11px] dark:border-white/[0.09] dark:bg-[#0e131d] dark:text-[#cbd5e1]" disabled={revokeOthersMutation.isPending || otherSessionCount === 0} onClick={() => revokeOthersMutation.mutate()}>Sign out other devices</Button>
        </div>
        {sessionActionError && <p role="alert" className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-700 dark:border-[#f43f5e]/30 dark:text-[#fda4af]">{authErrorMessage(sessionActionError, "Session action failed.")}</p>}
        <div className="mt-3 space-y-2">
          {sessionsQuery.isLoading ? <div className="text-xs text-slate-500 dark:text-[#8b97ad]">Loading sessions...</div> : sessionsQuery.error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-rose-700 dark:text-[#fda4af]">Sessions failed to load: {authErrorMessage(sessionsQuery.error, "Request failed.")}</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void sessionsQuery.refetch()}>Retry</Button>
            </div>
          ) : sessions.length === 0 ? <div className="text-xs text-slate-500 dark:text-[#8b97ad]">No active sessions were returned.</div> : sessions.map((session) => (
            <div key={session.id} className={rowClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900 dark:text-[#edf2fb]">
                    <span>{session.current ? "This device" : "Signed-in device"}</span>
                    {session.current && <span className="rounded-full border border-lime-500/30 bg-lime-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-lime-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]">Current</span>}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-[#8b97ad]">IP {session.ipAddress ?? "unknown"} · Expires {formatDateTime(session.expiresAt)}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-[#8b97ad]" title={session.userAgent ?? undefined}>{session.userAgent ?? "User-Agent unknown"}</div>
                </div>
                {!session.current && <Button type="button" size="sm" variant="outline" className="h-7 border-rose-500/30 bg-white px-2 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#090c12] dark:text-[#fda4af] dark:hover:bg-[#f43f5e]/12" disabled={revokeSessionMutation.isPending} onClick={() => revokeSessionMutation.mutate(session.id)}>Revoke</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <form className={panelClass} onSubmit={submitPasswordChange}>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-[#edf2fb]"><KeyRound className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />Change password</h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">Use at least 10 characters. Optionally sign out other devices after the change.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">Current<input className={`${inputClass} mt-1`} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label>
          <label className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">New<input className={`${inputClass} mt-1`} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={10} /></label>
          <label className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-[#8b97ad]">Confirm<input className={`${inputClass} mt-1`} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={10} /></label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-slate-600 dark:text-[#9aa7bd]"><input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 accent-blue-600" checked={revokeOthersAfterChange} onChange={(event) => setRevokeOthersAfterChange(event.target.checked)} />Sign out other devices after changing password</label>
        {passwordError && <p role="alert" className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-700 dark:border-[#f43f5e]/30 dark:text-[#fda4af]">{passwordError}</p>}
        {notice && <p role="status" className="mt-3 rounded-md border border-lime-500/30 bg-lime-500/10 px-2.5 py-2 text-xs text-emerald-700 dark:border-[#a3e635]/30 dark:bg-[#a3e635]/12 dark:text-[#a3e635]">{notice}</p>}
        <Button type="submit" className="mt-3 h-8 bg-blue-600 text-xs text-white hover:bg-blue-500 dark:bg-[#2563eb] dark:hover:bg-[#3b82f6]" disabled={changePasswordMutation.isPending}>{changePasswordMutation.isPending ? "Updating..." : "Update password"}</Button>
      </form>
    </div>
  );
}

export function AccessSettingsSection({ selectedCompanyId }: { selectedCompanyId: string | null }) {
  const access = useAccessSettingsController(selectedCompanyId);
  return (
    <div className="space-y-2 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8b97ad]"><ShieldCheck className="h-3.5 w-3.5 text-blue-600 dark:text-[#60a5fa]" />Access</div>
        <div className="flex items-center gap-1.5 text-[11px] tabular-nums">
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 font-medium text-blue-700 dark:border-[#60a5fa]/30 dark:bg-[#60a5fa]/12 dark:text-[#60a5fa]">{access.userMembers.length} users</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/90 bg-slate-100/80 px-2 py-0.5 font-medium text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#9aa7bd]">{access.permissionGroups.length} groups</span>
        </div>
      </div>
      <div className="tactile-card rounded-xl border border-slate-200/90 bg-white px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/[0.08] dark:bg-[#0e131d] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_24px_-10px_rgba(0,0,0,0.65)]" data-testid="access-settings">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-[#edf2fb]">User and group permissions</div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-[#8b97ad]">Manage direct user grants, invitations, sessions, and inherited group grants.</div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-[#8b97ad] tabular-nums"><span className="font-medium text-slate-700 dark:text-[#cbd5e1]">{access.userMembers.length} users</span><span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-white/20" /><span className="font-medium text-slate-700 dark:text-[#cbd5e1]">{access.permissionGroups.length} groups</span></div>
        </div>
        {access.accessLoading && <div className="mt-4 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 text-xs text-slate-500 dark:border-white/[0.07] dark:bg-[#090c12] dark:text-[#8b97ad]">Loading access settings...</div>}
        {access.accessError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/8 px-3 py-2.5 text-xs dark:border-[#f43f5e]/30 dark:bg-[#f43f5e]/10">
            <span className="text-rose-700 dark:text-[#fda4af]">Access settings failed to load: {getErrorMessage(access.accessError, "Request failed.")}</span>
            <Button size="sm" variant="outline" className="h-7 border-rose-500/30 bg-white text-xs text-rose-700 hover:bg-rose-50 dark:border-[#f43f5e]/30 dark:bg-[#090c12] dark:text-[#fda4af] dark:hover:bg-[#f43f5e]/15" onClick={access.retryAccess}>Retry</Button>
          </div>
        )}
        {!access.accessLoading && !access.accessError && (
          <Tabs defaultValue="users" className="mt-4">
            <TabsList variant="line" className="w-full justify-start border-b border-slate-200/80 pb-1 dark:border-white/[0.07]">
              <TabsTrigger value="users" className={tabTriggerClass}><Users className="h-3.5 w-3.5" />Users</TabsTrigger>
              <TabsTrigger value="groups" className={tabTriggerClass}><ShieldCheck className="h-3.5 w-3.5" />Groups</TabsTrigger>
              <TabsTrigger value="invites" className={tabTriggerClass}><Mail className="h-3.5 w-3.5" />Invites</TabsTrigger>
              <TabsTrigger value="security" className={tabTriggerClass}><KeyRound className="h-3.5 w-3.5" />Security</TabsTrigger>
            </TabsList>
            <TabsContent value="users" className="mt-4">
              <AccessUsersView
                members={access.userMembers} groupById={access.groupById} disabled={access.updateMemberPermissionsPending || access.addMemberPending}
                onToggleGrant={access.toggleUserGrant} memberSearchQuery={access.memberSearchQuery} onMemberSearchQueryChange={access.setMemberSearchQuery}
                searchResults={access.memberSearchResults} searchLoading={access.memberSearchLoading} searchError={access.memberSearchError}
                selectedUserId={access.selectedUserId} onSelectUser={access.setSelectedUserId} addUserPending={access.addMemberPending} onAddSelectedUser={access.addSelectedMember}
                memberLifecyclePending={access.memberLifecyclePending} onMemberRoleChange={access.setMemberRole} onMemberStatusToggle={access.toggleMemberStatus} onRemoveMember={access.removeMember}
              />
            </TabsContent>
            <TabsContent value="groups" className="mt-4">
              <AccessGroupsView
                permissionGroups={access.permissionGroups} userMembers={access.userMembers} selectedGroupId={access.selectedGroupId} selectedGroup={access.selectedGroup}
                selectedGroupDetail={access.selectedGroupDetail} selectedGroupDetailLoading={access.selectedGroupDetailQuery.isLoading} selectedGroupDetailError={access.selectedGroupDetailQuery.error}
                newGroupName={access.newGroupName} newGroupDescription={access.newGroupDescription} editingGroupName={access.editingGroupName} editingGroupDescription={access.editingGroupDescription}
                creating={access.createGroupPending} disabled={access.groupMutationPending} onSelectGroup={access.setSelectedGroupId} onNewGroupNameChange={access.setNewGroupName}
                onNewGroupDescriptionChange={access.setNewGroupDescription} onEditingGroupNameChange={access.setEditingGroupName} onEditingGroupDescriptionChange={access.setEditingGroupDescription}
                onCreateGroup={access.createGroup} onSaveGroup={access.saveSelectedGroup} onToggleStatus={access.toggleGroupStatus} onDeleteGroup={access.deleteSelectedGroup}
                onToggleMember={access.toggleGroupMember} onToggleGrant={access.toggleGroupGrant}
              />
            </TabsContent>
            <TabsContent value="invites" className="mt-4">
              <InvitesPanel invites={access.companyInvites} loading={access.invitesLoading} error={access.invitesError} retry={access.retryInvites} revoking={access.revokeInvitePending} onRevoke={access.revokeInvite} />
            </TabsContent>
            <TabsContent value="security" className="mt-4"><SecurityPanel /></TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
