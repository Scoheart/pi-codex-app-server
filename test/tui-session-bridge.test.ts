import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  setImmediate as nextTick,
  setTimeout as delay,
} from "node:timers/promises";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { TuiSessionBridge } from "../src/extension/tui-session-bridge.js";
import { projectPiConversation } from "../src/pi/conversation-projector.js";
import { SessionOwnerClient } from "../src/pi/session-owner-client.js";
import {
  acquireSessionLease,
  descriptorSchema,
  ownerPath,
} from "../src/pi/session-owner.js";
import type { ServerNotification } from "../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";

const cleanup: (() => Promise<void>)[] = [];
const response = (): AssistantMessage => ({
  api: "openai-completions",
  content: [{ text: "", type: "text" }],
  model: "gpt-4o",
  provider: "openai",
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 1,
    output: 1,
    totalTokens: 2,
  },
});
const fixture = async (
  persistent = false,
  laterInput?: () => Promise<void>
) => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-owner-test-"));
  cleanup.push(() => rm(home, { force: true, recursive: true }));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(home, "auth.json"),
    modelsPath: null,
  });
  const model = modelRuntime.getModel("openai", "gpt-4o");
  if (!model) {
    throw new Error("Missing synthetic model");
  }
  await modelRuntime.setRuntimeApiKey("openai", "synthetic-test-key");
  const settings = SettingsManager.inMemory({});
  let bridge: TuiSessionBridge | undefined;
  let context: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    agentDir: home,
    cwd: home,
    extensionFactories: [
      (pi) => {
        bridge = new TuiSessionBridge(pi, home);
        pi.on("session_start", async (_event, ctx) => {
          context = ctx;
          await bridge?.start(ctx);
        });
        pi.on("input", (event, ctx) => bridge?.guardInput(event, ctx));
        pi.on("input", () => laterInput?.());
        pi.on("before_agent_start", (_event, ctx) =>
          bridge?.beforeAgentStart(ctx)
        );
        pi.on("agent_start", (event) => bridge?.event(event));
        pi.on("message_start", (event) => bridge?.event(event));
        pi.on("message_update", (event) => bridge?.event(event));
        pi.on("message_end", (event) => bridge?.event(event));
        pi.on("agent_settled", (event) => bridge?.event(event));
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    settingsManager: settings,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    agentDir: home,
    cwd: home,
    model,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: persistent
      ? SessionManager.create(home, path.join(home, "sessions"))
      : SessionManager.inMemory(home),
    settingsManager: settings,
    tools: [],
  });
  cleanup.push(async () => {
    await bridge?.stop();
    session.dispose();
  });
  const streams: AssistantMessageEventStream[] = [];
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        stream.push({
          error: { ...response(), stopReason: "aborted" },
          reason: "aborted",
          type: "error",
        });
      },
      { once: true }
    );
    streams.push(stream);
    return stream;
  };
  await session.bindExtensions({
    abortHandler: () => {
      void session.abort();
    },
    mode: "tui",
  });
  const events: ServerNotification[][] = [[], []];
  const clients: SessionOwnerClient[] = [];
  for (const notifications of events) {
    // eslint-disable-next-line no-await-in-loop -- Establish each subscriber before registering its dependent cleanup.
    const client = await SessionOwnerClient.connect(
      home,
      session.sessionId,
      (event) => notifications.push(event),
      () => {}
    );
    if (!client) {
      throw new Error("Missing session owner");
    }
    clients.push(client);
    cleanup.push(() => {
      client.close();
      return Promise.resolve();
    });
  }
  return {
    bridge,
    clients,
    context,
    events,
    home,
    modelRuntime,
    session,
    streams,
  };
};
const streamText = (
  stream: AssistantMessageEventStream,
  text: string
): AssistantMessage => {
  const partial = response();
  stream.push({ partial, type: "start" });
  stream.push({ contentIndex: 0, partial, type: "text_start" });
  partial.content = [{ text, type: "text" }];
  stream.push({ contentIndex: 0, delta: text, partial, type: "text_delta" });
  return partial;
};
const complete = (
  stream: AssistantMessageEventStream,
  partial: AssistantMessage
): void => {
  const [content] = partial.content;
  if (content?.type !== "text") {
    throw new Error("Expected text response");
  }
  stream.push({
    content: content.text,
    contentIndex: 0,
    partial,
    type: "text_end",
  });
  stream.push({ message: partial, reason: "stop", type: "done" });
};

