export interface CodexAppRpc {
  userAgent?: string | undefined;
  /** `timeoutMs` overrides the one deadline every other request shares, for the few that need it. */
  request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  respond?(id: CodexRpcId, result: unknown): Promise<void>;
  close(): void;
}

/**
 * The deadline of the requests that load a thread into a fresh App Server — `thread/start`,
 * `thread/resume`, `thread/fork`.
 *
 * Every other request answers from a running server in well under a second, and 10 s is how long a
 * hung one is allowed to hide. Loading a thread is different work: on a loaded host a fresh server
 * answered `thread/start` in 5.6 s warm and not within 10 s cold, so a managed Codex session could
 * not be created from a cold start at all. The value fits inside `session.create`'s own 60 s.
 */
export const CODEX_THREAD_BOOTSTRAP_TIMEOUT_MS = 45_000;

export type CodexRpcId = number | string;
export interface CodexRpcEvent {
  method: string;
  params: unknown;
}
export interface CodexRpcRequest extends CodexRpcEvent {
  id: CodexRpcId;
}
export interface CodexRpcOptions {
  signal?: AbortSignal;
  maxMessageBytes?: number;
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
  onEvent?: (event: CodexRpcEvent) => void;
  onRequest?: (request: CodexRpcRequest) => void;
  onClose?: (error: Error) => void;
}
