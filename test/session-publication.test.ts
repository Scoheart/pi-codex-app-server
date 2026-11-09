import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextEventLoop } from "node:timers/promises";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";

import { appServerLogger } from "../src/logging/app-server-logger.js";
import { PiLiveSessionManager } from "../src/pi/live-session-manager.js";
import { PiProjectCatalog } from "../src/pi/project-catalog.js";
import {
  PiSessionPresence,
  readPiPresence,
} from "../src/pi/session-presence.js";
import { PiSessionPublication } from "../src/pi/session-publication.js";
import { PiSessionRepository } from "../src/pi/session-repository.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import { parseCodexWireMessage } from "../src/protocol/validation.js";
import type { CodexWireMessage } from "../src/protocol/validation.js";
import { createAppServer } from "../src/server/create-app-server.js";
import { MetadataDatabase } from "../src/storage/metadata-database.js";

interface TestPolicy {
  maxAgeDays?: number | string | null;
  mode?: string;
}
interface TestExportSettings {
  projects?: TestPolicy;
  unassigned?: TestPolicy;
}

const initializeClient = async function* initializeClient() {
  yield JSON.stringify({
    id: 0,
    method: "initialize",
    params: { clientInfo: { name: "test", version: "1" } },
  });
  yield JSON.stringify({ method: "initialized" });
};

const fixture = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pi-publication-"));
  const cwd = path.join(home, "repo");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  const database = new MetadataDatabase(":memory:");
  const publication = new PiSessionPublication({
    agentDir: home,
    database,
    home,
  });
  const session = (id: string, days = 0): SessionInfo => ({
    allMessagesText: id,
    created: new Date(0),
    cwd,
    firstMessage: id,
    id,
    messageCount: 1,
    modified: new Date(Date.now() - days * 86_400_000),
    path: path.join(home, `${id}.jsonl`),
  });
  const settings = async (
    sessionExport: TestExportSettings,
    project = false
  ): Promise<void> => {
    await writeFile(
      project
        ? path.join(cwd, ".pi", "settings.json")
        : path.join(home, "settings.json"),
      JSON.stringify({ codexAppServer: { sessionExport }, theme: "dark" })
    );
  };
  const close = async (): Promise<void> => {
    database.close();
    await rm(home, { force: true, recursive: true });
  };
  return { close, cwd, database, home, publication, session, settings };
};

