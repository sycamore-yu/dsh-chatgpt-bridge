import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, BridgeError } from '../../lib/bridge.js';
import { isAgentOptionsEqual } from '../../lib/goal-control.js';
import { createMcpServer } from '../../lib/mcp.js';

const WORKSPACE = {
  id: 'ws-test',
  title: 'test_workspace',
  path: '/tmp/test_workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionIds: [],
};

function makeAgent(id, workspacePath = WORKSPACE.path) {
  const events = [];
  const inbox = { hasPending: false, nextTurn: [], nextStep: [] };
  const agent = {
    id,
    status: 'running',
    inbox,
    session: {
      id,
      header: { id, createdAt: Date.now(), cwd: workspacePath },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
    followup(message) {
      agent.status = 'running';
      inbox.hasPending = true;
      inbox.nextTurn.push(message ?? { id: 'm' });
    },
    cancel() {
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
    },
  };
  return agent;
}

function makeBridgeWithAgentTracking() {
  const agents = new Map();
  const createdCalls = [];
  const registeredListeners = [];
  const workspace = { ...WORKSPACE, attachSession: async () => {} };

  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async (callOpts) => {
      createdCalls.push(callOpts);
      const agent = makeAgent(callOpts.sessionId, callOpts.meta?.cwd ?? WORKSPACE.path);
      agent.options = callOpts.agentOptions;
      agents.set(callOpts.sessionId, agent);

      // Trigger the setup callback on a mock agentCtx
      const agentCtx = {
        on: (event, handler) => {
          registeredListeners.push({ event, handler, sessionId: callOpts.sessionId });
          return () => {};
        },
        get: () => undefined,
      };
      if (typeof callOpts.setup === 'function') {
        await callOpts.setup(agentCtx, agent);
      }

      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing) return { agent: existing };
      const agent = makeAgent(resumeSessionId, WORKSPACE.path);
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };

  const services = {
    workspaceRegistry: { list: () => [workspace] },
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((a) => a.session), get: (id) => agents.get(id)?.session },
    sessionPersistence: {
      list: async () => [...agents.values()].map((a) => ({ header: a.session.header })),
      open: async (id) => {
        const a = agents.get(id);
        if (!a) throw new Error('not found');
        return {
          header: a.session.header,
          read: async () => ({ events: a.session.snapshotEvents() }),
          close: async () => {},
        };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    },
  };

  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: { rename() {}, get: () => undefined },
    on: () => {},
  };

  const bridge = new Bridge(
    ctx,
    { sessionMaxItems: 10, sessionMaxChars: 500, resultMaxItems: 10, resultMaxChars: 500 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );

  return { bridge, agents, createdCalls, registeredListeners, workspace };
}

test('R1: default behavior unchanged when agent_options omitted', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();
  const session = await bridge.createSession('ws-test', 'default-title');
  assert.ok(session.session_id);
  assert.equal(createdCalls.length, 1);
  assert.deepEqual(createdCalls[0].agentOptions, {
    provider: 'default-provider',
    model: 'default-model',
  });
});

test('R2: deepseek-official / deepseek-v4-flash / high goes into agents.create', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();
  const session = await bridge.createSession('ws-test', 'custom-model', undefined, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoning_effort: 'high',
  });
  assert.ok(session.session_id);
  assert.equal(createdCalls.length, 1);
  assert.deepEqual(createdCalls[0].agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
});

test('R2: installModelSelection uses explicit selection and overrides global default', async () => {
  const { bridge, registeredListeners } = makeBridgeWithAgentTracking();
  await bridge.createSession('ws-test', 'custom-model', undefined, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoning_effort: 'high',
  });

  // Find system-prompt/assemble and agent/request listeners installed by installModelSelection
  const assembleListener = registeredListeners.find((l) => l.event === 'system-prompt/assemble');
  assert.ok(assembleListener, 'system-prompt/assemble listener should be registered');

  const requestListener = registeredListeners.find((l) => l.event === 'agent/request');
  assert.ok(requestListener, 'agent/request listener should be registered');

  // Trigger assemble hook: selection.current must be snapshot and variable injected
  const assembleResult = await assembleListener.handler(
    {},
    {},
    async () => ({ variables: {} }),
  );
  assert.equal(assembleResult.variables.provider, 'deepseek-official');
  assert.equal(assembleResult.variables.model, 'deepseek-v4-flash');

  // Trigger request hook: reasoningEffort must be placed on request
  const requestResult = await requestListener.handler(
    {},
    async () => ({ provider: 'default-provider', model: 'default-model' }),
  );
  assert.equal(requestResult.provider, 'deepseek-official');
  assert.equal(requestResult.model, 'deepseek-v4-flash');
  assert.equal(requestResult.reasoningEffort, 'high');
});

test('R3: session_id + agent_options is rejected with clear error', async () => {
  const { bridge } = makeBridgeWithAgentTracking();
  await assert.rejects(
    () => bridge.startGoal({
      workspace: 'ws-test',
      goal: 'Some goal',
      session_id: 'session-existing-123',
      agent_options: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
    }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'AGENT_OPTIONS_NOT_SUPPORTED_FOR_EXISTING_SESSION');
      assert.match(err.message, /cannot be specified for existing session/);
      return true;
    },
  );
});

