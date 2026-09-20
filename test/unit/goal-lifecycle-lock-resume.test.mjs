import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../lib/bridge.js';

// ── shared harness ──────────────────────────────────────────────────────────
// A workspace registry with one registered workspace. The path is intentionally
// not a real git repo: baseline capture degrades to an empty fingerprint.
const WORKSPACE = {
  id: 'ws-1',
  title: 'mix_workspace',
  path: join(tmpdir(), 'dsh-bridge-lifecycle-ws'),
  createdAt: 'x',
  updatedAt: 'x',
  sessionIds: [],
};

function makeAgent(id, cwd, events, { settleOnCancel = true } = {}) {
  const inbox = { nextTurn: [], nextStep: [], hasPending: true };
  const agent = {
    id,
    status: 'running',
    inbox,
    session: {
      id,
      header: { id, createdAt: Date.now(), cwd },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
    followup(message) {
      agent.lastFollowup = message;
      agent.status = 'running';
      inbox.hasPending = true;
      inbox.nextTurn.push({ id: 'm' });
    },
    cancel() {
      if (!settleOnCancel) return; // DSH cancellation of a live turn is asynchronous
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
      events.push({
        type: 'turn/end',
        seq: events.length,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      });
    },
  };
  return agent;
}

/**
 * Build a bridge plus a session store that survives a simulated process
 * restart: headers and event arrays persist while the live agent map is
 * rebuilt empty. `dshHome` points the Goal sidecar store at a temp directory.
 */
function makeHarness({ dshHome, persisted, live, settleOnCancel = true, resumeFails = false } = {}) {
  const store = persisted ?? new Map();
  const agents = live ?? new Map();
  const workspace = { ...WORKSPACE, attachSession: async () => {} };
  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      const events = [];
      const agent = makeAgent(sessionId, meta.cwd, events, { settleOnCancel });
      agents.set(sessionId, agent);
      store.set(sessionId, { header: agent.session.header, events });
      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing !== undefined) throw new Error(`agent "${resumeSessionId}" is already registered`);
      if (resumeFails) throw new Error('resume unavailable in this profile');
      const saved = store.get(resumeSessionId);
      if (saved === undefined) throw new Error('missing');
      const agent = makeAgent(resumeSessionId, saved.header.cwd, saved.events, { settleOnCancel });
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };
  const persistence = {
    list: async () => [...store.values()].map((item) => ({ header: item.header })),
    open: async (id) => {
      const saved = store.get(id);
      if (saved === undefined) throw new Error('missing');
      return {
        header: saved.header,
        read: async () => ({ events: saved.events }),
        close: async () => {},
      };
    },
  };
  const ctx = {
    get: (key) => ({
      workspaceRegistry: { list: () => [workspace] },
      agents: agentsApi,
      sessions: { list: () => [], get: () => undefined },
      sessionPersistence: persistence,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })[key],
    agents: agentsApi,
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: persistence,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sessionTitle: { rename() {}, get: () => undefined },
    on: () => () => true,
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(
    ctx,
    { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500, dshHome },
    log,
  );
  return { bridge, store, agents };
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-lifecycle-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// ── Bug 1: workspace lock must not outlive stop/cancel ──────────────────────

test('lifecycle: cancelTask releases the workspace mutable lock immediately', async (t) => {
  const dshHome = tempHome(t);
  // settleOnCancel=false models DSH's asynchronous turn cancellation: the live
  // agent keeps status 'running' for a while after cancel() returns.
  const { bridge } = makeHarness({ dshHome, settleOnCancel: false });

  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'edit files' });
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path)?.sessionId, started.session_id);

  await bridge.cancelTask(started.session_id);
  assert.equal(
    bridge.workspaceGuard.getLock(WORKSPACE.path),
    undefined,
    'cancelTask must release the workspace write lock instead of leaving it to a later status poll',
  );
});

test('lifecycle: a new writable Goal succeeds right after stop_goal/cancel_task', async (t) => {
  const dshHome = tempHome(t);
  const { bridge } = makeHarness({ dshHome, settleOnCancel: false });

  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'first writer' });
  await bridge.cancelTask(first.session_id);

  const second = await bridge.startGoal({ workspace: 'ws-1', goal: 'second writer' });
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path)?.sessionId, second.session_id);

  await bridge.stopGoal(second.session_id);
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path), undefined);

  const third = await bridge.startGoal({ workspace: 'ws-1', goal: 'third writer' });
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path)?.sessionId, third.session_id);
});

