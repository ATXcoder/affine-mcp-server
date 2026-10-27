#!/usr/bin/env node
// Collection rules stored for AFFiNE: tag rules become native AFFiNE filters that AFFiNE
// evaluates live, other rules fall back to an allow-list snapshot, and nothing stored can
// break AFFiNE's own rule evaluation. Runs offline against dist/.
import assert from "node:assert/strict";

import {
  nativeFiltersOf,
  planCollectionRules,
  toNativeFilters,
  viewNativeFilters,
} from "../dist/tools/collectionRules.js";

const TAGS = [
  { id: "t-smart", value: "smart-home" },
  { id: "t-smartphone", value: "smartphone" },
  { id: "t-review", value: "needs-review" },
  { id: "t-dup", value: "possible-duplicate" },
];
const DOCS = {
  speakers: ["t-smart"],
  haos: ["t-smart", "t-review"],
  phone: ["t-smartphone"],
  dup: ["t-dup"],
  untagged: [],
};

/**
 * AFFiNE's collection evaluation (collection-rules service): every filter must match
 * (intersection), an unsupported filter turns the whole result into nothing, no filters
 * match nothing, and allowList docs are added on top.
 */
function affineCollectionDocs({ rules, allowList }) {
  const filters = rules?.filters ?? [];
  let matched = new Set();
  if (filters.length > 0) {
    let acc = null;
    for (const filter of filters) {
      const isTagFilter = filter.type === "system" && filter.key === "tags" && filter.method === "include-any-of";
      if (!isTagFilter) { acc = "error"; break; }
      const ids = (filter.value ?? "").split(",").filter(Boolean);
      const docs = new Set(Object.keys(DOCS).filter(doc => DOCS[doc].some(tag => ids.includes(tag))));
      acc = acc === null ? docs : new Set([...acc].filter(doc => docs.has(doc)));
    }
    matched = acc === "error" ? new Set() : acc;
  }
  return [...new Set([...matched, ...(allowList ?? [])])].sort();
}

const tag = (operator, value) => ({ field: "tag", operator, value });

function testTagEqualsBecomesNativeFilter() {
  const native = toNativeFilters({ match: "all", filters: [tag("equals", "smart-home")] }, TAGS);
  assert.deepEqual(native, [{ type: "system", key: "tags", method: "include-any-of", value: "t-smart" }]);
}

function testTagContainsCoversEveryMatchingTag() {
  const native = toNativeFilters({ match: "all", filters: [tag("contains", "SMART")] }, TAGS);
  assert.deepEqual(native, [{ type: "system", key: "tags", method: "include-any-of", value: "t-smart,t-smartphone" }],
    "contains is case-insensitive and covers every tag whose name contains the text");
}

function testMatchAnyUnionsAndMatchAllIntersects() {
  const any = toNativeFilters({ match: "any", filters: [tag("equals", "needs-review"), tag("equals", "possible-duplicate")] }, TAGS);
  assert.deepEqual(any, [{ type: "system", key: "tags", method: "include-any-of", value: "t-review,t-dup" }]);
  assert.deepEqual(affineCollectionDocs({ rules: { filters: any }, allowList: [] }), ["dup", "haos"]);

  const all = toNativeFilters({ match: "all", filters: [tag("equals", "smart-home"), tag("equals", "needs-review")] }, TAGS);
  assert.equal(all.length, 2, "one native filter per rule, which AFFiNE intersects");
  assert.deepEqual(affineCollectionDocs({ rules: { filters: all }, allowList: [] }), ["haos"]);
}

function testNonTagOrUnknownTagRulesAreNotNative() {
  assert.equal(toNativeFilters({ match: "all", filters: [{ field: "title", operator: "contains", value: "x" }] }, TAGS), null);
  assert.equal(toNativeFilters({ match: "all", filters: [tag("equals", "smart-home"), { field: "docId", operator: "equals", value: "d" }] }, TAGS), null);
  assert.equal(toNativeFilters({ match: "all", filters: [tag("equals", "no-such-tag")] }, TAGS), null,
    "a rule naming no existing tag would never match natively, so it is evaluated once instead");
  assert.equal(toNativeFilters({ match: "all", filters: [] }, TAGS), null);
}

