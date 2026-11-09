import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { WebSocket } from "ws";
import { z } from "zod";

import type { ServerNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import {
  parseCodexWireMessage,
  parseServerNotification,
} from "../protocol/validation.js";
import {
  migrateOwnerTurn,
  migrateOwnerNotification,
} from "./owner-protocol-migration.js";
import { ownerPath, descriptorSchema, packetSchema } from "./session-owner.js";
import type {
  OwnerSnapshot,
  OwnerRequest,
  OwnerResult,
} from "./session-owner.js";
import { assertSupportedPiInput } from "./user-input-support.js";

export class SessionOwnerClient {
  snapshot: OwnerSnapshot = { historyTurnCount: 0, turn: null };
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    string,
    {
      resolve: (value: OwnerResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #closed = false;
  readonly #protocolVersion: 1 | 2 | 3;
  readonly #ready: ReturnType<typeof Promise.withResolvers<undefined>> =
    Promise.withResolvers<undefined>();
  private constructor(
    socket: WebSocket,
    notify: (notification: ServerNotification) => void,
    closed: () => void,
    protocolVersion: 1 | 2 | 3
  ) {
    this.#socket = socket;
    this.#protocolVersion = protocolVersion;
    socket.on("message", (data) => {
      try {
        const packet = packetSchema.parse(JSON.parse(data.toString()));
        if (packet.type === "snapshot") {
          const parsed =
            packet.turn === null
              ? null
              : parseServerNotification(
                  parseCodexWireMessage(
                    JSON.stringify({
                      method: "turn/started",
                      params: {
                        threadId: "snapshot",
                        turn: migrateOwnerTurn(packet.turn, protocolVersion),
                      },
                    })
                  )
                );
          if (parsed && parsed.method !== "turn/started") {
            throw new Error("Invalid Pi owner snapshot");
          }
          this.snapshot = {
            historyTurnCount: packet.historyTurnCount,
            turn: parsed?.params.turn ?? null,
          };
          this.#ready.resolve();
        } else if (packet.type === "event") {
          const notification = parseServerNotification(
            parseCodexWireMessage(
              JSON.stringify(
                migrateOwnerNotification(packet.notification, protocolVersion)
              )
            )
          );
          this.#update(notification);
          notify(notification);
        } else {
          const pending = this.#pending.get(packet.id);
          if (!pending) {
            return;
          }
          if (packet.error) {
            pending.reject(new Error(packet.error));
          } else {
            const result = z
              .union([
                z.object({ turnId: z.string() }),
                z.record(z.string(), z.never()),
                z.object({ id: z.string(), status: z.string() }).passthrough(),
              ])
              .parse(packet.result);
            if ("status" in result) {
              const notification = parseServerNotification(
                parseCodexWireMessage(
                  JSON.stringify({
                    method: "turn/started",
                    params: {
                      threadId: "result",
                      turn: migrateOwnerTurn(
                        z.json().parse(packet.result),
                        protocolVersion
                      ),
                    },
                  })
                )
              );
              if (notification.method !== "turn/started") {
                throw new Error("Invalid Pi owner response");
              }
              pending.resolve(notification.params.turn);
            } else {
              pending.resolve(result);
            }
          }
          clearTimeout(pending.timer);
          this.#pending.delete(packet.id);
        }
      } catch {
        socket.close(1008, "Invalid Pi owner packet");
      }
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#ready.reject(new Error("Pi owner disconnected before snapshot"));
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            "Pi session owner disconnected; command outcome may be unknown"
          )
        );
      }
      this.#pending.clear();
      closed();
    });
    socket.on("error", () => socket.terminate());
  }
  #update(notification: ServerNotification): void {
    if (
      notification.method === "turn/started" ||
      notification.method === "turn/completed"
    ) {
      this.snapshot = {
        ...this.snapshot,
        turn: structuredClone(notification.params.turn),
      };
      return;
    }
    const { turn } = this.snapshot;
    if (!turn) {
      return;
    }
    if (
      notification.method === "item/started" ||
      notification.method === "item/completed"
    ) {
      const index = turn.items.findIndex(
        (item) => item.id === notification.params.item.id
      );
      if (index === -1) {
        turn.items.push(structuredClone(notification.params.item));
      } else {
        turn.items[index] = structuredClone(notification.params.item);
      }
    } else if (notification.method === "item/agentMessage/delta") {
      const item = turn.items.find(
        (candidate) => candidate.id === notification.params.itemId
      );
      if (item?.type === "agentMessage") {
        item.text += notification.params.delta;
      }
    } else if (notification.method === "item/reasoning/textDelta") {
      const item = turn.items.find(
        (candidate) => candidate.id === notification.params.itemId
      );
      if (item?.type === "reasoning") {
        item.content[notification.params.contentIndex] =
          (item.content[notification.params.contentIndex] ?? "") +
          notification.params.delta;
      }
    }
  }
  static async connect(
    home: string,
    threadId: string,
    notify: (notification: ServerNotification) => void,
    closed: () => void
  ): Promise<SessionOwnerClient | undefined> {
    let descriptor;
    try {
      descriptor = descriptorSchema.parse(
        JSON.parse(await readFile(`${ownerPath(home, threadId)}.json`, "utf-8"))
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    if (descriptor.threadId !== threadId) {
      throw new Error("Pi owner descriptor identity mismatch");
    }
    const url = new URL(descriptor.url);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
      throw new Error("Pi owner endpoint must be loopback");
    }
    try {
      process.kill(descriptor.pid, 0);
    } catch {
      return undefined;
    }
    const socket = new WebSocket(url, {
      handshakeTimeout: 5000,
      headers: { Authorization: `Bearer ${descriptor.token}` },
      maxPayload: 16 * 1024 * 1024,
    });
    const client = new SessionOwnerClient(
      socket,
      notify,
      closed,
      descriptor.protocolVersion
    );
    try {
      await Promise.all([once(socket, "open"), client.requestSnapshot()]);
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }
  async requestSnapshot(): Promise<void> {
    const timer = setTimeout(
      () => this.#ready.reject(new Error("Pi owner snapshot timed out")),
      5000
    );
    try {
      await this.#ready.promise;
    } finally {
      clearTimeout(timer);
    }
  }
  async request(request: OwnerRequest): Promise<OwnerResult> {
    if (this.#closed) {
      throw new Error("Pi session owner is disconnected");
    }
    if (
      request.method === "thread/settings/update" &&
      this.#protocolVersion < 3
    ) {
      throw new Error(
        "Pi TUI bridge needs an upgrade. Load the updated extension and run /reload before updating thread settings."
      );
    }
    if (request.method === "turn/start" || request.method === "turn/steer") {
      assertSupportedPiInput(request.params.input);
    }
    const id = randomUUID();
    const completion = Promise.withResolvers<OwnerResult>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      completion.reject(
        new Error("Pi owner command timed out; outcome may be unknown")
      );
    }, 15_000);
    this.#pending.set(id, { ...completion, timer });
    this.#socket.send(JSON.stringify({ id, request }));
    return await completion.promise;
  }
  close(): void {
    this.#socket.terminate();
  }
}