test('lifecycle: lock release after stop/cancel is idempotent with no side effects', async (t) => {
  const dshHome = tempHome(t);
  const { bridge } = makeHarness({ dshHome, settleOnCancel: false });

  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'writer' });
  await bridge.stopGoal(first.session_id);
  await bridge.stopGoal(first.session_id);
  await bridge.cancelTask(first.session_id).catch(() => {});
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path), undefined);

  const next = await bridge.startGoal({ workspace: 'ws-1', goal: 'next writer' });
  await bridge.cancelTask(next.session_id);
  await bridge.cancelTask(next.session_id);
  assert.equal(bridge.workspaceGuard.getLock(WORKSPACE.path), undefined);
});

// ── Bug 2: persisted supervised Goal recovery after a bridge restart ────────

test('recovery: persisted supervised Goal resumes from the sidecar after restart', async (t) => {
  const dshHome = tempHome(t);
  const store = new Map();

  // Process 1: create the supervised Goal.
  const first = makeHarness({ dshHome, persisted: store, live: new Map() });
  const started = await first.bridge.startGoal({ workspace: 'ws-1', goal: 'long supervised goal' });
  const sid = started.session_id;
  const sidecar = join(dshHome, 'chatgpt-bridge', 'goals', `${sid}.json`);
  assert.ok(existsSync(sidecar), 'Goal record is persisted to the sidecar');

  // Process 2: same persistence, empty live-agent map (restart).
  const second = makeHarness({ dshHome, persisted: store, live: new Map() });
  const status = await second.bridge.getTaskStatus(sid);

  assert.equal(status.goal?.goal_id, `goal-${sid}`, 'the supervised Goal survives the restart');
  assert.equal(status.live, true, 'status must recover the persisted supervised Goal, not report unknown');
  assert.notEqual(status.status, 'unknown');

  // And it can continue.
  const resumed = await second.bridge.resumeGoal(sid);
  assert.equal(resumed.session_id, sid);
  assert.equal(resumed.goal.goal_id, `goal-${sid}`);
  assert.equal(resumed.goal.revision, 2);
  assert.ok(['running', 'queued', 'idle'].includes(resumed.status));
});

test('recovery: a cancelled supervised Goal is not resurrected by a status read', async (t) => {
  const dshHome = tempHome(t);
  const store = new Map();

  const first = makeHarness({ dshHome, persisted: store, live: new Map() });
  const started = await first.bridge.startGoal({ workspace: 'ws-1', goal: 'to be stopped' });
  const sid = started.session_id;
  await first.bridge.stopGoal(sid);

  const saved = JSON.parse(readFileSync(join(dshHome, 'chatgpt-bridge', 'goals', `${sid}.json`), 'utf8'));
  assert.ok(saved.history.some((event) => event.type === 'goal_cancelled'));

  const second = makeHarness({ dshHome, persisted: store, live: new Map() });
  const status = await second.bridge.getTaskStatus(sid);
  assert.equal(second.agents.has(sid), false, 'a cancelled Goal is not resumed');
  assert.equal(status.live, false);
  assert.notEqual(status.status, 'unknown');
});

test('recovery: concurrent status reads on a cold supervised Goal agree (no duplicate resume)', async (t) => {
  const dshHome = tempHome(t);
  const store = new Map();

  const first = makeHarness({ dshHome, persisted: store, live: new Map() });
  const started = await first.bridge.startGoal({ workspace: 'ws-1', goal: 'raced recovery' });
  const sid = started.session_id;

  const second = makeHarness({ dshHome, persisted: store, live: new Map() });
  const [a, b] = await Promise.all([
    second.bridge.getTaskStatus(sid),
    second.bridge.getTaskStatus(sid),
  ]);

  assert.equal(second.agents.size, 1, 'exactly one live agent is created by the racing reads');
  for (const status of [a, b]) {
    assert.notEqual(status.status, 'unknown');
    assert.equal(status.goal.goal_id, `goal-${sid}`);
    assert.equal(status.live, true);
  }
  assert.equal(a.status, b.status, 'racing reads report the same folded status');
});

test('recovery: persisted Goal with no resume available reports stable idle, not unknown', async (t) => {
  const dshHome = tempHome(t);
  const store = new Map();

  const first = makeHarness({ dshHome, persisted: store, live: new Map() });
  const started = await first.bridge.startGoal({ workspace: 'ws-1', goal: 'no resume available' });
  const sid = started.session_id;

  const second = makeHarness({ dshHome, persisted: store, live: new Map(), resumeFails: true });
  const status = await second.bridge.getTaskStatus(sid);
  assert.equal(status.live, false);
  assert.equal(status.status, 'idle', 'a persisted Goal never folds back to unknown');
  assert.equal(status.goal.goal_id, `goal-${sid}`);
});
