/**
 * Direct workspace channel — MCP surface tests.
 *
 * These drive the real McpServer through the official SDK client over an
 * in-memory transport, so the zod input schemas, the tool→Bridge wiring and the
 * { error: { code } } result convention are all exercised end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../../lib/bridge.js';
import { createMcpServer } from '../../lib/mcp.js';

function fixture(t) {
  const root = resolve(mkdtempSync(join(tmpdir(), 'dsh-direct-mcp-')));
  assert.ok(root.startsWith(resolve(tmpdir())));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'direct-mcp@example.invalid');
  git('config', 'user.name', 'Direct MCP Test');
  writeFileSync(join(root, 'readme.md'), '# fixture\n\nneedle in a haystack\n');
  writeFileSync(join(root, '.env'), 'API_KEY=sk-mcp-do-not-leak-0123456789\n');
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x00]));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'inner.txt'), 'inner body\n');
  writeFileSync(join(tmpdir(), `dsh-direct-mcp-outside-${process.pid}.txt`), 'outside\n');
  symlinkSync(join(tmpdir(), `dsh-direct-mcp-outside-${process.pid}.txt`), join(root, 'escape.link'));
  t.after(() => rmSync(join(tmpdir(), `dsh-direct-mcp-outside-${process.pid}.txt`), { force: true }));
  git('add', 'readme.md', 'blob.bin', 'sub/inner.txt');
  git('commit', '-m', 'baseline');
  return { root };
}

async function connectedServer(t, root, options = {}) {
  const activeSessions = new Set(options.activeSessions ?? []);
  const workspace = {
    id: 'ws-doc',
    title: 'fixture',
    path: root,
    createdAt: 'x',
    updatedAt: 'x',
    sessionIds: [],
  };
  const services = {
    workspaceRegistry: { list: () => [workspace] },
    agents: {
      get: (sessionId) => (activeSessions.has(String(sessionId))
        ? { status: 'running', inbox: { nextTurn: [], nextStep: [] } }
        : undefined),
      list: () => [],
    },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => () => true,
    inject: () => ({}),
    effect: (execute) => execute(),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
  const server = createMcpServer(bridge, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'direct-workspace-mcp-test', version: '0.1.0' });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, bridge };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { parsed, isError: result.isError === true };
}

test('direct MCP: all eight direct workspace tools are registered with schemas', async (t) => {
  const { client } = await connectedServer(t, resolve(mkdtempSync(join(tmpdir(), 'dsh-direct-mcp-empty-'))));
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  for (const name of [
    'dsh_workspace_info',
    'dsh_list_directory',
    'dsh_read_file',
    'dsh_search_workspace',
    'dsh_git_status',
    'dsh_git_diff',
    'dsh_write_file',
    'dsh_apply_patch',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
    const tool = listed.tools.find((item) => item.name === name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.description.length > 40, true);
  }
});

test('direct MCP: read-only tools return structured results over the protocol', async (t) => {
  const { root } = fixture(t);
  const { client } = await connectedServer(t, root);

  const info = await call(client, 'dsh_workspace_info', { workspace: 'ws-doc' });
  assert.equal(info.isError, false);
  assert.equal(info.parsed.workspace_id, 'ws-doc');
  assert.equal(info.parsed.is_git_repository, true);
  assert.equal(info.parsed.lock, null);

  const listed = await call(client, 'dsh_list_directory', { workspace: 'ws-doc', depth: 2 });
  assert.equal(listed.isError, false);
  assert.ok(listed.parsed.entries.some((entry) => entry.path === 'sub/inner.txt'));
  assert.ok(!listed.parsed.entries.some((entry) => entry.name === '.env'));
  assert.ok(listed.parsed.sensitive_skipped >= 1);

  const read = await call(client, 'dsh_read_file', { workspace: 'ws-doc', path: 'readme.md', start_line: 3, end_line: 3 });
  assert.equal(read.isError, false);
  assert.equal(read.parsed.content, 'needle in a haystack');
  assert.equal(read.parsed.sha256.length, 64);
  assert.equal(read.parsed.start_line, 3);

  const found = await call(client, 'dsh_search_workspace', { workspace: 'ws-doc', query: 'needle' });
  assert.equal(found.isError, false);
  assert.equal(found.parsed.matches.length, 1);
  assert.equal(found.parsed.matches[0].path, 'readme.md');

  const status = await call(client, 'dsh_git_status', { workspace: 'ws-doc' });
  assert.equal(status.isError, false);
  assert.equal(status.parsed.read_only, true);
  assert.equal(status.parsed.clean, false);
  assert.equal(status.parsed.dirty_count, 1);
  assert.equal(status.parsed.entries[0].path, 'escape.link');
  assert.ok(status.parsed.sensitive_omitted >= 1, '.env must be counted, not listed');

  writeFileSync(join(root, 'readme.md'), '# fixture\n\nneedle changed\n');
  const diff = await call(client, 'dsh_git_diff', { workspace: 'ws-doc', mode: 'unstaged' });
  assert.equal(diff.isError, false);
  assert.ok(diff.parsed.diff.includes('+needle changed'));
  assert.equal(diff.parsed.changed_files.includes('readme.md'), true);
});

test('direct MCP: write_file and apply_patch round-trip with hashes', async (t) => {
  const { root } = fixture(t);
  const { client } = await connectedServer(t, root);

  const created = await call(client, 'dsh_write_file', {
    workspace: 'ws-doc',
    path: 'sub/created.txt',
    content: 'first\n',
  });
  assert.equal(created.isError, false);
  assert.equal(created.parsed.created, true);
  assert.equal(created.parsed.old_sha256, null);
  assert.equal(created.parsed.path, 'sub/created.txt');
  assert.equal(readFileSync(join(root, 'sub', 'created.txt'), 'utf8'), 'first\n');

  const patched = await call(client, 'dsh_apply_patch', {
    workspace: 'ws-doc',
    path: 'sub/created.txt',
    old_text: 'first',
    new_text: 'second',
    expected_sha256: created.parsed.new_sha256,
  });
  assert.equal(patched.isError, false);
  assert.equal(patched.parsed.replacements, 1);
  assert.equal(patched.parsed.old_sha256, created.parsed.new_sha256);
  assert.equal(readFileSync(join(root, 'sub', 'created.txt'), 'utf8'), 'second\n');

  const overwritten = await call(client, 'dsh_write_file', {
    workspace: 'ws-doc',
    path: 'sub/created.txt',
    content: 'third\n',
    expected_sha256: patched.parsed.new_sha256,
  });
  assert.equal(overwritten.isError, false);
  assert.equal(overwritten.parsed.created, false);
  rmSync(join(root, 'sub', 'created.txt'), { force: true });
});

test('direct MCP: refusals surface as stable error codes, never as free text', async (t) => {
  const { root } = fixture(t);
  const { client } = await connectedServer(t, root);

  const cases = [
    ['dsh_read_file', { workspace: 'ws-doc', path: '../outside.txt' }, 'PATH_OUTSIDE_WORKSPACE'],
    ['dsh_read_file', { workspace: 'ws-doc', path: '.env' }, 'SENSITIVE_PATH_DENIED'],
    ['dsh_read_file', { workspace: 'ws-doc', path: 'blob.bin' }, 'BINARY_FILE_DENIED'],
    ['dsh_read_file', { workspace: 'ws-doc', path: 'escape.link' }, 'PATH_OUTSIDE_WORKSPACE'],
    ['dsh_read_file', { workspace: 'ws-doc', path: 'nope.txt' }, 'FILE_NOT_FOUND'],
    ['dsh_write_file', { workspace: 'ws-doc', path: '.env', content: 'x' }, 'SENSITIVE_PATH_DENIED'],
    ['dsh_write_file', { workspace: 'ws-doc', path: '../escape.txt', content: 'x' }, 'PATH_OUTSIDE_WORKSPACE'],
    ['dsh_write_file', { workspace: 'ws-doc', path: '.git/HEAD', content: 'x' }, 'SENSITIVE_PATH_DENIED'],
    ['dsh_apply_patch', { workspace: 'ws-doc', path: 'readme.md', old_text: 'absent', new_text: 'x' }, 'PATCH_CONFLICT'],
    ['dsh_workspace_info', { workspace: 'not-registered' }, 'WORKSPACE_NOT_FOUND'],
    ['dsh_git_diff', { workspace: 'ws-doc', mode: 'ref', ref: '--cached' }, 'INVALID_ARGUMENT'],
  ];
  for (const [name, args, code] of cases) {
    const result = await call(client, name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must fail`);
    assert.equal(result.parsed.error.code, code, `${name} ${JSON.stringify(args)} -> ${JSON.stringify(result.parsed)}`);
    assert.equal(typeof result.parsed.error.message, 'string');
  }
  assert.equal(existsSync(join(root, 'escape.txt')), false);
  assert.equal(existsSync(join(tmpdir(), `dsh-direct-mcp-outside-${process.pid}.txt`)), true);
  assert.equal(readFileSync(join(root, 'readme.md'), 'utf8'), '# fixture\n\nneedle in a haystack\n');
});

test('direct MCP: the input schema rejects out-of-range arguments before any file access', async (t) => {
  const { root } = fixture(t);
  const { client } = await connectedServer(t, root);
  const cases = [
    ['dsh_list_directory', { workspace: 'ws-doc', depth: 99 }],
    ['dsh_read_file', { workspace: 'ws-doc', path: 'readme.md', max_bytes: 99_999_999 }],
    ['dsh_write_file', { workspace: 'ws-doc', path: 'x.txt', content: 'x', expected_sha256: 'short' }],
    ['dsh_search_workspace', { workspace: 'ws-doc', query: 'x', limit: 100_000 }],
    ['dsh_git_diff', { workspace: 'ws-doc', mode: 'bogus' }],
    ['dsh_write_file', { workspace: 'ws-doc', path: 'x.txt' }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args }).catch((error) => ({ protocolError: error }));
    if (result.protocolError !== undefined) continue;
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must be rejected`);
  }
  assert.equal(existsSync(join(root, 'x.txt')), false);
});

test('direct MCP: a live Goal lock blocks the direct write with WORKSPACE_LOCKED', async (t) => {
  const { root } = fixture(t);
  const { client, bridge } = await connectedServer(t, root, { activeSessions: ['session-live-goal'] });
  bridge.workspaceGuard.acquireMutableLock(root, 'session-live-goal', 'goal-live');
  const result = await call(client, 'dsh_write_file', {
    workspace: 'ws-doc',
    path: 'blocked.txt',
    content: 'nope\n',
  });
  assert.equal(result.isError, true);
  assert.equal(result.parsed.error.code, 'WORKSPACE_LOCKED');
  assert.equal(result.parsed.error.details.holder_session_id, 'session-live-goal');
  assert.equal(existsSync(join(root, 'blocked.txt')), false);
  // The Goal keeps its lock, and reads still work.
  assert.equal(bridge.workspaceGuard.getLock(root).sessionId, 'session-live-goal');
  const read = await call(client, 'dsh_read_file', { workspace: 'ws-doc', path: 'readme.md' });
  assert.equal(read.isError, false);
});

test('direct MCP: read-only tools still work while a Goal holds the workspace lock', async (t) => {
  const { root } = fixture(t);
  const { client, bridge } = await connectedServer(t, root);
  bridge.workspaceGuard.acquireMutableLock(root, 'session-live-goal', 'goal-live');
  for (const [name, args] of [
    ['dsh_workspace_info', { workspace: 'ws-doc' }],
    ['dsh_list_directory', { workspace: 'ws-doc' }],
    ['dsh_read_file', { workspace: 'ws-doc', path: 'readme.md' }],
    ['dsh_search_workspace', { workspace: 'ws-doc', query: 'needle' }],
    ['dsh_git_status', { workspace: 'ws-doc' }],
    ['dsh_git_diff', { workspace: 'ws-doc' }],
  ]) {
    const result = await call(client, name, args);
    assert.equal(result.isError, false, `${name} must stay available under a Goal lock`);
  }
  assert.equal(bridge.workspaceGuard.getLock(root).sessionId, 'session-live-goal');
});
