export interface CodexAppRpc {
  userAgent?: string | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

export interface CodexRpcEvent { method: string; params: unknown }
export interface CodexRpcOptions {
  signal?: AbortSignal;
  maxMessageBytes?: number;
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
  onEvent?: (event: CodexRpcEvent) => void;
  onClose?: (error: Error) => void;
}
