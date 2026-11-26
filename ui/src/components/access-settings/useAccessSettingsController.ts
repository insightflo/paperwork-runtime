import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PermissionKey } from "@paperclipai/shared";
import { useToast } from "../../context/ToastContext";
import { accessApi, type AccessGrantInput, type CompanyAccessMember } from "../../api/access";
import { api } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage, memberDisplayName, toggleGrant } from "./utils";
import { useMemberPicker } from "./useMemberPicker";

export type CompanyMemberRole = "owner" | "admin" | "member" | "viewer";
export type CompanyInvite = {
  id: string; companyId: string | null; inviteType: string; allowedJoinTypes: string;
  expiresAt: string | null; createdAt: string | null; revokedAt: string | null;
  acceptedAt: string | null; inviteMessage: string | null;
};
type MemberLifecycleInput = { membershipRole?: CompanyMemberRole; status?: "active" | "suspended" };

const invitesKey = (companyId: string) => ["access", "invites", companyId] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function textOrNull(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function toInvite(value: unknown): CompanyInvite | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id, companyId: textOrNull(value.companyId),
    inviteType: textOrNull(value.inviteType) ?? "company_join", allowedJoinTypes: textOrNull(value.allowedJoinTypes) ?? "both",
    expiresAt: textOrNull(value.expiresAt), createdAt: textOrNull(value.createdAt), revokedAt: textOrNull(value.revokedAt),
    acceptedAt: textOrNull(value.acceptedAt), inviteMessage: textOrNull(value.inviteMessage),
  };
}

async function listCompanyInvites(companyId: string) {
  const payload = await api.get<unknown>(`/companies/${companyId}/invites`);
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.invites)
      ? payload.invites
      : [];
  return rows.map(toInvite).filter((invite): invite is CompanyInvite => !!invite);
}