describe("TUI session bridge", () => {
  afterEach(async () => {
    // eslint-disable-next-line no-await-in-loop -- Sockets and leases must close before removing their temporary directories.
    for (const close of cleanup.splice(0).toReversed()) {
      // eslint-disable-next-line no-await-in-loop -- Dependent cleanup releases sockets before leases and directories.
      await close();
    }
  });

  it("publishes runtime status so desktop can discover background work and clear its busy indicator", async () => {
    const f = await fixture();
    const native = f.session.prompt("background work");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const [stream] = f.streams;
    if (!stream) {
      throw new Error("Missing provider stream");
    }
    complete(stream, streamText(stream, "finished"));
    await native;
    await vi.waitFor(() =>
      expect(f.clients[0]?.snapshot.turn?.status).toBe("completed")
    );
    const statuses = f.events[0]?.filter(
      (event) => event.method === "thread/status/changed"
    );
    expect(statuses).toStrictEqual([
      {
        method: "thread/status/changed",
        params: {
          status: { activeFlags: [], type: "active" },
          threadId: f.session.sessionId,
        },
      },
      {
        method: "thread/status/changed",
        params: { status: { type: "idle" }, threadId: f.session.sessionId },
      },
    ]);
  });

  it("streams native TUI input and remote input to both clients with one Pi runtime", async () => {
    const f = await fixture();
    const native = f.session.prompt("native input");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const [first] = f.streams;
    if (!first) {
      throw new Error("Missing provider stream");
    }
    const partial = streamText(first, "native response");
    await vi.waitFor(() => {
      for (const events of f.events) {
        expect(events).toContainEqual(
          expect.objectContaining({
            method: "item/agentMessage/delta",
            params: expect.objectContaining({ delta: "native response" }),
          })
        );
      }
    });
    expect(f.context?.isIdle()).toBeFalsy();
    complete(first, partial);
    await native;
    await vi.waitFor(() => {
      for (const events of f.events) {
        expect(events.at(-2)?.method).toBe("turn/completed");
        expect(events.at(-1)).toMatchObject({
          method: "thread/status/changed",
          params: { status: { type: "idle" } },
        });
      }
    });
    const result = await f.clients[0]?.request({
      id: 1,
      method: "turn/start",
      params: {
        clientUserMessageId: "remote-input",
        input: [{ text: "remote input", text_elements: [], type: "text" }],
        threadId: f.session.sessionId,
      },
    });
    expect(result).toMatchObject({ status: "inProgress" });
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    const [, second] = f.streams;
    if (!second) {
      throw new Error("Missing second provider stream");
    }
    const reply = streamText(second, "remote response");
    await vi.waitFor(() => {
      for (const events of f.events) {
        expect(events).toContainEqual(
          expect.objectContaining({
            method: "item/agentMessage/delta",
            params: expect.objectContaining({ delta: "remote response" }),
          })
        );
      }
    });
    complete(second, reply);
    await vi.waitFor(() => {
      for (const client of f.clients) {
        expect(client.snapshot.turn?.status).toBe("completed");
      }
    });
    const users = f.session.sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "message" && entry.message.role === "user"
      );
    expect(users).toHaveLength(2);
    for (const events of f.events) {
      expect(
        events.filter(
          (event) =>
            event.method === "item/completed" &&
            event.params.item.type === "userMessage"
        )
      ).toHaveLength(2);
    }
    expect(f.events[0]).toStrictEqual(f.events[1]);
  });

  it.each([false, true])(
    "preserves accepted message identities after reopening JSONL without an owner snapshot, aborted=%s",
    async (aborted) => {
      const f = await fixture(true);
      const result = await f.clients[0]?.request({
        id: 1,
        method: "turn/start",
        params: {
          clientUserMessageId: "accepted-client",
          input: [{ text: "synthetic input", text_elements: [], type: "text" }],
          threadId: f.session.sessionId,
        },
      });
      const duplicate = await f.clients[1]?.request({
        id: 2,
        method: "turn/start",
        params: {
          clientUserMessageId: "accepted-client",
          input: [{ text: "synthetic input", text_elements: [], type: "text" }],
          threadId: f.session.sessionId,
        },
      });
      expect(duplicate).toMatchObject({ id: f.clients[0]?.snapshot.turn?.id });
      await vi.waitFor(() => expect(f.streams).toHaveLength(1));
      const [stream] = f.streams;
      if (!stream) {
        throw new Error("Missing synthetic stream");
      }
      const partial = streamText(stream, "synthetic reply");
      if (aborted) {
        await f.session.abort();
      } else {
        complete(stream, partial);
      }
      await vi.waitFor(() =>
        expect(f.clients[0]?.snapshot.turn?.status).toBe(
          aborted ? "interrupted" : "completed"
        )
      );
      const file = f.session.sessionManager.getSessionFile();
      if (!file) {
        throw new Error("Missing session file");
      }
      const reopened = projectPiConversation(
        SessionManager.open(file).getBranch(),
        f.home
      );
      const live = f.clients[0]?.snapshot.turn;
      expect(result).toMatchObject({ id: reopened.at(-1)?.id });
      expect(reopened.at(-1)).toMatchObject({
        id: live?.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            clientId: "accepted-client",
            type: "userMessage",
          }),
        ]),
        rootTurnId: live?.rootTurnId,
      });
      expect(
        reopened.at(-1)?.items.filter((item) => item.type === "userMessage")
      ).toStrictEqual(
        live?.items.filter((item) => item.type === "userMessage")
      );
      f.bridge?.refresh();
      const eventCount = f.events[0]?.length;
      const replay = await f.clients[0]?.request({
        id: 3,
        method: "turn/start",
        params: {
          clientUserMessageId: "accepted-client",
          input: [{ text: "synthetic input", text_elements: [], type: "text" }],
          threadId: f.session.sessionId,
        },
      });
      expect({
        events: f.events[0]?.length,
        executions: f.streams.length,
        replay,
      }).toMatchObject({
        events: eventCount,
        executions: 1,
        replay: { id: live?.id, status: live?.status },
      });
    }
  );

  it("rejects a second writer and rejects stale turn steering", async () => {
    const f = await fixture();
    await expect(
      acquireSessionLease(f.home, f.session.sessionId)
    ).rejects.toThrow("Lock file is already being held");
    await expect(
      f.clients[0]?.request({
        id: 2,
        method: "turn/steer",
        params: {
          expectedTurnId: "stale",
          input: [],
          threadId: f.session.sessionId,
        },
      })
    ).rejects.toThrow("Active Pi turn changed");
  });

  it("reconnects with stable partial item IDs while the native owner continues", async () => {
    const f = await fixture();
    const native = f.session.prompt("keep running");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const [stream] = f.streams;
    if (!stream) {
      throw new Error("Missing provider stream");
    }
    const partial = streamText(stream, "partial");
    await vi.waitFor(() =>
      expect(
        f.clients[0]?.snapshot.turn?.items.some(
          (item) => item.type === "agentMessage" && item.text === "partial"
        )
      ).toBeTruthy()
    );
    const snapshot = structuredClone(f.clients[0]?.snapshot);
    f.clients[0]?.close();
    const reconnected = await SessionOwnerClient.connect(
      f.home,
      f.session.sessionId,
      () => {},
      () => {}
    );
    if (!reconnected) {
      throw new Error("Missing owner on reconnect");
    }
    cleanup.push(() => {
      reconnected.close();
      return Promise.resolve();
    });
    expect(reconnected.snapshot).toStrictEqual(snapshot);
    expect(f.context?.isIdle()).toBeFalsy();
    complete(stream, partial);
    await native;
    await vi.waitFor(() =>
      expect(reconnected.snapshot.turn?.status).toBe("completed")
    );
  });

  it("steers one active run and interrupts it from either subscriber", async () => {
    const f = await fixture();
    const native = f.session.prompt("first");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    await vi.waitFor(() =>
      expect(f.clients[0]?.snapshot.turn?.status).toBe("inProgress")
    );
    const turn = f.clients[0]?.snapshot.turn;
    const [stream] = f.streams;
    if (!turn || !stream) {
      throw new Error("Missing active turn");
    }
    // Mobile publishes its unchanged composer settings before sending a steer.
    await expect(
      f.clients[1]?.request({
        id: 2,
        method: "thread/settings/update",
        params: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          cwd: f.home,
          disabledPluginIds: [],
          effort: "off",
          model: "openai/gpt-4o",
          sandboxPolicy: { type: "dangerFullAccess" },
          serviceTier: null,
          summary: "auto",
          threadId: f.session.sessionId,
        },
      })
    ).resolves.toStrictEqual({});
    await f.clients[1]?.request({
      id: 3,
      method: "turn/steer",
      params: {
        clientUserMessageId: "steer-once",
        expectedTurnId: turn.id,
        input: [{ text: "steered", text_elements: [], type: "text" }],
        threadId: f.session.sessionId,
      },
    });
    await f.clients[0]?.request({
      id: 30,
      method: "turn/steer",
      params: {
        clientUserMessageId: "steer-once",
        expectedTurnId: turn.id,
        input: [{ text: "steered", text_elements: [], type: "text" }],
        threadId: f.session.sessionId,
      },
    });
    complete(stream, streamText(stream, "first response"));
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    await f.clients[0]?.request({
      id: 4,
      method: "turn/interrupt",
      params: { threadId: f.session.sessionId, turnId: turn.id },
    });
    await native;
    await vi.waitFor(() => {
      for (const client of f.clients) {
        expect(client.snapshot.turn?.status).toBe("interrupted");
      }
    });
    for (const client of f.clients) {
      expect(
        client.snapshot.turn?.items.filter(
          (item) => item.type === "userMessage"
        )
      ).toHaveLength(2);
    }
  });

  it("defers model changes until the next native prompt and persists the choice", async () => {
    const f = await fixture(true);
    const native = f.session.prompt("keep this model for the active turn");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const [first] = f.streams;
    if (!first) {
      throw new Error("Missing first stream");
    }
    await f.clients[0]?.request({
      id: 1,
      method: "thread/settings/update",
      params: {
        effort: "high",
        model: "openai/o3",
        threadId: f.session.sessionId,
      },
    });
    expect(f.session.model?.id).toBe("gpt-4o");
    complete(first, streamText(first, "first finished"));
    await native;
    if (!f.context) {
      throw new Error("Missing native context");
    }
    // Reloading the owner loses its in-memory state, but keeps the Pi session branch.
    await f.bridge?.start(f.context);
    const next = f.session.prompt("use the updated defaults");
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.session.model?.id).toBe("o3");
    expect(f.session.thinkingLevel).toBe("high");
    const [, second] = f.streams;
    if (!second) {
      throw new Error("Missing second stream");
    }
    const secondResponse = streamText(second, "second finished");
    secondResponse.model = "o3";
    complete(second, secondResponse);
    await next;
    const { sessionFile } = f.session;
    if (!sessionFile) {
      throw new Error("Missing persisted session");
    }
    const restored = SessionManager.open(sessionFile);
    expect(restored.buildSessionContext()).toMatchObject({
      model: { modelId: "o3", provider: "openai" },
      thinkingLevel: "high",
    });
  });

  it("rejects unsupported settings before changing the model", async () => {
    const f = await fixture();
    await expect(
      f.clients[0]?.request({
        id: 1,
        method: "thread/settings/update",
        params: {
          approvalPolicy: "on-request",
          model: "openai/o3",
          threadId: f.session.sessionId,
        },
      })
    ).rejects.toThrow(/approvalPolicy/u);
    expect(f.session.model?.id).toBe("gpt-4o");
    await expect(
      f.clients[0]?.request({
        id: 2,
        method: "thread/settings/update",
        params: {
          cwd: path.join(f.home, "other"),
          threadId: f.session.sessionId,
        },
      })
    ).rejects.toThrow(/new.*thread|new.*session/iu);
  });

  it("does not let unchanged steer settings override a later local model selection", async () => {
    const f = await fixture();
    const firstRun = f.session.prompt("first");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    await f.clients[0]?.request({
      id: 1,
      method: "thread/settings/update",
      params: {
        effort: "off",
        model: "openai/gpt-4o",
        threadId: f.session.sessionId,
      },
    });
    const [first] = f.streams;
    if (!first) {
      throw new Error("Missing first stream");
    }
    complete(first, streamText(first, "finished"));
    await firstRun;
    const model = f.context?.modelRegistry.find("openai", "o3");
    if (!model) {
      throw new Error("Missing next model");
    }
    await f.session.setModel(model);
    const next = f.session.prompt("native model selection wins");
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.session.model?.id).toBe("o3");
    const [, second] = f.streams;
    if (!second) {
      throw new Error("Missing next stream");
    }
    complete(second, streamText(second, "finished"));
    await next;
  });

  it("asks old TUI owners to reload without sending an uncertain settings command", async () => {
    const f = await fixture();
    const descriptorFile = `${ownerPath(f.home, f.session.sessionId)}.json`;
    const descriptor = descriptorSchema.parse(
      JSON.parse(await readFile(descriptorFile, "utf-8"))
    );
    await writeFile(
      descriptorFile,
      JSON.stringify({ ...descriptor, protocolVersion: 2 }),
      { mode: 0o600 }
    );
    const client = await SessionOwnerClient.connect(
      f.home,
      f.session.sessionId,
      () => {},
      () => {}
    );
    if (!client) {
      throw new Error("Missing legacy client");
    }
    try {
      await expect(
        client.request({
          id: 1,
          method: "thread/settings/update",
          params: { model: "openai/o3", threadId: f.session.sessionId },
        })
      ).rejects.toThrow(/reload/u);
      expect(f.session.model?.id).toBe("gpt-4o");
    } finally {
      client.close();
    }
  });

  it("holds native input while an idle remote model update is awaiting authentication", async () => {
    const f = await fixture();
    const authStarted = Promise.withResolvers<undefined>();
    const authReleased = Promise.withResolvers<undefined>();
    const checkAuth = f.modelRuntime.checkAuth.bind(f.modelRuntime);
    const check = vi
      .spyOn(f.modelRuntime, "checkAuth")
      .mockImplementation(async (...args) => {
        authStarted.resolve();
        await authReleased.promise;
        return await checkAuth(...args);
      });
    const settings = f.clients[0]?.request({
      id: 1,
      method: "thread/settings/update",
      params: {
        effort: "high",
        model: "openai/o3",
        threadId: f.session.sessionId,
      },
    });
    await authStarted.promise;
    let settled = false;
    const native = f.session
      .prompt("native input while settings are pending")
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() =>
        expect(settled || f.streams.length > 0).toBeTruthy()
      );
      expect(f.streams).toHaveLength(0);
    } finally {
      authReleased.resolve();
      await settings;
      check.mockRestore();
      await f.session.abort();
      await native;
    }
    expect(f.session.model?.id).toBe("o3");
    expect(f.session.thinkingLevel).toBe("high");
  });

  it("waits at the inference boundary after a later asynchronous input handler", async () => {
    const inputEntered = Promise.withResolvers<undefined>();
    const inputReleased = Promise.withResolvers<undefined>();
    const f = await fixture(false, async () => {
      inputEntered.resolve();
      await inputReleased.promise;
    });
    const native = f.session.prompt(
      "native prompt admitted before the remote update"
    );
    await inputEntered.promise;
    const authEntered = Promise.withResolvers<undefined>();
    const authReleased = Promise.withResolvers<undefined>();
    const checkAuth = f.modelRuntime.checkAuth.bind(f.modelRuntime);
    const check = vi
      .spyOn(f.modelRuntime, "checkAuth")
      .mockImplementation(async (...args) => {
        authEntered.resolve();
        await authReleased.promise;
        return await checkAuth(...args);
      });
    const settings = f.clients[0]?.request({
      id: 1,
      method: "thread/settings/update",
      params: {
        effort: "high",
        model: "openai/o3",
        threadId: f.session.sessionId,
      },
    });
    await authEntered.promise;
    inputReleased.resolve();
    try {
      await vi.waitFor(() => expect(f.session.isStreaming).toBeTruthy());
      await nextTick();
      expect(f.streams).toHaveLength(0);
    } finally {
      authReleased.resolve();
      await settings;
      check.mockRestore();
      await f.session.abort();
      await native;
    }
  });

  it("drains native settings preparation before releasing the writer on stop", async () => {
    const f = await fixture();
    const first = f.session.prompt("first");
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    await f.clients[0]?.request({
      id: 1,
      method: "thread/settings/update",
      params: {
        effort: "high",
        model: "openai/o3",
        threadId: f.session.sessionId,
      },
    });
    const [stream] = f.streams;
    if (!stream) {
      throw new Error("Missing stream");
    }
    complete(stream, streamText(stream, "first finished"));
    await first;
    const authEntered = Promise.withResolvers<undefined>();
    const authReleased = Promise.withResolvers<undefined>();
    const checkAuth = f.modelRuntime.checkAuth.bind(f.modelRuntime);
    const check = vi
      .spyOn(f.modelRuntime, "checkAuth")
      .mockImplementation(async (...args) => {
        authEntered.resolve();
        await authReleased.promise;
        return await checkAuth(...args);
      });
    const next = f.session.prompt("do not start after the owner stops");
    await authEntered.promise;
    const stopping = f.bridge?.stop();
    try {
      const outcome = await Promise.race([
        stopping?.then(() => "stopped"),
        delay(100, "waiting"),
      ]);
      expect(outcome).toBe("waiting");
      await expect(
        acquireSessionLease(f.home, f.session.sessionId)
      ).rejects.toHaveProperty("code", "ELOCKED");
    } finally {
      authReleased.resolve();
      await stopping;
      check.mockRestore();
      await f.session.abort();
      await next;
    }
    expect(f.streams).toHaveLength(1);
  });

  it("admits only one simultaneous remote prompt", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      f.clients.map((client, index) =>
        client.request({
          id: index,
          method: "turn/start",
          params: {
            input: [
              { text: `input ${index}`, text_elements: [], type: "text" },
            ],
            threadId: f.session.sessionId,
          },
        })
      )
    );
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const turn = f.clients[0]?.snapshot.turn;
    if (!turn) {
      throw new Error("Missing admitted turn");
    }
    await f.clients[0]?.request({
      id: 5,
      method: "turn/interrupt",
      params: { threadId: f.session.sessionId, turnId: turn.id },
    });
    await vi.waitFor(() =>
      expect(f.clients[0]?.snapshot.turn?.status).toBe("interrupted")
    );
  });

  it("renames through the owner and broadcasts the name", async () => {
    const f = await fixture();
    await f.clients[0]?.request({
      id: 6,
      method: "thread/name/set",
      params: { name: "shared name", threadId: f.session.sessionId },
    });
    expect(f.session.sessionManager.getSessionName()).toBe("shared name");
    await vi.waitFor(() => {
      for (const events of f.events) {
        expect(events).toContainEqual({
          method: "thread/name/updated",
          params: { threadId: f.session.sessionId, threadName: "shared name" },
        });
      }
    });
  });

  it("rejects unauthenticated connections without disturbing the owner", async () => {
    const f = await fixture();
    const descriptor = descriptorSchema.parse(
      JSON.parse(
        await readFile(
          `${ownerPath(f.home, f.session.sessionId)}.json`,
          "utf-8"
        )
      )
    );
    const socket = new WebSocket(descriptor.url, {
      handshakeTimeout: 1000,
      headers: { Authorization: "Bearer invalid" },
    });
    try {
      await expect(once(socket, "open")).rejects.toThrow("401");
    } finally {
      socket.terminate();
    }
    expect(f.context?.isIdle()).toBeTruthy();
    await expect(
      acquireSessionLease(f.home, f.session.sessionId)
    ).rejects.toThrow("Lock file is already being held");
  });
});
