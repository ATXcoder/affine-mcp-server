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

  const RECOVER_DOC_RELIABILITY_WARNING =
    "KNOWN UNRELIABLE on self-hosted AFFiNE (verified 2026-08-16): this mutation reports success and even records a backup history entry, but the doc's visible content may not actually change — reproduced against both this tool and AFFiNE's own web UI restore feature on the same doc/timestamp, so it is an upstream AFFiNE server issue, not specific to this fork. Matches a known, recurring category of self-hosted history/restore bugs (toeverything/AFFiNE issues #9557, #10457, #10533, #11282). Always re-read the doc after calling this to confirm the content actually changed — do not trust a successful response alone, and do not rely on this for real data recovery until re-verified against a newer AFFiNE version.";

  const recoverDocHandler = async (parsed: { workspaceId?: string; guid: string; timestamp: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const mutation = `mutation RecoverDoc($workspaceId:String!,$guid:String!,$timestamp:DateTime!){ recoverDoc(workspaceId:$workspaceId, guid:$guid, timestamp:$timestamp) }`;
    const data = await gql.request<{ recoverDoc: string }>(mutation, { workspaceId, guid: parsed.guid, timestamp: parsed.timestamp });
    return text({
      workspaceId,
      docId: parsed.guid,
      timestamp: parsed.timestamp,
      recoveredAt: data.recoverDoc,
      warning: RECOVER_DOC_RELIABILITY_WARNING,
    });
  };
  server.registerTool(
    "recover_doc",
    {
      title: "Recover Doc",
      description: `Revert a document to a prior version by timestamp. Use list_histories first to find a valid timestamp for that doc — recoverDoc requires an exact match to one of its returned \`timestamp\` values, not an arbitrary date. This is intended to overwrite the doc's current content with that historical snapshot and would not be reversible except by recovering to a different timestamp. ${RECOVER_DOC_RELIABILITY_WARNING}`,
      inputSchema: {
        workspaceId: z.string().optional(),
        guid: z.string().describe("Doc id to recover."),
        timestamp: z.string().describe("Exact history timestamp to recover to, as returned by list_histories (ISO DateTime string).")
      }
    },
    recoverDocHandler as any
  );
}
