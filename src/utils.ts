/**
 * MCP response builders and display formatters. No network access lives here.
 */

import { STATUS_LABELS } from './constants.js';
import type { CallToolResult } from './types.js';

/**
 * Build a successful tool result.
 * @param text human-readable summary
 */
export function createSuccessResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Build a tool execution error. Per MCP spec these are reported in-band so the
 * model can self-correct, not raised as JSON-RPC protocol errors.
 * @param error
 */
export function createErrorResponse(error: Error | string): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `❌ ${message}` }], isError: true };
}

/** Wrap a tool handler so thrown errors become MCP tool errors instead of protocol errors. */
export function guard<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error : String(error));
    }
  };
}

export function formatDate(dateString?: string | null): string {
  if (!dateString) return STATUS_LABELS.NOT_SET;
  return new Date(dateString).toISOString().slice(0, 10);
}

export function calculateCompletionPercentage(completed: number, total: number): number {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

export function getStatusLabel(closed?: boolean): string {
  return closed ? STATUS_LABELS.CLOSED : STATUS_LABELS.ACTIVE;
}

export function getSafeValue(value: string | number | null | undefined, defaultValue: string = STATUS_LABELS.UNKNOWN): string {
  return String(value || defaultValue);
}
