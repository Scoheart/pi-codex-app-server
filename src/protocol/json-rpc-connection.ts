import type { Logger } from "@logtape/logtape";
import {
  JSONRPCClient,
  JSONRPCErrorCode,
  JSONRPCErrorException,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from "json-rpc-2.0";
import type { TypedJSONRPCServerAndClient } from "json-rpc-2.0";

import type { ServerNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import type { MessageTransport } from "../transports/message-transport.js";
import type {
  CodexClientMethods,
  CodexServerMethods,
} from "./generated/codex-methods.js";
import { CodexClientMethodNames } from "./generated/codex-methods.js";
import {
  ProtocolValidationError,
  addJsonRpcVersion,
  parseClientNotification,
  parseClientRequest,
  parseCodexWireMessage,
  parseServerNotification,
  parseServerRequest,
  removeJsonRpcVersion,
  validateClientResponse,
  validateServerResponse,
} from "./validation.js";
import type { JsonRpcLibraryMessage } from "./validation.js";

export interface JsonRpcRequestContext {
  readonly clientId: string;
  readonly signal: AbortSignal;
}

type ClientMethod = keyof CodexClientMethods;
type ServerMethod = keyof CodexServerMethods;
type ServerNotificationMethod = ServerNotification["method"];
type ServerNotificationFor<Method extends ServerNotificationMethod> = Extract<
  ServerNotification,
  { readonly method: Method }
>;
type ServerNotificationParams<Method extends ServerNotificationMethod> =
  ServerNotificationFor<Method> extends { readonly params: infer Params }
    ? Params
    : undefined;

export type ClientRequestHandler<Method extends ClientMethod> = (
  params: Parameters<CodexClientMethods[Method]>[0],
  context: JsonRpcRequestContext
) =>
  | ReturnType<CodexClientMethods[Method]>
  | PromiseLike<ReturnType<CodexClientMethods[Method]>>;

export type ClientNotificationHandler = (
  context: JsonRpcRequestContext
) => void | PromiseLike<void>;

type CodexJsonRpcPeer = TypedJSONRPCServerAndClient<
  CodexClientMethods,
  CodexServerMethods,
  JsonRpcRequestContext,
  JsonRpcRequestContext
>;

const initializationError = (
  method: ClientMethod,
  initialized: boolean
): string | undefined => {
  if (method === "initialize") {
    return initialized ? "Already initialized" : undefined;
  }
  return initialized ? undefined : "Not initialized";
};

export class JsonRpcConnection {
  readonly #abortController = new AbortController();
  readonly #clientId: string;
  readonly #context: JsonRpcRequestContext;
  readonly #logger: Logger;
  readonly #pendingClientRequests = new Map<string | number, ClientMethod>();
  readonly #requestStartedAt = new Map<string | number, number>();
  readonly #pendingServerRequests = new Map<string | number, ServerMethod>();
  readonly #peer: CodexJsonRpcPeer;
  readonly #transport: MessageTransport;
  readonly #deferredRequests = new Set<Promise<void>>();
  #initialized = false;
  #optOutNotificationMethods = new Set<string>();

  constructor(options: {
    readonly clientId: string;
    readonly logger: Logger;
    readonly transport: MessageTransport;
  }) {
    this.#clientId = options.clientId;
    this.#context = {
      clientId: options.clientId,
      signal: this.#abortController.signal,
    };
    this.#logger = options.logger;
    this.#transport = options.transport;
    const sendPayload = async (
      payload: JsonRpcLibraryMessage
    ): Promise<void> => {
      await this.#sendPayload(payload);
    };
    const reportLibraryError = (message: string): void => {
      this.#logger.error(message, { clientId: this.#clientId });
    };
    const server = new JSONRPCServer<JsonRpcRequestContext>({
      errorListener: reportLibraryError,
    });
    const client = new JSONRPCClient<JsonRpcRequestContext>(sendPayload);
    this.#peer = new JSONRPCServerAndClient(server, client, {
      errorListener: reportLibraryError,
    });
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  close(): void {
    this.#abortController.abort();
    this.#peer.rejectAllPendingRequests("JSON-RPC connection closed");
    this.#transport.close();
  }

  registerRequest<Method extends ClientMethod>(
    method: Method,
    handler: ClientRequestHandler<Method>
  ): void {
    this.#peer.addMethod(method, handler);
  }

  registerCompatibilityFallbacks(): void {
    for (const method of CodexClientMethodNames) {
      this.#registerCompatibilityFallback(method);
    }
  }

  registerInitialized(handler: ClientNotificationHandler): void {
    const initialized = (
      _params: undefined,
      context: JsonRpcRequestContext
    ): void | PromiseLike<void> => {
      if (!this.#initialized) {
        return;
      }
      return handler(context);
    };
    this.#peer.server.addMethod("initialized", initialized);
  }

  async run(): Promise<void> {
    try {
      for await (const message of this.#transport.read()) {
        await this.#receive(message);
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("JSON-RPC transport failed");
      this.#logger.error(failure, { clientId: this.#clientId });
      throw failure;
    } finally {
      this.close();
      await Promise.allSettled(this.#deferredRequests);
    }
  }

  notify<Method extends ServerNotificationMethod>(
    method: Method,
    params: ServerNotificationParams<Method>
  ): void {
    if (this.#optOutNotificationMethods.has(method)) {
      return;
    }
    this.#peer.notify(method, params, this.#context);
  }

  async #receive(text: string): Promise<void> {
    let message;
    try {
      message = parseCodexWireMessage(text);
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Invalid JSON-RPC message");
      this.#logger.warn(failure, { clientId: this.#clientId });
      await this.#transport.send(
        JSON.stringify({
          error: {
            code: JSONRPCErrorCode.ParseError,
            message: failure.message,
          },
          id: null,
        })
      );
      return;
    }

    try {
      if ("method" in message) {
        if ("id" in message) {
          const request = parseClientRequest(message);
          const handshakeError = initializationError(
            request.method,
            this.#initialized
          );
          if (handshakeError) {
            await this.#transport.send(
              JSON.stringify({
                error: { code: -32_000, message: handshakeError },
                id: request.id,
              })
            );
            return;
          }
          if (request.method === "initialize") {
            this.#optOutNotificationMethods = new Set(
              request.params.capabilities?.optOutNotificationMethods
            );
          }
          this.#pendingClientRequests.set(request.id, request.method);
          this.#requestStartedAt.set(request.id, performance.now());
          this.#logger.debug("App-server request received", {
            clientId: this.#clientId,
            method: request.method,
            requestId: request.id,
          });
        } else {
          parseClientNotification(message);
        }
      } else {
        const method = this.#pendingServerRequests.get(message.id);
        if (method && message.result !== undefined) {
          validateServerResponse(method, message.result);
        }
        this.#pendingServerRequests.delete(message.id);
      }
    } catch (error) {
      if (
        error instanceof ProtocolValidationError &&
        "method" in message &&
        "id" in message
      ) {
        await this.#transport.send(
          JSON.stringify({
            error: {
              code: JSONRPCErrorCode.InvalidParams,
              message: error.message,
            },
            id: message.id,
          })
        );
        return;
      }
      throw error;
    }

    const response = this.#peer.receiveAndSend(
      addJsonRpcVersion(message),
      this.#context,
      this.#context
    );
    if (
      message.method === "command/exec" ||
      message.method === "command/exec/write"
    ) {
      // Process exit and backpressured stdin must not block control or disconnect handling.
      this.#deferredRequests.add(response);
      void this.#finishDeferredRequest(response);
    } else {
      await response;
    }
  }

  async #finishDeferredRequest(response: Promise<void>): Promise<void> {
    try {
      await response;
    } catch (error) {
      this.#logger.error(
        error instanceof Error ? error : new Error("Deferred command failed")
      );
    } finally {
      this.#deferredRequests.delete(response);
    }
  }

  #registerCompatibilityFallback<Method extends ClientMethod>(
    method: Method
  ): void {
    this.#peer.server.addMethod(method, () => {
      throw new JSONRPCErrorException(
        `Method not implemented: ${method}`,
        JSONRPCErrorCode.MethodNotFound
      );
    });
  }

  async #sendPayload(payload: JsonRpcLibraryMessage): Promise<void> {
    let message = removeJsonRpcVersion(payload);
    if ("method" in message) {
      if ("id" in message) {
        const request = parseServerRequest(message);
        this.#pendingServerRequests.set(request.id, request.method);
      } else {
        parseServerNotification(message);
      }
    } else {
      const method = this.#pendingClientRequests.get(message.id);
      if (method && message.result !== undefined) {
        try {
          validateClientResponse(method, message.result);
          if (method === "initialize") {
            this.#initialized = true;
          }
        } catch (error) {
          const failure =
            error instanceof Error
              ? error
              : new Error("Invalid server response");
          this.#logger.error(failure, { clientId: this.#clientId, method });
          message = {
            error: {
              code: JSONRPCErrorCode.InternalError,
              message: failure.message,
            },
            id: message.id,
          };
        }
      }
      this.#pendingClientRequests.delete(message.id);
      const startedAt = this.#requestStartedAt.get(message.id);
      this.#requestStartedAt.delete(message.id);
      this.#logger.debug("App-server request completed", {
        clientId: this.#clientId,
        durationMs:
          startedAt === undefined
            ? null
            : Math.round(performance.now() - startedAt),
        errorCode: message.error?.code ?? null,
        errorMessage: message.error?.message ?? null,
        method,
        requestId: message.id,
      });
    }
    await this.#transport.send(JSON.stringify(message));
  }
}