describe("Session publication", () => {
  test("explicit history access bypasses inactivity but cannot bypass off", async () => {
    const f = await fixture();
    try {
      const session = f.session("hidden", 1000);
      await expect(f.publication.select([session])).resolves.toStrictEqual([]);
      await expect(
        f.publication.select([session], session.id)
      ).resolves.toStrictEqual([session]);
      await f.settings({ unassigned: { mode: "off" } });
      await expect(
        f.publication.select([session], session.id)
      ).resolves.toStrictEqual([]);
    } finally {
      await f.close();
    }
  });

  test.each(["notLoaded", "idle", "active"] as const)(
    "publishes reconnects and updates %s threads without duplicate live snapshots",
    async (status) => {
      const f = await fixture();
      await f.settings({ unassigned: { mode: "all" } });
      let session = f.session("known-thread", 1);
      const list = vi
        .spyOn(PiSessionRepository.prototype, "list")
        .mockResolvedValue([session]);
      const runtime = vi
        .spyOn(PiLiveSessionManager.prototype, "withRuntimeStatus")
        .mockImplementation((thread) => ({
          ...thread,
          status:
            status === "active"
              ? { activeFlags: [], type: status }
              : { type: status },
        }));
      const server = await createAppServer({
        autoStart: false,
        hostName: "test",
        listenUrl: new URL("ws://127.0.0.1:0"),
        paths: {
          database: path.join(f.home, "reconnect.sqlite"),
          endpoint: path.join(f.home, "endpoint.json"),
          home: f.home,
          logs: f.home,
        },
        piAgentDir: f.home,
        remoteControl: {
          baseUrl: new URL("https://chatgpt.com/backend-api/"),
          enabled: false,
        },
      });
      server.database.upsertThread({
        archived: false,
        projectId: null,
        sessionFile: session.path,
        threadId: session.id,
        updatedAt: session.modified.getTime(),
      });
      const responses: CodexWireMessage[] = [];
      const refresh = async (): Promise<void> => {
        const published = Promise.withResolvers<undefined>();
        const trigger = new JsonRpcConnection({
          clientId: "refresh",
          logger: appServerLogger,
          transport: {
            close: () => {},
            read: async function* read() {
              yield* initializeClient();
              await published.promise;
              await nextEventLoop();
            },
            send: (message) => {
              const notification = parseCodexWireMessage(message);
              if (
                "method" in notification &&
                notification.method === "thread/started"
              ) {
                published.resolve();
              }
              return Promise.resolve();
            },
          },
        });
        server.register(trigger);
        await trigger.run();
      };
      const connection = new JsonRpcConnection({
        clientId: "reconnected-desktop",
        logger: appServerLogger,
        transport: {
          close: () => {},
          read: async function* read() {
            yield* initializeClient();
            await vi.waitFor(() =>
              expect(responses).toContainEqual(
                expect.objectContaining({ method: "thread/started" })
              )
            );
            await nextEventLoop();
            session = { ...session, modified: new Date() };
            list.mockResolvedValue([session]);
            await refresh();
            await nextEventLoop();
            session = {
              ...session,
              modified: new Date(),
              name: "Updated title",
            };
            list.mockResolvedValue([session]);
            await refresh();
            await vi.waitFor(() =>
              expect(responses).toContainEqual(
                expect.objectContaining({
                  method:
                    status === "notLoaded"
                      ? "thread/started"
                      : "thread/name/updated",
                  params:
                    status === "notLoaded"
                      ? expect.objectContaining({
                          thread: expect.objectContaining({
                            name: "Updated title",
                          }),
                        })
                      : { threadId: session.id, threadName: "Updated title" },
                })
              )
            );
            await nextEventLoop();
            await refresh();
            await nextEventLoop();
            yield JSON.stringify({ id: 1, method: "thread/list", params: {} });
            await nextEventLoop();
          },
          send: (message) => {
            responses.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      try {
        server.register(connection);
        await connection.run();
        const announcements = responses.filter(
          (message) =>
            "method" in message && message.method === "thread/started"
        );
        expect(announcements).toMatchObject(
          status === "notLoaded"
            ? [
                { params: { thread: { id: "known-thread", name: null } } },
                { params: { thread: { id: "known-thread", name: null } } },
                {
                  params: {
                    thread: {
                      id: "known-thread",
                      name: "Updated title",
                      updatedAt: Math.floor(session.modified.getTime() / 1000),
                    },
                  },
                },
              ]
            : [{ params: { thread: { id: "known-thread", name: null } } }]
        );
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: 1,
            result: expect.objectContaining({
              data: [
                expect.objectContaining({
                  id: session.id,
                  name: session.name,
                  recencyAt: Math.floor(session.modified.getTime() / 1000),
                  updatedAt: Math.floor(session.modified.getTime() / 1000),
                }),
              ],
            }),
          })
        );
      } finally {
        server.close();
        list.mockRestore();
        runtime.mockRestore();
        await f.close();
      }
    }
  );

  test("explicit RPC history reads activate a hidden session until unsubscribe", async () => {
    const f = await fixture();
    const presence = new PiSessionPresence(f.home);
    const responses: CodexWireMessage[] = [];
    const list = vi
      .spyOn(PiSessionRepository.prototype, "list")
      .mockResolvedValue([f.session("rpc-thread", 1000)]);
    await writeFile(
      f.session("rpc-thread").path,
      JSON.stringify({
        cwd: f.cwd,
        id: "rpc-thread",
        timestamp: new Date(0).toISOString(),
        type: "session",
        version: 3,
      })
    );
    const server = await createAppServer({
      autoStart: false,
      hostName: "test",
      listenUrl: new URL("ws://127.0.0.1:0"),
      paths: {
        database: path.join(f.home, "rpc.sqlite"),
        endpoint: path.join(f.home, "endpoint.json"),
        home: f.home,
        logs: f.home,
      },
      piAgentDir: f.home,
      remoteControl: {
        baseUrl: new URL("https://chatgpt.com/backend-api/"),
        enabled: false,
      },
    });
    try {
      server.database.upsertThread({
        archived: false,
        projectId: null,
        sessionFile: f.session("rpc-thread").path,
        threadId: "rpc-thread",
        updatedAt: 0,
      });
      await f.settings({ unassigned: { mode: "active" } });
      const trigger = new JsonRpcConnection({
        clientId: "refresh",
        logger: appServerLogger,
        transport: {
          close: () => {},
          read: initializeClient,
          send: async () => {},
        },
      });
      server.register(trigger);
      const connection = new JsonRpcConnection({
        clientId: "active",
        logger: appServerLogger,
        transport: {
          close: () => {},
          read: async function* read() {
            yield JSON.stringify({
              id: 0,
              method: "initialize",
              params: { clientInfo: { name: "test", version: "1" } },
            });
            yield JSON.stringify({ method: "initialized" });
            yield JSON.stringify({
              id: 1,
              method: "thread/read",
              params: { includeTurns: true, threadId: "rpc-thread" },
            });
            await presence.stop();
            yield JSON.stringify({ id: 2, method: "thread/list", params: {} });
            yield JSON.stringify({
              id: 3,
              method: "thread/unsubscribe",
              params: { threadId: "rpc-thread" },
            });
            yield JSON.stringify({ id: 4, method: "thread/list", params: {} });
            await trigger.run();
          },
          send: (message) => {
            responses.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      server.register(connection);
      await connection.run();
      expect(
        responses.filter(
          (message) => "id" in message && [2, 3, 4].includes(Number(message.id))
        )
      ).toMatchObject([
        { id: 2, result: { data: [{ id: "rpc-thread" }] } },
        { id: 3, result: { status: "unsubscribed" } },
        { id: 4, result: { data: [] } },
      ]);
      expect(responses).toContainEqual({
        method: "thread/deleted",
        params: { threadId: "rpc-thread" },
      });
      expect(server.database.getThread("rpc-thread")).toBeDefined();
    } finally {
      server.close();
      list.mockRestore();
      await presence.stop();
      await f.close();
    }
  });

  test.each(["global", "local"] as const)(
    "settings updates respect changes to %s publication policy",
    async (scope) => {
      const f = await fixture();
      const session = f.session("settings-thread");
      await writeFile(
        session.path,
        JSON.stringify({
          cwd: f.cwd,
          id: session.id,
          timestamp: new Date(0).toISOString(),
          type: "session",
          version: 3,
        })
      );
      await f.settings({ unassigned: { mode: "all" } });
      const list = vi
        .spyOn(PiSessionRepository.prototype, "list")
        .mockResolvedValue([session]);
      // Replace only execution: publication and RPC validation use their real implementations.
      const update = vi
        .spyOn(PiLiveSessionManager.prototype, "updateSettings")
        .mockResolvedValue();
      const server = await createAppServer({
        autoStart: false,
        hostName: "test",
        listenUrl: new URL("ws://127.0.0.1:0"),
        paths: {
          database: path.join(f.home, "settings.sqlite"),
          endpoint: path.join(f.home, "endpoint.json"),
          home: f.home,
          logs: f.home,
        },
        piAgentDir: f.home,
        remoteControl: {
          baseUrl: new URL("https://chatgpt.com/backend-api/"),
          enabled: false,
        },
      });
      server.database.upsertThread({
        archived: false,
        projectId: null,
        sessionFile: session.path,
        threadId: session.id,
        updatedAt: 0,
      });
      const responses: CodexWireMessage[] = [];
      const local = scope === "local";
      const connection = new JsonRpcConnection({
        clientId: "settings-publication",
        logger: appServerLogger,
        transport: {
          close: () => {},
          read: async function* read() {
            yield* initializeClient();
            yield JSON.stringify({
              id: 1,
              method: "thread/settings/update",
              params: { effort: "off", threadId: session.id },
            });
            await f.settings({ unassigned: { mode: "off" } }, local);
            yield JSON.stringify({
              id: 2,
              method: "thread/read",
              params: { threadId: session.id },
            });
            yield JSON.stringify({
              id: 3,
              method: "thread/settings/update",
              params: { effort: "off", threadId: session.id },
            });
            await f.settings({ unassigned: { mode: "all" } }, local);
            yield JSON.stringify({
              id: 4,
              method: "thread/settings/update",
              params: { effort: "off", threadId: session.id },
            });
            yield JSON.stringify({
              id: 5,
              method: "thread/settings/update",
              params: { effort: "off", threadId: "unknown-thread" },
            });
          },
          send: (message) => {
            responses.push(parseCodexWireMessage(message));
            return Promise.resolve();
          },
        },
      });
      try {
        server.register(connection);
        await connection.run();
        expect(responses).toContainEqual({ id: 1, result: {} });
        expect(responses).toContainEqual({ id: 4, result: {} });
        for (const id of [2, 3, 5]) {
          expect(responses).toContainEqual({
            error: {
              code: expect.any(Number),
              message: expect.stringContaining("Thread not found"),
            },
            id,
          });
        }
      } finally {
        server.close();
        update.mockRestore();
        list.mockRestore();
        await f.close();
      }
    }
  );

  test("off blocks starting new sessions and project policy is independent", async () => {
    const f = await fixture();
    try {
      await f.settings({ unassigned: { mode: "off" } });
      await expect(f.publication.assertCanStart(f.cwd)).rejects.toThrow(
        "publication is disabled"
      );
      await mkdir(path.join(f.cwd, ".git"));
      await expect(
        f.publication.assertCanStart(f.cwd)
      ).resolves.toBeUndefined();
      await f.settings({ projects: { mode: "off" } }, true);
      await expect(f.publication.assertCanStart(f.cwd)).rejects.toThrow(
        "publication is disabled"
      );
    } finally {
      await f.close();
    }
  });

  test("missing policies publish only active sessions and all-history publication requires opt-in", async () => {
    const f = await fixture();
    const presence = new PiSessionPresence(f.home);
    try {
      const sessions = [f.session("old", 1000), f.session("new")];
      await expect(f.publication.select(sessions)).resolves.toStrictEqual([]);
      await presence.start("new");
      await expect(f.publication.select(sessions)).resolves.toStrictEqual([
        sessions[1],
      ]);
      await f.settings({ unassigned: { mode: "all" } });
      await expect(f.publication.select(sessions)).resolves.toStrictEqual(
        sessions
      );
    } finally {
      await presence.stop();
      await f.close();
    }
  });

  test("age limits use activity, keep projects independent, and reload project overrides", async () => {
    const f = await fixture();
    try {
      const { project } = new PiProjectCatalog(f.database).create({
        idempotencyKey: "repo",
        name: "Repo",
        roots: [{ path: f.cwd }],
      });
      f.database.upsertThread({
        archived: false,
        projectId: project.id,
        sessionFile: "old-project.jsonl",
        threadId: "old-project",
        updatedAt: 0,
      });
      const sessions = [
        f.session("old", 31),
        f.session("new", 29),
        f.session("old-project", 1000),
      ];
      await f.settings({
        projects: { mode: "all" },
        unassigned: { maxAgeDays: 30, mode: "all" },
      });
      const globalSelection = await f.publication.select(sessions);
      expect(globalSelection.map(({ id }) => id)).toStrictEqual([
        "new",
        "old-project",
      ]);
      await f.settings(
        { projects: { maxAgeDays: 30 }, unassigned: { maxAgeDays: null } },
        true
      );
      const projectSelection = await f.publication.select(sessions);
      expect(projectSelection.map(({ id }) => id)).toStrictEqual([
        "old",
        "new",
      ]);
      await f.settings(
        { projects: { mode: "off" }, unassigned: { mode: "off" } },
        true
      );
      await expect(f.publication.select(sessions)).resolves.toStrictEqual([]);
    } finally {
      await f.close();
    }
  });

  test("active follows Pi presence, multiple Codex subscribers, unsubscribe, and disconnect", async () => {
    const f = await fixture();
    const presence = new PiSessionPresence(f.home);
    try {
      await f.settings({ unassigned: { maxAgeDays: 30, mode: "active" } });
      const sessions = [f.session("old", 1000)];
      await presence.start("old");
      await expect(f.publication.select(sessions)).resolves.toStrictEqual(
        sessions
      );
      const first = new AbortController();
      const second = new AbortController();
      f.publication.retain("old", first.signal);
      f.publication.retain("old", second.signal);
      await presence.stop();
      await expect(f.publication.select(sessions)).resolves.toStrictEqual(
        sessions
      );
      f.publication.release("old", first.signal);
      await expect(f.publication.select(sessions)).resolves.toStrictEqual(
        sessions
      );
      second.abort();
      await expect(f.publication.select(sessions)).resolves.toStrictEqual([]);
      f.publication.retain("old", second.signal);
      await expect(f.publication.select(sessions)).resolves.toStrictEqual([]);
    } finally {
      await presence.stop();
      await f.close();
    }
  });

  test("a running Codex turn survives disconnect, but off overrides active work", async () => {
    const f = await fixture();
    let working = true;
    const publication = new PiSessionPublication({
      agentDir: f.home,
      database: f.database,
      home: f.home,
      isWorking: () => working,
    });
    try {
      const sessions = [f.session("old", 1000)];
      await f.settings({ unassigned: { mode: "active" } });
      await expect(publication.select(sessions)).resolves.toStrictEqual(
        sessions
      );
      working = false;
      await expect(publication.select(sessions)).resolves.toStrictEqual([]);
      working = true;
      await f.settings({ unassigned: { mode: "off" } });
      await expect(publication.select(sessions)).resolves.toStrictEqual([]);
    } finally {
      await f.close();
    }
  });

  test("presence switches sessions and ignores crashed, expired, and malformed records", async () => {
    const f = await fixture();
    const first = new PiSessionPresence(f.home);
    const second = new PiSessionPresence(f.home);
    try {
      await first.start("a");
      await second.start("b");
      await expect(readPiPresence(f.home)).resolves.toStrictEqual(
        new Set(["a", "b"])
      );
      await first.start("c");
      await expect(readPiPresence(f.home)).resolves.toStrictEqual(
        new Set(["b", "c"])
      );
      await first.stop();
      await second.stop();
      const directory = path.join(f.home, "presence");
      await writeFile(
        path.join(directory, "expired.json"),
        JSON.stringify({
          pid: process.pid,
          threadId: "expired",
          touchedAt: Date.now() - 60_000,
        })
      );
      await writeFile(
        path.join(directory, "crashed.json"),
        JSON.stringify({
          pid: 1_073_741_823,
          threadId: "crashed",
          touchedAt: Date.now(),
        })
      );
      await writeFile(path.join(directory, "malformed.json"), "{");
      await expect(readPiPresence(f.home)).resolves.toStrictEqual(new Set());
    } finally {
      await first.stop();
      await second.stop();
      await f.close();
    }
  });

  test("invalid policies fail instead of widening publication", async () => {
    const f = await fixture();
    try {
      for (const maxAgeDays of [0, -1, 1.5, "30"]) {
        // Each validation case must reach the file loader independently.
        // oxlint-disable-next-line no-await-in-loop
        await f.settings({ unassigned: { maxAgeDays } });
        // oxlint-disable-next-line no-await-in-loop
        await expect(f.publication.select([f.session("old")])).rejects.toThrow(
          "Invalid Pi session export settings"
        );
      }
    } finally {
      await f.close();
    }
  });
});
