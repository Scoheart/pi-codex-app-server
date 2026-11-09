import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import type { ServerNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import {
  parseClientRequest,
  parseCodexWireMessage,
} from "../protocol/validation.js";
import { acquireSessionLease, ownerPath } from "./session-owner.js";
import type {
  OwnerSnapshot,
  OwnerRequest,
  OwnerResult,
  OwnerPacket,
} from "./session-owner.js";

export class SessionOwnerHost {
  readonly #home: string;
  readonly #threadId: string;
  readonly #snapshot: () => OwnerSnapshot;
  readonly #handle: (request: OwnerRequest) => Promise<OwnerResult>;
  #server?: WebSocketServer;
  #release?: () => Promise<void>;
  #pending: Promise<void> = Promise.resolve();
  constructor(options: {
    home: string;
    threadId: string;
    snapshot: () => OwnerSnapshot;
    handle: (request: OwnerRequest) => Promise<OwnerResult>;
  }) {
    this.#home = options.home;
    this.#threadId = options.threadId;
    this.#snapshot = options.snapshot;
    this.#handle = options.handle;
  }
  async start(): Promise<void> {
    this.#release = await acquireSessionLease(this.#home, this.#threadId);
    const token = randomUUID();
    const server = new WebSocketServer({
      host: "127.0.0.1",
      maxPayload: 16 * 1024 * 1024,
      port: 0,
      verifyClient: (info: { req: IncomingMessage }) => {
        const actual = Buffer.from(info.req.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${token}`);
        return (
          actual.length === expected.length && timingSafeEqual(actual, expected)
        );
      },
    });
    this.#server = server;
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "snapshot", ...this.#snapshot() }));
      socket.on("message", (data) => {
        this.#pending = this.#dispatch(socket, data.toString(), this.#pending);
      });
      socket.on("error", () => socket.terminate());
    });
    try {
      await once(server, "listening");
      const address = z
        .object({ port: z.number().int() })
        .parse(server.address());
      await writeFile(
        `${ownerPath(this.#home, this.#threadId)}.json.tmp`,
        JSON.stringify({
          pid: process.pid,
          protocolVersion: 3,
          threadId: this.#threadId,
          token,
          url: `ws://127.0.0.1:${address.port}`,
        }),
        { mode: 0o600 }
      );
      await rename(
        `${ownerPath(this.#home, this.#threadId)}.json.tmp`,
        `${ownerPath(this.#home, this.#threadId)}.json`
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async #dispatch(
    socket: WebSocket,
    text: string,
    previous: Promise<void>
  ): Promise<void> {
    await previous;
    let id: string | undefined;
    try {
      const envelope = z
        .object({ id: z.string(), request: z.json() })
        .parse(JSON.parse(text));
      ({ id } = envelope);
      const request = parseClientRequest(
        parseCodexWireMessage(JSON.stringify(envelope.request))
      );
      if (
        request.method !== "turn/start" &&
        request.method !== "turn/steer" &&
        request.method !== "turn/interrupt" &&
        request.method !== "thread/compact/start" &&
        request.method !== "thread/settings/update" &&
        request.method !== "thread/name/set"
      ) {
        throw new Error("Unsupported Pi owner operation");
      }
      if (request.params.threadId !== this.#threadId) {
        throw new Error("Pi owner session identity changed");
      }
      const result = await this.#handle(request);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id, result, type: "response" }));
      }
    } catch (error) {
      if (id && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : "Pi owner command failed",
            id,
            type: "response",
          })
        );
      } else {
        socket.close(1008, "Invalid Pi owner command");
      }
    }
  }
  publish(notification: ServerNotification): void {
    if (
      notification.method === "turn/started" ||
      notification.method === "turn/completed"
    ) {
      this.publishSnapshot();
    }
    this.#broadcast({ notification, type: "event" });
  }
  publishSnapshot(): void {
    this.#broadcast({ type: "snapshot", ...this.#snapshot() });
  }
  #broadcast(packet: OwnerPacket): void {
    const text = JSON.stringify(packet);
    for (const socket of this.#server?.clients ?? []) {
      if (socket.bufferedAmount > 16 * 1024 * 1024) {
        socket.close(1013, "Pi owner subscriber fell behind");
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      }
    }
  }
  async stop(): Promise<void> {
    await rm(`${ownerPath(this.#home, this.#threadId)}.json`, { force: true });
    await rm(`${ownerPath(this.#home, this.#threadId)}.json.tmp`, {
      force: true,
    });
    for (const socket of this.#server?.clients ?? []) {
      socket.terminate();
    }
    if (this.#server) {
      const closed = once(this.#server, "close");
      this.#server.close();
      await closed;
    }
    this.#server = undefined;
    await this.#pending;
    await this.#release?.();
    this.#release = undefined;
  }
}