export function useAccessSettingsController(selectedCompanyId: string | null) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [editingGroupName, setEditingGroupName] = useState("");
  const [editingGroupDescription, setEditingGroupDescription] = useState("");
  const notifyError = (title: string, fallback: string) => (err: unknown) =>
    pushToast({ title, body: getErrorMessage(err, fallback), tone: "error" });

  const accessMembersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.members(selectedCompanyId) : ["access", "members", "__no-company__"],
    queryFn: () => accessApi.listMembers(selectedCompanyId!), enabled: !!selectedCompanyId,
  });
  const permissionGroupsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.access.permissionGroups(selectedCompanyId) : ["access", "permission-groups", "__no-company__"],
    queryFn: () => accessApi.listPermissionGroups(selectedCompanyId!), enabled: !!selectedCompanyId,
  });
  const companyInvitesQuery = useQuery({
    queryKey: selectedCompanyId ? invitesKey(selectedCompanyId) : ["access", "invites", "__no-company__"],
    queryFn: () => listCompanyInvites(selectedCompanyId!), enabled: !!selectedCompanyId, retry: false,
  });

  const permissionGroups = useMemo(() => permissionGroupsQuery.data ?? [], [permissionGroupsQuery.data]);
  const accessMembers = useMemo(() => accessMembersQuery.data ?? [], [accessMembersQuery.data]);
  const companyInvites = useMemo(() => companyInvitesQuery.data ?? [], [companyInvitesQuery.data]);
  const userMembers = useMemo(() => accessMembers.filter((member) => member.principalType === "user"), [accessMembers]);
  const groupById = useMemo(() => new Map(permissionGroups.map((group) => [group.id, group])), [permissionGroups]);
  const selectedGroup = selectedGroupId ? permissionGroups.find((group) => group.id === selectedGroupId) ?? null : null;

  const selectedGroupDetailQuery = useQuery({
    queryKey: selectedCompanyId && selectedGroupId ? queryKeys.access.permissionGroup(selectedCompanyId, selectedGroupId) : ["access", "permission-groups", "__no-company__", "__no-group__"],
    queryFn: () => accessApi.getPermissionGroup(selectedCompanyId!, selectedGroupId!),
    enabled: !!selectedCompanyId && !!selectedGroupId,
  });
  const selectedGroupDetail = selectedGroupDetailQuery.data ?? null;

  useEffect(() => {
    if (!selectedCompanyId) {
      setSelectedGroupId(null);
      return;
    }
    if (!permissionGroupsQuery.data) return;
    setSelectedGroupId((current) => {
      if (current && permissionGroups.some((group) => group.id === current)) return current;
      return permissionGroups[0]?.id ?? null;
    });
  }, [selectedCompanyId, permissionGroups, permissionGroupsQuery.data]);
  useEffect(() => {
    setEditingGroupName(selectedGroup?.name ?? "");
    setEditingGroupDescription(selectedGroup?.description ?? "");
  }, [selectedGroup?.id, selectedGroup?.name, selectedGroup?.description]);
  useEffect(() => { setNewGroupName(""); setNewGroupDescription(""); }, [selectedCompanyId]);

  function invalidateAccessQueries(groupId?: string | null) {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.access.members(selectedCompanyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.access.permissionGroups(selectedCompanyId) });
    void queryClient.invalidateQueries({ queryKey: invitesKey(selectedCompanyId) });
    if (groupId) void queryClient.invalidateQueries({ queryKey: queryKeys.access.permissionGroup(selectedCompanyId, groupId) });
  }

  const memberPicker = useMemberPicker(selectedCompanyId, () => invalidateAccessQueries());
  const updateMemberPermissionsMutation = useMutation({
    mutationFn: ({ memberId, grants }: { memberId: string; grants: AccessGrantInput[] }) =>
      accessApi.updateMemberPermissions(selectedCompanyId!, memberId, grants),
    onSuccess: () => invalidateAccessQueries(),
    onError: notifyError("Permission update failed", "Unable to update user permissions."),
  });
  const updateMemberLifecycleMutation = useMutation({
    mutationFn: ({ memberId, input }: { memberId: string; input: MemberLifecycleInput }) =>
      api.patch<unknown>(`/companies/${selectedCompanyId}/members/${memberId}`, input),
    onSuccess: () => {
      invalidateAccessQueries();
      pushToast({ title: "Member updated", tone: "success" });
    },
    onError: notifyError("Member update failed", "Unable to update this member."),
  });
  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.delete<void>(`/companies/${selectedCompanyId}/members/${memberId}`),
    onSuccess: () => {
      invalidateAccessQueries();
      pushToast({ title: "Member removed", tone: "success" });
    },
    onError: notifyError("Member removal failed", "Unable to remove this member."),
  });
  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => api.post<unknown>(`/invites/${inviteId}/revoke`, {}),
    onSuccess: () => {
      invalidateAccessQueries();
      pushToast({ title: "Invite revoked", tone: "success" });
    },
    onError: notifyError("Invite revoke failed", "Unable to revoke this invite."),
  });
  const createGroupMutation = useMutation({
    mutationFn: () => accessApi.createPermissionGroup(selectedCompanyId!, {
      name: newGroupName.trim(),
      description: newGroupDescription.trim() || null,
      status: "active",
    }),
    onSuccess: (group) => {
      setNewGroupName("");
      setNewGroupDescription("");
      setSelectedGroupId(group.id);
      invalidateAccessQueries(group.id);
      pushToast({ title: "Group created", body: group.name, tone: "success" });
    },
    onError: notifyError("Group creation failed", "Unable to create group."),
  });
  const updateGroupMutation = useMutation({
    mutationFn: ({ groupId, ...input }: { groupId: string; name?: string; description?: string | null; status?: "active" | "suspended" }) =>
      accessApi.updatePermissionGroup(selectedCompanyId!, groupId, input),
    onSuccess: (group) => {
      invalidateAccessQueries(group.id);
      pushToast({ title: "Group updated", body: group.name, tone: "success" });
    },
    onError: notifyError("Group update failed", "Unable to update group."),
  });
  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => accessApi.deletePermissionGroup(selectedCompanyId!, groupId).then(() => groupId),
    onSuccess: (groupId) => {
      setSelectedGroupId(null);
      invalidateAccessQueries(groupId);
      pushToast({ title: "Group deleted", tone: "success" });
    },
    onError: notifyError("Group delete failed", "Unable to delete group."),
  });
  const updateGroupMembersMutation = useMutation({
    mutationFn: (input: { groupId: string; addUserIds?: string[]; removeUserIds?: string[] }) =>
      accessApi.updatePermissionGroupMembers(selectedCompanyId!, input.groupId, {
        addUserIds: input.addUserIds,
        removeUserIds: input.removeUserIds,
      }),
    onSuccess: (_members, variables) => invalidateAccessQueries(variables.groupId),
    onError: notifyError("Group members update failed", "Unable to update group members."),
  });
  const updateGroupPermissionsMutation = useMutation({
    mutationFn: ({ groupId, grants }: { groupId: string; grants: AccessGrantInput[] }) =>
      accessApi.updatePermissionGroupPermissions(selectedCompanyId!, groupId, grants),
    onSuccess: (_grants, variables) => invalidateAccessQueries(variables.groupId),
    onError: notifyError("Group permission update failed", "Unable to update group permissions."),
  });

  const groupMutationPending =
    updateGroupMutation.isPending || deleteGroupMutation.isPending || updateGroupMembersMutation.isPending || updateGroupPermissionsMutation.isPending;
  const accessLoading = accessMembersQuery.isLoading || permissionGroupsQuery.isLoading;
  const accessError = accessMembersQuery.error ?? permissionGroupsQuery.error;
  const retryAccess = () => {
    void accessMembersQuery.refetch();
    void permissionGroupsQuery.refetch();
  };

  return {
    accessError,
    accessLoading,
    companyInvites,
    groupById,
    groupMutationPending,
    permissionGroups,
    selectedGroup,
    selectedGroupDetail,
    selectedGroupDetailQuery,
    userMembers,
    editingGroupDescription,
    editingGroupName,
    newGroupDescription,
    newGroupName,
    memberSearchQuery: memberPicker.memberSearchQuery,
    memberSearchResults: memberPicker.memberSearchResults,
    memberSearchLoading: memberPicker.memberSearchLoading,
    memberSearchError: memberPicker.memberSearchError,
    selectedUserId: memberPicker.selectedUserId,
    selectedGroupId,
    addMemberPending: memberPicker.addMemberPending,
    createGroupPending: createGroupMutation.isPending,
    invitesLoading: companyInvitesQuery.isLoading,
    invitesError: companyInvitesQuery.error,
    memberLifecyclePending: updateMemberLifecycleMutation.isPending || removeMemberMutation.isPending,
    revokeInvitePending: revokeInviteMutation.isPending,
    updateMemberPermissionsPending: updateMemberPermissionsMutation.isPending,
    setEditingGroupDescription,
    setEditingGroupName,
    setNewGroupDescription,
    setNewGroupName,
    setMemberSearchQuery: memberPicker.setMemberSearchQuery,
    setSelectedUserId: memberPicker.setSelectedUserId,
    setSelectedGroupId,
    retryAccess,
    retryInvites: () => void companyInvitesQuery.refetch(),
    createGroup: () => createGroupMutation.mutate(),
    addSelectedMember: memberPicker.addSelectedMember,
    revokeInvite: (inviteId: string) => revokeInviteMutation.mutate(inviteId),
    setMemberRole: (member: CompanyAccessMember, role: CompanyMemberRole) => {
      if ((member.membershipRole ?? "member") !== role) {
        updateMemberLifecycleMutation.mutate({ memberId: member.id, input: { membershipRole: role } });
      }
    },
    toggleMemberStatus: (member: CompanyAccessMember) => {
      updateMemberLifecycleMutation.mutate({
        memberId: member.id,
        input: { status: member.status === "active" ? "suspended" : "active" },
      });
    },
    removeMember: (member: CompanyAccessMember) => {
      const confirmed = window.confirm(`Remove ${memberDisplayName(member)} from this company? Their direct access will be revoked.`);
      if (confirmed) removeMemberMutation.mutate(member.id);
    },
    deleteSelectedGroup: () => {
      if (!selectedGroup) return;
      const confirmed = window.confirm(`Delete group "${selectedGroup.name}"? Its permissions and memberships will be removed.`);
      if (confirmed) deleteGroupMutation.mutate(selectedGroup.id);
    },
    saveSelectedGroup: () => {
      if (!selectedGroup) return;
      updateGroupMutation.mutate({
        groupId: selectedGroup.id,
        name: editingGroupName.trim(),
        description: editingGroupDescription.trim() || null,
      });
    },
    toggleGroupGrant: (permissionKey: PermissionKey, checked: boolean) => {
      if (!selectedGroupDetail) return;
      updateGroupPermissionsMutation.mutate({
        groupId: selectedGroupDetail.id,
        grants: toggleGrant(selectedGroupDetail.grants, permissionKey, checked),
      });
    },
    toggleGroupMember: (userId: string, checked: boolean) => {
      if (!selectedGroup) return;
      updateGroupMembersMutation.mutate({
        groupId: selectedGroup.id,
        addUserIds: checked ? [userId] : [],
        removeUserIds: checked ? [] : [userId],
      });
    },
    toggleGroupStatus: (status: "active" | "suspended") => {
      if (!selectedGroup) return;
      updateGroupMutation.mutate({ groupId: selectedGroup.id, status });
    },
    toggleUserGrant: (member: CompanyAccessMember, permissionKey: PermissionKey, checked: boolean) =>
      updateMemberPermissionsMutation.mutate({
        memberId: member.id,
        grants: toggleGrant(member.grants, permissionKey, checked),
      }),
  };
}
