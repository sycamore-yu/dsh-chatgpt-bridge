/**
 * MCP server surface: data-plane and control-plane dsh_* tools ChatGPT calls.
 * Every tool maps onto a Bridge operation; nothing here reaches the filesystem,
 * the shell, or DSH internals directly. Outputs are JSON text blocks; failures
 * are reported as isError results with { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Bridge, BridgeError } from './bridge.js';
import { DirectWorkspaceError } from './direct-workspace.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { redactValue } from './redact.js';
import { parseConstraints } from './goal-constraints.js';
import type { AgentOptionsInput } from './goal-control.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';

export const agentOptionsSchema = z.object({
  provider: z.string().min(1).describe('Provider route (e.g. deepseek-official)'),
  model: z.string().min(1).describe('Model id interpreted by provider (e.g. deepseek-v4-flash)'),
  reasoning_effort: z.string().min(1).optional().describe('Optional adapter-owned reasoning effort (e.g. low, medium, high)'),
});

const actionClassSchema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'filesystem.scan',
  'process.exec',
  'process.spawn',
  'git.read',
  'git.mutate',
  'npm.publish',
  'github.release',
  'network',
  'credentials.metadata',
  'workspace.read',
  'workspace.write',
  'temp.read',
  'temp.write',
  'external_path.read',
  'external_path.write',
]);

const constraintSchema = z.object({
  read_only: z.boolean().optional(),
  allow_workspace_scan: z.boolean().optional(),
  max_changed_files: z.number().int().min(0).optional(),
  allowed_actions: z.array(actionClassSchema).optional(),
  forbidden_actions: z.array(actionClassSchema).optional(),
});

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(redactValue(value), null, 2) }] };
}

function errorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof BridgeError || error instanceof DirectWorkspaceError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = process.env.DSH_CHATGPT_BRIDGE_DEBUG === '1' && error instanceof Error ? error.stack : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(stack ? { error: { code: 'INTERNAL', message, stack } } : { error: { code: 'INTERNAL', message } }, null, 2) }],
    isError: true,
  };
}

/** Wrap one async handler into the MCP error convention. */
function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger): McpServer {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'dsh_health',
    {
      title: 'DSH bridge health',
      description:
        'Bridge and DSH runtime status: versions, live/persisted/active session counts and ' +
        'capability flags. Never returns tokens, keys, cookies or environment secrets.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.health()),
  );

  server.registerTool(
    'dsh_list_workspaces',
    {
      title: 'List registered workspaces',
      description:
        'List the workspaces DSH already registered/authorized. Sessions can only be created ' +
        'inside these. Arbitrary paths are never opened or auto-registered.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.listWorkspaces()),
  );

  server.registerTool(
    'dsh_create_session',
    {
      title: 'Create a DSH session',
      description:
        'Create a real DSH agent session bound to a registered workspace (id, canonical path, or ' +
        'title from dsh_list_workspaces). The agent starts immediately; if initial_message is ' +
        'given the first turn begins right away. Returns the stable session_id to continue later.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        title: z.string().optional().describe('Optional display title for the session'),
        initial_message: z.string().optional().describe('Optional first message for the agent'),
        agent_options: agentOptionsSchema.optional().describe('Optional model route and reasoning effort for the new session'),
      }),
    },
    safe(async (args: { workspace: string; title?: string; initial_message?: string; agent_options?: AgentOptionsInput }) =>
      bridge.createSession(args.workspace, args.title, args.initial_message, args.agent_options)),
  );

  server.registerTool(
    'dsh_list_sessions',
    {
      title: 'List DSH sessions',
      description:
        'List sessions (live + persisted), newest first, with limited paging. DSH persistence is ' +
        'the authority: sessions survive bridge and ChatGPT restarts and can be continued by id.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 50)'),
        offset: z.number().int().min(0).optional().describe('Skip this many rows (default 0)'),
        workspace: z.string().optional().describe('Filter to one registered workspace'),
      }),
    },
    safe(async (args: { limit?: number; offset?: number; workspace?: string }) =>
      bridge.listSessions({ limit: args.limit, offset: args.offset, workspace: args.workspace })),
  );

  server.registerTool(
    'dsh_get_session',
    {
      title: 'Inspect one DSH session',
      description:
        'Status, workspace, recent message summary (bounded), agent state, pending work, ' +
        'waiting approvals/questions and todos for one session. History is budgeted, never unlimited.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_items: z.number().int().min(1).max(200).optional().describe('Max message rows'),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars per message'),
      }),
    },
    safe(async (args: { session_id: string; max_items?: number; max_chars?: number }) =>
      bridge.getSession(args.session_id, args.max_items, args.max_chars)),
  );

  server.registerTool(
    'dsh_send_message',
    {
      title: 'Send a message to a DSH session',
      description:
        'Continue an EXISTING DSH session: the message joins that session\'s durable log and the ' +
        'same agent loop (never a fresh agent). Returns immediately. For a multi-step goal or ' +
        'execution plan prefer dsh_start_goal + dsh_wait_goal instead of polling this low-level API.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message: z.string().min(1).max(20000),
      }),
    },
    safe(async (args: { session_id: string; message: string }) =>
      bridge.sendMessage(args.session_id, args.message)),
  );

  server.registerTool(
    'dsh_get_task_status',
    {
      title: 'Task status of one session',
      description:
        'Status vocabulary: idle, queued, running, waiting_for_user, waiting_for_approval, ' +
        'completed, failed, cancelled, blocked, max-tokens, interrupted. Also reports pending ' +
        'inbox items and any waiting approvals/questions with their ids. For long supervised ' +
        'goals prefer dsh_wait_goal, which long-polls instead of returning one snapshot.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.getTaskStatus(args.session_id)),
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Final result of the last turn',
      description:
        'Last turn\'s assistant text, status, tool calls, changed files (from the session log, ' +
        'not guessed) and structured error when the turn failed. dsh_wait_goal already returns a ' +
        'bounded final summary when the goal is terminal; use this for a more detailed check.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars of assistant text'),
      }),
    },
    safe(async (args: { session_id: string; max_chars?: number }) =>
      bridge.getResult(args.session_id, args.max_chars)),
  );

  server.registerTool(
    'dsh_cancel_task',
    {
      title: 'Cancel the running task',
      description:
        'Cancel the active turn of a live session through DSH\'s own cancel mechanism ' +
        '(agent.cancel). No processes are killed; the turn ends with an aborted reason. For ' +
        'supervised goals prefer dsh_stop_goal, which is idempotent and also fails-closed any ' +
        'pending approval or question.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.cancelTask(args.session_id)),
  );

  server.registerTool(
    'dsh_answer_question',
    {
      title: 'Answer a pending user question',
      description:
        'Answer a question the DSH agent asked the human (status waiting_for_user). Pass the ' +
        'question_id from dsh_get_task_status, one or more offered option labels, and optional ' +
        'free text.',
      inputSchema: z.object({
        question_id: z.string().min(1),
        session_id: z.string().optional(),
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      }),
    },
    safe(async (args: { question_id: string; session_id?: string; selected: string[]; custom?: string }) =>
      bridge.answerQuestion(args.question_id, args.session_id, { selected: args.selected, custom: args.custom })),
  );

  server.registerTool(
    'dsh_approve',
    {
      title: 'Decide one pending approval',
      description:
        'Decide one explicit DSH permission approval (status waiting_for_approval). Requires the ' +
        'exact approval_id and an explicit approve/reject decision. There is no approve-all; ' +
        'every grant is allowed-once for the exact tool call. Rejecting fails the call closed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        approval_id: z.string().min(1),
        decision: z.enum(['approve', 'reject']),
      }),
    },
    safe(async (args: { session_id: string; approval_id: string; decision: 'approve' | 'reject' }) =>
      bridge.approve(args.session_id, args.approval_id, args.decision)),
  );

  server.registerTool(
    'dsh_create_goal',
    {
      title: 'Create a supervised DSH goal',
      description:
        'Create a supervised DSH goal. If an equivalent active Goal already exists on the workspace, ' +
        'it is reused idempotently without bumping revision. Returns continuation_required.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion target for DSH'),
        plan: z.string().max(20000).optional().describe('Optional execution plan DSH should follow'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
        agent_options: agentOptionsSchema.optional().describe('Optional model route and reasoning effort for the new session'),
      }),
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      plan?: string;
      request_id?: string;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      workspace_lock_override?: boolean;
      agent_options?: AgentOptionsInput;
    }) => bridge.createGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_revise_goal',
    {
      title: 'Revise a supervised DSH goal',
      description:
        'Substantive update to an existing Goal (goal/plan/mode/constraints). Increments revision with optimistic locking (expected_revision).',
      inputSchema: z.object({
        session_id: z.string().min(1),
        goal: z.string().max(20000).optional(),
        plan: z.string().max(20000).optional(),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        revision_reason: z.string().max(200).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
    },
    safe(async (args: {
      session_id: string;
      goal?: string;
      plan?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      revision_reason?: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.reviseGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_pause_goal',
    {
      title: 'Pause a supervised DSH goal',
      description: 'Pause active turn and keep durable checkpoint without losing state.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.pauseGoal(args.session_id)),
  );

  server.registerTool(
    'dsh_resume_goal',
    {
      title: 'Resume a paused/deferred DSH goal',
      description: 'Resume from checkpoint without re-running completed steps.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        resume_steps: z.array(z.string().min(1)).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
    },
    safe(async (args: {
      session_id: string;
      resume_steps?: string[];
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.resumeGoal(args.session_id, args.resume_steps, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_retry_step',
    {
      title: 'Retry a blocked or failed step',
      description: 'Retry a specific blocked or failed step under the same identity, clearing stale blockers.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        step_id: z.string().min(1),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
    },
    safe(async (args: {
      session_id: string;
      step_id: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.retryStep(args.session_id, args.step_id, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_rerun_step',
    {
      title: 'Rerun or re-verify a step',
      description: 'Explicitly rerun a step with a fresh attempt even if previously completed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        step_id: z.string().min(1),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
    },
    safe(async (args: {
      session_id: string;
      step_id: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.rerunStep(args.session_id, args.step_id, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_wait_until_action_required',
    {
      title: 'Long wait on supervised Goal until action is required',
      description:
        'Server-side long wait: returns only when human approval/question, error, or terminal completion is reached, avoiding high-frequency polling.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait (default 120, max 300)'),
      }),
    },
    safe(async (args: { session_id: string; wait_seconds?: number }) =>
      bridge.waitUntilActionRequired(args.session_id, args.wait_seconds)),
  );

  server.registerTool(
    'dsh_credential_status',
    {
      title: 'Check credential availability (secret-safe)',
      description: 'Inspect provider credential availability and source without returning raw secret tokens or keys.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.getCredentialStatus()),
  );

  server.registerTool(
    'dsh_start_goal',
    {
      title: 'Start a supervised DSH goal',
      description:
        'Use this when the user gives DSH a multi-step goal or an execution plan. Creates or ' +
        'continues a native DSH session, writes the goal+plan as a user message, and returns ' +
        'continuation_required + next_tool_call. If continuation_required is true, immediately ' +
        'call dsh_wait_goal in this same assistant turn. Do not tell the user the task is merely ' +
        'running in the background. Optional request_id makes connector retries idempotent. '
        + 'Passing session_id revises the existing Goal (revision +1, history kept). '
        + 'To defer or resume steps without rewriting the goal, prefer dsh_update_goal. '
        + 'execution_mode defaults to standard; constraints only tighten DSH permissions.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion target for DSH'),
        plan: z.string().max(20000).optional().describe('Optional execution plan DSH should follow'),
        session_id: z.string().optional().describe('Continue this existing DSH session; omit to create a new one'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key for connector retries in this process'),
        expected_revision: z.number().int().min(1).optional().describe('Optional optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional()
          .describe('standard (default), minimal (necessary actions only), or strict (follow plan/constraints)'),
        constraints: constraintSchema.optional().describe('Structured Goal constraints; can only tighten DSH policy'),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
        agent_options: agentOptionsSchema.optional().describe('Optional model route and reasoning effort for the new session'),
      }),
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      plan?: string;
      session_id?: string;
      request_id?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      workspace_lock_override?: boolean;
      agent_options?: AgentOptionsInput;
    }) => bridge.startGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_update_goal',
    {
      title: 'Revise, defer, or resume a supervised Goal',
      description:
        'Control-plane update for an EXISTING supervised Goal. session_id is required and this '
        + 'tool never creates a session. action=revise changes goal/plan/mode/constraints; '
        + 'action=defer marks steps deferred (not failed) so independent branches can continue; '
        + 'action=resume reactivates deferred/blocked steps without replaying completed '
        + 'destructive actions. Each call increments Goal revision and keeps history. '
        + 'Then call dsh_wait_goal if continuation_required is true.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Existing DSH session that already has a Goal'),
        action: z.enum(['revise', 'defer', 'resume']).optional()
          .describe('revise (default), defer a step, or resume deferred/blocked work'),
        goal: z.string().max(20000).optional().describe('Replacement goal text (revise)'),
        plan: z.string().max(20000).optional().describe('Replacement plan'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        defer_steps: z.array(z.string().min(1)).optional()
          .describe('Step ids, kinds, or content fragments to defer (e.g. npm_publish)'),
        resume_steps: z.array(z.string().min(1)).optional()
          .describe('Step ids/kinds to resume; omit on action=resume to resume all deferred steps'),
        revision_reason: z.string().max(200).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
    },
    safe(async (args: {
      session_id: string;
      action?: 'revise' | 'defer' | 'resume';
      goal?: string;
      plan?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      defer_steps?: string[];
      resume_steps?: string[];
      revision_reason?: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.updateGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_wait_goal',
    {
      title: 'Wait on a supervised DSH goal',
      description:
        'Bounded long-poll (default 25s, max 30s) of one DSH session. If continuation_required is ' +
        'true, call this tool again immediately in the same assistant turn unless user action is ' +
        'required. Do not end the turn while continuation_required is true. Do not tell the user ' +
        'the task is running in the background and stop. waiting_for_approval / waiting_for_user ' +
        'stop the loop so you can ask the human, then dsh_approve or dsh_answer_question, then ' +
        'call this again. Never auto-approve or guess answers.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(30).optional().describe('Max seconds to wait (default 25)'),
      }),
    },
    safe(async (args: { session_id: string; wait_seconds?: number }) =>
      bridge.waitGoal(args.session_id, args.wait_seconds)),
  );

  server.registerTool(
    'dsh_stop_goal',
    {
      title: 'Stop a supervised DSH goal',
      description:
        'Use when the user asks to stop, cancel, or interrupt the supervised DSH goal. Idempotent: ' +
        'already completed/cancelled/failed sessions return already_stopped=true without error. ' +
        'Cancels through DSH agent.cancel and fails-closed any pending approval or question. ' +
        'Does not kill processes.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.stopGoal(args.session_id)),
  );

  // ── direct workspace channel (no DSH Goal, no agent) ───────────────────────
  // These tools read and write files in a registered workspace directly. They
  // never start an agent, never run a shell, and never touch a path outside the
  // registered root. Use them for light inspection/editing; use dsh_start_goal
  // when the task needs experiments, builds, or multi-step execution.

  server.registerTool(
    'dsh_workspace_info',
    {
      title: 'Inspect one registered workspace',
      description:
        'Registration id, canonical path, existence, git summary (branch/upstream/dirty count, ' +
        'sensitive paths omitted) and the current mutable-lock holder. Use it before a direct ' +
        'read or write, and to learn whether a live Goal currently owns the workspace write lock. ' +
        'Read-only: no lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, canonical path, or title from dsh_list_workspaces'),
      }),
    },
    safe(async (args: { workspace: string }) => bridge.directWorkspace.workspaceInfo(args.workspace)),
  );

  server.registerTool(
    'dsh_list_directory',
    {
      title: 'List a workspace directory',
      description:
        'List entries of one directory inside a registered workspace (relative path; "." is the ' +
        'root). Bounded depth (1-3), bounded page size with offset paging. Sensitive entries ' +
        '(.env, keys, credentials, .git, .ssh, .dsh, ...) are never listed and are counted in ' +
        'sensitive_skipped. Read-only: no workspace lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        path: z.string().optional().describe('Workspace-relative directory path (default ".")'),
        depth: z.number().int().min(1).max(3).optional().describe('Recursion depth (default 1, max 3)'),
        limit: z.number().int().min(1).max(2000).optional().describe('Max entries per page (default 200)'),
        offset: z.number().int().min(0).optional().describe('Skip this many entries (default 0)'),
      }),
    },
    safe(async (args: { workspace: string; path?: string; depth?: number; limit?: number; offset?: number }) =>
      bridge.directWorkspace.listDirectory(args)),
  );

  server.registerTool(
    'dsh_read_file',
    {
      title: 'Read a UTF-8 text file in a workspace',
      description:
        'Read one text file from a registered workspace with an exact sha256, size, mode and line ' +
        'range paging (start_line/end_line, max_bytes). Binary files (NUL bytes or invalid UTF-8) ' +
        'and sensitive paths are refused, and paths outside the workspace root are refused. ' +
        'redacted=true means bridge-wide secret masking altered the returned text; sha256 is always ' +
        'the on-disk digest. Read-only: no workspace lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        path: z.string().min(1).describe('Workspace-relative file path'),
        start_line: z.number().int().min(1).optional().describe('First line to return (1-based, default 1)'),
        end_line: z.number().int().min(1).optional().describe('Last line to return (inclusive)'),
        max_bytes: z.number().int().min(1).max(262144).optional().describe('Max bytes of text returned (default 262144)'),
      }),
    },
    safe(async (args: { workspace: string; path: string; start_line?: number; end_line?: number; max_bytes?: number }) =>
      bridge.directWorkspace.readFile(args)),
  );

  server.registerTool(
    'dsh_search_workspace',
    {
      title: 'Search a workspace (ripgrep, node fallback)',
      description:
        'Search file contents inside a registered workspace. Uses ripgrep when available and falls ' +
        'back to a bounded in-process walker otherwise; both skip sensitive paths and binary files. ' +
        'Bounded results with offset paging. Read-only: no workspace lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        query: z.string().min(1).max(1000).describe('Text or regular expression to find'),
        path: z.string().optional().describe('Workspace-relative directory to search (default ".")'),
        regex: z.boolean().optional().describe('Treat query as a regular expression (default false = literal)'),
        case_sensitive: z.boolean().optional().describe('Case-sensitive match (default false)'),
        glob: z.string().optional().describe('Optional ripgrep glob filter, e.g. "*.ts"'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max matches (default 100)'),
        offset: z.number().int().min(0).optional().describe('Skip this many matches (default 0)'),
      }),
    },
    safe(async (args: { workspace: string; query: string; path?: string; regex?: boolean; case_sensitive?: boolean; glob?: string; limit?: number; offset?: number }) =>
      bridge.directWorkspace.searchWorkspace(args)),
  );

  server.registerTool(
    'dsh_git_status',
    {
      title: 'Read-only git status of a workspace',
      description:
        'Structured `git status --porcelain=v1 --branch` for a registered workspace: branch, ' +
        'upstream, ahead/behind, per-file index/worktree codes. Runs with GIT_OPTIONAL_LOCKS=0 so ' +
        'it never refreshes or writes the index; it can never stage, commit, or reset. Sensitive ' +
        'paths are omitted and counted. No workspace lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1),
      }),
    },
    safe(async (args: { workspace: string }) => bridge.directWorkspace.gitStatus(args)),
  );

  server.registerTool(
    'dsh_git_diff',
    {
      title: 'Read-only git diff of a workspace',
      description:
        'Read-only diff for a registered workspace: mode=unstaged (default), staged, head, or ref ' +
        '(a plain revision name such as a commit sha, branch, or tag; no rev:path form). Line ' +
        'paging via offset/max_lines. Runs with external diff drivers and textconv disabled; it ' +
        'can never stage, commit, or reset. Diffs for sensitive paths are excluded and counted. ' +
        'No workspace lock is taken.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        mode: z.enum(['unstaged', 'staged', 'head', 'ref']).optional().describe('Diff mode (default unstaged)'),
        ref: z.string().optional().describe('Revision for mode=ref'),
        path: z.string().optional().describe('Limit the diff to one workspace-relative path'),
        offset: z.number().int().min(0).optional().describe('Skip this many diff lines (default 0)'),
        max_lines: z.number().int().min(1).max(4000).optional().describe('Max diff lines (default 400)'),
      }),
    },
    safe(async (args: { workspace: string; mode?: 'unstaged' | 'staged' | 'head' | 'ref'; ref?: string; path?: string; offset?: number; max_lines?: number }) =>
      bridge.directWorkspace.gitDiff(args)),
  );

  server.registerTool(
    'dsh_write_file',
    {
      title: 'Atomically write one text file in a workspace',
      description:
        'Create or replace one UTF-8 text file inside a registered workspace. The write is atomic ' +
        '(temporary file + rename), preserves the existing file mode, is limited in size, and ' +
        'refuses NUL bytes, unpaired surrogates, sensitive paths, symlinks, and paths outside the ' +
        'root. Pass expected_sha256 (from dsh_read_file) to make the update conditional, or ' +
        'create_only=true to refuse overwriting. The write takes the workspace mutable lock unless ' +
        'a live Goal holds it (then WORKSPACE_LOCKED), and fails closed with WORKSPACE_DRIFT (and ' +
        'rolls back) if the rest of the workspace changed while the write was in flight. It never ' +
        'runs git add or git commit.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        path: z.string().min(1).describe('Workspace-relative file path'),
        content: z.string().max(1048576).describe('Full new UTF-8 text content'),
        expected_sha256: z.string().length(64).optional().describe('Required current sha256 of the file (optimistic lock)'),
        create_only: z.boolean().optional().describe('Refuse to overwrite an existing file (default false)'),
      }),
    },
    safe(async (args: { workspace: string; path: string; content: string; expected_sha256?: string; create_only?: boolean }) =>
      bridge.directWorkspace.writeFile(args)),
  );

  server.registerTool(
    'dsh_apply_patch',
    {
      title: 'Apply an exact text patch in a workspace',
      description:
        'Replace an exact substring of one UTF-8 text file inside a registered workspace. ' +
        'old_text must match exactly once unless replace_all=true, and an optional ' +
        'line_start/line_end scopes the search. Ambiguity is always refused with PATCH_CONFLICT ' +
        '(0 matches or several matches) instead of guessing. Same atomic write, permission, ' +
        'sensitive-path, lock and drift guarantees as dsh_write_file; pass expected_sha256 as a ' +
        'precondition. It never runs git add or git commit.',
      inputSchema: z.object({
        workspace: z.string().min(1),
        path: z.string().min(1).describe('Workspace-relative file path'),
        old_text: z.string().min(1).max(1048576).describe('Exact text to replace'),
        new_text: z.string().max(1048576).describe('Replacement text'),
        expected_sha256: z.string().length(64).optional().describe('Required current sha256 of the file (optimistic lock)'),
        replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match'),
        line_start: z.number().int().min(1).optional().describe('Scope the search to this first line (1-based)'),
        line_end: z.number().int().min(1).optional().describe('Scope the search to this last line (inclusive)'),
      }),
    },
    safe(async (args: { workspace: string; path: string; old_text: string; new_text: string; expected_sha256?: string; replace_all?: boolean; line_start?: number; line_end?: number }) =>
      bridge.directWorkspace.applyPatch(args)),
  );

  return server;
}