test('R4: start_goal passes through agent_options when creating new session', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();
  const res = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Build feature',
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    },
  });
  assert.ok(res.session_id);
  assert.equal(createdCalls.length, 1);
  assert.deepEqual(createdCalls[0].agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
});

test('R5: create_goal passes through agent_options', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();
  const res = await bridge.createGoal({
    workspace: 'ws-test',
    goal: 'Supervised goal',
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    },
  });
  assert.ok(res.session_id);
  assert.equal(createdCalls.length, 1);
  assert.deepEqual(createdCalls[0].agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
});

test('R4: request_id conflicts on different agent_options', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();
  const first = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Identical goal target',
    request_id: 'req-options-test',
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'low',
    },
  });
  assert.ok(first.session_id);
  assert.equal(createdCalls.length, 1);

  // Different reasoning_effort with same request_id -> conflict
  await assert.rejects(
    () => bridge.startGoal({
      workspace: 'ws-test',
      goal: 'Identical goal target',
      request_id: 'req-options-test',
      agent_options: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoning_effort: 'high',
      },
    }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, 'REQUEST_ID_CONFLICT');
      return true;
    },
  );

  // Exactly identical agent_options with same request_id -> idempotent reuse
  const retry = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Identical goal target',
    request_id: 'req-options-test',
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'low',
    },
  });
  assert.equal(retry.session_id, first.session_id);
  assert.equal(retry.existing_goal_reused, true);
});

test('R4: explicit model does not reuse old model active goal', async () => {
  const { bridge, createdCalls } = makeBridgeWithAgentTracking();

  // 1. First goal created without agent_options (uses default model)
  const defaultGoal = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Shared objective across runs',
  });
  assert.equal(createdCalls.length, 1);
  assert.ok(defaultGoal.session_id);

  // 2. Second goal with identical goal string but explicit agent_options
  const explicitGoal = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Shared objective across runs',
    workspace_lock_override: true,
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    },
  });
  assert.equal(createdCalls.length, 2, 'Should create a new session instead of reusing default model session');
  assert.notEqual(explicitGoal.session_id, defaultGoal.session_id);
  assert.notEqual(explicitGoal.existing_goal_reused, true);

  // 3. Third goal with identical explicit agent_options reuses the explicit session!
  const thirdGoal = await bridge.startGoal({
    workspace: 'ws-test',
    goal: 'Shared objective across runs',
    workspace_lock_override: true,
    agent_options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoning_effort: 'high',
    },
  });
  assert.equal(createdCalls.length, 2, 'Should reuse the matching explicit session');
  assert.equal(thirdGoal.session_id, explicitGoal.session_id);
  assert.equal(thirdGoal.existing_goal_reused, true);
});

test('MCP schema: dsh_create_session, dsh_create_goal, and dsh_start_goal expose agent_options', () => {
  const { bridge } = makeBridgeWithAgentTracking();
  const mcp = createMcpServer(
    bridge,
    { authMode: 'none', resultMaxItems: 10, resultMaxChars: 500, sessionMaxItems: 10, sessionMaxChars: 500 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );

  // Tools registered on McpServer
  // Inspect the internal tool definitions or listTools
  const tools = mcp._registeredTools;
  assert.ok(tools['dsh_create_session'], 'dsh_create_session registered');
  assert.ok(tools['dsh_create_goal'], 'dsh_create_goal registered');
  assert.ok(tools['dsh_start_goal'], 'dsh_start_goal registered');

  const sessionSchema = tools['dsh_create_session'].inputSchema;
  assert.ok(sessionSchema.shape.agent_options, 'dsh_create_session schema has agent_options');

  const createGoalSchema = tools['dsh_create_goal'].inputSchema;
  assert.ok(createGoalSchema.shape.agent_options, 'dsh_create_goal schema has agent_options');

  const startGoalSchema = tools['dsh_start_goal'].inputSchema;
  assert.ok(startGoalSchema.shape.agent_options, 'dsh_start_goal schema has agent_options');
});

test('isAgentOptionsEqual helper correctly handles optional reasoning_effort', () => {
  assert.equal(isAgentOptionsEqual(undefined, undefined), true);
  assert.equal(isAgentOptionsEqual({ provider: 'p', model: 'm' }, undefined), false);
  assert.equal(isAgentOptionsEqual(undefined, { provider: 'p', model: 'm' }), false);
  assert.equal(isAgentOptionsEqual({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true);
  assert.equal(isAgentOptionsEqual({ provider: 'p', model: 'm' }, { provider: 'p', model: 'other' }), false);
  assert.equal(
    isAgentOptionsEqual(
      { provider: 'p', model: 'm', reasoning_effort: 'high' },
      { provider: 'p', model: 'm', reasoning_effort: 'high' },
    ),
    true,
  );
  assert.equal(
    isAgentOptionsEqual(
      { provider: 'p', model: 'm', reasoning_effort: 'high' },
      { provider: 'p', model: 'm', reasoning_effort: 'low' },
    ),
    false,
  );
  assert.equal(
    isAgentOptionsEqual(
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', reasoning_effort: 'high' },
    ),
    false,
  );
});
