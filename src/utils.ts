import type { CallToolResult } from './types.js';

export function createSuccessResponse(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function createErrorResponse(error: Error | string): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `❌ ${message}` }], isError: true };
}

export function guard<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error : String(error));
    }
  };
}

export function calculateCompletionPercentage(completed: number, total: number): number {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

