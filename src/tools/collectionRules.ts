/**
 * Translates MCP collection rules to and from AFFiNE's native collection rules.
 *
 * AFFiNE stores a collection as `{ id, name, rules: { filters: FilterParams[] }, allowList }`
 * and evaluates `rules.filters` live: every filter must match (intersection), a filter it
 * cannot parse makes the whole rule match nothing, and `allowList` docs are added on top.
 * Tag filters are `{ type: "system", key: "tags", method: "include-any-of", value: "<tagId>,..." }`.
 *
 * Tag rules are written natively so AFFiNE keeps the collection current as docs are tagged.
 * Title and doc-id rules have no exact native equivalent (AFFiNE's title filter is a fuzzy
 * search), so they are evaluated once into the allow-list. The MCP rule set itself is kept
 * under `rules.mcp`, which AFFiNE ignores, so the tools can still report it.
 */

export type CollectionRuleField = "title" | "tag" | "docId";
export type CollectionRuleOperator = "contains" | "equals" | "startsWith" | "in";
export type CollectionRuleFilter = {
  field: CollectionRuleField;
  operator: CollectionRuleOperator;
  value: string | string[];
};
export type CollectionRules = { match: "all" | "any"; filters: CollectionRuleFilter[] };

export type NativeFilter = { type: string; key: string; method: string; value?: string };
export type TagOption = { id: string; value: string };

/** The `rules` value stored on a collection. */
export type StoredCollectionRules = { filters: NativeFilter[]; mcp: CollectionRules };

/** Rules as the tools report them; `live` means AFFiNE evaluates them itself. */
export type CollectionRulesView = CollectionRules & { live: boolean };

const NATIVE_TAG_FILTER = { type: "system", key: "tags", method: "include-any-of" } as const;

function tagIdsFor(filter: CollectionRuleFilter, tags: TagOption[]): string[] {
  if (filter.field !== "tag" || typeof filter.value !== "string") return [];
  const target = filter.value.toLocaleLowerCase();
  return tags
    .filter(tag => {
      const name = tag.value.toLocaleLowerCase();
      return filter.operator === "contains" ? name.includes(target) : name === target;
    })
    .map(tag => tag.id);
}

/**
 * Native AFFiNE filters equivalent to `rules`, or null when they can't be expressed natively:
 * any non-tag filter, or a tag filter that matches no existing tag (an empty tag list would
 * never match, and a tag created later wouldn't be picked up either).
 * "all" becomes one native filter per rule (AFFiNE intersects them); "any" becomes a single
 * include-any-of over the union of tag ids.
 */
export function toNativeFilters(rules: CollectionRules, tags: TagOption[]): NativeFilter[] | null {
  if (rules.filters.length === 0) return null;
  const idSets: string[][] = [];
  for (const filter of rules.filters) {
    if (filter.field !== "tag") return null;
    const ids = tagIdsFor(filter, tags);
    if (ids.length === 0) return null;
    idSets.push(ids);
  }
  if (rules.match === "any") {
    const union = Array.from(new Set(idSets.flat()));
    return [{ ...NATIVE_TAG_FILTER, value: union.join(",") }];
  }
  return idSets.map(ids => ({ ...NATIVE_TAG_FILTER, value: ids.join(",") }));
}

/**
 * What to store for a new rule set. `matchedDocIds` are the docs the rule matches now.
 * Live (native) rules keep only manually added docs in the allow-list, so un-tagging a doc
 * removes it; snapshot rules store the matches in the allow-list, as before.
 */
export function planCollectionRules(input: {
  rules: CollectionRules;
  tags: TagOption[];
  matchedDocIds: string[];
  existingAllowList: string[];
}): { stored: StoredCollectionRules; allowList: string[]; live: boolean } {
  const native = toNativeFilters(input.rules, input.tags);
  if (native) {
    const matched = new Set(input.matchedDocIds);
    return {
      stored: { filters: native, mcp: input.rules },
      allowList: input.existingAllowList.filter(id => !matched.has(id)),
      live: true,
    };
  }
  return {
    stored: { filters: [], mcp: input.rules },
    allowList: [...input.matchedDocIds],
    live: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNativeFilter(value: unknown): value is NativeFilter {
  return isRecord(value) && typeof value.type === "string" && typeof value.key === "string" && typeof value.method === "string";
}

/** Native filters AFFiNE can evaluate (drops MCP-format filters written by older versions). */
export function nativeFiltersOf(rawRules: unknown): NativeFilter[] {
  if (!isRecord(rawRules) || !Array.isArray(rawRules.filters)) return [];
  return rawRules.filters.filter(isNativeFilter);
}

/**
 * Best-effort MCP view of native filters created in the AFFiNE app: tag include-any-of
 * filters become "tag equals <name>" rules. Other native filters can't be shown as MCP
 * rules and are left out of the view (they stay stored and keep working in AFFiNE).
 */
export function viewNativeFilters(filters: NativeFilter[], tagsById: Map<string, TagOption>): CollectionRules {
  const tagFilters = filters.filter(f => f.type === "system" && f.key === "tags" && f.method === "include-any-of");
  const names = (f: NativeFilter) =>
    (f.value ?? "").split(",").filter(Boolean).map(id => tagsById.get(id)?.value ?? id);
  if (tagFilters.length === 1) {
    const values = names(tagFilters[0]);
    return {
      match: values.length > 1 ? "any" : "all",
      filters: values.map(value => ({ field: "tag" as const, operator: "equals" as const, value })),
    };
  }
  return {
    match: "all",
    filters: tagFilters.flatMap(f => names(f).slice(0, 1).map(value => ({ field: "tag" as const, operator: "equals" as const, value }))),
  };
}
