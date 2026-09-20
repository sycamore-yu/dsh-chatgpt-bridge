#!/usr/bin/env node
/**
 * Real MCP dogfooding for the bridge DIRECT workspace channel.
 *
 * Drives the running bridge over Streamable HTTP with the official MCP SDK
 * client and verifies, against real registered workspaces:
 *   [A] the eight direct tools are registered;
 *   [B] read-only reads/lists/searches/git work and are stable;
 *   [C] path escape, sensitive paths, binary files and unregistered workspaces
 *       are refused with stable codes;
 *   [D] a workspace whose mutable lock is held by a live Goal refuses a direct
 *       write with WORKSPACE_LOCKED while read-only tools keep working;
 *   [E] on an unlocked workspace, write -> read -> patch -> conditional
 *       overwrite -> cleanup leaves the workspace exactly as it was found.
 *
 * Usage:
 *   node scripts/direct-workspace-dogfood.mjs [--workspace <id|path|title>]
 *                                             [--write-workspace <id|path|title>]
 *                                             [--json <report.json>]
 *
 * Exit code is non-zero when any check fails. The write section only ever
 * creates one clearly named temporary file and removes it again; it never
 * touches user content.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.DSH_CHATGPT_BRIDGE_URL ?? 'http://127.0.0.1:3456/mcp';
const TOKEN_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'chatgpt-bridge.token');
const DIRECT_TOOLS = [
  'dsh_workspace_info',
  'dsh_list_directory',
  'dsh_read_file',
  'dsh_search_workspace',
  'dsh_git_status',
  'dsh_git_diff',
  'dsh_write_file',
  'dsh_apply_patch',
];

const argv = process.argv.slice(2);
function argOf(name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
}

const report = { started_at: new Date().toISOString(), target: BASE, sections: [], checks: [], failures: 0, skips: 0 };
let section = 'general';

function begin(name) {
  section = name;
  report.sections.push(name);
  console.log(`\n[${name}]`);
}

function check(name, ok, detail = '') {
  const entry = { section, name, ok: ok === true, detail: String(detail).slice(0, 400) };
  report.checks.push(entry);
  if (entry.ok) console.log(`  ✔ ${name}`);
  else {
    report.failures += 1;
    console.error(`  ✖ ${name} ${entry.detail}`);
  }
  return entry.ok;
}

function skip(name, reason) {
  report.skips += 1;
  report.checks.push({ section, name, ok: null, detail: reason });
  console.log(`  – ${name} (skipped: ${reason})`);
}

function readToken() {
  if (!existsSync(TOKEN_FILE)) return '';
  return readFileSync(TOKEN_FILE, 'utf8').trim();
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
  return { parsed, isError: result.isError === true, raw: text };
}

function errorCode(result) {
  return result?.parsed?.error?.code;
}

const token = readToken();
console.log('dsh-chatgpt-bridge direct workspace dogfooding');
console.log('target:', BASE, '| token:', token ? '***present***' : '(none)');

const transport = new StreamableHTTPClientTransport(new URL(BASE), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
});
const client = new Client({ name: 'dsh-direct-workspace-dogfood', version: '0.1.0' });
await client.connect(transport);

const cleanupPaths = [];
try {
  // ── [A] tool surface ───────────────────────────────────────────────────────
  begin('A surface');
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const tool of DIRECT_TOOLS) check(`${tool} registered`, names.includes(tool));
  check('tool count >= 31', names.length >= 31, `count=${names.length}`);

  const workspaces = await call(client, 'dsh_list_workspaces');
  check('dsh_list_workspaces ok', workspaces.isError === false && Array.isArray(workspaces.parsed));
  const workspaceList = workspaces.parsed ?? [];
  check('at least one registered workspace', workspaceList.length > 0, `count=${workspaceList.length}`);
  if (workspaceList.length === 0) throw new Error('no registered workspace to exercise');

  const wanted = argOf('--workspace');
  const readWorkspace = wanted !== undefined
    ? workspaceList.find((item) => item.id === wanted || item.path === wanted || item.title === wanted)
    : workspaceList[0];
  check('read target workspace resolved', readWorkspace !== undefined, wanted ?? '(first)');
  report.read_workspace = readWorkspace;
  console.log(`     read workspace: ${readWorkspace.title} (${readWorkspace.path})`);

  // ── [B] read-only channel ──────────────────────────────────────────────────
  begin('B read-only');
  const info = await call(client, 'dsh_workspace_info', { workspace: readWorkspace.id });
  check('dsh_workspace_info ok', info.isError === false && info.parsed.workspace_id === readWorkspace.id, JSON.stringify(info.parsed?.error ?? ''));
  check('workspace_info reports a path', typeof info.parsed?.path === 'string');
  report.lock = info.parsed?.lock ?? null;

  const listed1 = await call(client, 'dsh_list_directory', { workspace: readWorkspace.id, path: '.', depth: 1, limit: 50 });
  check('dsh_list_directory ok', listed1.isError === false && Array.isArray(listed1.parsed.entries));
  check(
    'list_directory never returns a sensitive entry',
    (listed1.parsed.entries ?? []).every((entry) => !/^\.env|\.pem$|\.key$|^\.ssh$|^\.git$|^\.dsh$|^secrets$/.test(entry.name)),
    (listed1.parsed.entries ?? []).map((entry) => entry.name).join(','),
  );
  check('list_directory reports sensitive_skipped', typeof listed1.parsed.sensitive_skipped === 'number');

  const listingPaged = await call(client, 'dsh_list_directory', { workspace: readWorkspace.id, path: '.', limit: 2 });
  check('list_directory pages', listingPaged.parsed.returned <= 2, `returned=${listingPaged.parsed.returned}`);

  const fileEntry = (listed1.parsed.entries ?? []).find((entry) => entry.type === 'file' && /\.(md|json|txt|ts|js|mjs|yml|yaml)$/.test(entry.name));
  if (fileEntry === undefined) {
    skip('dsh_read_file on a known text file', 'no text file at the workspace root');
  } else {
    const read1 = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: fileEntry.path, start_line: 1, end_line: 3 });
    check('dsh_read_file ok', read1.isError === false && typeof read1.parsed.content === 'string', JSON.stringify(read1.parsed?.error ?? ''));
    check('read_file returns a sha256', /^[a-f0-9]{64}$/.test(read1.parsed.sha256 ?? ''));
    check('read_file honors the line range', (read1.parsed.returned_lines ?? 99) <= 3);
    const read2 = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: fileEntry.path, start_line: 1, end_line: 3 });
    check('read_file is deterministic', read1.parsed.sha256 === read2.parsed.sha256);
    check('read_file reports paging fields', 'truncated' in read1.parsed && 'next_start_line' in read1.parsed);
  }

  const searched = await call(client, 'dsh_search_workspace', { workspace: readWorkspace.id, query: 'dsh_list_workspaces', limit: 5 });
  check('dsh_search_workspace ok', searched.isError === false && Array.isArray(searched.parsed.matches));
  check('search reports an engine', ['ripgrep', 'node'].includes(searched.parsed.engine), searched.parsed.engine);
  check('search bounded results', (searched.parsed.matches ?? []).length <= 5);
  report.search_engine = searched.parsed.engine;

  const status = await call(client, 'dsh_git_status', { workspace: readWorkspace.id });
  if (status.isError === true && errorCode(status) === 'GIT_NOT_A_REPOSITORY') {
    check('dsh_git_status reports GIT_NOT_A_REPOSITORY for a non-repo workspace', true);
  } else {
    check('dsh_git_status ok', status.isError === false && status.parsed.read_only === true);
    check('git_status is structured', typeof status.parsed.branch === 'string' || status.parsed.branch === null);
  }

  const diff = await call(client, 'dsh_git_diff', { workspace: readWorkspace.id, mode: 'unstaged', max_lines: 20 });
  if (diff.isError === true && errorCode(diff) === 'GIT_NOT_A_REPOSITORY') {
    check('dsh_git_diff reports GIT_NOT_A_REPOSITORY for a non-repo workspace', true);
  } else {
    check('dsh_git_diff ok', diff.isError === false && diff.parsed.read_only === true);
    check('git_diff is bounded', (diff.parsed.returned_lines ?? 0) <= 20);
    // Path-level leak check: no sensitive *file* in the diff headers or the
    // reported changed-file list. Matching the whole diff body false-positives
    // on project prose that merely mentions `.env`/`id_rsa`.
    const diffHeaders = (diff.parsed.diff ?? '').split('\n').filter((line) => line.startsWith('diff --git '));
    const sensitivePath = /(^|\/)\.env\b|private\.pem|id_rsa/;
    check(
      'git_diff never leaks a sensitive path',
      diffHeaders.every((line) => !sensitivePath.test(line))
        && (diff.parsed.changed_files ?? []).every((file) => !sensitivePath.test(file)),
      `headers=${diffHeaders.length} sensitive_omitted=${diff.parsed.sensitive_omitted}`,
    );
  }

  // ── [C] refusals ───────────────────────────────────────────────────────────
  begin('C refusals');
  const escape = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: '../outside.txt' });
  check('read_file refuses ../ traversal', errorCode(escape) === 'PATH_OUTSIDE_WORKSPACE', errorCode(escape));
  const absolute = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: '/etc/hostname' });
  check('read_file refuses an absolute outside path', errorCode(absolute) === 'PATH_OUTSIDE_WORKSPACE', errorCode(absolute));
  const dotenv = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: '.env' });
  check('read_file refuses .env', errorCode(dotenv) === 'SENSITIVE_PATH_DENIED', errorCode(dotenv));
  const gitdir = await call(client, 'dsh_write_file', { workspace: readWorkspace.id, path: '.git/HEAD', content: 'x' });
  check('write_file refuses .git', errorCode(gitdir) === 'SENSITIVE_PATH_DENIED', errorCode(gitdir));
  const unregistered = await call(client, 'dsh_workspace_info', { workspace: '/etc' });
  check('unregistered workspace is refused', errorCode(unregistered) === 'WORKSPACE_NOT_FOUND', errorCode(unregistered));
  const badArgs = await client.callTool({ name: 'dsh_list_directory', arguments: { workspace: readWorkspace.id, depth: 99 } })
    .then((result) => ({ isError: result.isError === true, detail: result.content?.find?.((block) => block.type === 'text')?.text ?? '' }))
    .catch((error) => ({ isError: true, detail: `transport: ${String(error)}` }));
  check('schema bounds are enforced', badArgs.isError === true, badArgs.detail);

  const binaryCandidates = ['assets/screenshots/06-native-settings-real-use.png', 'node_modules/.package-lock.json'];
  let binaryChecked = false;
  for (const candidate of binaryCandidates) {
    const result = await call(client, 'dsh_read_file', { workspace: readWorkspace.id, path: candidate });
    if (errorCode(result) === 'BINARY_FILE_DENIED') {
      check(`read_file refuses a binary file (${candidate})`, true);
      binaryChecked = true;
      break;
    }
  }
  if (!binaryChecked) skip('read_file refuses a binary file', 'no binary fixture found in this workspace');

  // ── [D] Goal lock integration ──────────────────────────────────────────────
  begin('D lock');
  const lockedWorkspaces = [];
  for (const workspace of workspaceList) {
    const infoOf = await call(client, 'dsh_workspace_info', { workspace: workspace.id });
    if (infoOf.parsed?.lock?.holder_active === true) lockedWorkspaces.push({ workspace, lock: infoOf.parsed.lock });
  }
  report.locked_workspaces = lockedWorkspaces.map((entry) => ({ id: entry.workspace.id, title: entry.workspace.title, lock: entry.lock }));
  if (lockedWorkspaces.length === 0) {
    skip('direct write is refused while a live Goal holds the lock', 'no workspace currently holds an active mutable lock');
  } else {
    const target = lockedWorkspaces[0];
    console.log(`     locked workspace: ${target.workspace.title} by ${target.lock.session_id}`);
    const blocked = await call(client, 'dsh_write_file', {
      workspace: target.workspace.id,
      path: 'dsh-bridge-direct-probe-blocked.txt',
      content: 'must not be written\n',
    });
    check('write_file returns WORKSPACE_LOCKED', errorCode(blocked) === 'WORKSPACE_LOCKED', `${errorCode(blocked)} ${JSON.stringify(blocked.parsed?.error?.details ?? '')}`);
    check('locked write reports the holder', typeof blocked.parsed?.error?.details?.holder_session_id === 'string');
    const readWhileLocked = await call(client, 'dsh_read_file', { workspace: target.workspace.id, path: 'README.md' }).catch(() => ({ isError: true }));
    check('read-only channel still works under a Goal lock', readWhileLocked.isError === false || errorCode(readWhileLocked) === 'FILE_NOT_FOUND');
  }

  // ── [E] write round-trip on an unlocked workspace ──────────────────────────
  begin('E write round-trip');
  const writeWanted = argOf('--write-workspace');
  let writeWorkspace;
  if (writeWanted !== undefined) {
    writeWorkspace = workspaceList.find((item) => item.id === writeWanted || item.path === writeWanted || item.title === writeWanted);
  } else {
    for (const workspace of workspaceList) {
      const infoOf = await call(client, 'dsh_workspace_info', { workspace: workspace.id });
      if (infoOf.parsed?.lock === null) {
        writeWorkspace = workspace;
        break;
      }
    }
  }
  report.write_workspace = writeWorkspace ?? null;
  if (writeWorkspace === undefined) {
    skip('direct write round-trip', 'every registered workspace currently holds an active lock');
  } else {
    console.log(`     write workspace: ${writeWorkspace.title} (${writeWorkspace.path})`);
    const probeDirListing = await call(client, 'dsh_list_directory', { workspace: writeWorkspace.id, path: '.', limit: 200 });
    const probeDir = (probeDirListing.parsed?.entries ?? []).some((entry) => entry.type === 'directory' && entry.name === 'tmp') ? 'tmp' : '';
    const probeName = `dsh-bridge-direct-probe-${process.pid}.txt`;
    const probePath = probeDir === '' ? probeName : `${probeDir}/${probeName}`;
    const statusBefore = await call(client, 'dsh_git_status', { workspace: writeWorkspace.id });
    const dirtyBefore = statusBefore.parsed?.entries ?? null;

    const created = await call(client, 'dsh_write_file', {
      workspace: writeWorkspace.id,
      path: probePath,
      content: 'direct-workspace-probe v1\n',
      create_only: true,
    });
    if (created.isError === true) {
      check('dsh_write_file create ok', false, `${errorCode(created)} ${created.parsed?.error?.message ?? ''}`);
    } else {
      cleanupPaths.push({ workspace: writeWorkspace.id, path: probePath, absolute: join(writeWorkspace.path, probePath) });
      check('write_file created the probe file', created.parsed.created === true && created.parsed.old_sha256 === null);
      check('write_file returned the new sha256', /^[a-f0-9]{64}$/.test(created.parsed.new_sha256 ?? ''));

      const readBack = await call(client, 'dsh_read_file', { workspace: writeWorkspace.id, path: probePath });
      check('read_file sees the written content', readBack.parsed.content === 'direct-workspace-probe v1');
      check('read_file sha matches the write', readBack.parsed.sha256 === created.parsed.new_sha256);

      const patched = await call(client, 'dsh_apply_patch', {
        workspace: writeWorkspace.id,
        path: probePath,
        old_text: 'v1',
        new_text: 'v2',
        expected_sha256: created.parsed.new_sha256,
      });
      check('apply_patch replaced exactly one match', patched.isError === false && patched.parsed.replacements === 1, JSON.stringify(patched.parsed?.error ?? ''));
      const afterPatch = await call(client, 'dsh_read_file', { workspace: writeWorkspace.id, path: probePath });
      check('patched content is on disk', afterPatch.parsed.content === 'direct-workspace-probe v2');

      const conflict = await call(client, 'dsh_apply_patch', {
        workspace: writeWorkspace.id,
        path: probePath,
        old_text: 'absent-text',
        new_text: 'x',
      });
      check('0-match patch returns PATCH_CONFLICT', errorCode(conflict) === 'PATCH_CONFLICT');

      const stale = await call(client, 'dsh_write_file', {
        workspace: writeWorkspace.id,
        path: probePath,
        content: 'stale\n',
        expected_sha256: created.parsed.new_sha256,
      });
      check('stale expected_sha256 returns PRECONDITION_FAILED', errorCode(stale) === 'PRECONDITION_FAILED', errorCode(stale));

      const finalWrite = await call(client, 'dsh_write_file', {
        workspace: writeWorkspace.id,
        path: probePath,
        content: 'direct-workspace-probe final\n',
        expected_sha256: afterPatch.parsed.sha256,
      });
      check('conditional overwrite succeeded', finalWrite.isError === false && finalWrite.parsed.created === false);

      const escapeWrite = await call(client, 'dsh_write_file', { workspace: writeWorkspace.id, path: '../dsh-probe-escape.txt', content: 'x' });
      check('write_file refuses ../', errorCode(escapeWrite) === 'PATH_OUTSIDE_WORKSPACE', errorCode(escapeWrite));

      const statusAfter = await call(client, 'dsh_git_status', { workspace: writeWorkspace.id });
      if (dirtyBefore !== null && statusAfter.parsed?.entries !== undefined) {
        const withoutProbe = (entries) => (entries ?? [])
          .filter((entry) => entry.path !== probePath)
          .map((entry) => `${entry.status} ${entry.path}`)
          .sort();
        check(
          'no other workspace file changed during the probe',
          JSON.stringify(withoutProbe(dirtyBefore)) === JSON.stringify(withoutProbe(statusAfter.parsed.entries)),
          `${JSON.stringify(withoutProbe(dirtyBefore))} vs ${JSON.stringify(withoutProbe(statusAfter.parsed.entries))}`,
        );
      } else {
        skip('no other workspace file changed during the probe', 'workspace is not a git repository');
      }
    }
  }
} catch (error) {
  report.failures += 1;
  console.error(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  // Cleanup: remove every probe file this run created, on disk and verified.
  for (const entry of cleanupPaths) {
    try {
      if (existsSync(entry.absolute)) rmSync(entry.absolute, { force: true });
      const stillThere = existsSync(entry.absolute);
      check(`cleanup removed ${entry.path}`, stillThere === false);
    } catch (error) {
      check(`cleanup removed ${entry.path}`, false, String(error));
    }
  }
  await client.close();
  report.finished_at = new Date().toISOString();
  report.passed = report.checks.filter((entry) => entry.ok === true).length;
  const jsonArg = argOf('--json');
  if (jsonArg !== undefined) writeFileSync(jsonArg, JSON.stringify(report, null, 2));
  console.log(`\nsummary: ${report.passed} passed, ${report.failures} failed, ${report.skips} skipped`);
  console.log(`read workspace: ${report.read_workspace?.title ?? 'none'} | lock: ${report.lock === null ? 'free' : 'held'}`);
  console.log(`search engine: ${report.search_engine ?? 'n/a'} | write workspace: ${report.write_workspace?.title ?? 'none'}`);
  process.exit(report.failures === 0 ? 0 : 1);
}
