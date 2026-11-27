// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccessUsersView } from "./AccessUsersView";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

const groupById = new Map<string, { id: string; name: string }>();

describe("AccessUsersView member picker", () => {
  it("renders the add-user search control and empty prompt", () => {
    const html = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery=""
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(html).toContain("Add user");
    expect(html).toContain("Search active users by name or email");
    expect(html).toContain("No human users have access to this company yet.");
  });

  it("renders loading, selectable result, and selected add state", () => {
    const loadingHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={true}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );
    const selectedHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[{ id: "user-2", name: "Candidate Cora", email: "candidate@example.com" }]}
        searchLoading={false}
        searchError={null}
        selectedUserId="user-2"
        onSelectUser={vi.fn()}
        addUserPending={true}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(loadingHtml).toContain("Searching users...");
    expect(selectedHtml).toContain("Candidate Cora");
    expect(selectedHtml).toContain("candidate@example.com");
    expect(selectedHtml).toContain("Adding...");
  });

  it("renders search errors and no-result state", () => {
    const errorHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="can"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={new Error("Search failed")}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );
    const emptyResultHtml = renderToStaticMarkup(
      <AccessUsersView
        members={[]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery="missing"
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(errorHtml).toContain("Search failed");
    expect(emptyResultHtml).toContain("No matching users available.");
  });

  it("renders the cobalt inherited-permission badge for permissions inherited from groups", () => {
    const member = {
      id: "member-1",
      companyId: "company-1",
      principalType: "user" as const,
      principalId: "user-1",
      status: "active" as const,
      membershipRole: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      grants: [],
      groupMemberships: [{ groupId: "group-1", status: "active" }],
      user: { id: "user-1", name: "Alice Kim", email: "alice@example.com" },
    };
    const groups = new Map([["group-1", { id: "group-1", name: "Operators" }]]);
    const inheritedByMember = new Map<string, ReadonlySet<string>>([
      ["member-1", new Set(["tasks:assign", "agents:create"])],
    ]);

    const html = renderToStaticMarkup(
      <AccessUsersView
        members={[member]}
        groupById={groups}
        inheritedPermissionKeysByMemberId={inheritedByMember}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery=""
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(html).toContain("Operators");
    expect(html).toContain('data-testid="inherited-badge-tasks:assign"');
    expect(html).toContain('data-testid="inherited-badge-agents:create"');
    expect(html).toContain("그룹 상속");
    expect(html).not.toContain('data-testid="inherited-badge-users:invite"');
    expect(html).toContain("2/6 granted");
  });

  it("omits the inherited badge when a member has no inherited permissions", () => {
    const member = {
      id: "member-2",
      companyId: "company-1",
      principalType: "user" as const,
      principalId: "user-2",
      status: "active" as const,
      membershipRole: "viewer",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      grants: [],
      groupMemberships: [],
      user: { id: "user-2", name: "Bob Park", email: "bob@example.com" },
    };

    const html = renderToStaticMarkup(
      <AccessUsersView
        members={[member]}
        groupById={groupById}
        disabled={false}
        onToggleGrant={vi.fn()}
        memberSearchQuery=""
        onMemberSearchQueryChange={vi.fn()}
        searchResults={[]}
        searchLoading={false}
        searchError={null}
        selectedUserId={null}
        onSelectUser={vi.fn()}
        addUserPending={false}
        onAddSelectedUser={vi.fn()}
      />,
    );

    expect(html).not.toContain("그룹 상속");
  });
});
