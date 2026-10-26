#!/usr/bin/env node
// Nested Markdown lists: the parser records each item's depth, the importer
// nests deeper items under their parent list block, and export indents them so
// re-import nests them again. Runs offline against dist/.
import assert from 'node:assert/strict';

import { parseMarkdownToOperations } from '../dist/markdown/parse.js';
import { createMarkdownListNesting } from '../dist/markdown/listNesting.js';
import { renderBlocksToMarkdown } from '../dist/markdown/render.js';

const NESTED = [
  '- a',
  '  - b',
  '    - c',
  '  - d',
  '- e',
  '',
  '1. one',
  '   - mixed',
  '2. two',
  '',
  'Paragraph between lists',
  '',
  '- [ ] todo',
  '  - [x] done child',
].join('\n');

function listSummary(operations) {
  return operations.map(op => op.type === 'list'
    ? { text: op.text, style: op.style, depth: op.depth ?? 0, ...(op.style === 'todo' ? { checked: op.checked } : {}) }
    : { type: op.type, text: op.text });
}

/**
 * Inserts parsed operations into a minimal block tree using the same placement
 * rules as applyMarkdownOperationsToDoc: nested items become children of their
 * parent list block, everything else is appended at the top level.
 * `skip` names items whose insertion fails, to check the clamping fallback.
 */
function buildBlockTree(operations, { skip = [] } = {}) {
  const nesting = createMarkdownListNesting();
  const blocksById = new Map();
  const rootBlockIds = [];
  operations.forEach((op, index) => {
    const parent = nesting.parentFor(op);
    if (skip.includes(op.text)) return;
    const id = `block-${index}`;
    blocksById.set(id, {
      id,
      parentId: parent?.parentId ?? null,
      flavour: op.type === 'list' ? 'affine:list' : 'affine:paragraph',
      type: op.type === 'list' ? op.style : 'text',
      text: op.text,
      checked: op.type === 'list' && op.style === 'todo' ? op.checked : null,
      language: null,
      childIds: [],
      url: null,
      sourceId: null,
      caption: null,
      tableData: null,
      textDeltas: null,
      tableCellDeltas: null,
    });
    if (parent) blocksById.get(parent.parentId).childIds.push(id);
    else rootBlockIds.push(id);
    nesting.inserted(op, id, parent?.depth ?? 0);
  });
  return { rootBlockIds, blocksById };
}

function parentText(tree, text) {
  const block = [...tree.blocksById.values()].find(b => b.text === text);
  assert.ok(block, `block "${text}" exists`);
  return block.parentId ? tree.blocksById.get(block.parentId).text : null;
}

function testParserRecordsDepthWithoutWarnings() {
  const parsed = parseMarkdownToOperations(NESTED);
  assert.deepEqual(listSummary(parsed.operations), [
    { text: 'a', style: 'bulleted', depth: 0 },
    { text: 'b', style: 'bulleted', depth: 1 },
    { text: 'c', style: 'bulleted', depth: 2 },
    { text: 'd', style: 'bulleted', depth: 1 },
    { text: 'e', style: 'bulleted', depth: 0 },
    { text: 'one', style: 'numbered', depth: 0 },
    { text: 'mixed', style: 'bulleted', depth: 1 },
    { text: 'two', style: 'numbered', depth: 0 },
    { type: 'paragraph', text: 'Paragraph between lists' },
    { text: 'todo', style: 'todo', depth: 0, checked: false },
    { text: 'done child', style: 'todo', depth: 1, checked: true },
  ]);
  assert.equal(parsed.warnings.some(w => /flattened|nesting depth/i.test(w)), false,
    `no flattening warnings, got: ${JSON.stringify(parsed.warnings)}`);
  assert.equal(parsed.lossy, false, 'nested lists import without loss');
}

function testTopLevelItemsOmitDepth() {
  const [op] = parseMarkdownToOperations('- only').operations;
  assert.equal('depth' in op, false, 'top-level items keep the original operation shape');
}

