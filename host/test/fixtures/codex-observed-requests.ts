/**
 * The request fields signed-in Codex 0.163.0 sends, request by request.
 *
 * Names and their order were observed in a credential-free probe of Codex in
 * ChatGPT sign-in mode against local mock servers (the guest's own
 * requests, before any proxy). Every value here is synthetic. `Host` is
 * left out: tests that write a raw request add the destination's.
 *
 * The browser bridge must relay each of these for a process holding a
 * credential grant for the destination, except the WebSocket handshake,
 * which it cannot carry at all.
 */
export interface CodexObservedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

const THREAD = "00000000-0000-7000-8000-000000000001";
const USER_AGENT =
  "codex_exec/0.163.0 (Unknown Unknown; unknown) xterm-256color (codex_exec; 0.163.0)";

export const CODEX_OBSERVED_REQUESTS = {
  /** A model turn over HTTPS with server-sent events. Its body is zstd. */
  responses: {
    method: "POST",
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: [
      ["version", "0.163.0"],
      ["x-codex-beta-features", "remote_compaction_v2"],
      ["x-codex-turn-state", "synthetic-turn-state"],
      ["x-codex-window-id", `${THREAD}:0`],
      ["x-codex-turn-metadata", '{"synthetic":true}'],
      ["x-codex-routing-hint", "model=gpt-5.5"],
      ["x-client-request-id", THREAD],
      ["session-id", THREAD],
      ["thread-id", THREAD],
      ["accept", "text/event-stream"],
      ["content-encoding", "zstd"],
      ["content-type", "application/json"],
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["originator", "codex_exec"],
      ["user-agent", USER_AGENT],
      ["content-length", "16"],
    ],
  },
  /**
   * A model turn for a model whose catalog entry sets use_responses_lite
   * (gpt-6.1-sol, as a live ChatGPT account requires in 0.163.0): the same
   * request plus x-openai-internal-codex-responses-lite (client.rs
   * add_responses_lite_header). A live turn through the dev relay was
   * refused for lacking it in the allow-list.
   */
  responsesLite: {
    method: "POST",
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: [
      ["version", "0.163.0"],
      ["x-codex-beta-features", "remote_compaction_v2"],
      ["x-codex-window-id", `${THREAD}:0`],
      ["x-codex-turn-metadata", '{"synthetic":true}'],
      ["x-codex-routing-hint", "model=gpt-6.1-sol"],
      ["x-openai-internal-codex-responses-lite", "true"],
      ["x-client-request-id", THREAD],
      ["session-id", THREAD],
      ["thread-id", THREAD],
      ["accept", "text/event-stream"],
      ["content-encoding", "zstd"],
      ["content-type", "application/json"],
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["originator", "codex-tui"],
      ["user-agent", USER_AGENT],
      ["content-length", "16"],
    ],
  },
  /** The WebSocket handshake Codex tries before falling back to HTTPS. */
  websocketHandshake: {
    method: "GET",
    url: "https://chatgpt.com/backend-api/codex/responses",
    headers: [
      ["Connection", "Upgrade"],
      ["Upgrade", "websocket"],
      ["Sec-WebSocket-Version", "13"],
      ["Sec-WebSocket-Key", "AAAAAAAAAAAAAAAAAAAAAA=="],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["authorization", "Bearer synthetic-access-token"],
      ["user-agent", USER_AGENT],
      ["originator", "codex_exec"],
      ["openai-beta", "responses_websockets=2026-02-06"],
      ["version", "0.163.0"],
      ["x-codex-beta-features", "remote_compaction_v2"],
      ["x-client-request-id", THREAD],
      ["session-id", THREAD],
      ["thread-id", THREAD],
      ["x-codex-window-id", `${THREAD}:0`],
      ["x-codex-turn-metadata", '{"synthetic":true}'],
      ["x-codex-routing-hint", "model=gpt-5.5"],
      ["sec-websocket-extensions", "permessage-deflate; client_max_window_bits"],
    ],
  },
  models: {
    method: "GET",
    url: "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0",
    headers: [
      ["version", "0.163.0"],
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["originator", "codex_exec"],
      ["user-agent", USER_AGENT],
      ["accept", "*/*"],
    ],
  },
  /** The token refresh: its credential travels in the body, not a field. */
  tokenRefresh: {
    method: "POST",
    url: "https://auth.openai.com/oauth/token",
    headers: [
      ["content-type", "application/json"],
      ["originator", "codex_exec"],
      ["user-agent", "codex_exec/0.163.0 (Unknown Unknown; unknown) xterm-256color"],
      ["accept", "*/*"],
      ["content-length", "16"],
    ],
  },
  analyticsEvents: {
    method: "POST",
    url: "https://chatgpt.com/backend-api/codex/analytics-events/events",
    headers: [
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["content-type", "application/json"],
      ["originator", "codex_exec"],
      ["user-agent", USER_AGENT],
      ["accept", "*/*"],
      ["content-length", "16"],
    ],
  },
  installedPlugins: {
    method: "GET",
    url: "https://chatgpt.com/backend-api/ps/plugins/installed",
    headers: [
      ["originator", "codex_exec"],
      ["user-agent", USER_AGENT],
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["oai-product-sku", "codex"],
      ["accept", "*/*"],
    ],
  },
  mcpInitialize: {
    method: "POST",
    url: "https://chatgpt.com/backend-api/ps/mcp",
    headers: [
      ["user-agent", "codex-mcp-client/0.163.0"],
      ["x-openai-product-sku", "codex"],
      ["originator", "codex_exec"],
      ["accept", "text/event-stream, application/json"],
      ["content-type", "application/json"],
      ["content-length", "16"],
    ],
  },
  userSettings: {
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/settings/user",
    headers: [
      ["user-agent", USER_AGENT],
      ["authorization", "Bearer synthetic-access-token"],
      ["chatgpt-account-id", "acct-synthetic-0001"],
      ["cache-control", "no-cache, no-store"],
      ["accept", "*/*"],
    ],
  },
} as const satisfies Record<string, CodexObservedRequest>;

/**
 * Fields Codex sends only for account classes or sub-agents the probe did
 * not reach (read from its source): US-residency workspaces, FedRAMP
 * accounts, and review/compaction sub-agent threads.
 */
export const CODEX_SOURCE_ONLY_REQUEST_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["x-openai-account-routing-override", "us"],
  ["x-openai-fedramp", "true"],
  ["x-openai-subagent", "review"],
  ["x-codex-parent-thread-id", THREAD],
];