function testLiveRuleKeepsOnlyManualAllowListEntries() {
  const plan = planCollectionRules({
    rules: { match: "all", filters: [tag("equals", "smart-home")] },
    tags: TAGS,
    matchedDocIds: ["speakers", "haos"],
    existingAllowList: ["speakers", "haos", "untagged"],
  });
  assert.equal(plan.live, true);
  assert.deepEqual(plan.allowList, ["untagged"], "docs the live rule covers leave the allow-list; manual ones stay");
  assert.deepEqual(plan.stored.mcp, { match: "all", filters: [tag("equals", "smart-home")] }, "MCP rules kept for display");
  assert.deepEqual(affineCollectionDocs({ rules: plan.stored, allowList: plan.allowList }), ["haos", "speakers", "untagged"]);

  // A doc tagged later joins without touching the collection.
  DOCS.later = ["t-smart"];
  assert.deepEqual(affineCollectionDocs({ rules: plan.stored, allowList: plan.allowList }), ["haos", "later", "speakers", "untagged"]);
  delete DOCS.later;
}

function testSnapshotRuleStoresMatchesWithoutBreakingAffine() {
  const plan = planCollectionRules({
    rules: { match: "all", filters: [{ field: "title", operator: "contains", value: "home" }] },
    tags: TAGS,
    matchedDocIds: ["speakers"],
    existingAllowList: ["dup"],
  });
  assert.equal(plan.live, false);
  assert.deepEqual(plan.stored.filters, [], "no MCP-format filter is written where AFFiNE reads its rules");
  assert.deepEqual(plan.allowList, ["speakers"]);
  assert.deepEqual(affineCollectionDocs({ rules: plan.stored, allowList: plan.allowList }), ["speakers"]);
}

function testLegacyMcpFiltersBreakAffineRules() {
  // What older versions stored, plus a tag rule added in the AFFiNE app: AFFiNE matches nothing.
  const legacy = {
    rules: {
      match: "all",
      filters: [
        { field: "tag", operator: "contains", value: "smart-home" },
        { type: "system", key: "tags", method: "include-any-of", value: "t-smart" },
      ],
    },
    allowList: [],
  };
  assert.deepEqual(affineCollectionDocs(legacy), [], "reproduces the empty Smart Home collection");
  assert.deepEqual(nativeFiltersOf(legacy.rules), [legacy.rules.filters[1]], "only the native filter is kept as native");
}

function testAppCreatedNativeFiltersAreShownByTagName() {
  const byId = new Map(TAGS.map(t => [t.id, t]));
  assert.deepEqual(
    viewNativeFilters([{ type: "system", key: "tags", method: "include-any-of", value: "t-smart" }], byId),
    { match: "all", filters: [tag("equals", "smart-home")] },
  );
  assert.deepEqual(
    viewNativeFilters([{ type: "system", key: "tags", method: "include-any-of", value: "t-review,t-dup" }], byId),
    { match: "any", filters: [tag("equals", "needs-review"), tag("equals", "possible-duplicate")] },
  );
}

const tests = [
  testTagEqualsBecomesNativeFilter,
  testTagContainsCoversEveryMatchingTag,
  testMatchAnyUnionsAndMatchAllIntersects,
  testNonTagOrUnknownTagRulesAreNotNative,
  testLiveRuleKeepsOnlyManualAllowListEntries,
  testSnapshotRuleStoresMatchesWithoutBreakingAffine,
  testLegacyMcpFiltersBreakAffineRules,
  testAppCreatedNativeFiltersAreShownByTagName,
];
for (const test of tests) {
  test();
  console.log(`✓ ${test.name}`);
}
console.log("Native collection rule tests passed");
