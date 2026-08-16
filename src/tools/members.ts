import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";

const WorkspaceId = z.string().min(1, "workspaceId required");

const INVITE_LINK_EXPIRE_VALUES = ["OneDay", "ThreeDays", "OneWeek", "OneMonth"] as const;
const WORKSPACE_ROLE_VALUES = ["Owner", "Admin", "Collaborator"] as const;

type WorkspaceMember = {
  id: string;
  name?: string | null;
  email?: string | null;
  permission?: string | null;
  role?: string | null;
  inviteId?: string | null;
  status?: string | null;
};

/** Register the six workspace-member-management tools on the MCP server. */
export function registerMemberTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string }
) {
  function requireWorkspaceId(workspaceId?: string): string {
    const id = workspaceId || defaults.workspaceId;
    if (!id) {
      throw new Error(
        "workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment."
      );
    }
    return id;
  }

  async function fetchMembers(workspaceId: string, query?: string): Promise<WorkspaceMember[]> {
    const gqlQuery = `query WorkspaceMembers($workspaceId:String!,$query:String){ workspace(id:$workspaceId){ members(query:$query){ id name email permission role inviteId status } } }`;
    const data = await gql.request<{ workspace: { members: WorkspaceMember[] } }>(gqlQuery, {
      workspaceId,
      query,
    });
    return data.workspace.members;
  }

  /**
   * Resolve a member by exact userId, or by unique case-insensitive email.
   * Falls back to returning the raw input as the userId if no member matches
   * (lets the underlying mutation surface its own clear error, rather than
   * this helper guessing wrong).
   */
  async function resolveMemberUserId(
    workspaceId: string,
    userIdOrEmail: string
  ): Promise<{ userId: string; member: WorkspaceMember | null }> {
    const members = await fetchMembers(workspaceId);
    const byId = members.find((m) => m.id === userIdOrEmail);
    if (byId) return { userId: byId.id, member: byId };
    const lowered = userIdOrEmail.trim().toLowerCase();
    const byEmail = members.filter((m) => (m.email || "").trim().toLowerCase() === lowered);
    if (byEmail.length === 1) return { userId: byEmail[0].id, member: byEmail[0] };
    if (byEmail.length > 1) {
      throw new Error(
        `"${userIdOrEmail}" matches ${byEmail.length} members by email — this shouldn't happen; use the exact userId instead.`
      );
    }
    return { userId: userIdOrEmail, member: null };
  }

  // ---------------------------------------------------------------------------
  // list_workspace_members
  // ---------------------------------------------------------------------------
  const listWorkspaceMembersHandler = async (parsed: { workspaceId?: string; query?: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const members = await fetchMembers(workspaceId, parsed.query);
    return text({ workspaceId, count: members.length, members });
  };
  server.registerTool(
    "list_workspace_members",
    {
      title: "List Workspace Members",
      description:
        "List members of a workspace, including userId, email, role, and invite status. Use this to look up a member's userId, or just pass their email directly to grant_member/revoke_member — both resolve against this same list.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        query: z.string().optional().describe("Optional search filter (matches name/email)."),
      },
    },
    listWorkspaceMembersHandler as any
  );

  // ---------------------------------------------------------------------------
  // invite_members
  // ---------------------------------------------------------------------------
  const inviteMembersHandler = async (parsed: { workspaceId?: string; emails: string[] }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const mutation = `mutation InviteMembers($workspaceId:String!,$emails:[String!]!){ inviteMembers(workspaceId:$workspaceId, emails:$emails){ email inviteId error } }`;
    const data = await gql.request<{
      inviteMembers: Array<{ email: string; inviteId: string | null; error: unknown }>;
    }>(mutation, { workspaceId, emails: parsed.emails });
    return text({ workspaceId, results: data.inviteMembers });
  };
  server.registerTool(
    "invite_members",
    {
      title: "Invite Members",
      description:
        "Send AFFiNE workspace invitations by email. Requires the server to have SMTP configured to actually deliver invite emails — without it, expect each result to carry an error even though a pending invite record may still be created. This does not set a role; new members join with the default role and must be promoted separately with grant_member. On a self-hosted deployment without SMTP, prefer create_invite_link instead.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        emails: z.array(z.string().email()).min(1).describe("Email addresses to invite."),
      },
    },
    inviteMembersHandler as any
  );

  // ---------------------------------------------------------------------------
  // create_invite_link
  // ---------------------------------------------------------------------------
  const createInviteLinkHandler = async (parsed: { workspaceId?: string; expireTime: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const mutation = `mutation CreateInviteLink($workspaceId:String!,$expireTime:WorkspaceInviteLinkExpireTime!){ createInviteLink(workspaceId:$workspaceId, expireTime:$expireTime){ link expireTime } }`;
    const data = await gql.request<{ createInviteLink: { link: string; expireTime: string } }>(
      mutation,
      { workspaceId, expireTime: parsed.expireTime }
    );
    return text({ workspaceId, link: data.createInviteLink.link, expireTime: data.createInviteLink.expireTime });
  };
  server.registerTool(
    "create_invite_link",
    {
      title: "Create Invite Link",
      description:
        "Create a shareable workspace invite link that expires after the given duration — works without SMTP, unlike invite_members. Anyone with the link can join the workspace; share it only through a trusted channel.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        expireTime: z.enum(INVITE_LINK_EXPIRE_VALUES).describe("How long the link stays valid."),
      },
    },
    createInviteLinkHandler as any
  );

  // ---------------------------------------------------------------------------
  // revoke_invite_link
  // ---------------------------------------------------------------------------
  const revokeInviteLinkHandler = async (parsed: { workspaceId?: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const mutation = `mutation RevokeInviteLink($workspaceId:String!){ revokeInviteLink(workspaceId:$workspaceId) }`;
    const data = await gql.request<{ revokeInviteLink: boolean }>(mutation, { workspaceId });
    return text({ workspaceId, revoked: data.revokeInviteLink });
  };
  server.registerTool(
    "revoke_invite_link",
    {
      title: "Revoke Invite Link",
      description: "Invalidate the workspace's current shareable invite link, if one exists.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
      },
    },
    revokeInviteLinkHandler as any
  );

  // ---------------------------------------------------------------------------
  // grant_member
  // ---------------------------------------------------------------------------
  const grantMemberHandler = async (parsed: { workspaceId?: string; userIdOrEmail: string; role: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { userId, member } = await resolveMemberUserId(workspaceId, parsed.userIdOrEmail);
    const mutation = `mutation GrantMember($workspaceId:String!,$userId:String!,$permission:WorkspaceRole!){ grantMember(workspaceId:$workspaceId, userId:$userId, permission:$permission) }`;
    const data = await gql.request<{ grantMember: boolean }>(mutation, {
      workspaceId,
      userId,
      permission: parsed.role,
    });
    return text({
      workspaceId,
      userId,
      email: member?.email ?? null,
      role: parsed.role,
      updated: data.grantMember,
    });
  };
  server.registerTool(
    "grant_member",
    {
      title: "Grant Member Role",
      description:
        "Change a workspace member's role (Owner, Admin, or Collaborator). Accepts either the member's userId or their email (resolved via the current member list — errors if the email matches more than one member, which shouldn't normally happen). Setting Owner transfers primary workspace ownership; use deliberately.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        userIdOrEmail: z.string().min(1).describe("Member's userId or email."),
        role: z.enum(WORKSPACE_ROLE_VALUES).describe("New role to grant."),
      },
    },
    grantMemberHandler as any
  );

  // ---------------------------------------------------------------------------
  // revoke_member
  // ---------------------------------------------------------------------------
  const revokeMemberHandler = async (parsed: { workspaceId?: string; userIdOrEmail: string }) => {
    const workspaceId = requireWorkspaceId(parsed.workspaceId);
    const { userId, member } = await resolveMemberUserId(workspaceId, parsed.userIdOrEmail);
    const mutation = `mutation RevokeMember($workspaceId:String!,$userId:String!){ revokeMember(workspaceId:$workspaceId, userId:$userId) }`;
    const data = await gql.request<{ revokeMember: boolean }>(mutation, { workspaceId, userId });
    return text({
      workspaceId,
      userId,
      email: member?.email ?? null,
      revoked: data.revokeMember,
    });
  };
  server.registerTool(
    "revoke_member",
    {
      title: "Revoke Member",
      description:
        "Remove a member from the workspace, revoking their access. Accepts either the member's userId or their email (resolved via the current member list). This only removes their workspace membership — it does not delete anything they've created.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        userIdOrEmail: z.string().min(1).describe("Member's userId or email."),
      },
    },
    revokeMemberHandler as any
  );
}
