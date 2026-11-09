/* oxlint-disable anti-slop/no-module-mocking -- Replace the Pi session creation boundary to exercise turn lifecycle without providers, credentials, or user extensions. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentSession,
  SessionManager,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerConfig } from "../src/config/app-server-config.js";
import { appServerLogger } from "../src/logging/app-server-logger.js";
import { projectPiConversation } from "../src/pi/conversation-projector.js";
import { PiLiveSessionManager } from "../src/pi/live-session-manager.js";
import { emptyTurn } from "../src/pi/live-turn.js";
import { PiModelCatalog } from "../src/pi/model-catalog.js";
import { PiModelRuntime } from "../src/pi/pi-model-runtime.js";
import { SessionOwnerHost } from "../src/pi/session-owner-host.js";
import { PiSessionPresence } from "../src/pi/session-presence.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { PiThreadCatalog } from "../src/pi/thread-catalog.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import {
  parseCodexWireMessage,
  parseServerNotification,
} from "../src/protocol/validation.js";
import { RemoteClientTransport } from "../src/remote/client-transport.js";
import { AppServer } from "../src/server/app-server.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";
import { AsyncMessageQueue } from "../src/transports/async-message-queue.js";
import type { ServerNotification } from "../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import type { Thread } from "../vendor/openai-codex-app-server-protocol/typescript/v2/Thread.js";
import type { ThreadResumeParams } from "../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadResumeParams.js";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn<typeof createAgentSession>(),
}));
vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  createAgentSession: mocks.createSession,
}));

const databases: MetadataDatabase[] = [];

type SessionListener = (event: AgentSessionEvent) => void;

const createConnection = (
  notifications: ServerNotification[]
): JsonRpcConnection =>
  new JsonRpcConnection({
    clientId: "turn-test",
    logger: appServerLogger,
    transport: new RemoteClientTransport((message) => {
      notifications.push(
        parseServerNotification(parseCodexWireMessage(message))
      );
      return Promise.resolve();
    }),
  });

const fixture = (home?: string) => {
  const database = new MetadataDatabase(":memory:");
  databases.push(database);
  const modelRuntime: PiModelRuntime = Object.create(PiModelRuntime.prototype);
  const modelCatalog = new PiModelCatalog(modelRuntime);
  const sessionRepository = new PiSessionRepository(database);
  const sessionManager = SessionManager.inMemory("/synthetic");
  vi.spyOn(sessionRepository, "load").mockResolvedValue(sessionManager);
  vi.spyOn(sessionRepository, "read").mockResolvedValue({
    info: {
      allMessagesText: "",
      created: new Date(0),
      cwd: "/synthetic",
      firstMessage: "",
      id: "thread",
      messageCount: 0,
      modified: new Date(0),
      path: "/synthetic/session.jsonl",
    },
    manager: sessionManager,
  });
  const threadCatalog = new PiThreadCatalog({ database, sessionRepository });
  const manager = new PiLiveSessionManager({
    home,
    modelCatalog,
    modelRuntime,
    sessionRepository,
    threadCatalog,
  });
  let listener: SessionListener | undefined;
  const unsubscribe = vi.fn<() => undefined>();
  const completion = Promise.withResolvers<undefined>();
  const prompt = vi.fn<AgentSession["prompt"]>(async () => {
    await completion.promise;
  });
  const abort = vi.fn<AgentSession["abort"]>(() => {
    completion.resolve();
    return Promise.resolve();
  });
  const session: AgentSession = Object.create(AgentSession.prototype);
  Object.defineProperties(session, {
    abort: { value: abort },
    isStreaming: { value: false },
    model: { configurable: true, value: undefined },
    prompt: { value: prompt },
    sessionManager: { value: sessionManager },
    subscribe: {
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Pi exposes session events through a synchronous subscriber callback.
      value: (callback: SessionListener) => {
        listener = callback;
        return unsubscribe;
      },
    },
    thinkingLevel: { configurable: true, value: "off" },
  });
  mocks.createSession.mockResolvedValue({
    extensionsResult: {
      errors: [],
      extensions: [],
      runtime: createExtensionRuntime(),
    },
    session,
  });
  const notifications: ServerNotification[] = [];
  const connection = createConnection(notifications);
  return {
    abort,
    completion,
    connection,
    database,
    emit: (event: AgentSessionEvent) => listener?.(event),
    manager,
    modelCatalog,
    modelRuntime,
    notifications,
    prompt,
    session,
    sessionManager,
    sessionRepository,
    threadCatalog,
    unsubscribe,
  };
};

const assistantEnd = (
  stopReason: "stop" | "error" | "aborted"
): AgentSessionEvent => ({
  message: {
    api: "openai-responses",
    content: [],
    errorMessage: stopReason === "error" ? "Provider failed" : undefined,
    model: "synthetic",
    provider: "synthetic",
    role: "assistant",
    stopReason,
    timestamp: 1,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  },
  type: "message_end",
});

describe("Pi live turn lifecycle", () => {
  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    vi.restoreAllMocks();
    mocks.createSession.mockReset();
  });

  it("announces native activity to desktop before the conversation has a subscriber", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-background-owner-"));
    const f = fixture(home);
    const presence = new PiSessionPresence(home);
    const turn = emptyTurn();
    const host = new SessionOwnerHost({
      handle: () => Promise.resolve(turn),
      home,
      snapshot: () => ({ historyTurnCount: 0, turn }),
      threadId: "thread",
    });
    try {
      await host.start();
      await presence.start("thread");
      await f.manager.observeRuntime(f.connection, new Set(["thread"]));
      expect(f.notifications).toStrictEqual([
        {
          method: "thread/status/changed",
          params: {
            status: { activeFlags: [], type: "active" },
            threadId: "thread",
          },
        },
      ]);
      turn.status = "completed";
      host.publish({
        method: "turn/completed",
        params: { threadId: "thread", turn },
      });
      await vi.waitFor(() =>
        expect(f.notifications.at(-1)).toMatchObject({
          method: "thread/status/changed",
          params: { status: { type: "idle" } },
        })
      );
      expect(f.notifications).toHaveLength(2);
      expect(f.manager.loadedList({}).data).toStrictEqual(["thread"]);
      f.manager.detachConnection(f.connection);
      expect(f.manager.loadedList({}).data).toStrictEqual([]);
    } finally {
      f.manager.close();
      await presence.stop();
      await host.stop();
      await rm(home, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "delivers completion before an idle subscriber detaches, legacy owner=%s",
    async (legacy) => {
      const home = await mkdtemp(path.join(tmpdir(), "pi-idle-detach-"));
      const f = fixture(home);
      const turn = emptyTurn();
      const host = new SessionOwnerHost({
        handle: () => Promise.resolve(turn),
        home,
        snapshot: () => ({ historyTurnCount: 0, turn }),
        threadId: "thread",
      });
      const received: ServerNotification[] = [];
      const connection = new JsonRpcConnection({
        clientId: "idle-detach",
        logger: appServerLogger,
        transport: new RemoteClientTransport((message) => {
          const notification = parseServerNotification(
            parseCodexWireMessage(message)
          );
          received.push(notification);
          if (
            notification.method === "thread/status/changed" &&
            notification.params.status.type === "idle"
          ) {
            f.manager.detachConnection(connection);
          }
          return Promise.resolve();
        }),
      });
      try {
        await host.start();
        f.manager.rebindConnection("thread", connection);
        await f.manager.attachOwner("thread");
        host.publish({
          method: "turn/started",
          params: { threadId: "thread", turn },
        });
        await vi.waitFor(() =>
          expect(received.at(-1)?.method).toBe("turn/started")
        );
        turn.status = "completed";
        if (legacy) {
          host.publish({
            method: "thread/status/changed",
            params: { status: { type: "idle" }, threadId: "thread" },
          });
        }
        host.publish({
          method: "turn/completed",
          params: { threadId: "thread", turn },
        });
        await vi.waitFor(() =>
          expect(received.at(-1)).toMatchObject({
            method: "thread/status/changed",
            params: { status: { type: "idle" } },
          })
        );
        expect(received.at(-2)).toMatchObject({
          method: "turn/completed",
          params: { turn: { id: turn.id, status: "completed" } },
        });
      } finally {
        connection.close();
        f.manager.close();
        await host.stop();
        await rm(home, { force: true, recursive: true });
      }
    }
  );

  it("delegates to the TUI owner without creating a second SDK runtime", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-owner-manager-"));
    const f = fixture(home);
    const turn = emptyTurn();
    const host = new SessionOwnerHost({
      handle: () => {
        host.publish({
          method: "turn/started",
          params: { threadId: "thread", turn },
        });
        return Promise.resolve(turn);
      },
      home,
      snapshot: () => ({ historyTurnCount: 0, turn }),
      threadId: "thread",
    });
    const otherNotifications: ServerNotification[] = [];
    const other = createConnection(otherNotifications);
    try {
      await host.start();
      f.manager.rebindConnection("thread", other);
      await expect(
        f.manager.startTurn({ input: [], threadId: "thread" }, f.connection)
      ).resolves.toMatchObject({ id: turn.id });
      await vi.waitFor(() =>
        expect(otherNotifications.at(-1)?.method).toBe("turn/started")
      );
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.manager.isWorking("thread")).toBeTruthy();
    } finally {
      f.manager.close();
      await host.stop();
      await rm(home, { force: true, recursive: true });
    }
  });

  it("reconnects a subscribed client after the TUI owner channel is replaced", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-replaced-owner-"));
    const f = fixture(home);
    const turn = emptyTurn();
    turn.items.push({
      delivery: null,
      id: "reply",
      memoryCitation: null,
      phase: null,
      questions: null,
      text: "recovered reply",
      type: "agentMessage",
    });
    let host = new SessionOwnerHost({
      handle: () => Promise.resolve(turn),
      home,
      snapshot: () => ({ historyTurnCount: 0, turn }),
      threadId: "thread",
    });
    try {
      await host.start();
      f.manager.rebindConnection("thread", f.connection);
      await f.manager.attachOwner("thread");
      await host.stop();
      await vi.waitFor(() =>
        expect(f.notifications.at(-2)?.method).toBe("turn/completed")
      );
      turn.status = "completed";
      host = new SessionOwnerHost({
        handle: () => Promise.resolve(turn),
        home,
        snapshot: () => ({ historyTurnCount: 0, turn }),
        threadId: "thread",
      });
      await host.start();
      await vi.waitFor(
        () =>
          expect(f.notifications.at(-2)).toMatchObject({
            method: "turn/completed",
            params: { turn: { id: turn.id, status: "completed" } },
          }),
        { timeout: 2500 }
      );
      expect(f.notifications).toContainEqual(
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({
              id: "reply",
              text: "recovered reply",
            }),
          }),
        })
      );
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      f.manager.close();
      await host.stop();
      await rm(home, { force: true, recursive: true });
    }
  });

  it("blocks remote writes to an older TUI that has not loaded its owner channel", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-old-owner-"));
    const f = fixture(home);
    try {
      await mkdir(path.join(home, "presence"));
      await writeFile(
        path.join(home, "presence", "tui.json"),
        JSON.stringify({
          pid: process.pid,
          threadId: "thread",
          touchedAt: Date.now(),
        })
      );
      await expect(
        f.manager.startTurn({ input: [], threadId: "thread" }, f.connection)
      ).rejects.toThrow("Run /reload");
      await expect(f.manager.deletionLease("thread")).rejects.toThrow(
        "Close the Pi TUI"
      );
      await expect(f.manager.setName("thread", "name")).rejects.toThrow(
        "Reload the Pi TUI"
      );
      expect(mocks.createSession).not.toHaveBeenCalled();
    } finally {
      f.manager.close();
      await rm(home, { force: true, recursive: true });
    }
  });

  it("starts, reads, resumes, and runs a new thread before Pi persists its history", async () => {
    const f = fixture();
    const model = {
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      contextWindow: 1000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "test",
      input: ["text"],
      maxTokens: 1000,
      name: "Test",
      provider: "test",
      reasoning: false,
    } as const;
    vi.spyOn(f.modelCatalog, "resolve").mockReturnValue({
      ...model,
      input: ["text"],
    });
    Object.defineProperties(f.session, {
      dispose: { value: vi.fn<AgentSession["dispose"]>() },
      model: { value: model },
      sessionFile: { value: undefined },
      sessionId: { value: f.sessionManager.getSessionId() },
      setThinkingLevel: { value: () => {} },
      steer: {
        value: (text: string) => {
          f.sessionManager.appendMessage({
            content: text,
            role: "user",
            timestamp: 2,
          });
          return Promise.resolve();
        },
      },
      thinkingLevel: { value: "off" },
    });
    const server = new AppServer({
      config: {
        autoStart: false,
        hostName: "test",
        listenUrl: new URL("ws://127.0.0.1:0"),
        paths: {
          database: ":memory:",
          endpoint: "/synthetic/endpoint.json",
          home: "/synthetic",
          logs: "/synthetic/logs",
        },
        piAgentDir: "/synthetic",
        remoteControl: {
          baseUrl: new URL("https://example.invalid"),
          enabled: false,
        },
      },
      database: f.database,
      liveSessionManager: f.manager,
      modelCatalog: f.modelCatalog,
      modelRuntime: f.modelRuntime,
      sessionRepository: f.sessionRepository,
      threadCatalog: f.threadCatalog,
    });
    const output: ReturnType<typeof parseCodexWireMessage>[] = [];
    const threadId = f.sessionManager.getSessionId();
    const connection = new JsonRpcConnection({
      clientId: "new-thread",
      logger: appServerLogger,
      transport: {
        close: () => {},
        read: async function* read() {
          yield JSON.stringify({
            id: 0,
            method: "initialize",
            params: { clientInfo: { name: "test", version: "1" } },
          });
          yield JSON.stringify({
            id: 1,
            method: "thread/start",
            params: { cwd: "/synthetic", ephemeral: true },
          });
          yield JSON.stringify({
            id: 2,
            method: "thread/read",
            params: { includeTurns: true, threadId },
          });
          yield JSON.stringify({
            id: 3,
            method: "thread/resume",
            params: { threadId },
          });
          yield JSON.stringify({
            id: 4,
            method: "turn/start",
            params: {
              input: [{ text: "hello", text_elements: [], type: "text" }],
              threadId,
            },
          });
          yield JSON.stringify({
            id: 7,
            method: "thread/settings/update",
            params: {
              approvalPolicy: "never",
              effort: "off",
              model: "test/test",
              threadId,
            },
          });
          const active = output.find(
            (message) => message.method === "turn/started"
          );
          const notification = active
            ? parseServerNotification(active)
            : undefined;
          const turnId =
            notification?.method === "turn/started"
              ? notification.params.turn.id
              : undefined;
          yield JSON.stringify({
            id: 8,
            method: "turn/steer",
            params: {
              expectedTurnId: turnId,
              input: [{ text: "steer", text_elements: [], type: "text" }],
              threadId,
            },
          });
          yield JSON.stringify({
            id: 9,
            method: "thread/backgroundTerminals/list",
            params: { threadId },
          });
          f.completion.resolve();
          await vi.waitFor(() =>
            expect(output).toContainEqual(
              expect.objectContaining({ method: "turn/completed" })
            )
          );
          yield JSON.stringify({
            id: 5,
            method: "thread/delete",
            params: { threadId },
          });
          yield JSON.stringify({
            id: 6,
            method: "thread/loaded/list",
            params: {},
          });
        },
        send: (message) => {
          output.push(parseCodexWireMessage(message));
          return Promise.resolve();
        },
      },
    });
    server.register(connection);
    await connection.run();
    for (const id of [1, 2, 3, 4, 5, 7, 8]) {
      expect(output).toContainEqual(
        expect.objectContaining({ id, result: expect.anything() })
      );
    }
    expect(output).toContainEqual({
      id: 9,
      result: { data: [], nextCursor: null },
    });
    expect(f.sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: "steer", role: "user" }),
        type: "message",
      })
    );
    expect(output).toContainEqual({
      id: 6,
      result: { data: [], nextCursor: null },
    });
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith("hello", {
      images: [],
      source: "rpc",
    });
  });

  it("releases daemon ownership when turn preflight rejects the selected model", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-rejected-preflight-"));
    const f = fixture(home);
    Object.defineProperty(f.session, "dispose", {
      value: vi.fn<AgentSession["dispose"]>(),
    });
    vi.spyOn(f.modelCatalog, "resolve").mockImplementation(
      vi.fn<PiModelCatalog["resolve"]>()
    );
    try {
      await expect(
        f.manager.startTurn(
          { input: [], model: "missing/model", threadId: "thread" },
          f.connection
        )
      ).rejects.toThrow("Unknown Pi model");
      const release = await f.manager.deletionLease("thread");
      await release();
      expect(f.manager.loadedList({}).data).toStrictEqual([]);
    } finally {
      f.manager.close();
      await rm(home, { force: true, recursive: true });
    }
  });

  it("waits for turn cleanup before acquiring a settings writer", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pi-settings-cleanup-"));
    const f = fixture(home);
    const disposed = Promise.withResolvers<undefined>();
    const model = {
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      contextWindow: 1000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "next",
      input: ["text"],
      maxTokens: 1000,
      name: "Next",
      provider: "test",
      reasoning: false,
    } as const;
    const noOwner = await f.manager.attachOwner("thread");
    vi.spyOn(f.manager, "attachOwner").mockResolvedValue(noOwner);
    vi.spyOn(f.modelCatalog, "resolve").mockReturnValue({
      ...model,
      input: ["text"],
    });
    Object.defineProperties(f.session, {
      dispose: { value: () => disposed.resolve() },
      setModel: {
        value: () =>
          Promise.reject(
            new Error("Disposed Pi runtime must not write settings")
          ),
      },
    });
    const nextSession: AgentSession = Object.create(AgentSession.prototype);
    let selected: AgentSession["model"];
    Object.defineProperties(nextSession, {
      dispose: { value: () => {} },
      isStreaming: { value: false },
      model: { get: () => selected },
      sessionFile: { value: undefined },
      sessionManager: { value: f.sessionManager },
      setModel: {
        value: (value: NonNullable<AgentSession["model"]>) => {
          selected = value;
          f.sessionManager.appendModelChange(value.provider, value.id);
          return Promise.resolve();
        },
      },
      thinkingLevel: { value: "off" },
    });
    try {
      await f.manager.startTurn(
        { input: [], threadId: "thread" },
        f.connection
      );
      mocks.createSession.mockResolvedValue({
        extensionsResult: {
          errors: [],
          extensions: [],
          runtime: createExtensionRuntime(),
        },
        session: nextSession,
      });
      f.completion.resolve();
      await disposed.promise;
      await expect(
        f.manager.updateSettings({ model: "test/next", threadId: "thread" })
      ).resolves.toBeUndefined();
      expect(f.sessionManager.buildSessionContext().model).toStrictEqual({
        modelId: "next",
        provider: "test",
      });
      const release = await f.manager.deletionLease("thread");
      await release();
    } finally {
      f.manager.close();
      await rm(home, { force: true, recursive: true });
    }
  });

  it("persists accepted identities when the daemon owns execution", async () => {
    const f = fixture();
    f.prompt.mockImplementation(async () => {
      f.sessionManager.appendMessage({
        content: "synthetic input",
        role: "user",
        timestamp: 1,
      });
      await f.completion.promise;
      const event = assistantEnd("stop");
      if (event.type === "message_end" && event.message.role === "assistant") {
        f.sessionManager.appendMessage(event.message);
      }
    });
    const turn = await f.manager.startTurn(
      {
        clientUserMessageId: "sdk-client",
        input: [{ text: "synthetic input", text_elements: [], type: "text" }],
        threadId: "thread",
      },
      f.connection
    );
    const duplicate = await f.manager.startTurn(
      {
        clientUserMessageId: "sdk-client",
        input: [{ text: "synthetic input", text_elements: [], type: "text" }],
        threadId: "thread",
      },
      f.connection
    );
    expect({
      executions: f.prompt.mock.calls.length,
      id: duplicate.id,
    }).toStrictEqual({ executions: 1, id: turn.id });
    f.completion.resolve();
    await vi.waitFor(() =>
      expect(f.notifications.at(-1)).toMatchObject({
        method: "thread/status/changed",
        params: { status: { type: "idle" } },
      })
    );
    expect(
      projectPiConversation(f.sessionManager.getBranch(), "/synthetic")
    ).toMatchObject([
      {
        id: turn.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            clientId: "sdk-client",
            type: "userMessage",
          }),
        ]),
      },
    ]);
    vi.spyOn(f.session, "dispose").mockImplementation(() => {});
    f.manager.unload("thread");
    const count = f.notifications.length;
    const replay = await f.manager.startTurn(
      {
        clientUserMessageId: "sdk-client",
        input: [{ text: "synthetic input", text_elements: [], type: "text" }],
        threadId: "thread",
      },
      f.connection
    );
    await expect(
      f.manager.steer({
        clientUserMessageId: "sdk-client",
        expectedTurnId: turn.id,
        input: [{ text: "synthetic input", text_elements: [], type: "text" }],
        threadId: "thread",
      })
    ).resolves.toStrictEqual({ turnId: turn.id });
    expect({
      events: f.notifications.length,
      executions: f.prompt.mock.calls.length,
      replay,
    }).toMatchObject({
      events: count,
      executions: 1,
      replay: { id: turn.id, status: "completed" },
    });
  });

  it("reports prompt rejection as failed with its error", async () => {
    const { completion, connection, manager, notifications, unsubscribe } =
      fixture();
    await manager.startTurn(
      {
        input: [{ text: "hello", text_elements: [], type: "text" }],
        threadId: "thread",
      },
      connection
    );
    completion.reject(new Error("No credentials"));
    await vi.waitFor(() =>
      expect(notifications.at(-2)).toMatchObject({
        method: "turn/completed",
        params: {
          turn: { error: { message: "No credentials" }, status: "failed" },
        },
      })
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["stop", "error", "aborted"] as const)(
    "projects the final assistant stop reason %s",
    async (stopReason) => {
      const { completion, connection, emit, manager, notifications } =
        fixture();
      await manager.startTurn({ input: [], threadId: "thread" }, connection);
      emit(assistantEnd(stopReason));
      completion.resolve();
      const status = {
        aborted: "interrupted",
        error: "failed",
        stop: "completed",
      }[stopReason];
      await vi.waitFor(() =>
        expect(notifications.at(-2)).toMatchObject({
          method: "turn/completed",
          params: { turn: { status } },
        })
      );
      expect(notifications.at(-2)).toMatchObject({
        params: {
          turn: {
            error:
              stopReason === "error" ? { message: "Provider failed" } : null,
          },
        },
      });
    }
  );

  it("reports cancellation as interrupted when Pi resolves abort normally", async () => {
    const { abort, connection, manager, notifications } = fixture();
    const turn = await manager.startTurn(
      { input: [], threadId: "thread" },
      connection
    );
    await manager.interrupt("thread", turn.id);
    await vi.waitFor(() =>
      expect(notifications.at(-2)).toMatchObject({
        params: { turn: { error: null, status: "interrupted" } },
      })
    );
    expect(abort).toHaveBeenCalledOnce();
  });

  it("reports success after Pi recovers from a failed model attempt", async () => {
    const { completion, connection, emit, manager, notifications } = fixture();
    await manager.startTurn({ input: [], threadId: "thread" }, connection);
    emit(assistantEnd("error"));
    emit(assistantEnd("stop"));
    completion.resolve();
    await vi.waitFor(() =>
      expect(notifications.at(-2)).toMatchObject({
        method: "turn/completed",
        params: { turn: { error: null, status: "completed" } },
      })
    );
  });

  it("delivers completion to both attached connections and permits the next turn", async () => {
    const { completion, connection, manager, notifications } = fixture();
    await manager.startTurn({ input: [], threadId: "thread" }, connection);
    const resumedNotifications: ServerNotification[] = [];
    const resumed = createConnection(resumedNotifications);
    manager.rebindConnection("thread", resumed);
    completion.resolve();
    await vi.waitFor(() =>
      expect(resumedNotifications.at(-2)).toMatchObject({
        method: "turn/completed",
      })
    );
    expect(
      notifications.some(
        (notification) => notification.method === "turn/completed"
      )
    ).toBeTruthy();
    await expect(
      manager.startTurn({ input: [], threadId: "thread" }, resumed)
    ).resolves.toMatchObject({ status: "inProgress" });
  });

  it("keeps other subscribers attached when one disconnects", async () => {
    const f = fixture();
    const otherNotifications: ServerNotification[] = [];
    const other = createConnection(otherNotifications);
    await f.manager.startTurn({ input: [], threadId: "thread" }, f.connection);
    f.manager.rebindConnection("thread", other);
    f.connection.close();
    f.completion.resolve();
    await vi.waitFor(() =>
      expect(otherNotifications.at(-2)?.method).toBe("turn/completed")
    );
    expect(
      f.notifications.some(
        (notification) => notification.method === "turn/completed"
      )
    ).toBeFalsy();
  });

  it.each([false, true])(
    "resumes a live turn with stable item IDs after events hit a closed stream, paginated=%s",
    async (paginated) => {
      const {
        completion,
        connection,
        database,
        emit,
        manager,
        modelCatalog,
        modelRuntime,
        notifications,
        sessionManager,
        sessionRepository,
        threadCatalog,
      } = fixture();
      const historicalId = sessionManager.appendMessage({
        content: "previous",
        role: "user",
        timestamp: 0,
      });
      const turn = await manager.startTurn(
        { input: [], threadId: "thread" },
        connection
      );
      connection.close();
      const final = assistantEnd("stop");
      if (final.type !== "message_end" || final.message.role !== "assistant") {
        throw new Error("Expected assistant message fixture");
      }
      const partial = final.message;
      emit({
        assistantMessageEvent: { contentIndex: 0, partial, type: "text_start" },
        message: partial,
        type: "message_update",
      });
      emit({
        assistantMessageEvent: {
          contentIndex: 0,
          delta: "before resume",
          partial,
          type: "text_delta",
        },
        message: partial,
        type: "message_update",
      });
      const thread: Thread = {
        agentNickname: null,
        agentRole: null,
        canAcceptDirectInput: true,
        cliVersion: "test",
        createdAt: 0,
        cwd: "/synthetic",
        daybreakEnabled: null,
        environments: null,
        ephemeral: true,
        extra: null,
        forkedFromId: null,
        gitInfo: null,
        historyMode: "legacy",
        id: "thread",
        model: null,
        modelProvider: "pi",
        name: null,
        originator: null,
        parentThreadId: null,
        path: null,
        preview: "previous",
        projectId: null,
        reasoningEffort: null,
        recencyAt: 0,
        section: null,
        sectionEnteredAt: null,
        sessionId: "thread",
        source: { custom: "pi" },
        status: { type: "idle" },
        threadSource: "pi",
        turns: [],
        updatedAt: 0,
      };
      thread.turns = [
        {
          ...structuredClone(turn),
          id: historicalId,
          items: [],
          status: "completed",
        },
        { ...structuredClone(turn), id: "projected-live-id", items: [] },
      ];
      vi.spyOn(threadCatalog, "read").mockResolvedValue(thread);
      const config: AppServerConfig = {
        autoStart: false,
        hostName: "test",
        listenUrl: new URL("ws://127.0.0.1:0"),
        paths: {
          database: ":memory:",
          endpoint: "/synthetic/endpoint.json",
          home: "/synthetic",
          logs: "/synthetic/logs",
        },
        piAgentDir: "/synthetic",
        remoteControl: {
          baseUrl: new URL("https://example.invalid/"),
          enabled: false,
        },
      };
      const server = new AppServer({
        config,
        database,
        liveSessionManager: manager,
        modelCatalog,
        modelRuntime,
        sessionRepository,
        threadCatalog,
      });
      const input = new AsyncMessageQueue();
      const output: ReturnType<typeof parseCodexWireMessage>[] = [];
      const resumed = new JsonRpcConnection({
        clientId: "resumed",
        logger: appServerLogger,
        transport: {
          close: () => input.close(),
          read: () => input,
          send: (message) => {
            output.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      server.register(resumed);
      const running = resumed.run();
      try {
        input.push(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "test", version: "1" } },
          })
        );
        await vi.waitFor(() => expect(output).toHaveLength(1));
        const resumeParams: ThreadResumeParams = { threadId: "thread" };
        if (paginated) {
          resumeParams.excludeTurns = true;
          resumeParams.initialTurnsPage = {
            itemsView: "full",
            limit: 1,
            sortDirection: "desc",
          };
        }
        input.push(
          JSON.stringify({
            id: 2,
            method: "thread/resume",
            params: resumeParams,
          })
        );
        await vi.waitFor(() => expect(output).toHaveLength(2));
        const itemId = turn.items.find(
          (item) => item.type === "agentMessage"
        )?.id;
        expect(itemId).toStrictEqual(expect.any(String));
        const expectedLiveTurn = {
          id: turn.id,
          items: [
            { type: "userMessage" },
            { id: itemId, text: "before resume", type: "agentMessage" },
          ],
          status: "inProgress",
        };
        const cursor = expect.any(String);
        const expectedResponse = {
          initialTurnsPage: paginated
            ? { data: [expectedLiveTurn], nextCursor: cursor }
            : null,
          thread: {
            status: { type: "active" },
            turns: paginated ? [] : [{ id: historicalId }, expectedLiveTurn],
          },
        };
        expect(output[1]).toMatchObject({ id: 2, result: expectedResponse });
        emit({
          assistantMessageEvent: {
            contentIndex: 0,
            delta: " after resume",
            partial,
            type: "text_delta",
          },
          message: partial,
          type: "message_update",
        });
        completion.resolve();
        await vi.waitFor(() =>
          expect(output.at(-2)).toMatchObject({ method: "turn/completed" })
        );
        expect(output[2]).toMatchObject({
          method: "item/agentMessage/delta",
          params: { delta: " after resume", itemId, turnId: turn.id },
        });
        expect(
          notifications.some(
            (notification) =>
              notification.method === "item/started" &&
              notification.params.item.type === "agentMessage"
          )
        ).toBeFalsy();
      } finally {
        resumed.close();
        await running;
      }
    }
  );
});
