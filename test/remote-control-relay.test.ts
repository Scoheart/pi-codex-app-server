/* oxlint-disable anti-slop/no-module-mocking -- Enrollment and auth are external I/O boundaries; this test exercises the real WebSocket relay against a local server. */

import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { getLogger } from "@logtape/logtape";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { CODEX_APP_SERVER_COMPATIBILITY_VERSION } from "../src/codex-app-server-identity.js";
import type { AppServerConfig } from "../src/config/app-server-config.js";
import type { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import type {
  getOrCreateInstallationId,
  loadOrEnroll,
} from "../src/remote/enrollment.js";
import { RemoteControlRelay } from "../src/remote/relay.js";
import type { loadRemoteControlAuth } from "../src/remote/remote-control-auth.js";
import { AppServer } from "../src/server/app-server.js";
import { WebSocketTransport } from "../src/transports/websocket-transport.js";
import type { JsonValue } from "../vendor/openai-codex-app-server-protocol/typescript/serde_json/JsonValue.js";

type GetOrCreateInstallationId = typeof getOrCreateInstallationId;
type LoadOrEnroll = typeof loadOrEnroll;
type LoadRemoteControlAuth = typeof loadRemoteControlAuth;

const remoteMocks = vi.hoisted(() => ({
  getOrCreateInstallationId: vi.fn<GetOrCreateInstallationId>(
    () => "00000000-0000-4000-8000-000000000001"
  ),
  loadOrEnroll: vi.fn<LoadOrEnroll>(),
  loadRemoteControlAuth: vi.fn<LoadRemoteControlAuth>(() =>
    Promise.resolve({
      accessToken: "test-access-token",
      accountId: "test-account",
    })
  ),
}));

vi.mock(import("../src/remote/enrollment.js"), () => ({
  getOrCreateInstallationId: remoteMocks.getOrCreateInstallationId,
  loadOrEnroll: remoteMocks.loadOrEnroll,
}));

vi.mock(import("../src/remote/remote-control-auth.js"), () => ({
  loadRemoteControlAuth: remoteMocks.loadRemoteControlAuth,
}));

const logger = getLogger(["test", "remote-control-relay"]);
const relays: RemoteControlRelay[] = [];
const servers: WebSocketServer[] = [];
const runs: Promise<void>[] = [];

const addressSchema = z
  .object({ port: z.number().int().positive() })
  .passthrough();
const socketSchema = z.custom<WebSocket>(
  (value) => value instanceof WebSocket,
  "Expected a WebSocket"
);
const serverEnvelopeSchema = z
  .object({
    client_id: z.string(),
    segment_count: z.number().optional(),
    segment_id: z.number().optional(),
    seq_id: z.number().int().nonnegative(),
    status: z.enum(["active", "unknown"]).optional(),
    stream_id: z.string(),
    type: z.enum(["pong", "server_message", "server_message_chunk"]),
  })
  .passthrough();

const nextJsonMessage = async (
  socket: WebSocket,
  timeoutMs = 1000
): Promise<z.infer<typeof serverEnvelopeSchema>> => {
  const [data] = await once(socket, "message", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return serverEnvelopeSchema.parse(JSON.parse(String(data)));
};

const expectNoJsonMessage = async (
  socket: WebSocket,
  timeoutMs = 100
): Promise<void> => {
  await expect(
    once(socket, "message", { signal: AbortSignal.timeout(timeoutMs) })
  ).rejects.toThrow(/aborted/iu);
};

const sendEnvelope = (socket: WebSocket, envelope: JsonValue): void => {
  socket.send(JSON.stringify(envelope));
};

const makeTestServer = (
  onRegister?: (connection: JsonRpcConnection) => void
): AppServer => {
  const appServer: AppServer = Object.create(AppServer.prototype);
  Object.defineProperties(appServer, {
    database: { value: {} },
    modelRuntime: { value: {} },
    register: {
      value: (connection: JsonRpcConnection): void => {
        onRegister?.(connection);
        connection.registerRequest("initialize", () => ({
          codexHome: "/tmp",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: "relay-test",
        }));
        connection.registerRequest("thread/list", () => ({
          backwardsCursor: null,
          data: [],
          nextCursor: null,
        }));
      },
    },
  });
  return appServer;
};

const makeConfig = (): AppServerConfig => ({
  autoStart: true,
  hostName: "test-host",
  listenUrl: new URL("ws://127.0.0.1:0"),
  paths: {
    database: "/tmp/pi-codex-test/state.sqlite",
    endpoint: "/tmp/pi-codex-test/endpoint.json",
    home: "/tmp/pi-codex-test",
    logs: "/tmp/pi-codex-test/logs",
  },
  piAgentDir: "/tmp/pi-agent",
  remoteControl: {
    baseUrl: new URL("http://127.0.0.1:3000/backend-api/"),
    enabled: true,
  },
});

const startRelay = async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  const { port } = addressSchema.parse(server.address());
  remoteMocks.loadOrEnroll.mockResolvedValue({
    accountId: "test-account",
    appServerVersion: CODEX_APP_SERVER_COMPATIBILITY_VERSION,
    environmentId: "test-environment",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    remoteControlToken: "test-token",
    serverId: "test-server",
    serverName: "test-host",
    websocketUrl: `ws://127.0.0.1:${port}/`,
  });
  const connections: JsonRpcConnection[] = [];
  const sockets: WebSocket[] = [];
  const messages: z.infer<typeof serverEnvelopeSchema>[][] = [];
  const cursors: (string | string[] | undefined)[] = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    cursors.push(request.headers["x-codex-subscribe-cursor"]);
    const received: z.infer<typeof serverEnvelopeSchema>[] = [];
    messages.push(received);
    socket.on("message", (data) =>
      received.push(serverEnvelopeSchema.parse(JSON.parse(String(data))))
    );
  });
  const relay = new RemoteControlRelay({
    config: makeConfig(),
    logger,
    server: makeTestServer((connection) => connections.push(connection)),
  });
  relays.push(relay);
  runs.push(relay.run());
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const [socket] = sockets;
  if (!socket) {
    throw new Error("Relay socket missing");
  }
  sendEnvelope(socket, {
    client_id: "client",
    message: {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "1" } },
    },
    seq_id: 1,
    stream_id: "stream",
    type: "client_message",
  });
  await vi.waitFor(() => expect(messages[0]).toHaveLength(1));
  const [connection] = connections;
  if (!connection) {
    throw new Error("RPC connection missing");
  }
  return { connection, cursors, messages, relay, socket, sockets };
};

