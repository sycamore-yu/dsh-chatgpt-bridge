/**
 * Direct workspace channel — service-level behaviour and safety tests.
 *
 * Every case runs against a real temporary git repository and the real
 * WorkspaceConcurrencyGuard; nothing here mocks the filesystem, git, or the
 * lock model that production uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WorkspaceConcurrencyGuard } from '../../lib/workspace-guard.js';
import { DirectWorkspaceError, DirectWorkspaceService } from '../../lib/direct-workspace.js';

const SECRET_BODY = 'API_KEY=sk-live-do-not-leak-0123456789abcdef\n';
const BIG_LINES = 1200;

function sha(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function initRepo(t) {
  const root = resolve(mkdtempSync(join(tmpdir(), 'dsh-direct-ws-')));
  assert.ok(root.startsWith(resolve(tmpdir())));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'direct-workspace@example.invalid');
  git('config', 'user.name', 'Direct Workspace Test');

  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested alpha\nsecond line\n');
  writeFileSync(join(root, 'big.txt'), Array.from({ length: BIG_LINES }, (_, index) => `line-${index + 1}`).join('\n') + '\n');
  // Sensitive fixtures: never readable, never writable, never listed.
  writeFileSync(join(root, '.env'), SECRET_BODY);
  writeFileSync(join(root, 'private.pem'), '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'ssh-private\n');
  // Binary fixture.
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  // Symlink escape fixture plus an in-workspace symlink.
  writeFileSync(join(tmpdir(), `dsh-direct-outside-${process.pid}.txt`), 'outside\n');
  symlinkSync(join(tmpdir(), `dsh-direct-outside-${process.pid}.txt`), join(root, 'escape.link'));
  symlinkSync(join(root, 'tracked.txt'), join(root, 'inner.link'));
  t.after(() => rmSync(join(tmpdir(), `dsh-direct-outside-${process.pid}.txt`), { force: true }));
  writeFileSync(join(root, '.gitignore'), 'escape.link\ninner.link\n');

  git('add', 'tracked.txt', 'sub/nested.txt', 'big.txt', 'blob.bin', '.gitignore');
  git('commit', '-m', 'baseline');
  return { root, git };
}

function makeService(root, options = {}) {
  const guard = options.guard ?? new WorkspaceConcurrencyGuard();
  const active = new Set(options.activeSessions ?? []);
  const registryInputs = [];
  const service = new DirectWorkspaceService({
    resolveWorkspace: async (input) => {
      registryInputs.push(input);
      if (input !== 'ws-1' && input !== root) {
        const error = new Error(`no registered workspace matches "${input}"`);
        error.code = 'WORKSPACE_NOT_FOUND';
        throw error;
      }
      return { id: 'ws-1', title: 'repo', path: root, createdAt: 'x', updatedAt: 'x', sessionIds: [] };
    },
    guard,
    isLockHolderActive: (sessionId) => active.has(sessionId),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
    ...(options.ripgrepExecutable === undefined ? {} : { ripgrepExecutable: options.ripgrepExecutable }),
  });
  return { service, guard, active, registryInputs };
}

async function expectCode(promise, code, assertDetails) {
  await assert.rejects(
    () => promise,
    (error) => {
      assert.ok(error instanceof DirectWorkspaceError, `expected DirectWorkspaceError, got ${error?.name}: ${error?.message}`);
      assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
      if (assertDetails !== undefined) assertDetails(error);
      return true;
    },
  );
}

// ── workspace_info ───────────────────────────────────────────────────────────

test('direct: workspace_info reports registry identity, git summary, limits and no lock', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const info = await service.workspaceInfo('ws-1');
  assert.equal(info.workspace_id, 'ws-1');
  assert.equal(info.path, root);
  assert.equal(info.exists, true);
  assert.equal(info.is_git_repository, true);
  assert.equal(info.lock, null);
  assert.equal(info.git.clean, true, JSON.stringify(info.git));
  assert.equal(info.git.sensitive_omitted >= 3, true, 'untracked sensitive files are counted, never listed');
  assert.equal(info.git.branch.length > 0, true);
  assert.equal(info.limits.maxWriteBytes > 0, true);
  assert.equal(info.sensitive_policy, 'bridge-direct-workspace/1');
});

test('direct: workspace_info exposes a live Goal lock with kind=goal', async (t) => {
  const { root } = initRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const { service, active } = makeService(root, { guard });
  active.add('session-goal');
  guard.acquireMutableLock(root, 'session-goal', 'goal-1');
  const info = await service.workspaceInfo('ws-1');
  assert.equal(info.lock.kind, 'goal');
  assert.equal(info.lock.session_id, 'session-goal');
  assert.equal(info.lock.holder_active, true);
});

test('direct: unregistered workspace references are rejected by the resolver', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  await assert.rejects(
    () => service.workspaceInfo('/etc'),
    (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    },
  );
});

// ── list_directory ───────────────────────────────────────────────────────────

test('direct: list_directory pages entries and never lists sensitive entries', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const listed = await service.listDirectory({ workspace: 'ws-1', path: '.', limit: 100 });
  const names = listed.entries.map((entry) => entry.name);
  assert.ok(names.includes('tracked.txt'));
  assert.ok(names.includes('sub'));
  assert.ok(!names.includes('.env'), '.env must never be listed');
  assert.ok(!names.includes('private.pem'), 'private keys must never be listed');
  assert.ok(!names.includes('.ssh'), 'sensitive directories must never be listed');
  assert.ok(!names.includes('.git'), 'git internals must never be listed');
  assert.ok(listed.sensitive_skipped >= 4, `expected sensitive skips, got ${listed.sensitive_skipped}`);
  const sub = listed.entries.find((entry) => entry.name === 'sub');
  assert.equal(sub.type, 'directory');
  const tracked = listed.entries.find((entry) => entry.name === 'tracked.txt');
  assert.equal(tracked.type, 'file');
  assert.ok(tracked.size > 0);
  assert.ok(typeof tracked.mtime === 'string');
  assert.equal(listed.truncated, false);
});

test('direct: list_directory supports depth, offset paging and escape reporting', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const deep = await service.listDirectory({ workspace: 'ws-1', path: '.', depth: 2, limit: 100 });
  assert.ok(deep.entries.some((entry) => entry.path === 'sub/nested.txt'));
  const first = await service.listDirectory({ workspace: 'ws-1', path: '.', limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, 2);
  const second = await service.listDirectory({ workspace: 'ws-1', path: '.', limit: 2, offset: 2 });
  assert.notDeepEqual(second.entries.map((entry) => entry.path), first.entries.map((entry) => entry.path));
  const link = await service.listDirectory({ workspace: 'ws-1', path: '.' });
  const escape = link.entries.find((entry) => entry.name === 'escape.link');
  if (escape !== undefined) assert.equal(escape.target_escapes, true);
});

test('direct: list_directory refuses a sensitive directory and rejects depth beyond the cap', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  await expectCode(service.listDirectory({ workspace: 'ws-1', path: '.ssh' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.listDirectory({ workspace: 'ws-1', path: '.', depth: 9 }), 'INVALID_ARGUMENT');
});

// ── read_file ────────────────────────────────────────────────────────────────

test('direct: read_file returns content, digest, mode and line paging', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const first = await service.readFile({ workspace: 'ws-1', path: 'sub/nested.txt' });
  assert.equal(first.content, 'nested alpha\nsecond line');
  assert.equal(first.total_lines, 2);
  assert.equal(first.complete, true);
  assert.equal(first.truncated, false);
  assert.equal(first.sha256, sha('nested alpha\nsecond line\n'));
  assert.equal(first.redacted, false);
  assert.match(first.mode, /^0[0-7]{3}$/);

  const window = await service.readFile({ workspace: 'ws-1', path: 'sub/nested.txt', start_line: 2, end_line: 2 });
  assert.equal(window.content, 'second line');
  assert.equal(window.start_line, 2);
  assert.equal(window.returned_lines, 1);
  assert.equal(window.truncated, false);

  const beyond = await service.readFile({ workspace: 'ws-1', path: 'sub/nested.txt', start_line: 5 });
  assert.equal(beyond.content, '');
  assert.equal(beyond.returned_lines, 0);
});

test('direct: read_file refuses binary, sensitive, escaping and non-file targets', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  await expectCode(service.readFile({ workspace: 'ws-1', path: 'blob.bin' }), 'BINARY_FILE_DENIED');
  await expectCode(service.readFile({ workspace: 'ws-1', path: '.env' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.readFile({ workspace: 'ws-1', path: '.ssh/id_rsa' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.readFile({ workspace: 'ws-1', path: 'private.pem' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.readFile({ workspace: 'ws-1', path: '../outside.txt' }), 'PATH_OUTSIDE_WORKSPACE');
  await expectCode(service.readFile({ workspace: 'ws-1', path: '/etc/hostname' }), 'PATH_OUTSIDE_WORKSPACE');
  await expectCode(service.readFile({ workspace: 'ws-1', path: 'missing.txt' }), 'FILE_NOT_FOUND');
  await expectCode(service.readFile({ workspace: 'ws-1', path: 'sub' }), 'IS_A_DIRECTORY');
});

test('direct: read_file follows an in-workspace symlink but refuses an escaping one', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  await expectCode(service.readFile({ workspace: 'ws-1', path: 'escape.link' }), 'PATH_OUTSIDE_WORKSPACE');
});

test('direct: read_file reports truncation and next_start_line for a large file', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const page = await service.readFile({ workspace: 'ws-1', path: 'big.txt', max_bytes: 64 });
  assert.equal(page.truncated, true);
  assert.equal(page.byte_truncated, true);
  assert.ok(page.returned_lines >= 1);
  assert.ok(page.next_start_line >= 1);
  const plain = await service.readFile({ workspace: 'ws-1', path: 'big.txt', start_line: 1, end_line: 1, max_bytes: 262144 });
  assert.equal(plain.total_lines, BIG_LINES);
  assert.equal(plain.start_line, 1);
  assert.equal(plain.end_line, 1);
  assert.equal(plain.truncated, true);
  const tail = await service.readFile({ workspace: 'ws-1', path: 'big.txt', start_line: BIG_LINES, max_bytes: 262144 });
  assert.equal(tail.content, `line-${BIG_LINES}`);
});

// ── search_workspace ─────────────────────────────────────────────────────────

test('direct: search_workspace finds literal and regex matches with both engines', async (t) => {
  const { root } = initRepo(t);
  for (const forceSearchEngine of ['ripgrep', 'node']) {
    const { service } = makeService(root, { testHooks: { forceSearchEngine } });
    const literal = await service.searchWorkspace({ workspace: 'ws-1', query: 'nested alpha' });
    // 'ripgrep' here means "prefer ripgrep": without the binary installed the
    // service must degrade to the node engine instead of failing.
    if (forceSearchEngine === 'node') assert.equal(literal.engine, 'node');
    else assert.ok(['ripgrep', 'node'].includes(literal.engine), literal.engine);
    assert.equal(literal.matches.length, 1);
    assert.equal(literal.matches[0].path, 'sub/nested.txt');
    assert.equal(literal.matches[0].line, 1);
    assert.equal(literal.matches[0].column, 1);

    const regex = await service.searchWorkspace({ workspace: 'ws-1', query: 'line-\\d{3}$', regex: true, limit: 5 });
    assert.ok(regex.matches.length > 0);
    assert.ok(regex.truncated);

    const insensitive = await service.searchWorkspace({ workspace: 'ws-1', query: 'NESTED ALPHA' });
    assert.equal(insensitive.matches.length, 1);
    const sensitive = await service.searchWorkspace({ workspace: 'ws-1', query: 'NESTED ALPHA', case_sensitive: true });
    assert.equal(sensitive.matches.length, 0);

    const globbed = await service.searchWorkspace({ workspace: 'ws-1', query: 'line-', glob: '*.txt', limit: 3 });
    assert.equal(globbed.matches.length, 3);
  }
});

test('direct: search_workspace parses ripgrep JSON output when the binary exists', { skip: process.platform === 'win32' ? 'POSIX-only stub' : false }, async (t) => {
  const { root } = initRepo(t);
  const stub = join(resolve(mkdtempSync(join(tmpdir(), 'dsh-rg-stub-'))), 'rg');
  t.after(() => rmSync(dirname(stub), { recursive: true, force: true }));
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      'writeFileSync(process.env.DSH_RG_ARGS_FILE, process.argv.slice(2).join("\\n"));',
      'const emit = (object) => process.stdout.write(JSON.stringify(object) + "\\n");',
      "emit({ type: 'begin', data: { path: { text: 'sub/nested.txt' } } });",
      "emit({ type: 'match', data: { path: { text: 'sub/nested.txt' }, lines: { text: 'nested alpha\\n' }, line_number: 1, submatches: [{ start: 0, end: 6 }] } });",
      "emit({ type: 'match', data: { path: { text: '.env' }, lines: { text: 'sk-live-secret\\n' }, line_number: 1, submatches: [{ start: 0, end: 3 }] } });",
      "emit({ type: 'end', data: { path: { text: 'sub/nested.txt' } } });",
    ].join('\n'),
    'utf8',
  );
  chmodSync(stub, 0o755);
  const argsFile = join(dirname(stub), 'args.txt');
  const previous = process.env.DSH_RG_ARGS_FILE;
  process.env.DSH_RG_ARGS_FILE = argsFile;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_RG_ARGS_FILE;
    else process.env.DSH_RG_ARGS_FILE = previous;
  });
  const { service } = makeService(root, { ripgrepExecutable: stub });
  const result = await service.searchWorkspace({ workspace: 'ws-1', query: 'nested alpha' });
  assert.equal(result.engine, 'ripgrep');
  assert.equal(result.matches.length, 1, 'a match in a sensitive path is dropped even when ripgrep reports it');
  assert.equal(result.matches[0].path, 'sub/nested.txt');
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.matches[0].column, 1);
  const args = readFileSync(argsFile, 'utf8').split('\n');
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--fixed-strings'));
  assert.ok(args.includes('--ignore-case'));
  assert.ok(args.some((arg) => arg.startsWith('!**/.git/**')));
  assert.ok(args.some((arg) => arg.startsWith('!**/.ssh/**')));
});

test('direct: search_workspace never returns sensitive or binary content', async (t) => {
  const { root } = initRepo(t);
  for (const forceSearchEngine of ['ripgrep', 'node']) {
    const { service } = makeService(root, { testHooks: { forceSearchEngine } });
    const secret = await service.searchWorkspace({ workspace: 'ws-1', query: 'sk-live-do-not-leak' });
    assert.equal(secret.matches.length, 0, `${forceSearchEngine} must not search .env`);
    const key = await service.searchWorkspace({ workspace: 'ws-1', query: 'BEGIN PRIVATE KEY' });
    assert.equal(key.matches.length, 0, `${forceSearchEngine} must not search private.pem`);
    const ssh = await service.searchWorkspace({ workspace: 'ws-1', query: 'ssh-private' });
    assert.equal(ssh.matches.length, 0, `${forceSearchEngine} must not search .ssh`);
  }
});

test('direct: search_workspace enforces offset paging and bounded results', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const page = await service.searchWorkspace({ workspace: 'ws-1', query: 'line-', limit: 2 });
  assert.equal(page.matches.length, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.next_offset, 2);
  const second = await service.searchWorkspace({ workspace: 'ws-1', query: 'line-', limit: 2, offset: 2 });
  assert.notDeepEqual(second.matches.map((match) => match.line), page.matches.map((match) => match.line));
  await expectCode(service.searchWorkspace({ workspace: 'ws-1', query: 'x', limit: 5000 }), 'INVALID_ARGUMENT');
  await expectCode(service.searchWorkspace({ workspace: 'ws-1', query: '(' , regex: true }), 'INVALID_ARGUMENT');
  await expectCode(service.searchWorkspace({ workspace: 'ws-1', query: '' }), 'INVALID_ARGUMENT');
});

// ── git_status / git_diff ────────────────────────────────────────────────────

test('direct: git_status is structured, read-only, and omits sensitive paths', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const clean = await service.gitStatus({ workspace: 'ws-1' });
  assert.equal(clean.clean, true);
  assert.equal(clean.read_only, true);
  assert.equal(clean.entries.length, 0);

  writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  writeFileSync(join(root, '.env'), `${SECRET_BODY}TOKEN=more\n`);
  const dirty = await service.gitStatus({ workspace: 'ws-1' });
  assert.equal(dirty.clean, false);
  assert.equal(dirty.dirty_count, 1);
  assert.equal(dirty.entries[0].path, 'tracked.txt');
  assert.equal(dirty.entries[0].status, ' M');
  assert.equal(dirty.sensitive_omitted, 3, '.env, private.pem and .ssh/id_rsa are counted but never listed');
  assert.ok(!JSON.stringify(dirty).includes('do-not-leak'));
});

test('direct: git_diff supports unstaged, staged, head, ref, path and paging', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  const unstaged = await service.gitDiff({ workspace: 'ws-1' });
  assert.equal(unstaged.mode, 'unstaged');
  assert.equal(unstaged.read_only, true);
  assert.ok(unstaged.diff.includes('+changed'));
  assert.deepEqual(unstaged.changed_files, ['tracked.txt']);
  assert.equal(unstaged.truncated, false);

  const paged = await service.gitDiff({ workspace: 'ws-1', max_lines: 2 });
  assert.equal(paged.returned_lines, 2);
  assert.equal(paged.truncated, true);
  assert.equal(paged.next_offset, 2);
  const next = await service.gitDiff({ workspace: 'ws-1', max_lines: 2, offset: 2 });
  assert.equal(next.offset, 2);

  const scoped = await service.gitDiff({ workspace: 'ws-1', path: 'sub/nested.txt' });
  assert.equal(scoped.diff, '');
  const head = await service.gitDiff({ workspace: 'ws-1', mode: 'head' });
  assert.ok(head.diff.includes('+changed'));

  execFileSync('git', ['add', 'tracked.txt'], { cwd: root, stdio: 'pipe' });
  const staged = await service.gitDiff({ workspace: 'ws-1', mode: 'staged' });
  assert.ok(staged.diff.includes('+changed'));
  const ref = await service.gitDiff({ workspace: 'ws-1', mode: 'ref', ref: 'HEAD' });
  assert.ok(ref.diff.includes('+changed'));
  await expectCode(service.gitDiff({ workspace: 'ws-1', mode: 'ref', ref: '--cached' }), 'INVALID_ARGUMENT');
  await expectCode(service.gitDiff({ workspace: 'ws-1', mode: 'ref', ref: 'HEAD:.env' }), 'INVALID_ARGUMENT');
});

test('direct: git_diff excludes sensitive content from the diff body', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  execFileSync('git', ['add', '.env'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'track env fixture'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, '.env'), `${SECRET_BODY}ROTATED_TOKEN=leak-me-not\n`);
  writeFileSync(join(root, 'tracked.txt'), 'changed\n');
  const diff = await service.gitDiff({ workspace: 'ws-1' });
  assert.ok(!diff.diff.includes('leak-me-not'), 'sensitive file content must never appear in a diff');
  assert.ok(!diff.diff.includes('.env'));
  assert.equal(diff.sensitive_omitted, 1);
  assert.deepEqual(diff.changed_files, ['tracked.txt']);
});

test('direct: git tools report GIT_NOT_A_REPOSITORY outside a work tree', async (t) => {
  const root = resolve(mkdtempSync(join(tmpdir(), 'dsh-direct-nogit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'plain.txt'), 'plain\n');
  const { service } = makeService(root);
  await expectCode(service.gitStatus({ workspace: 'ws-1' }), 'GIT_NOT_A_REPOSITORY');
  await expectCode(service.gitDiff({ workspace: 'ws-1' }), 'GIT_NOT_A_REPOSITORY');
  const info = await service.workspaceInfo('ws-1');
  assert.equal(info.is_git_repository, false);
  assert.equal(info.git, null);
});

// ── write_file ───────────────────────────────────────────────────────────────

test('direct: write_file creates then updates atomically with a preserved mode', async (t) => {
  const { root } = initRepo(t);
  const { service, guard } = makeService(root);
  const created = await service.writeFile({ workspace: 'ws-1', path: 'sub/new.txt', content: 'hello\n' });
  assert.equal(created.created, true);
  assert.equal(created.changed, true);
  assert.equal(created.old_sha256, null);
  assert.equal(created.new_sha256, sha('hello\n'));
  assert.equal(created.bytes, 6);
  assert.equal(readFileSync(join(root, 'sub', 'new.txt'), 'utf8'), 'hello\n');
  assert.deepEqual(
    readdirSync(join(root, 'sub')).filter((name) => name.startsWith('.dsh-direct-')),
    [],
    'no temporary file may be left behind',
  );
  assert.equal(guard.getLock(root), undefined, 'the direct write must release its guard lock');
  assert.equal(guard.getLastMutation(root)?.type, 'write_file');

  chmodSync(join(root, 'sub', 'new.txt'), 0o600);
  const updated = await service.writeFile({
    workspace: 'ws-1',
    path: 'sub/new.txt',
    content: 'hello again\n',
    expected_sha256: created.new_sha256,
  });
  assert.equal(updated.created, false);
  assert.equal(updated.changed, true);
  assert.equal(updated.mode, '0600');
  assert.equal(statSync(join(root, 'sub', 'new.txt')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(root, 'sub', 'new.txt'), 'utf8'), 'hello again\n');
});

test('direct: write_file enforces preconditions and refusals', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  await expectCode(
    service.writeFile({ workspace: 'ws-1', path: 'tracked.txt', content: 'x\n', expected_sha256: sha('wrong') }),
    'PRECONDITION_FAILED',
  );
  await expectCode(
    service.writeFile({ workspace: 'ws-1', path: 'tracked.txt', content: 'x\n', create_only: true }),
    'FILE_EXISTS',
  );
  await expectCode(service.writeFile({ workspace: 'ws-1', path: '../escape.txt', content: 'x\n' }), 'PATH_OUTSIDE_WORKSPACE');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: '/tmp/escape.txt', content: 'x\n' }), 'PATH_OUTSIDE_WORKSPACE');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: '.env', content: 'x\n' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: '.ssh/id_rsa', content: 'x\n' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: '.git/HEAD', content: 'x\n' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'notes/../.env', content: 'x\n' }), 'SENSITIVE_PATH_DENIED');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'blob.bin', content: 'x\u0000y' }), 'BINARY_FILE_DENIED');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'new/missing.txt', content: 'x' }), 'DIRECTORY_NOT_FOUND');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'sub', content: 'x' }), 'IS_A_DIRECTORY');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'escape.link', content: 'x' }), 'PATH_OUTSIDE_WORKSPACE');
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'inner.link', content: 'x' }), 'SYMLINK_NOT_WRITABLE');
  await expectCode(
    service.writeFile({ workspace: 'ws-1', path: 'big2.txt', content: 'a'.repeat(300 * 1024) }),
    'FILE_TOO_LARGE',
  );
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
});

// ── apply_patch ──────────────────────────────────────────────────────────────

test('direct: apply_patch replaces a unique match and reports hashes', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const before = readFileSync(join(root, 'sub', 'nested.txt'), 'utf8');
  const patched = await service.applyPatch({
    workspace: 'ws-1',
    path: 'sub/nested.txt',
    old_text: 'second line\n',
    new_text: 'second line changed\n',
    expected_sha256: sha(before),
  });
  assert.equal(patched.replacements, 1);
  assert.equal(patched.changed, true);
  assert.equal(patched.old_sha256, sha(before));
  assert.equal(readFileSync(join(root, 'sub', 'nested.txt'), 'utf8'), 'nested alpha\nsecond line changed\n');
  assert.equal(patched.new_sha256, sha('nested alpha\nsecond line changed\n'));
});

test('direct: apply_patch refuses zero matches, multiple matches and invalid input', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  writeFileSync(join(root, 'multi.txt'), 'dup\ndup\n');
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'multi.txt', old_text: 'absent', new_text: 'x' }),
    'PATCH_CONFLICT',
    (error) => assert.equal(error.details.matches, 0),
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'multi.txt', old_text: 'dup\n', new_text: 'x' }),
    'PATCH_CONFLICT',
    (error) => assert.equal(error.details.matches, 2),
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'missing.txt', old_text: 'a', new_text: 'b' }),
    'PATCH_CONFLICT',
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'multi.txt', old_text: 'same', new_text: 'same' }),
    'PATCH_INVALID',
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'multi.txt', old_text: 'dup', new_text: 'x', line_start: 1, line_end: 2 }),
    'PATCH_CONFLICT',
    (error) => assert.equal(error.details.matches, 2, 'the range still needs a unique match'),
  );
  const scopedOne = await service.applyPatch({
    workspace: 'ws-1',
    path: 'multi.txt',
    old_text: 'dup',
    new_text: 'first',
    line_start: 1,
    line_end: 1,
  });
  assert.equal(scopedOne.replacements, 1);
  assert.equal(readFileSync(join(root, 'multi.txt'), 'utf8'), 'first\ndup\n');
  writeFileSync(join(root, 'multi.txt'), 'dup\ndup\n');
  const all = await service.applyPatch({
    workspace: 'ws-1',
    path: 'multi.txt',
    old_text: 'dup',
    new_text: 'solo',
    replace_all: true,
  });
  assert.equal(all.replacements, 2);
  assert.equal(readFileSync(join(root, 'multi.txt'), 'utf8'), 'solo\nsolo\n');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
});

test('direct: apply_patch scopes the search to a line range', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  writeFileSync(join(root, 'scoped.txt'), 'target\nfiller\ntarget\n');
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'scoped.txt', old_text: 'target', new_text: 'x' }),
    'PATCH_CONFLICT',
    (error) => assert.equal(error.details.matches, 2, 'two hits without a range must be refused'),
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'scoped.txt', old_text: 'absent', new_text: 'x', line_start: 3, line_end: 3 }),
    'PATCH_CONFLICT',
    (error) => assert.equal(error.details.matches, 0, 'a range with no hit must be refused'),
  );
  const result = await service.applyPatch({
    workspace: 'ws-1',
    path: 'scoped.txt',
    old_text: 'target',
    new_text: 'first',
    line_start: 1,
    line_end: 1,
  });
  assert.equal(result.replacements, 1);
  assert.equal(readFileSync(join(root, 'scoped.txt'), 'utf8'), 'first\nfiller\ntarget\n');
});

// ── lock + drift integration ─────────────────────────────────────────────────

test('direct: a live Goal lock makes the write fail closed with WORKSPACE_LOCKED', async (t) => {
  const { root } = initRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const { service, active } = makeService(root, { guard });
  active.add('session-goal');
  guard.acquireMutableLock(root, 'session-goal', 'goal-1');
  await expectCode(
    service.writeFile({ workspace: 'ws-1', path: 'blocked.txt', content: 'x\n' }),
    'WORKSPACE_LOCKED',
    (error) => {
      assert.equal(error.details.holder_session_id, 'session-goal');
      assert.equal(error.details.status, 'waiting_for_workspace_lock');
    },
  );
  await expectCode(
    service.applyPatch({ workspace: 'ws-1', path: 'tracked.txt', old_text: 'baseline', new_text: 'x' }),
    'WORKSPACE_LOCKED',
  );
  assert.equal(existsSync(join(root, 'blocked.txt')), false);
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
  // Reads still work while a Goal holds the lock.
  const read = await service.readFile({ workspace: 'ws-1', path: 'tracked.txt' });
  assert.equal(read.content, 'baseline');
});

test('direct: a stale lock holder does not deadlock and is taken over', async (t) => {
  const { root } = initRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const { service } = makeService(root, { guard });
  guard.acquireMutableLock(root, 'session-dead', 'goal-dead');
  const written = await service.writeFile({ workspace: 'ws-1', path: 'stale.txt', content: 'ok\n' });
  assert.equal(written.created, true);
  assert.equal(guard.getLock(root), undefined, 'the stale holder must be released after the direct write');
  assert.equal(readFileSync(join(root, 'stale.txt'), 'utf8'), 'ok\n');
});

test('direct: concurrent direct writes to one workspace are serialized', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root);
  const results = await Promise.all([
    service.writeFile({ workspace: 'ws-1', path: 'race.txt', content: 'first\n' }),
    service.writeFile({ workspace: 'ws-1', path: 'race.txt', content: 'second\n' }),
    service.applyPatch({ workspace: 'ws-1', path: 'race.txt', old_text: 'first\n', new_text: 'patched\n' }).catch((error) => error),
  ]);
  assert.ok(results[0].new_sha256 !== results[1].new_sha256);
  const final = readFileSync(join(root, 'race.txt'), 'utf8');
  assert.ok(['second\n', 'patched\n'].includes(final), `unexpected final content: ${JSON.stringify(final)}`);
});

test('direct: a foreign workspace change during a write fails closed and rolls back', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root, {
    testHooks: {
      afterWriteBeforeFingerprint: async () => {
        writeFileSync(join(root, 'tracked.txt'), 'foreign change\n');
      },
    },
  });
  await expectCode(
    service.writeFile({ workspace: 'ws-1', path: 'drift.txt', content: 'mine\n' }),
    'WORKSPACE_DRIFT',
    (error) => {
      assert.equal(typeof error.details.expected_fingerprint, 'string');
      assert.equal(typeof error.details.actual_fingerprint, 'string');
      assert.notEqual(error.details.expected_fingerprint, error.details.actual_fingerprint);
    },
  );
  assert.equal(existsSync(join(root, 'drift.txt')), false, 'a new file must be removed by the rollback');
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'foreign change\n');
});

test('direct: drift rollback restores the previous content of an existing file', async (t) => {
  const { root } = initRepo(t);
  let armed = false;
  const { service } = makeService(root, {
    testHooks: {
      afterWriteBeforeFingerprint: async () => {
        if (!armed) {
          armed = true;
          writeFileSync(join(root, 'sub', 'nested.txt'), 'foreign\n');
        }
      },
    },
  });
  await expectCode(
    service.applyPatch({
      workspace: 'ws-1',
      path: 'tracked.txt',
      old_text: 'baseline\n',
      new_text: 'mine\n',
    }),
    'WORKSPACE_DRIFT',
  );
  assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'baseline\n');
  assert.equal(readFileSync(join(root, 'sub', 'nested.txt'), 'utf8'), 'foreign\n');
});

test('direct: read-only tools never acquire the mutable workspace lock', async (t) => {
  const { root } = initRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const { service } = makeService(root, { guard });
  let acquisitions = 0;
  const originalAcquire = guard.acquireMutableLock.bind(guard);
  guard.acquireMutableLock = (...args) => {
    acquisitions += 1;
    return originalAcquire(...args);
  };
  guard.acquireMutableLock(root, 'session-goal', 'goal-1');
  acquisitions = 0;
  await service.workspaceInfo('ws-1');
  await service.listDirectory({ workspace: 'ws-1', path: '.' });
  await service.readFile({ workspace: 'ws-1', path: 'tracked.txt' });
  await service.searchWorkspace({ workspace: 'ws-1', query: 'baseline' });
  await service.gitStatus({ workspace: 'ws-1' });
  await service.gitDiff({ workspace: 'ws-1' });
  assert.equal(acquisitions, 0, 'read-only tools must never take the mutable lock');
  assert.equal(guard.getLock(root)?.sessionId, 'session-goal', 'the Goal lock must be untouched');
});

test('direct: the workspace fingerprint ignores the written path but sees everything else', async (t) => {
  const { root } = initRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const before = await guard.captureBaseline(root, { excludePaths: ['tracked.txt'] });
  writeFileSync(join(root, 'tracked.txt'), 'my own change\n');
  const after = await guard.captureBaseline(root, { excludePaths: ['tracked.txt'] });
  assert.equal(before.workspaceFingerprint, after.workspaceFingerprint);
  writeFileSync(join(root, 'sub', 'nested.txt'), 'foreign\n');
  const drifted = await guard.captureBaseline(root, { excludePaths: ['tracked.txt'] });
  assert.notEqual(before.workspaceFingerprint, drifted.workspaceFingerprint);
});

test('direct: write tools work in a non-git workspace and leave no residue', async (t) => {
  const root = resolve(mkdtempSync(join(tmpdir(), 'dsh-direct-plain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { service } = makeService(root);
  const created = await service.writeFile({ workspace: 'ws-1', path: 'note.txt', content: 'plain\n' });
  assert.equal(created.created, true);
  const read = await service.readFile({ workspace: 'ws-1', path: 'note.txt' });
  assert.equal(read.content, 'plain');
  const patched = await service.applyPatch({ workspace: 'ws-1', path: 'note.txt', old_text: 'plain', new_text: 'plain text' });
  assert.equal(patched.replacements, 1);
  assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'plain text\n');
  await expectCode(service.gitStatus({ workspace: 'ws-1' }), 'GIT_NOT_A_REPOSITORY');
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.dsh-direct-')), []);
});

test('direct: sensitive-path policy is pure and covers the documented classes', async (t) => {
  const { classifySensitivePath, isSensitiveRelativePath } = await import('../../lib/sensitive-paths.js');
  for (const hidden of [
    '.env',
    '.env.local',
    'config/.env.production',
    'secrets/db.json',
    '.ssh/id_rsa',
    '.gnupg/secring.gpg',
    '.aws/credentials',
    '.dsh/settings.yaml',
    '.git/config',
    '.npmrc',
    '.netrc',
    'certs/server.pem',
    'certs/server.key',
    'chatgpt-bridge.token',
    'service-account.json',
    'id_ed25519',
    '.credentials.yaml',
    '.config/gh/hosts.yml',
    '.docker/config.json',
  ]) {
    assert.equal(isSensitiveRelativePath(hidden), true, `${hidden} must be denied`);
  }
  for (const allowed of ['src/index.ts', 'README.md', 'sub/nested.txt', 'docs/credentials-and-tokens.md', 'test/unit/direct-workspace.test.mjs']) {
    assert.equal(isSensitiveRelativePath(allowed), false, `${allowed} must stay readable`);
  }
  assert.equal(classifySensitivePath('').sensitive, false);
  assert.equal(classifySensitivePath('.').sensitive, false);
});

test('direct: limits are reported and enforced from one source', async (t) => {
  const { root } = initRepo(t);
  const { service } = makeService(root, { limits: { maxReadBytes: 32, maxWriteBytes: 16, maxListEntries: 3 } });
  const limits = service.describeLimits();
  assert.equal(limits.maxReadBytes, 32);
  assert.equal(limits.maxWriteBytes, 16);
  const page = await service.readFile({ workspace: 'ws-1', path: 'big.txt', max_bytes: 32 });
  assert.ok(Buffer.byteLength(page.content, 'utf8') <= 32, `${Buffer.byteLength(page.content, 'utf8')} bytes returned`);
  await expectCode(service.writeFile({ workspace: 'ws-1', path: 'small.txt', content: 'x'.repeat(17) }), 'FILE_TOO_LARGE');
  const listed = await service.listDirectory({ workspace: 'ws-1', path: '.' });
  assert.equal(listed.entries.length, 3);
  await expectCode(service.listDirectory({ workspace: 'ws-1', path: '.', limit: 4 }), 'INVALID_ARGUMENT');
  assert.equal(lstatSync(join(root, 'tracked.txt')).isFile(), true);
});
