import { describe, expect, test, vi } from "vitest";

import { appServerLogger } from "../src/logging/app-server-logger.js";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.js";
import {
  parseCodexWireMessage,
  parseServerNotification,
} from "../src/protocol/validation.js";
import { registerHostOperations } from "../src/server/host-operations.js";
import { AsyncMessageQueue } from "../src/transports/async-message-queue.js";

const client = async () => {
  const queue = new AsyncMessageQueue();
  const messages: ReturnType<typeof parseCodexWireMessage>[] = [];
  const connection = new JsonRpcConnection({
    clientId: "mobile-command-stream",
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
  queue.push(
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test", version: "1" } },
    })
  );
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({ id: 1, result: expect.anything() })
    )
  );
  return {
    async close() {
      connection.close();
      await run;
    },
    messages,
    queue,
  };
};

const outputText = (
  messages: ReturnType<typeof parseCodexWireMessage>[],
  stream = "stdout"
) =>
  messages
    .flatMap((message) => {
      if (
        !("method" in message) ||
        message.method !== "command/exec/outputDelta"
      ) {
        return [];
      }
      const notification = parseServerNotification(message);
      return notification.method === "command/exec/outputDelta" &&
        notification.params.stream === stream
        ? [
            Buffer.from(notification.params.deltaBase64, "base64").toString(
              "utf-8"
            ),
          ]
        : [];
    })
    .join("");

