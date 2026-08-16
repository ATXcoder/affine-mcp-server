import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { z } from "zod";
import { BoundedHistoryTake } from "../util/inputSchemas.js";

export function registerHistoryTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const listHistoriesHandler = async (parsed: { workspaceId?: string; guid: string; take?: number; before?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const query = `query Histories($workspaceId:String!,$guid:String!,$take:Int,$before:DateTime){ workspace(id:$workspaceId){ histories(guid:$guid, take:$take, before:$before){ id timestamp workspaceId } } }`;
    const data = await gql.request<{ workspace: any }>(query, { workspaceId, guid: parsed.guid, take: parsed.take, before: parsed.before });
    return text(data.workspace.histories);
  };
  server.registerTool(
    "list_histories",
    {
      title: "List Histories",
      description: "List doc histories (timestamps) for a doc.",
      inputSchema: {
        workspaceId: z.string().optional(),
        guid: z.string(),
        take: BoundedHistoryTake.optional().describe("Maximum history entries to return (1-200)."),
        before: z.string().optional()
      }
    },
    listHistoriesHandler as any
  );

  const recoverDocHandler = async (parsed: { workspaceId?: string; guid: string; timestamp: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const mutation = `mutation RecoverDoc($workspaceId:String!,$guid:String!,$timestamp:DateTime!){ recoverDoc(workspaceId:$workspaceId, guid:$guid, timestamp:$timestamp) }`;
    const data = await gql.request<{ recoverDoc: string }>(mutation, { workspaceId, guid: parsed.guid, timestamp: parsed.timestamp });
    return text({ workspaceId, docId: parsed.guid, timestamp: parsed.timestamp, recoveredAt: data.recoverDoc });
  };
  server.registerTool(
    "recover_doc",
    {
      title: "Recover Doc",
      description: "Revert a document to a prior version by timestamp. Use list_histories first to find a valid timestamp for that doc — recoverDoc requires an exact match to one of its returned `timestamp` values, not an arbitrary date. This overwrites the doc's current content with that historical snapshot; it is not reversible except by recovering to a different timestamp (including the doc's most recent history entry, if captured before this call).",
      inputSchema: {
        workspaceId: z.string().optional(),
        guid: z.string().describe("Doc id to recover."),
        timestamp: z.string().describe("Exact history timestamp to recover to, as returned by list_histories (ISO DateTime string).")
      }
    },
    recoverDocHandler as any
  );
}