describe("Remote Control relay lifecycle", () => {
  afterEach(async () => {
    for (const relay of relays.splice(0)) {
      relay.close();
    }
    await Promise.all(runs.splice(0));
    await Promise.all(
      servers.splice(0).map(async (server) => {
        const closed = once(server, "close");
        server.close();
        await closed;
      })
    );
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("cancels proxy CONNECT sockets when the relay closes before the handshake", async () => {
    const proxy = createServer();
    const sockets = new Set<Socket>();
    let connected = false;
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (_request, socket) => {
      connected = true;
      // A CONNECT proxy releases its half-open side when the client aborts.
      socket.on("end", () => socket.destroy());
      socket.resume();
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const { port } = addressSchema.parse(proxy.address());
    for (const key of [
      "http_proxy",
      "no_proxy",
      "npm_config_proxy",
      "npm_config_no_proxy",
    ]) {
      vi.stubEnv(key, "");
      Reflect.deleteProperty(process.env, key);
    }
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port}`);
    vi.stubEnv("NO_PROXY", "");
    remoteMocks.loadOrEnroll.mockResolvedValue({
      accountId: "test",
      appServerVersion: CODEX_APP_SERVER_COMPATIBILITY_VERSION,
      environmentId: "test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      remoteControlToken: "test",
      serverId: "test",
      serverName: "test",
      websocketUrl: "ws://127.0.0.1:9/",
    });
    const relay = new RemoteControlRelay({
      config: makeConfig(),
      logger,
      server: makeTestServer(),
    });
    relays.push(relay);
    const run = relay.run();
    runs.push(run);
    try {
      await vi.waitFor(() => expect(connected).toBeTruthy());
      relay.close();
      await run;
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      relay.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      const closed = once(proxy, "close");
      proxy.close();
      await closed;
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "routes through an HTTP proxy unless NO_PROXY bypasses it (%s)",
    async (bypass) => {
      const proxy = createServer();
      let tunnels = 0;
      proxy.on("connect", (request, socket, head) => {
        tunnels += 1;
        const address = new URL(`http://${request.url}`);
        const upstream = connect(Number(address.port), address.hostname, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) {
            upstream.write(head);
          }
          socket.pipe(upstream).pipe(socket);
        });
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const { port } = addressSchema.parse(proxy.address());
      for (const key of [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "npm_config_proxy",
        "npm_config_no_proxy",
      ]) {
        vi.stubEnv(key, "");
        Reflect.deleteProperty(process.env, key);
      }
      vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port}`);
      vi.stubEnv("NO_PROXY", bypass ? "127.0.0.1" : "");
      try {
        const { relay } = await startRelay();
        expect(tunnels).toBe(bypass ? 0 : 1);
        relay.close();
        await Promise.all(runs);
      } finally {
        for (const relay of relays) {
          relay.close();
        }
        await Promise.all(runs);
        const closed = once(proxy, "close");
        proxy.close();
        await closed;
        vi.unstubAllEnvs();
      }
    }
  );

  it("requires initialize for a stream and keeps server sequence continuity across reinitialize", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = addressSchema.parse(server.address());

    remoteMocks.loadOrEnroll.mockResolvedValue({
      accountId: "test-account",
      appServerVersion: CODEX_APP_SERVER_COMPATIBILITY_VERSION,
      environmentId: "test-environment",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      remoteControlToken: "test-token",
      serverId: "test-server",
      serverName: "test-host",
      websocketUrl: `ws://127.0.0.1:${address.port}/`,
    });

    const relay = new RemoteControlRelay({
      config: makeConfig(),
      logger,
      server: makeTestServer(),
    });
    relays.push(relay);

    const connectionPromise = once(server, "connection");
    const runPromise = relay.run();
    const [connection] = await connectionPromise;
    const socket = socketSchema.parse(connection);

    sendEnvelope(socket, {
      client_id: "client-1",
      seq_id: 99,
      stream_id: "stream-1",
      type: "ping",
    });
    await expect(nextJsonMessage(socket)).resolves.toMatchObject({
      client_id: "client-1",
      seq_id: 1,
      status: "unknown",
      stream_id: "stream-1",
      type: "pong",
    });
    sendEnvelope(socket, {
      client_id: "client-1",
      seq_id: 1,
      stream_id: "stream-1",
      type: "ack",
    });

    sendEnvelope(socket, {
      client_id: "client-1",
      message: { id: 1, method: "thread/list", params: {} },
      seq_id: 1,
      stream_id: "stream-1",
      type: "client_message",
    });
    await expectNoJsonMessage(socket);

    sendEnvelope(socket, {
      client_id: "client-1",
      message: {
        id: 2,
        method: "initialize",
        params: {
          capabilities: null,
          clientInfo: { name: "test", title: null, version: "1" },
        },
      },
      seq_id: 2,
      stream_id: "stream-1",
      type: "client_message",
    });
    await expect(nextJsonMessage(socket)).resolves.toMatchObject({
      client_id: "client-1",
      seq_id: 2,
      stream_id: "stream-1",
      type: "server_message",
    });
    sendEnvelope(socket, {
      client_id: "client-1",
      seq_id: 2,
      stream_id: "stream-1",
      type: "ack",
    });

    sendEnvelope(socket, {
      client_id: "client-1",
      message: { id: 3, method: "thread/list", params: {} },
      seq_id: 3,
      stream_id: "stream-1",
      type: "client_message",
    });
    await expect(nextJsonMessage(socket)).resolves.toMatchObject({
      client_id: "client-1",
      seq_id: 3,
      stream_id: "stream-1",
      type: "server_message",
    });
    sendEnvelope(socket, {
      client_id: "client-1",
      seq_id: 3,
      stream_id: "stream-1",
      type: "ack",
    });

    sendEnvelope(socket, {
      client_id: "client-1",
      message: {
        id: 2,
        method: "initialize",
        params: { clientInfo: { name: "test", version: "1" } },
      },
      seq_id: 2,
      stream_id: "stream-1",
      type: "client_message",
    });
    sendEnvelope(socket, {
      client_id: "client-1",
      message: { id: 3, method: "thread/list", params: {} },
      seq_id: 3,
      stream_id: "stream-1",
      type: "client_message",
    });
    await expectNoJsonMessage(socket);

    sendEnvelope(socket, {
      client_id: "client-1",
      message: {
        id: 4,
        method: "initialize",
        params: {
          capabilities: null,
          clientInfo: { name: "test", title: null, version: "1" },
        },
      },
      seq_id: 4,
      stream_id: "stream-1",
      type: "client_message",
    });
    await expect(nextJsonMessage(socket)).resolves.toMatchObject({
      client_id: "client-1",
      seq_id: 4,
      stream_id: "stream-1",
      type: "server_message",
    });

    relay.close();
    await runPromise;
  });

  it("sends complete chunk batches before later notifications and pong", async () => {
    const { connection, messages, socket } = await startRelay();
    const paused = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const { send } = WebSocketTransport.prototype;
    vi.spyOn(WebSocketTransport.prototype, "send").mockImplementation(
      async function sendWithBackpressure(
        this: WebSocketTransport,
        message: string
      ) {
        await send.call(this, message);
        const envelope = serverEnvelopeSchema.parse(JSON.parse(message));
        if (envelope.seq_id === 2 && envelope.segment_id === 0) {
          paused.resolve();
          await release.promise;
        }
      }
    );
    try {
      connection.notify("thread/name/updated", {
        threadId: "thread",
        threadName: "x".repeat(350_000),
      });
      await paused.promise;
      await vi.waitFor(() => expect(messages[0]).toHaveLength(2));
      connection.notify("thread/archived", { threadId: "thread" });
      sendEnvelope(socket, {
        client_id: "client",
        stream_id: "stream",
        type: "ping",
      });
      await expectNoJsonMessage(socket);
      release.resolve();
      await vi.waitFor(() =>
        expect(messages[0]?.at(-1)).toMatchObject({ seq_id: 4, type: "pong" })
      );
      const chunks =
        messages[0]?.filter((message) => message.seq_id === 2) ?? [];
      expect(chunks).toHaveLength(chunks[0]?.segment_count ?? 0);
      expect(chunks.map((message) => message.segment_id)).toStrictEqual(
        chunks.map((_, index) => index)
      );
      expect(messages[0]?.map((message) => message.seq_id)).toStrictEqual([
        1,
        ...chunks.map(() => 2),
        3,
        4,
      ]);
    } finally {
      release.resolve();
    }
  });

  it("replays only unacked chunks with the cursor before accepting live output", async () => {
    const { connection, cursors, messages, sockets, socket } =
      await startRelay();
    connection.notify("thread/name/updated", {
      threadId: "thread",
      threadName: "x".repeat(350_000),
    });
    connection.notify("thread/archived", { threadId: "thread" });
    await vi.waitFor(() => expect(messages[0]?.at(-1)?.seq_id).toBe(3));
    sendEnvelope(socket, {
      client_id: "client",
      cursor: "resume-cursor",
      segment_id: 0,
      seq_id: 2,
      stream_id: "stream",
      type: "ack",
    });
    sendEnvelope(socket, {
      client_id: "client",
      stream_id: "stream",
      type: "ping",
    });
    await vi.waitFor(() => expect(messages[0]?.at(-1)?.seq_id).toBe(4));
    socket.terminate();
    const paused = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const { send } = WebSocketTransport.prototype;
    vi.spyOn(WebSocketTransport.prototype, "send").mockImplementation(
      async function pauseReplay(this: WebSocketTransport, message: string) {
        await send.call(this, message);
        const envelope = serverEnvelopeSchema.parse(JSON.parse(message));
        if (envelope.seq_id === 2 && envelope.segment_id === 1) {
          paused.resolve();
          await release.promise;
        }
      }
    );
    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(2), {
        timeout: 5000,
      });
      await paused.promise;
      await vi.waitFor(() => expect(messages[1]).toHaveLength(1));
      connection.notify("thread/unarchived", { threadId: "thread" });
      const [, resumed] = sockets;
      if (!resumed) {
        throw new Error("Reconnect socket missing");
      }
      await expectNoJsonMessage(resumed);
      release.resolve();
      await vi.waitFor(() => expect(messages[1]?.at(-1)?.seq_id).toBe(5));
      expect(cursors[1]).toBe("resume-cursor");
      const expected = messages[0]?.filter(
        (message) =>
          message.seq_id > 2 ||
          (message.seq_id === 2 && (message.segment_id ?? 0) > 0)
      );
      expect(messages[1]?.slice(0, -1)).toStrictEqual(expected);
    } finally {
      release.resolve();
    }
  }, 10_000);

  it("retires unacked state but preserves desktop sequence continuity when a logical stream reopens", async () => {
    const { messages, sockets, socket } = await startRelay();
    sendEnvelope(socket, {
      client_id: "client",
      stream_id: "stream",
      type: "client_closed",
    });
    sendEnvelope(socket, {
      client_id: "client",
      message: {
        id: 2,
        method: "initialize",
        params: { clientInfo: { name: "test", version: "1" } },
      },
      seq_id: 1,
      stream_id: "stream",
      type: "client_message",
    });
    await vi.waitFor(() => expect(messages[0]).toHaveLength(2));
    expect(messages[0]?.[1]?.seq_id).toBe(2);
    sendEnvelope(socket, { client_id: "client", type: "client_closed" });
    sendEnvelope(socket, {
      client_id: "barrier",
      stream_id: "barrier",
      type: "ping",
    });
    await vi.waitFor(() => expect(messages[0]).toHaveLength(3));
    sendEnvelope(socket, { client_id: "barrier", type: "client_closed" });
    socket.terminate();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5000 });
    const [, resumed] = sockets;
    if (!resumed) {
      throw new Error("Reconnect socket missing");
    }
    await expectNoJsonMessage(resumed);
  }, 10_000);
});