describe("Mobile streaming command execution", () => {
  test("reserves a stdin close boundary before awaiting a large write", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "let n=0;console.log('READY');process.stdin.pause();setTimeout(()=>{process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n));process.stdin.resume()},200)",
            ],
            processId: "closing",
            streamStdin: true,
            streamStdoutStderr: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toContain("READY")
      );
      for (const request of [
        {
          id: 3,
          method: "command/exec/write",
          params: {
            closeStdin: true,
            deltaBase64: Buffer.alloc(2 * 1024 * 1024, 65).toString("base64"),
            processId: "closing",
          },
        },
        {
          id: 4,
          method: "command/exec/write",
          params: { deltaBase64: "Qg==", processId: "closing" },
        },
      ]) {
        peer.queue.push(JSON.stringify(request));
      }
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: 0, stderr: "", stdout: "" },
        })
      );
      expect(outputText(peer.messages)).toContain("2097152");
      expect(peer.messages).toContainEqual({
        error: { code: 0, message: "Command stdin is closed" },
        id: 4,
      });
    } finally {
      await peer.close();
    }
  });

  test("terminates a command even when a large stdin write is backpressured", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "console.log('READY');setInterval(()=>{},1000)",
            ],
            disableTimeout: true,
            processId: "blocked",
            streamStdin: true,
            streamStdoutStderr: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toContain("READY")
      );
      for (const request of [
        {
          id: 3,
          method: "command/exec/write",
          params: {
            deltaBase64: Buffer.alloc(2 * 1024 * 1024, 65).toString("base64"),
            processId: "blocked",
          },
        },
        {
          id: 4,
          method: "command/exec/terminate",
          params: { processId: "blocked" },
        },
      ]) {
        peer.queue.push(JSON.stringify(request));
      }
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({ id: 4, result: {} })
      );
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: -1, stderr: "", stdout: "" },
        })
      );
    } finally {
      await peer.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "terminates PTY descendants even after their leader exits",
    async () => {
      const peer = await client();
      let childPid = 0;
      const descendant =
        "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)";
      const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(child.pid));setInterval(()=>{},1000)`;
      try {
        peer.queue.push(
          JSON.stringify({
            id: 2,
            method: "command/exec",
            params: {
              command: [process.execPath, "-e", leader],
              disableTimeout: true,
              processId: "tree",
              tty: true,
            },
          })
        );
        await vi.waitFor(() =>
          expect(outputText(peer.messages)).toMatch(/^\d+\s*$/u)
        );
        childPid = Number(outputText(peer.messages).trim());
        peer.queue.push(
          JSON.stringify({
            id: 3,
            method: "command/exec/terminate",
            params: { processId: "tree" },
          })
        );
        await vi.waitFor(() =>
          expect(peer.messages).toContainEqual({
            id: 2,
            result: { exitCode: -1, stderr: "", stdout: "" },
          })
        );
        await vi.waitFor(
          () => expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/u),
          { timeout: 2500 }
        );
      } finally {
        await peer.close();
        if (childPid) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* The synthetic child has already exited. */
          }
        }
      }
    }
  );

  test("resizes and terminates a PTY before its original request completes", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "console.log('READY');process.on('SIGWINCH',()=>console.log(process.stdout.columns+'x'+process.stdout.rows));setInterval(()=>{},1000)",
            ],
            processId: "resize",
            tty: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toContain("READY")
      );
      peer.queue.push(
        JSON.stringify({
          id: 3,
          method: "command/exec/resize",
          params: { processId: "resize", size: { cols: 150, rows: 40 } },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toContain("150x40")
      );
      peer.queue.push(
        JSON.stringify({
          id: 4,
          method: "command/exec/terminate",
          params: { processId: "resize" },
        })
      );
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: -1, stderr: "", stdout: "" },
        })
      );
      expect(peer.messages).toContainEqual({ id: 3, result: {} });
      expect(peer.messages).toContainEqual({ id: 4, result: {} });
    } finally {
      await peer.close();
    }
  });

  test("disconnecting the client terminates its running command", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write(String(process.pid));setInterval(()=>{},1000)",
            ],
            processId: "disconnect",
            streamStdoutStderr: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toMatch(/^\d+$/u)
      );
      const pid = Number(outputText(peer.messages));
      await peer.close();
      await vi.waitFor(() =>
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u)
      );
    } finally {
      await peer.close();
    }
  });

  test("streams capped stdout/stderr before the deferred response without duplicating output", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('alpha');process.stderr.write('beta')",
            ],
            outputBytesCap: 3,
            processId: "directory-picker",
            streamStdoutStderr: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: 0, stderr: "", stdout: "" },
        })
      );
      expect(outputText(peer.messages)).toBe("alp");
      expect(outputText(peer.messages, "stderr")).toBe("bet");
      expect(
        peer.messages.filter(
          (message) =>
            "method" in message && message.method === "command/exec/outputDelta"
        )
      ).toHaveLength(2);
      expect(peer.messages).toContainEqual({
        method: "command/exec/outputDelta",
        params: {
          capReached: true,
          deltaBase64: Buffer.from("alp").toString("base64"),
          processId: "directory-picker",
          stream: "stdout",
        },
      });
      expect(peer.messages.at(-1)).toStrictEqual({
        id: 2,
        result: { exitCode: 0, stderr: "", stdout: "" },
      });
    } finally {
      await peer.close();
    }
  });

  test("processes stdin writes on the same connection while command/exec is still running", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write('READY:');process.stdin.on('data',bytes=>process.stdout.write(bytes))",
            ],
            processId: "input",
            streamStdin: true,
            streamStdoutStderr: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(outputText(peer.messages)).toContain("READY:")
      );
      peer.queue.push(
        JSON.stringify({
          id: 3,
          method: "command/exec/write",
          params: {
            closeStdin: true,
            deltaBase64: Buffer.from("hello ✓").toString("base64"),
            processId: "input",
          },
        })
      );
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: 0, stderr: "", stdout: "" },
        })
      );
      expect(outputText(peer.messages)).toBe("READY:hello ✓");
      expect(peer.messages).toContainEqual({ id: 3, result: {} });
    } finally {
      await peer.close();
    }
  });

  test("runs a real PTY with the requested terminal size", async () => {
    const peer = await client();
    try {
      peer.queue.push(
        JSON.stringify({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "console.log(process.stdout.isTTY?'tty':'pipe');console.log(process.stdout.columns+'x'+process.stdout.rows)",
            ],
            processId: "terminal",
            size: { cols: 120, rows: 35 },
            tty: true,
          },
        })
      );
      await vi.waitFor(() =>
        expect(peer.messages).toContainEqual({
          id: 2,
          result: { exitCode: 0, stderr: "", stdout: "" },
        })
      );
      expect(outputText(peer.messages)).toContain("tty\r\n120x35\r\n");
    } finally {
      await peer.close();
    }
  });
});
