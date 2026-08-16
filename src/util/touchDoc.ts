import * as Y from "yjs";
import { loadDoc, pushDocUpdate, type WorkspaceSocket } from "../ws.js";

/**
 * Bump a doc's `updatedDate` in the workspace's pageMeta so AFFiNE's "last
 * updated" UI reflects edits made over this raw CRDT protocol.
 *
 * AFFiNE's own client does this as a side effect of its editor's change
 * observer whenever a doc's content changes — the server never infers it
 * from the pushed update bytes themselves (it just relays/persists CRDT
 * deltas, the same way every other tool in this codebase treats it). Any
 * tool that pushes a content update to a specific doc without already
 * touching that doc's pageMeta entry for another reason (tagging, renaming,
 * creation — all of which should set `updatedDate` inline instead, since
 * they already have the entry loaded) must call this separately.
 *
 * No-op if the doc isn't present in workspace pageMeta (e.g. a WorkspaceDB
 * sub-doc like db$docProperties, not a real page) or if nothing changed.
 */
export async function touchDocUpdatedDate(
  socket: WorkspaceSocket,
  workspaceId: string,
  docId: string,
  timestamp: number = Date.now()
): Promise<void> {
  if (docId === workspaceId) return;
  const wsDoc = new Y.Doc();
  const wsSnapshot = await loadDoc(socket, workspaceId, workspaceId);
  if (wsSnapshot.missing) {
    Y.applyUpdate(wsDoc, Buffer.from(wsSnapshot.missing, "base64"));
  }
  const wsPrevSV = Y.encodeStateVector(wsDoc);
  const wsMeta = wsDoc.getMap("meta");
  const pages = wsMeta.get("pages");
  if (!(pages instanceof Y.Array)) return;
  const entry = pages.toArray().find(
    (value: unknown) => value instanceof Y.Map && value.get("id") === docId
  ) as InstanceType<typeof Y.Map> | undefined;
  if (!entry) return;
  entry.set("updatedDate", timestamp);
  const wsDelta = Y.encodeStateAsUpdate(wsDoc, wsPrevSV);
  if (wsDelta.length === 0) return;
  await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString("base64"));
}
