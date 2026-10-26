import type { MarkdownOperation } from "./types.js";

export type MarkdownListParent = { parentId: string; depth: number };

export type MarkdownListNesting = {
  /** The list block to nest this operation under, or undefined to place it at top level. */
  parentFor(operation: MarkdownOperation): MarkdownListParent | undefined;
  /** Record a block after it was inserted, at the depth it was actually placed. */
  inserted(operation: MarkdownOperation, blockId: string, depth: number): void;
};

/**
 * Tracks open list items while imported Markdown blocks are inserted, so a
 * nested list item (depth > 0) becomes a child of the most recent list item
 * one level up, which is how AFFiNE stores indented lists. Any other block
 * ends the list, so a later list starts again at the top level.
 */
export function createMarkdownListNesting(): MarkdownListNesting {
  // openItems[d] is the block id of the latest list item placed at depth d.
  const openItems: string[] = [];
  return {
    parentFor(operation) {
      if (operation.type !== "list" || !operation.depth || operation.depth < 1) return undefined;
      // Clamp to the deepest open item: if a parent was skipped, nest under its own parent.
      const depth = Math.min(Math.floor(operation.depth), openItems.length);
      return depth > 0 ? { parentId: openItems[depth - 1], depth } : undefined;
    },
    inserted(operation, blockId, depth) {
      if (operation.type !== "list") {
        openItems.length = 0;
        return;
      }
      openItems.length = depth;
      openItems[depth] = blockId;
    },
  };
}
