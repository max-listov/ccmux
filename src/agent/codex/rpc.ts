export interface CodexAppRpc {
  userAgent?: string | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  respond?(id: CodexRpcId, result: unknown): Promise<void>;
  close(): void;
}

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