function testNestedItemsBecomeChildrenOfTheirParent() {
  const tree = buildBlockTree(parseMarkdownToOperations(NESTED).operations);
  assert.equal(parentText(tree, 'a'), null);
  assert.equal(parentText(tree, 'b'), 'a');
  assert.equal(parentText(tree, 'c'), 'b');
  assert.equal(parentText(tree, 'd'), 'a', 'a sibling after a deeper item returns to its own parent');
  assert.equal(parentText(tree, 'e'), null);
  assert.equal(parentText(tree, 'mixed'), 'one', 'bullets nest under numbered items');
  assert.equal(parentText(tree, 'two'), null);
  assert.equal(parentText(tree, 'Paragraph between lists'), null,
    'a paragraph after a nested list is top level, not inside the list');
  assert.equal(parentText(tree, 'todo'), null, 'a paragraph ends the previous list');
  assert.equal(parentText(tree, 'done child'), 'todo');

  const order = tree.rootBlockIds.map(id => tree.blocksById.get(id).text);
  assert.deepEqual(order, ['a', 'e', 'one', 'two', 'Paragraph between lists', 'todo'], 'top-level order is preserved');
  const aChildren = tree.blocksById.get('block-0').childIds.map(id => tree.blocksById.get(id).text);
  assert.deepEqual(aChildren, ['b', 'd'], 'children keep their order');
}

function testSkippedParentClampsToNearestOpenItem() {
  // If "b" fails to insert, its child "c" (depth 2) nests under "a" instead of being lost.
  const tree = buildBlockTree(parseMarkdownToOperations(NESTED).operations, { skip: ['b'] });
  assert.equal(parentText(tree, 'c'), 'a');
  assert.equal(parentText(tree, 'd'), 'a');
}

function testNestingHelperBasics() {
  const nesting = createMarkdownListNesting();
  const item = (depth) => ({ type: 'list', text: 'x', style: 'bulleted', ...(depth ? { depth } : {}) });
  assert.equal(nesting.parentFor(item(1)), undefined, 'a nested item with no open list goes to top level');
  nesting.inserted(item(0), 'A', 0);
  assert.deepEqual(nesting.parentFor(item(1)), { parentId: 'A', depth: 1 });
  assert.deepEqual(nesting.parentFor(item(3)), { parentId: 'A', depth: 1 }, 'depth jumps clamp to the deepest open item');
  nesting.inserted({ type: 'paragraph', text: 'p' }, 'P', 0);
  assert.equal(nesting.parentFor(item(1)), undefined, 'a non-list block closes open items');
}

function testRoundTripKeepsNesting() {
  const tree = buildBlockTree(parseMarkdownToOperations(NESTED).operations);
  const exported = renderBlocksToMarkdown(tree).markdown;
  assert.match(exported, /^1\. one\n {3}- mixed$/m, 'children of numbered items are indented 3 spaces');
  assert.match(exported, /^ {4}- c$/m, 'third level bullets are indented 4 spaces');

  const reimported = parseMarkdownToOperations(exported);
  assert.deepEqual(listSummary(reimported.operations), listSummary(parseMarkdownToOperations(NESTED).operations),
    `export then import keeps every item and depth.\nExported:\n${exported}`);
}

function testDeepNumberedNestingRoundTrips() {
  const markdown = ['1. step', '   1. sub-step', '      - detail'].join('\n');
  const ops = parseMarkdownToOperations(markdown).operations;
  assert.deepEqual(ops.map(op => op.depth ?? 0), [0, 1, 2]);
  const exported = renderBlocksToMarkdown(buildBlockTree(ops)).markdown;
  assert.deepEqual(parseMarkdownToOperations(exported).operations.map(op => [op.text, op.depth ?? 0]),
    [['step', 0], ['sub-step', 1], ['detail', 2]], `exported:\n${exported}`);
}

const tests = [
  testParserRecordsDepthWithoutWarnings,
  testTopLevelItemsOmitDepth,
  testNestedItemsBecomeChildrenOfTheirParent,
  testSkippedParentClampsToNearestOpenItem,
  testNestingHelperBasics,
  testRoundTripKeepsNesting,
  testDeepNumberedNestingRoundTrips,
];
for (const test of tests) {
  test();
  console.log(`✓ ${test.name}`);
}
console.log('Nested markdown list tests passed');
