import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { appServerLogger } from "../src/logging/app-server-logger.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import { parseCodexWireMessage } from "../src/protocol/validation.js";
import { registerHostOperations } from "../src/server/host-operations.js";
import { AsyncMessageQueue } from "../src/transports/async-message-queue.js";
import type { CommandExecParams } from "../vendor/openai-codex-app-server-protocol/typescript/v2/CommandExecParams.js";

const execute = async (params: CommandExecParams) => {
  const queue = new AsyncMessageQueue();
  const messages: ReturnType<typeof parseCodexWireMessage>[] = [];
  const connection = new JsonRpcConnection({
    clientId: "command-exec-test",
    logger: appServerLogger,
    transport: {
      close: () => queue.close(),
      read: () => queue,
      send: (message) => {
        messages.push(parseCodexWireMessage(message));
        return Promise.resolve();
      },
    },
  });
  connection.registerCompatibilityFallbacks();
  connection.registerRequest("initialize", () => ({
    codexHome: process.cwd(),
    platformFamily: "unix",
    platformOs: "macos",
    userAgent: "test",
  }));
  registerHostOperations(connection);
  const run = connection.run();
  for (const request of [
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "1" } },
    },
    { id: 2, method: "command/exec", params },
  ]) {
    queue.push(JSON.stringify(request));
  }
  try {
    await vi.waitFor(() =>
      expect(
        messages.some((message) => "id" in message && message.id === 2)
      ).toBeTruthy()
    );
    return messages.find((message) => "id" in message && message.id === 2);
  } finally {
    connection.close();
    await run;
  }
};

describe("Buffered host commands used by the mobile directory picker", () => {
  test("does not include command arguments in process-start error responses", async () => {
    const response = await execute({
      command: [process.execPath, "-e", "SYNTHETIC_PRIVATE_ARGUMENT\u0000"],
    });
    expect(response).toStrictEqual({
      error: { code: 0, message: "Could not start command process" },
      id: 2,
    });
  });

  test("lists the requested directory and returns stderr and nonzero exit codes", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "pi-directory-picker-")
    );
    await mkdir(path.join(directory, "mobile-project"));
    try {
      const response = await execute({
        command: [
          process.execPath,
          "-e",
          "console.log(require('node:fs').readdirSync('.').join('\\n'));process.stderr.write('diagnostic');process.exitCode=7",
        ],
        cwd: directory,
      });
      expect(response).toStrictEqual({
        id: 2,
        result: {
          exitCode: 7,
          stderr: "diagnostic",
          stdout: "mobile-project\n",
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("caps captured output per stream", async () => {
    await expect(
      execute({
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('abcdef');process.stderr.write('123456')",
        ],
        outputBytesCap: 3,
      })
    ).resolves.toStrictEqual({
      id: 2,
      result: { exitCode: 0, stderr: "123", stdout: "abc" },
    });
  });

  test("terminates a command at the requested timeout", async () => {
    await expect(
      execute({
        command: [
          process.execPath,
          "-e",
          "setTimeout(()=>process.stdout.write('too late'),10000)",
        ],
        timeoutMs: 100,
      })
    ).resolves.toStrictEqual({
      id: 2,
      result: { exitCode: -1, stderr: "", stdout: "" },
    });
  });
});
