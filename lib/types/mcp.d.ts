/**
 * MCP server surface: data-plane and control-plane dsh_* tools ChatGPT calls.
 * Every tool maps onto a Bridge operation; nothing here reaches the filesystem,
 * the shell, or DSH internals directly. Outputs are JSON text blocks; failures
 * are reported as isError results with { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Bridge } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
export declare const agentOptionsSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    reasoning_effort: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger): McpServer;
