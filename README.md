# dsh-chatgpt-bridge

[![M8ven Score](https://m8ven.ai/badge/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)](https://m8ven.ai/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)

> **Let ChatGPT drive your local DSH agents.**
>
> 在 ChatGPT 里创建任务、继续会话、监督 Goal、处理审批并检查结果，不用在 ChatGPT 和 DSH 之间反复复制 Prompt。

`dsh-chatgpt-bridge` connects **ChatGPT Web → secure MCP tunnel → DeepSeek Harness (DSH)**. ChatGPT becomes the control surface; DSH keeps the agent loop, tools, skills, subagents, workflows, sandbox, approvals and workspace security model.

**The bridge connects the two sides. It does not replace DSH, modify DSH core, or route DSH model traffic through ChatGPT.**

Current package: **v0.5.1**, targeting DeepSeek Harness **0.1.5-rc.2**. After a successful connection, ChatGPT should see **tool count = 23**.

## Why this exists

A normal ChatGPT + local-agent workflow has too much manual glue:

```text
Think in ChatGPT
      ↓
copy prompt to DSH
      ↓
wait / inspect logs
      ↓
copy result back
      ↓
review in ChatGPT
      ↓
repeat
```

With the bridge:

```text
ChatGPT Web
   ↓  create / continue / supervise / approve
Secure MCP tunnel
   ↓
dsh-chatgpt-bridge
   ↓
DeepSeek Harness
   ↓
local workspace + tools + agent runtime
```

You stay in ChatGPT while DSH remains the execution engine.

## What you can do from ChatGPT

- create and inspect native DSH sessions;
- send follow-up instructions without copying context between apps;
- start, inspect, update and wait on Goals;
- approve DSH actions through the bridge when your DSH policy requires it;
- list registered workspaces and inspect runtime health;
- read, list and search files in a registered workspace without starting a Goal;
- check `git status` / `git diff` in a registered workspace (read-only);
- write or patch one text file atomically, under the same workspace lock as Goals;
- keep using DSH's own sandbox, approval and workspace boundaries;
- manage the supported tunnel runtime from the DSH Web settings UI.

## Real setup

![DSH Web ChatGPT Bridge settings running in a real installation](assets/screenshots/06-native-settings-real-use.png)

The screenshot is from a real DSH Web installation with sensitive values masked.

## Quick start

### Requirements

- Node.js 22+
- a working DeepSeek Harness installation (`dsh` on `PATH`)
- a DSH Web profile/runtime
- ChatGPT access that can use the currently supported MCP/custom-app connection flow

### 1. Install the plugin

```bash
dsh plugin --profile web add dsh-chatgpt-bridge
```

`npm install dsh-chatgpt-bridge` alone is not enough: the plugin must be added to a DSH profile bundle.

### 2. Start DSH Web

```bash
dsh web
```

Keep DSH Web and the bridge in the **same web profile/runtime** so ChatGPT-created sessions appear live in the UI.

Default local endpoints:

| Service | Endpoint |
| --- | --- |
| DSH Web | `http://127.0.0.1:3080` |
| Bridge MCP | `http://127.0.0.1:3456/mcp` |

### 3. Read the bridge token

Windows PowerShell:

```powershell
Get-Content "$HOME\.dsh\chatgpt-bridge.token"
```

macOS / Linux:

```bash
cat ~/.dsh/chatgpt-bridge.token
```

Treat this token like a password. Do not commit it, post it, or paste it into public chats.

Alternatively, set `DSH_CHATGPT_BRIDGE_TOKEN` yourself and the bridge uses it instead of generating a file.

### 4. Connect ChatGPT

ChatGPT Web cannot reach a plain localhost MCP endpoint directly. Use the secure MCP/tunnel connection mechanism currently supported by OpenAI and forward it to:

```text
http://127.0.0.1:3456/mcp
```

Use the bridge token as the MCP bearer credential where the connection flow requires it.

The bridge keeps a localhost-first design: it binds `127.0.0.1`, never exposes a public interface, and never self-hosts a tunnel.

### 5. Refresh tools and verify

After connecting, refresh/rescan the MCP tools in ChatGPT and run a read-only check:

```text
请使用已连接的 DSH App，只做只读检查：
1. 调用 dsh_health
2. 调用 dsh_list_workspaces
3. 不修改任何文件
4. 返回 bridge version、health 和 workspace 名称
```

A healthy first check should look like:

```text
bridge version = 0.5.1
tool count = 23
```

If health is OK, the version matches, and your registered workspace appears, the control path is ready.

## First useful workflow

A practical pattern is:

```text
ChatGPT: define the task and constraints
        ↓
Bridge: create / start a DSH Goal
        ↓
DSH: execute inside its registered workspace
        ↓
Bridge: wait, inspect status, surface approvals
        ↓
ChatGPT: review the result and decide what happens next
```

For a safe first run, start with a read-only Goal:

```text
使用 DSH App 创建一个只读检查目标：
- workspace 使用 dsh_list_workspaces 查到的已注册工作区
- goal：只读检查项目
- constraints：read_only=true
- 列出项目结构并总结 README
- 等待目标结束后只汇报结果，不修改任何文件
```

## Dual channel: Goal execution and direct workspace tools

The bridge exposes **two channels** over the same MCP endpoint. Both work only
inside workspaces DSH already registered, and both obey the same
`WorkspaceConcurrencyGuard`.

| | Goal channel | Direct workspace channel |
| --- | --- | --- |
| Tools | `dsh_start_goal`, `dsh_wait_goal`, `dsh_send_message`, ... | `dsh_workspace_info`, `dsh_read_file`, `dsh_write_file`, `dsh_apply_patch`, ... |
| What runs | a real DSH agent session with DSH's sandbox, approvals and tools | the bridge process itself: files, search and read-only git |
| Workspace write lock | held for the whole Goal | taken per write, only when no live Goal holds it |
| Best for | experiments, builds, multi-step changes, anything needing a shell | light inspection and precise single-file edits |
| Never does | bypass DSH policy | run commands, `git add`, `git commit`, or leave the registered root |

```text
ChatGPT
  ├── Goal channel      → dsh_start_goal → DSH agent → tools / build / tests
  └── Direct channel    → dsh_read_file / dsh_write_file / dsh_git_diff
                          → registered workspace only, guarded + atomic
```

Use the direct channel when ChatGPT just needs to look at a file or make one
precise edit. Use the Goal channel when the task needs to run something.

### Direct tool list

| Tool | Purpose |
| --- | --- |
| `dsh_workspace_info` | workspace id/path, git branch summary, current lock holder, active limits |
| `dsh_list_directory` | bounded listing with depth, page size/offset; sensitive entries are skipped and counted |
| `dsh_read_file` | UTF-8 text read with `sha256`, size, mode and line-range paging |
| `dsh_search_workspace` | ripgrep when available, bounded node fallback otherwise; both skip sensitive paths and binary files |
| `dsh_git_status` | structured `git status --porcelain=v1 --branch` (`GIT_OPTIONAL_LOCKS=0`) |
| `dsh_git_diff` | read-only `unstaged` / `staged` / `head` / `ref` diff with line paging |
| `dsh_write_file` | atomic UTF-8 file create/replace with optional `expected_sha256` or `create_only` |
| `dsh_apply_patch` | exact-substring replace; refuses 0 or multiple matches unless scoped or `replace_all` |

### Examples

Inspect before editing:

```json
{ "workspace": "dsh-chatgpt-bridge" }
```

→ `dsh_workspace_info`

Read only the region you need:

```json
{ "workspace": "dsh-chatgpt-bridge", "path": "src/mcp.ts", "start_line": 1, "end_line": 40 }
```

→ `dsh_read_file` returns `content`, `sha256`, `total_lines`, `truncated` and
`next_start_line`.

Create a file, then update it conditionally:

```json
{ "workspace": "dsh-chatgpt-bridge", "path": "notes/todo.md", "content": "# TODO\n", "create_only": true }
```

```json
{
  "workspace": "dsh-chatgpt-bridge",
  "path": "notes/todo.md",
  "content": "# TODO\n\n- [x] shipped\n",
  "expected_sha256": "<new_sha256 from the create call>"
}
```

→ `dsh_write_file` returns `created`, `old_sha256`, `new_sha256`, `bytes`, `mode`.

Make one exact edit:

```json
{
  "workspace": "dsh-chatgpt-bridge",
  "path": "README.md",
  "old_text": "## What this project is not",
  "new_text": "## Non-goals",
  "expected_sha256": "<sha256 from dsh_read_file>"
}
```

→ `dsh_apply_patch` returns `replacements`, `old_sha256`, `new_sha256`. If
`old_text` matches zero or several times the call fails with `PATCH_CONFLICT`
instead of guessing; narrow it with `line_start`/`line_end` or pass
`replace_all: true`.

Search and inspect git state:

```json
{ "workspace": "dsh-chatgpt-bridge", "query": "WORKSPACE_LOCKED", "glob": "*.ts", "limit": 20 }
```

```json
{ "workspace": "dsh-chatgpt-bridge", "mode": "unstaged", "path": "src/mcp.ts", "max_lines": 80 }
```

### Direct channel security model

- **Registered roots only.** Every call resolves the workspace through the same
  `workspaceRegistry` `dsh_list_workspaces` reports; an unregistered path is
  `WORKSPACE_NOT_FOUND`, and paths are never auto-registered.
- **Containment twice.** A path is checked lexically (no `..` escape) and
  physically (`realpath` of the target, or of its nearest existing parent), so a
  symlink cannot leave the root. A symlink target that resolves inside the root
  is still refused as a write target (`SYMLINK_NOT_WRITABLE`).
- **Sensitive-path denylist.** `.env`/dotenv variants, `*.pem`/`*.key` and other
  key material, `id_rsa`-style keys, `credential`/`secret`/`token` files,
  `.ssh`, `.gnupg`, `.aws`, `.kube`, `.config/gh`, `secrets/`, `.dsh` (DSH and
  bridge credentials) and `.git` are refused for reads, listings, searches and
  writes. Listing and search count what they skip (`sensitive_skipped`,
  `sensitive_omitted`) instead of silently returning it.
- **Binary and size bounds.** Binary files (NUL bytes or invalid UTF-8) are
  refused, and every read/search/diff/write is bounded by byte, entry, match and
  line limits.
- **Same lock, no second model.** A direct write refuses with
  `WORKSPACE_LOCKED` while a live Goal holds the workspace mutable lock, then
  publishes its own transient holder in the same guard so a Goal starting
  mid-write is refused too. Concurrent direct writes to one workspace are
  serialized in-process.
- **Drift fails closed.** Each write captures the workspace fingerprint with its
  own target path excluded, writes atomically (temporary file + rename, existing
  mode preserved), and re-checks the fingerprint. If anything else changed in
  the meantime it reports `WORKSPACE_DRIFT` and rolls the file back.
- **Text is never intent.** Direct tools ignore Goal wording completely. Every
  decision comes from the registered workspace, the resolved path, the
  sensitive-path policy, live lock state, and the observed file/git state.
- **Read-only git.** `dsh_git_status`/`dsh_git_diff` run with
  `GIT_OPTIONAL_LOCKS=0` and `--no-ext-diff --no-textconv`; direct writes never
  `git add` or `git commit`.

Stable error codes: `WORKSPACE_NOT_FOUND`, `WORKSPACE_REGISTRY_UNAVAILABLE`,
`PATH_OUTSIDE_WORKSPACE`, `SENSITIVE_PATH_DENIED`, `BINARY_FILE_DENIED`,
`FILE_NOT_FOUND`, `FILE_EXISTS`, `FILE_TOO_LARGE`, `IS_A_DIRECTORY`,
`NOT_A_DIRECTORY`, `SYMLINK_NOT_WRITABLE`, `DIRECTORY_NOT_FOUND`,
`PRECONDITION_FAILED`, `PATCH_CONFLICT`, `PATCH_INVALID`, `WORKSPACE_LOCKED`,
`WORKSPACE_DRIFT`, `WRITE_FAILED`, `GIT_UNAVAILABLE`, `GIT_NOT_A_REPOSITORY`,
`GIT_ERROR`, `COMMAND_TIMEOUT`, `SEARCH_FAILED`, `INVALID_ARGUMENT`.

## Model and Reasoning Effort Control

When ChatGPT creates a new DSH session or starts/creates a new supervised Goal, it can explicitly specify the model route and reasoning intensity via optional `agent_options`:

- `provider: string` — Provider route (e.g. `deepseek-official`)
- `model: string` — Provider-owned model ID (e.g. `deepseek-v4-flash`)
- `reasoning_effort: string` *(optional)* — Adapter-owned reasoning effort (e.g. `low`, `medium`, `high`)

### Key Invariants

1. **Dual Configuration & Precedence**: `agent_options` configures both DSH `AgentOptions` and the initial selection of `installModelSelection`. The explicit model takes precedence over global profile defaults (`agentDefaultModel`) and ensures `reasoningEffort` enters both the runtime request and durable session headers.
2. **New Sessions Only**: Explicit `agent_options` is only allowed when creating a new session (`dsh_create_session`, `dsh_create_goal`, or `dsh_start_goal` without `session_id`). Passing both `session_id` and `agent_options` returns an immediate error (`AGENT_OPTIONS_NOT_SUPPORTED_FOR_EXISTING_SESSION`) to prevent hot-switching semantics on existing sessions.
3. **Idempotency Fingerprint**: The `request_id` fingerprint for `dsh_start_goal` includes `agent_options`. Different options with the same `request_id` are rejected with `REQUEST_ID_CONFLICT`.
4. **Active Goal Isolation**: When `agent_options` is explicitly specified, `dsh_start_goal` will never mistakenly reuse an active Goal session running under default or different models.

### Tool Invocation Examples (ChatGPT MCP)

#### 1. Creating a Session with Explicit Model (`dsh_create_session`)

```json
{
  "workspace": "ws-1",
  "title": "DeepSeek Flash High reasoning session",
  "initial_message": "Analyze system performance and diagnose bottlenecks",
  "agent_options": {
    "provider": "deepseek-official",
    "model": "deepseek-v4-flash",
    "reasoning_effort": "high"
  }
}
```

#### 2. Starting a Supervised Goal with Explicit Model (`dsh_start_goal`)

```json
{
  "workspace": "ws-1",
  "goal": "Refactor data ingestion module",
  "plan": "1. Inspect current pipeline\n2. Add batch processing\n3. Run test suite",
  "execution_mode": "strict",
  "agent_options": {
    "provider": "deepseek-official",
    "model": "deepseek-v4-flash",
    "reasoning_effort": "high"
  }
}
```

#### 3. Human Prompt in ChatGPT

```text
使用 DSH App 创建一个新目标：
- 工作区：选择已注册的工作区
- 模型配置：provider=deepseek-official, model=deepseek-v4-flash, reasoning_effort=high
- 目标：执行代码重构与性能优化
```

## Control-plane invariant: text is not intent

Free-text words in a `goal` or `plan` are never read as action intent. A Goal
that merely *mentions* an action — negated, discussed, quoted, or referenced in
Chinese or English — is not rejected before the Agent starts:

- "Do not modify, delete or rename any file; only report findings."
- "Audit the code paths that handle write, delete and publish operations."
- 'The error message says "write failed"; explain it.'
- "不要修改任何文件，只做只读审计。"
- "检查处理删除和推送的分支逻辑，不要执行它们。"

Intent is decided at execution time, from real tool calls and structured facts:

- `read_only`, `allowed_actions` / `forbidden_actions` and `max_changed_files`
  are enforced per tool call (reason codes `read_only`, `forbidden_action`,
  `action_not_allowed`, `max_changed_files`).
- Risk tiers and approvals come from the tool name plus tool-call arguments,
  never from Goal wording.
- The workspace lock and drift detection use workspace state.
- Step *deferral* is a structured request (`defer_steps`, or an explicit
  `[deferred]` Plan marker), never a "defer ..." phrase inside prose.

`dsh_start_goal` still returns `GOAL_INVALID`, but only for a contradictory
**structured** constraint set (for example the same action class in both
`allowed_actions` and `forbidden_actions`, or `read_only=true` together with an
explicit `filesystem.write` grant). Nothing about that decision depends on the
Goal's wording.

## Security model

This is a **control bridge**, not a remote shell replacement.

- The MCP server binds to loopback by default.
- It binds `127.0.0.1`, never exposes a public interface, and never self-hosts a tunnel.
- DSH remains responsible for its own sandbox, approvals and workspace rules.
- The bridge only works with workspaces already registered in DSH.
- The direct workspace channel (file read/search/git/write) resolves every path
  inside a registered root and denies a documented sensitive-path set (dotenv,
  private keys, credential/token files, `.ssh`, `.gnupg`, `.aws`, `.kube`,
  `secrets/`, `.dsh`, `.git`); writes are atomic, sized, locked and drift-checked.
- Tokens and tunnel/runtime secrets are stored outside the repository and should never be committed.
- Write/action tools are real actions. Keep approval policies appropriate for the workspace you expose.
- Tunnel/runtime management is designed to fail closed around process ownership and lifecycle ambiguity.

If you only need inspection, use read-only prompts and keep DSH constraints read-only.

## What this project is not

- It is **not** a ChatGPT API proxy.
- It does **not** make DSH use your ChatGPT subscription as a model provider.
- It does **not** upload an arbitrary workspace to ChatGPT.
- It does **not** expose your whole filesystem: the direct channel is limited to
  registered workspace roots, minus a sensitive-path denylist.
- It does **not** let the direct channel run commands, build, commit or push; use
  the Goal channel for that.
- It does **not** bypass DSH approvals or sandboxing.
- It does **not** modify DeepSeek Harness core.

## Troubleshooting

### ChatGPT cannot connect

`127.0.0.1` only exists on your machine. Confirm that your supported secure tunnel/MCP connection forwards to the bridge endpoint and that the bridge token matches the running DSH profile.

### `401 Unauthorized`

Re-read the token from the active DSH home/profile and make sure the connector sends the matching bearer credential.

### No workspace appears

The bridge only lists **registered DSH workspaces**. Register the project in DSH first; the bridge intentionally does not auto-register arbitrary filesystem paths.

### Session exists but is not live in DSH Web

Run the bridge and DSH Web in the same web profile/runtime. Separate runtimes may persist sessions but will not provide the same live UI behavior.

### Tool list looks stale

Restart/upgrade the plugin as needed, then refresh/rescan the MCP tools on the ChatGPT side.

## Project status

This is an actively maintained, independent DSH plugin. Compatibility releases track DeepSeek Harness changes while preserving the bridge's MCP/tool semantics and security boundaries.

Current package:

```text
dsh-chatgpt-bridge@0.5.1
```

Compatibility: **v0.5.1 → DSH 0.1.5-rc.2**. Fresh real ChatGPT UI validation after each DSH upgrade still needs to be rechecked on your machine.

Distribution and ecosystem listings:

- [npm](https://www.npmjs.com/package/dsh-chatgpt-bridge)
- [M8ven](https://m8ven.ai/mcp/jiezeng2004-design-dsh-chatgpt-bridge-14d0zo)
- [dshbase](https://dshbase.com/plugins/dsh-chatgpt-bridge/)
- [DSHarness](https://dsharness.org/plugin/jiezeng2004-design/dsh-chatgpt-bridge)

Third-party directory labels describe those directories' own checks; they are not security audits or endorsements.

## Development

The bridge is a standalone DSH plugin with no DSH core modifications. Development focuses on:

- MCP tool/schema compatibility;
- Goal/session lifecycle reliability;
- the direct workspace channel (path policy, sensitive-path denylist, workspace lock integration);
- native settings and tunnel runtime management;
- process-ownership safety;
- regression and compatibility testing across supported DSH releases.

## License

MIT. See [LICENSE](LICENSE).

---

**Unofficial community project. Not affiliated with or endorsed by OpenAI or DeepSeek.**
