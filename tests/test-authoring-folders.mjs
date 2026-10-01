#!/usr/bin/env node
import { testResourceName, testTempPath } from './require-destructive-test-safety.mjs';

/**
 * Integration test: sidebar folder management under the `authoring` profile
 * (the profile production runs).
 *
 * Verifies that authoring exposes the folder tools (create, rename, list, move,
 * link) and hides deletion; that a doc can be filed into a folder at creation
 * or afterwards; and that renames and nesting persist.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.resolve(__dirname, '..', 'dist', 'index.js');
const BASE_URL = process.env.AFFINE_BASE_URL || 'http://localhost:3010';
const EMAIL = process.env.AFFINE_ADMIN_EMAIL || process.env.AFFINE_EMAIL || 'test@affine.local';
const PASSWORD = process.env.AFFINE_ADMIN_PASSWORD || process.env.AFFINE_PASSWORD;
if (!PASSWORD) throw new Error('AFFINE_ADMIN_PASSWORD env var required');

function parse(result) {
  const text = result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text; }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function connect(profile, name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_SERVER_PATH],
    cwd: path.resolve(__dirname, '..'),
    env: {
      AFFINE_BASE_URL: BASE_URL,
      AFFINE_EMAIL: EMAIL,
      AFFINE_PASSWORD: PASSWORD,
      AFFINE_LOGIN_AT_START: 'sync',
      AFFINE_TOOL_PROFILE: profile,
      XDG_CONFIG_HOME: testTempPath(`${name}-config`),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    if (result?.isError) throw new Error(`${tool} MCP error: ${result?.content?.[0]?.text}`);
    const parsed = parse(result);
    if (parsed && typeof parsed === 'object' && parsed.error) throw new Error(`${tool} failed: ${parsed.error}`);
    return parsed;
  };
  return { client, transport, call };
}

async function main() {
  // 1. Full-profile client only to provision a disposable workspace + a pre-existing doc.
  const admin = await connect('full', 'scratch-admin');
  let workspaceId;
  let existingDocId;
  try {
    const ws = await admin.call('create_workspace', { name: `authoring-folders-${testResourceName('run')}` });
    workspaceId = ws?.id;
    assert(Boolean(workspaceId), 'provisioned disposable workspace');
    const doc = await admin.call('create_doc', { workspaceId, title: 'Existing doc', content: 'already here' });
    existingDocId = doc?.docId;
    assert(Boolean(existingDocId), 'provisioned an existing doc to file into a folder');
  } finally {
    await admin.transport.close();
  }

  // 2. The real check: authoring profile.
  const authoring = await connect('authoring', 'scratch-authoring');
  try {
    const listed = await authoring.client.listTools();
    const names = new Set(listed.tools.map(t => t.name));
    for (const tool of ['create_folder', 'rename_folder', 'list_organize_nodes', 'move_organize_node', 'add_organize_link', 'create_doc_from_markdown']) {
      assert(names.has(tool), `authoring exposes ${tool}`);
    }
    for (const tool of ['delete_folder', 'delete_organize_link', 'delete_workspace']) {
      assert(!names.has(tool), `authoring hides ${tool}`);
    }

    // Folder per video, with a transcript doc filed into it at creation.
    const videoFolder = await authoring.call('create_folder', { workspaceId, name: 'Video - Obsidian to AFFiNE' });
    assert(Boolean(videoFolder?.id), 'create_folder returned an id');

    const created = await authoring.call('create_doc_from_markdown', {
      workspaceId,
      title: 'Transcript (filed at creation)',
      markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |',
      folderId: videoFolder.id,
    });
    assert(created?.folderLinked === true, 'create_doc_from_markdown reports folderLinked=true');

    // File an existing doc into the same folder.
    const link = await authoring.call('add_organize_link', {
      workspaceId, folderId: videoFolder.id, type: 'doc', targetId: existingDocId,
    });
    assert(Boolean(link?.id), 'add_organize_link filed an existing doc');

    let nodes = (await authoring.call('list_organize_nodes', { workspaceId })).nodes;
    const children = nodes.filter(n => n.parentId === videoFolder.id);
    assert(children.length === 2, `folder contains 2 linked docs (found ${children.length})`);
    assert(children.some(n => n.data === created.docId), 'folder links the doc created from markdown');
    assert(children.some(n => n.data === existingDocId), 'folder links the pre-existing doc');

    // Rename, nest under a parent folder, and move a link.
    const renamed = await authoring.call('rename_folder', { workspaceId, folderId: videoFolder.id, name: 'Video - Renamed' });
    assert(renamed?.name === 'Video - Renamed', 'rename_folder works');

    const parent = await authoring.call('create_folder', { workspaceId, name: 'Videos' });
    const moved = await authoring.call('move_organize_node', { workspaceId, nodeId: videoFolder.id, parentId: parent.id });
    assert(moved?.parentId === parent.id, 'move_organize_node nests a folder under another');

    nodes = (await authoring.call('list_organize_nodes', { workspaceId })).nodes;
    const reloaded = nodes.find(n => n.id === videoFolder.id);
    assert(reloaded?.parentId === parent.id && reloaded?.data === 'Video - Renamed', 'tree persisted after reload');

    // Deletion must be impossible from authoring.
    let rejected = false;
    try { await authoring.call('delete_folder', { workspaceId, folderId: videoFolder.id }); } catch { rejected = true; }
    assert(rejected, 'delete_folder cannot be called from authoring');
  } finally {
    await authoring.transport.close();
  }

  console.log('\n=== Authoring-profile folder smoke test passed ===');
}

main().catch(error => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
