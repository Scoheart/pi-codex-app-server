import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSession,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { Thread } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";
import type { ThreadItem } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadItem.js";
import type { ThreadLoadedListParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadLoadedListParams.js";
import type { ThreadLoadedListResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadLoadedListResponse.js";
import type { ThreadSettingsUpdateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSettingsUpdateParams.js";
import type { ThreadStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadStartResponse.js";
import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";
import type { TurnStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnSteerResponse.js";
import type { UserInput } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/UserInput.js";
import { appServerLogger } from "../logging/app-server-logger.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";
import {
  parseCodexWireMessage,
  parseServerNotification,
} from "../protocol/validation.js";
import { findAcceptedTurn } from "./accepted-turn.js";
import { projectPiConversation } from "./conversation-projector.js";
import {
  emptyTurn,
  handleEvent,
  notifyItemStarted,
  notifyItemCompleted,
} from "./live-turn.js";
import type { ActiveTurn } from "./live-turn.js";
import { PiModelCatalog } from "./model-catalog.js";
import type { PiModelRuntime } from "./pi-model-runtime.js";
import { SessionOwnerClient } from "./session-owner-client.js";
import { acquireSessionLease } from "./session-owner.js";
import { readPiPresence } from "./session-presence.js";
import type { PiSessionRepository } from "./session-repository.js";
import type { PiThreadCatalog } from "./thread-catalog.js";
import {
  applyThreadSettings,
  pendingThreadSettings,
  turnThreadSettings,
  updateThreadSettings,
} from "./thread-settings.js";
import type { ThreadSettingsTarget } from "./thread-settings.js";
import { persistTurnReceipt } from "./turn-receipt.js";

const dataUrlSchema = z
  .string()
  .regex(/^data:[^;,]+;base64,/u)
  .transform((url) => {
    const separator = url.indexOf(",");
    return {
      data: url.slice(separator + 1),
      mimeType: url.slice(5, url.indexOf(";")),
      type: "image" as const,
    };
  });
const loadedCursorSchema = z
  .string()
  .regex(/^pi-loaded:\d+$/u)
  .transform((cursor) => Number(cursor.slice("pi-loaded:".length)));

const MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

interface LoadedSession {
  active?: ActiveTurn;
  completion?: Promise<void>;
  readonly session: AgentSession;
  release?: () => Promise<void>;
}

export const textPrompt = (input: readonly UserInput[]): string =>
  input
    .map((part) => {
      switch (part.type) {
        case "text": {
          return part.text;
        }
        case "skill": {
          return `Use skill ${part.name} at ${part.path}`;
        }
        case "mention": {
          return `Mention ${part.name} at ${part.path}`;
        }
        case "audio":
        case "localAudio": {
          return `[Audio input: ${"url" in part ? part.url : part.path}]`;
        }
        case "image":
        case "localImage": {
          return "";
        }
        default: {
          const exhaustive: never = part;
          return exhaustive;
        }
      }
    })
    .filter(Boolean)
    .join("\n\n");

const remoteImage = async (url: string): Promise<ImageContent> => {
  const dataResult = dataUrlSchema.safeParse(url);
  if (dataResult.success) {
    return dataResult.data;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Could not fetch image: HTTP ${response.status}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0];
  if (!mimeType?.startsWith("image/")) {
    throw new Error("Image URL did not return an image content type");
  }
  return {
    data: Buffer.from(await response.arrayBuffer()).toString("base64"),
    mimeType,
    type: "image",
  };
};

const localImage = async (filePath: string): Promise<ImageContent> => {
  const mimeType = MIME_TYPES.get(path.extname(filePath).toLocaleLowerCase());
  if (!mimeType) {
    throw new Error(`Unsupported local image type: ${filePath}`);
  }
  const data = await readFile(filePath);
  return {
    data: data.toString("base64"),
    mimeType,
    type: "image",
  };
};

export const images = async (
  input: readonly UserInput[]
): Promise<ImageContent[]> => {
  const imageInputs = input.filter(
    (part): part is Extract<UserInput, { type: "image" | "localImage" }> =>
      part.type === "image" || part.type === "localImage"
  );
  return await Promise.all(
    imageInputs.map((part) => {
      if (part.type === "localImage") {
        return localImage(part.path);
      }
      if (!("url" in part)) {
        throw new Error(
          "Pi cannot resolve cloud image fileId; provide an image URL or local path"
        );
      }
      return remoteImage(part.url);
    })
  );
};

export class PiLiveSessionManager {
  #closed = false;
  #ownerTimer?: ReturnType<typeof setInterval>;
  readonly #starting = new Set<string>();
  readonly #home?: string;
  readonly #lastDeliveredTurn = new Map<string, string>();
  readonly #lostOwners = new Map<
    string,
    { historyTurnCount: number; turn: Turn }
  >();
  readonly #ownerGeneration = new Map<string, symbol>();
  readonly #owners = new Map<string, SessionOwnerClient>();
  readonly #connectingOwners = new Map<
    string,
    Promise<SessionOwnerClient | undefined>
  >();
  readonly #loading = new Map<string, Promise<LoadedSession | undefined>>();
  readonly #subscribers = new Map<string, Set<JsonRpcConnection>>();
  readonly #runtimeObservers = new Map<
    JsonRpcConnection,
    ReadonlySet<string>
  >();
  readonly #runtimeStatuses = new Map<string, Thread["status"]>();
  readonly #loaded = new Map<string, LoadedSession>();
  readonly #modelCatalog: PiModelCatalog;
  readonly #modelRuntime: PiModelRuntime;
  readonly #sessionRepository: PiSessionRepository;
  readonly #threadCatalog: PiThreadCatalog;

  constructor(options: {
    readonly home?: string;
    readonly modelCatalog: PiModelCatalog;
    readonly modelRuntime: PiModelRuntime;
    readonly sessionRepository: PiSessionRepository;
    readonly threadCatalog: PiThreadCatalog;
  }) {
    this.#home = options.home;
    this.#modelCatalog = options.modelCatalog;
    this.#modelRuntime = options.modelRuntime;
    this.#sessionRepository = options.sessionRepository;
    this.#threadCatalog = options.threadCatalog;
    if (this.#home) {
      this.#ownerTimer = setInterval(() => {
        void this.#refreshOwners();
      }, 1000);
      this.#ownerTimer.unref();
    }
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#ownerTimer);
    for (const loaded of this.#loaded.values()) {
      loaded.session.dispose();
      if (!loaded.active) {
        void PiLiveSessionManager.#releaseLease(loaded);
      }
    }
    this.#loaded.clear();
    for (const owner of this.#owners.values()) {
      owner.close();
    }
    this.#owners.clear();
    this.#subscribers.clear();
    this.#runtimeObservers.clear();
    this.#runtimeStatuses.clear();
  }

  isWorking(threadId: string): boolean {
    const loaded = this.#loaded.get(threadId);
    return (
      this.#owners.get(threadId)?.snapshot.turn?.status === "inProgress" ||
      loaded?.active !== undefined ||
      loaded?.session.isStreaming === true
    );
  }

  unload(threadId: string): void {
    const loaded = this.#loaded.get(threadId);
    loaded?.session.dispose();
    if (loaded && !loaded.active) {
      void PiLiveSessionManager.#releaseLease(loaded);
    }
    this.#loaded.delete(threadId);
  }

  static async #releaseLease(loaded: LoadedSession): Promise<void> {
    const { release } = loaded;
    loaded.release = undefined;
    try {
      await release?.();
    } catch (error) {
      appServerLogger.warn(
        error instanceof Error
          ? error
          : new Error("Pi session lease release failed")
      );
    }
  }

  async start(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const cwd = path.resolve(params.cwd ?? process.cwd());
    const model = this.#modelCatalog.resolve(params.model);
    if (!model) {
      throw new Error(`Unknown Pi model: ${params.model}`);
    }
    const sessionManager = params.ephemeral
      ? SessionManager.inMemory(cwd)
      : SessionManager.create(cwd);
    const release = this.#home
      ? await acquireSessionLease(this.#home, sessionManager.getSessionId())
      : undefined;
    try {
      const { session } = await createAgentSession({
        cwd,
        model,
        modelRuntime: this.#modelRuntime.modelRuntime,
        sessionManager,
      });
      this.#loaded.set(session.sessionId, { release, session });
      const thread = await this.#threadFor(session, params.threadSource);
      return PiLiveSessionManager.#startResponse(session, thread);
    } catch (error) {
      await release?.();
      throw error;
    }
  }

  async #refreshOwners(): Promise<void> {
    const native = this.#home
      ? await readPiPresence(this.#home)
      : new Set<string>();
    const observed = [...native].filter((id) =>
      [...this.#runtimeObservers.values()].some((visible) => visible.has(id))
    );
    await Promise.all(
      [...new Set([...this.#subscribers.keys(), ...observed])].map(
        async (threadId) => {
          if (
            this.#closed ||
            this.#owners.has(threadId) ||
            this.#connectingOwners.has(threadId)
          ) {
            return;
          }
          try {
            const owner = await this.attachOwner(threadId);
            const turn = owner?.snapshot.turn;
            if (owner) {
              this.#publishRuntimeStatus(
                threadId,
                turn?.status === "inProgress"
                  ? { activeFlags: [], type: "active" }
                  : { type: "idle" }
              );
            }
            if (
              !turn ||
              !this.#subscribers.has(threadId) ||
              (turn.status !== "inProgress" &&
                this.#lastDeliveredTurn.get(threadId) === turn.id)
            ) {
              return;
            }
            const notifier = this.#notifier(threadId);
            notifier.notify("turn/started", {
              threadId,
              turn: { ...structuredClone(turn), status: "inProgress" },
            });
            for (const item of turn.items) {
              notifier.notify("item/started", {
                item,
                startedAtMs: Date.now(),
                threadId,
                turnId: turn.id,
              });
              if (turn.status !== "inProgress") {
                notifier.notify("item/completed", {
                  completedAtMs: Date.now(),
                  item,
                  threadId,
                  turnId: turn.id,
                });
              }
            }
            if (turn.status !== "inProgress") {
              this.#lastDeliveredTurn.set(threadId, turn.id);
              notifier.notify("turn/completed", { threadId, turn });
            }
          } catch (error) {
            appServerLogger.debug(
              error instanceof Error
                ? error.message
                : "Pi owner reconnect failed",
              { threadId }
            );
          }
        }
      )
    );
  }

  async attachOwner(threadId: string): Promise<SessionOwnerClient | undefined> {
    if (this.#closed) {
      return undefined;
    }
    const existing = this.#owners.get(threadId);
    if (existing || !this.#home) {
      return existing;
    }
    const pending = this.#connectingOwners.get(threadId);
    if (pending) {
      return await pending;
    }
    const generation = Symbol(threadId);
    this.#ownerGeneration.set(threadId, generation);
    const task = SessionOwnerClient.connect(
      this.#home,
      threadId,
      (notification) => {
        if (
          notification.method === "turn/completed" &&
          this.#subscribers.has(threadId)
        ) {
          this.#lastDeliveredTurn.set(threadId, notification.params.turn.id);
        }
        const notifier = this.#notifier(threadId);
        notifier.notify(notification.method, notification.params);
      },
      () => {
        if (this.#ownerGeneration.get(threadId) !== generation) {
          return;
        }
        const snapshot = this.#owners.get(threadId)?.snapshot;
        this.#owners.delete(threadId);
        if (snapshot?.turn?.status === "inProgress") {
          const turn = structuredClone(snapshot.turn);
          turn.status = "failed";
          turn.completedAt = Math.floor(Date.now() / 1000);
          turn.error = {
            additionalDetails: null,
            codexErrorInfo: null,
            message:
              "Pi session owner disconnected. Reconnect to inspect the persisted result before retrying.",
            misalignment: null,
          };
          this.#lostOwners.set(threadId, {
            historyTurnCount: snapshot.historyTurnCount,
            turn,
          });
          this.#notifier(threadId).notify("turn/completed", { threadId, turn });
        }
      }
    );
    this.#connectingOwners.set(threadId, task);
    try {
      const owner = await task;
      if (this.#closed) {
        owner?.close();
        return undefined;
      }
      if (owner) {
        this.#lostOwners.delete(threadId);
        this.#owners.set(threadId, owner);
      }
      return owner;
    } finally {
      this.#connectingOwners.delete(threadId);
    }
  }

  async resume(threadId: string): Promise<LoadedSession | undefined> {
    const pending = this.#loading.get(threadId);
    if (pending) {
      return await pending;
    }
    const task = this.#resume(threadId);
    this.#loading.set(threadId, task);
    try {
      return await task;
    } finally {
      this.#loading.delete(threadId);
    }
  }

  async #resume(threadId: string): Promise<LoadedSession | undefined> {
    const existing = this.#loaded.get(threadId);
    if (existing) {
      return existing;
    }
    if (await this.attachOwner(threadId)) {
      throw new Error(`Pi TUI owns thread: ${threadId}`);
    }
    const nativeSessions = this.#home
      ? await readPiPresence(this.#home)
      : undefined;
    if (nativeSessions?.has(threadId)) {
      throw new Error(
        "Pi TUI is open without a bridge. Run /reload in that TUI before sending remotely."
      );
    }
    const release = this.#home
      ? await acquireSessionLease(this.#home, threadId)
      : undefined;
    try {
      const sessionManager = await this.#sessionRepository.load(threadId);
      if (!sessionManager) {
        await release?.();
        return undefined;
      }
      const { session } = await createAgentSession({
        cwd: sessionManager.getCwd(),
        modelRuntime: this.#modelRuntime.modelRuntime,
        sessionManager,
      });
      const loaded = { release, session };
      this.#loaded.set(threadId, loaded);
      return loaded;
    } catch (error) {
      await release?.();
      throw error;
    }
  }

  async startTurn(
    params: TurnStartParams,
    connection: JsonRpcConnection
  ): Promise<Turn> {
    if (this.#starting.has(params.threadId)) {
      throw new Error(`Thread is already running: ${params.threadId}`);
    }
    this.#starting.add(params.threadId);
    try {
      return await this.#startTurn(params, connection);
    } catch (error) {
      const loaded = this.#loaded.get(params.threadId);
      if (loaded?.release && !loaded.active && !loaded.session.isStreaming) {
        loaded.session.dispose();
        await PiLiveSessionManager.#releaseLease(loaded);
        this.#loaded.delete(params.threadId);
      }
      throw error;
    } finally {
      this.#starting.delete(params.threadId);
    }
  }

  async updateSettings(params: ThreadSettingsUpdateParams): Promise<void> {
    const { threadId } = params;
    if (this.#starting.has(threadId)) {
      throw new Error(`Pi thread command is already in progress: ${threadId}`);
    }
    this.#starting.add(threadId);
    try {
      const owner = await this.attachOwner(threadId);
      if (owner) {
        await owner.request({
          id: randomUUID(),
          method: "thread/settings/update",
          params,
        });
        return;
      }
      let loaded = await this.resume(threadId);
      if (loaded?.completion && !loaded.active) {
        // A completed turn remains mapped until its asynchronous lease release finishes.
        await loaded.completion;
        loaded = await this.resume(threadId);
      }
      if (!loaded) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      try {
        await updateThreadSettings(
          params,
          this.#settingsTarget(loaded.session),
          !!loaded.active || loaded.session.isStreaming
        );
      } finally {
        // New sessions have no JSONL file until their first prompt; retain those runtimes.
        if (
          loaded.release &&
          !loaded.active &&
          !loaded.session.isStreaming &&
          loaded.session.sessionFile &&
          existsSync(loaded.session.sessionFile)
        ) {
          loaded.session.dispose();
          await PiLiveSessionManager.#releaseLease(loaded);
          this.#loaded.delete(threadId);
        }
      }
    } finally {
      this.#starting.delete(threadId);
    }
  }

  executionSettings(
    threadId: string,
    manager?: SessionManager
  ):
    | { model: string; modelProvider: string; reasoningEffort: string | null }
    | undefined {
    const session = this.#loaded.get(threadId)?.session;
    const sessionManager = session?.sessionManager ?? manager;
    if (!sessionManager) {
      return undefined;
    }
    const context = sessionManager.buildSessionContext();
    const pending = pendingThreadSettings(sessionManager.getBranch());
    const provider =
      session?.model?.provider ?? context.model?.provider ?? "pi";
    const modelId = session?.model?.id ?? context.model?.modelId ?? "unknown";
    const model =
      pending.model ??
      `${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
    return {
      model,
      modelProvider: decodeURIComponent(model.slice(0, model.indexOf("/"))),
      reasoningEffort:
        pending.effort ?? session?.thinkingLevel ?? context.thinkingLevel,
    };
  }

  #settingsTarget(session: AgentSession): ThreadSettingsTarget {
    return {
      append: (type, data) =>
        session.sessionManager.appendCustomEntry(type, data),
      cwd: session.sessionManager.getCwd(),
      effort: session.thinkingLevel,
      entries: session.sessionManager.getBranch(),
      model: session.model,
      resolve: (key) => this.#modelCatalog.resolve(key),
      setEffort: (effort) => session.setThinkingLevel(effort),
      setModel: (model) => session.setModel(model),
    };
  }

  async #startTurn(
    params: TurnStartParams,
    connection: JsonRpcConnection
  ): Promise<Turn> {
    this.rebindConnection(params.threadId, connection);
    const owner = await this.attachOwner(params.threadId);
    const accepted = await this.#acceptedTurn(
      params.threadId,
      params.clientUserMessageId
    );
    if (accepted) {
      return accepted;
    }
    if (owner) {
      const result = await owner.request({
        id: randomUUID(),
        method: "turn/start",
        params,
      });
      const notification = parseServerNotification(
        parseCodexWireMessage(
          JSON.stringify({
            method: "turn/started",
            params: { threadId: params.threadId, turn: result },
          })
        )
      );
      if (notification.method !== "turn/started") {
        throw new Error("Invalid Pi owner turn response");
      }
      return notification.params.turn;
    }
    const loaded = await this.resume(params.threadId);
    if (!loaded) {
      throw new Error(`Thread not found: ${params.threadId}`);
    }
    if (loaded.active || loaded.session.isStreaming) {
      throw new Error(`Thread is already running: ${params.threadId}`);
    }
    await applyThreadSettings(
      this.#settingsTarget(loaded.session),
      turnThreadSettings(params)
    );
    const turn = emptyTurn(params.rootTurnId);
    const active: ActiveTurn = {
      agentItems: new Map(),
      connection: this.#notifier(params.threadId),
      historyEntryId:
        loaded.session.sessionManager.getBranch().at(-1)?.id ?? null,
      historyTurnCount: projectPiConversation(
        loaded.session.sessionManager.getBranch(),
        loaded.session.sessionManager.getCwd()
      ).length,
      interrupted: false,
      reasoningItems: new Map(),
      startedAtMs: Date.now(),
      threadId: params.threadId,
      toolItems: new Map(),
      turn,
    };
    loaded.active = active;
    active.unsubscribe = loaded.session.subscribe((event) =>
      handleEvent(active, event)
    );
    const userItem: ThreadItem = {
      clientId: params.clientUserMessageId ?? null,
      content: params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    active.connection.notify("thread/status/changed", {
      status: { activeFlags: [], type: "active" },
      threadId: params.threadId,
    });
    active.connection.notify("turn/started", {
      threadId: params.threadId,
      turn,
    });
    notifyItemStarted(active, userItem);
    notifyItemCompleted(active, userItem);
    loaded.completion = this.#runPrompt(loaded, active, params.input);
    return turn;
  }

  rebindConnection(threadId: string, connection: JsonRpcConnection): void {
    let subscribers = this.#subscribers.get(threadId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribers.set(threadId, subscribers);
    }
    if (connection.signal.aborted || subscribers.has(connection)) {
      return;
    }
    subscribers.add(connection);
    connection.signal.addEventListener(
      "abort",
      () => this.detach(threadId, connection),
      { once: true }
    );
  }

  detach(threadId: string, connection: JsonRpcConnection): boolean {
    const subscribers = this.#subscribers.get(threadId);
    const removed = subscribers?.delete(connection) ?? false;
    if (!subscribers?.size) {
      this.#subscribers.delete(threadId);
      if (
        [...this.#runtimeObservers.values()].some((visible) =>
          visible.has(threadId)
        )
      ) {
        return removed;
      }
      const owner = this.#owners.get(threadId);
      this.#owners.delete(threadId);
      this.#ownerGeneration.delete(threadId);
      owner?.close();
    }
    return removed;
  }

  detachConnection(connection: JsonRpcConnection): void {
    this.#runtimeObservers.delete(connection);
    for (const threadId of new Set([
      ...this.#subscribers.keys(),
      ...this.#owners.keys(),
    ])) {
      this.detach(threadId, connection);
    }
  }

  #notifier(threadId: string): Pick<JsonRpcConnection, "notify"> {
    return {
      notify: (method, params) => {
        if (method === "thread/status/changed") {
          const notification = parseServerNotification(
            parseCodexWireMessage(JSON.stringify({ method, params }))
          );
          // Older owners announce idle before completion. Subscribers can
          // release their stream on idle, so completion must reach them first.
          if (
            notification.method === "thread/status/changed" &&
            (notification.params.status.type !== "idle" ||
              this.#runtimeStatuses.get(threadId)?.type !== "active")
          ) {
            this.#publishRuntimeStatus(threadId, notification.params.status);
          }
          return;
        }
        // Older Pi owners report turns but do not publish runtime status.
        if (method === "turn/started") {
          this.#publishRuntimeStatus(threadId, {
            activeFlags: [],
            type: "active",
          });
        }
        for (const connection of this.#subscribers.get(threadId) ?? []) {
          connection.notify(method, structuredClone(params));
        }
        if (method === "turn/completed") {
          this.#publishRuntimeStatus(threadId, { type: "idle" });
        }
      },
    };
  }

  #publishRuntimeStatus(threadId: string, status: Thread["status"]): void {
    if (
      JSON.stringify(this.#runtimeStatuses.get(threadId)) ===
      JSON.stringify(status)
    ) {
      return;
    }
    this.#runtimeStatuses.set(threadId, status);
    const recipients = new Set(this.#subscribers.get(threadId));
    for (const [connection, visible] of this.#runtimeObservers) {
      if (visible.has(threadId)) {
        recipients.add(connection);
      }
    }
    for (const connection of recipients) {
      connection.notify("thread/status/changed", { status, threadId });
    }
  }

  async observeRuntime(
    connection: JsonRpcConnection,
    visible: ReadonlySet<string>
  ): Promise<void> {
    const first = !this.#runtimeObservers.has(connection);
    const initial = first ? [...this.#runtimeStatuses] : [];
    this.#runtimeObservers.set(connection, visible);
    await this.#refreshOwners();
    if (first) {
      for (const [threadId, status] of initial) {
        if (
          visible.has(threadId) &&
          JSON.stringify(this.#runtimeStatuses.get(threadId)) ===
            JSON.stringify(status)
        ) {
          connection.notify("thread/status/changed", { status, threadId });
        }
      }
    }
  }

  withRuntimeStatus(thread: Thread): Thread {
    if (this.isWorking(thread.id)) {
      return { ...thread, status: { activeFlags: [], type: "active" } };
    }
    return this.#owners.has(thread.id) || this.#loaded.has(thread.id)
      ? { ...thread, status: { type: "idle" } }
      : thread;
  }

  withActiveTurn(input: Thread): Thread {
    const loaded = this.#loaded.get(input.id);
    const runtimeThread = this.withRuntimeStatus(input);
    const thread =
      loaded && runtimeThread.ephemeral && runtimeThread.turns.length === 0
        ? {
            ...runtimeThread,
            turns: [
              ...projectPiConversation(
                loaded.session.sessionManager.getBranch(),
                loaded.session.sessionManager.getCwd()
              ),
            ],
          }
        : runtimeThread;
    const owner =
      this.#owners.get(thread.id)?.snapshot ?? this.#lostOwners.get(thread.id);
    if (owner?.turn) {
      return {
        ...thread,
        status:
          owner.turn.status === "inProgress"
            ? { activeFlags: [], type: "active" }
            : { type: "idle" },
        turns: [
          ...thread.turns.slice(0, owner.historyTurnCount),
          structuredClone(owner.turn),
        ],
      };
    }
    const active = loaded?.active;
    if (!active) {
      return thread;
    }
    return {
      ...thread,
      status: { activeFlags: [], type: "active" },
      // Persisted history can contain a partial turn with different projected IDs.
      turns: [
        ...thread.turns.slice(0, active.historyTurnCount),
        structuredClone(active.turn),
      ],
    };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const owner = await this.attachOwner(threadId);
    if (owner) {
      await owner.request({
        id: randomUUID(),
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
      return;
    }
    const loaded = this.#loaded.get(threadId);
    if (!(loaded?.active && loaded.active.turn.id === turnId)) {
      throw new Error(`Active turn not found: ${turnId}`);
    }
    loaded.active.interrupted = true;
    await loaded.session.abort();
  }

  loadedList(params: ThreadLoadedListParams): ThreadLoadedListResponse {
    const threadIds = [
      ...new Set([...this.#loaded.keys(), ...this.#owners.keys()]),
    ];
    const offset = params.cursor ? loadedCursorSchema.parse(params.cursor) : 0;
    const limit = Math.max(params.limit ?? threadIds.length, 1);
    const data = threadIds.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor:
        nextOffset < threadIds.length ? `pi-loaded:${nextOffset}` : null,
    };
  }

  async setName(threadId: string, name: string): Promise<void> {
    const owner = await this.attachOwner(threadId);
    if (owner) {
      await owner.request({
        id: randomUUID(),
        method: "thread/name/set",
        params: { name, threadId },
      });
      return;
    }
    const native = this.#home ? await readPiPresence(this.#home) : undefined;
    if (native?.has(threadId)) {
      throw new Error("Reload the Pi TUI before renaming its session remotely");
    }
    const loaded = this.#loaded.get(threadId);
    const release =
      !loaded && this.#home
        ? await acquireSessionLease(this.#home, threadId)
        : undefined;
    try {
      const manager =
        loaded?.session.sessionManager ??
        (await this.#sessionRepository.load(threadId));
      if (!manager) {
        throw new Error(`Thread not found: ${threadId}`);
      }
      manager.appendSessionInfo(name);
      this.#notifier(threadId).notify("thread/name/updated", {
        threadId,
        threadName: name || undefined,
      });
    } finally {
      await release?.();
    }
  }

  async deletionLease(threadId: string): Promise<() => Promise<void>> {
    await this.attachOwner(threadId);
    const native = this.#home ? await readPiPresence(this.#home) : undefined;
    if (this.#owners.has(threadId) || native?.has(threadId)) {
      throw new Error("Close the Pi TUI before deleting its session");
    }
    if (this.isWorking(threadId) || this.#starting.has(threadId)) {
      throw new Error(`Thread is already running: ${threadId}`);
    }
    return !this.#loaded.has(threadId) && this.#home
      ? await acquireSessionLease(this.#home, threadId)
      : () => Promise.resolve();
  }

  async compact(threadId: string): Promise<void> {
    if (this.#starting.has(threadId)) {
      throw new Error(`Thread is already running: ${threadId}`);
    }
    this.#starting.add(threadId);
    try {
      await this.#compact(threadId);
    } finally {
      this.#starting.delete(threadId);
    }
  }

  async #compact(threadId: string): Promise<void> {
    const owner = await this.attachOwner(threadId);
    if (owner) {
      await owner.request({
        id: randomUUID(),
        method: "thread/compact/start",
        params: { threadId },
      });
      return;
    }
    const loaded = await this.resume(threadId);
    if (!loaded) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (loaded.active || loaded.session.isStreaming) {
      throw new Error(`Thread is already running: ${threadId}`);
    }
    try {
      await loaded.session.compact();
    } finally {
      if (loaded.release) {
        loaded.session.dispose();
        await PiLiveSessionManager.#releaseLease(loaded);
        this.#loaded.delete(threadId);
      }
    }
  }

  async steer(params: TurnSteerParams): Promise<TurnSteerResponse> {
    const owner = await this.attachOwner(params.threadId);
    const accepted = await this.#acceptedTurn(
      params.threadId,
      params.clientUserMessageId
    );
    if (accepted) {
      return { turnId: accepted.id };
    }
    if (owner) {
      const result = await owner.request({
        id: randomUUID(),
        method: "turn/steer",
        params,
      });
      return z.object({ turnId: z.string() }).parse(result);
    }
    const loaded = this.#loaded.get(params.threadId);
    const active = loaded?.active;
    if (!(loaded && active && active.turn.id === params.expectedTurnId)) {
      throw new Error(`Active turn not found: ${params.expectedTurnId}`);
    }
    const userItem: ThreadItem = {
      clientId: params.clientUserMessageId ?? null,
      content: params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    notifyItemStarted(active, userItem);
    await loaded.session.steer(
      textPrompt(params.input),
      await images(params.input)
    );
    notifyItemCompleted(active, userItem);
    return { turnId: active.turn.id };
  }

  async #acceptedTurn(
    threadId: string,
    clientId: string | null | undefined
  ): Promise<Turn | undefined> {
    if (!clientId) {
      return undefined;
    }
    const loaded = this.#loaded.get(threadId);
    const manager =
      loaded?.session.sessionManager ??
      (await this.#sessionRepository.load(threadId));
    return manager
      ? findAcceptedTurn({
          clientId,
          cwd: manager.getCwd(),
          entries: manager.getBranch(),
          live:
            loaded?.active?.turn ??
            this.#owners.get(threadId)?.snapshot.turn ??
            undefined,
        })
      : undefined;
  }

  async #runPrompt(
    loaded: LoadedSession,
    active: ActiveTurn,
    input: readonly UserInput[]
  ): Promise<void> {
    try {
      await loaded.session.prompt(textPrompt(input), {
        images: await images(input),
        source: "rpc",
      });
      if (active.failure) {
        throw active.failure;
      }
      active.turn.status = active.interrupted ? "interrupted" : "completed";
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Pi turn failed");
      active.turn.status = active.interrupted ? "interrupted" : "failed";
      if (!active.interrupted) {
        active.turn.error = {
          additionalDetails: null,
          codexErrorInfo: null,
          message: failure.message,
          misalignment: null,
        };
      }
    } finally {
      active.unsubscribe?.();
      persistTurnReceipt({
        append: (type, data) => {
          loaded.session.sessionManager.appendCustomEntry(type, data);
        },
        entries: loaded.session.sessionManager.getBranch(),
        historyEntryId: active.historyEntryId,
        threadId: active.threadId,
        turn: active.turn,
      });
      active.turn.completedAt = Math.floor(Date.now() / 1000);
      active.turn.durationMs = Date.now() - active.startedAtMs;
      loaded.active = undefined;
      if (loaded.release) {
        loaded.session.dispose();
        await loaded.release();
        this.#loaded.delete(active.threadId);
        loaded.release = undefined;
      }
      active.connection.notify("turn/completed", {
        threadId: active.threadId,
        turn: active.turn,
      });
    }
  }

  static #startResponse(
    session: AgentSession,
    thread: Thread
  ): ThreadStartResponse {
    const { model } = session;
    if (!model) {
      throw new Error("Pi did not select a model for the new thread");
    }
    return {
      activePermissionProfile: null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: session.sessionManager.getCwd(),
      disabledPluginIds: [],
      instructionSources: [],
      model: PiModelCatalog.key(model),
      modelProvider: model.provider,
      multiAgentMode: "explicitRequestOnly",
      reasoningEffort: session.thinkingLevel,
      runtimeWorkspaceRoots: [session.sessionManager.getCwd()],
      sandbox: { type: "dangerFullAccess" },
      serviceTier: null,
      thread,
    };
  }

  async #threadFor(
    session: AgentSession,
    source: ThreadStartParams["threadSource"]
  ): Promise<Thread> {
    const stored =
      session.sessionFile && existsSync(session.sessionFile)
        ? await this.#threadCatalog.read(session.sessionId, true)
        : undefined;
    if (stored) {
      return stored;
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: `pi-${PI_VERSION}`,
      createdAt: now,
      cwd: session.sessionManager.getCwd(),
      daybreakEnabled: null,
      environments: null,
      ephemeral: !session.sessionFile,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: session.sessionId,
      model: session.model ? PiModelCatalog.key(session.model) : null,
      modelProvider: session.model?.provider ?? "pi",
      name: null,
      originator: null,
      parentThreadId: null,
      path: session.sessionFile ?? null,
      preview: "",
      projectId: null,
      reasoningEffort: session.thinkingLevel,
      recencyAt: now,
      section: null,
      sectionEnteredAt: null,
      sessionId: session.sessionId,
      source: { custom: "pi" },
      status: { type: "idle" },
      threadSource: source ?? "pi",
      turns: [],
      updatedAt: now,
    };
  }
}
