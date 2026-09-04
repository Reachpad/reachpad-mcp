/**
 * Types for the package's one entry point.
 *
 * Hand-written rather than generated: the source is plain ESM with JSDoc, and
 * a generated `.d.ts` would export the whole internal surface. This states
 * only what a caller may depend on, which is also a promise about what will
 * not change under them.
 */

/** A JSON-RPC message in, a response out — or null for a notification. */
export type McpMessage = unknown;

export interface McpServer {
  /**
   * Handle one parsed JSON-RPC payload. Resolves to one response, or `null`
   * for a notification, which HTTP turns into 202 with no body.
   *
   * Safe to destructure: it closes over its own state and never uses `this`.
   */
  handle(message: McpMessage): Promise<McpMessage | null>;

  /** The advertised tools, in `tools/list` order. */
  tools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    };
  }>;
}

export interface CreateServerOptions {
  /**
   * Configuration, read the same way the process would read it. Supply
   * `REACHPAD_ENDPOINT` and one credential — narrowest first:
   * `REACHPAD_IDENTITY_CREDENTIAL`, `REACHPAD_OPERATOR_TOKEN`, or
   * `REACHPAD_IDP_ASSERTION` with `REACHPAD_USER_ID`.
   */
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
}

export function createServer(options?: CreateServerOptions): McpServer;

/**
 * Wire a server to a byte stream pair, newline-delimited JSON-RPC. Used by the
 * stdio entry point; a host embedding this over HTTP does not need it.
 */
export function serveStdio(
  server: McpServer,
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): unknown;
