import { randomUUID } from "node:crypto";

import type { CommandExecParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/CommandExecParams.js";
import type { CommandExecResponse } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/CommandExecResponse.js";
import { appServerLogger } from "../logging/app-server-logger.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";
import { startCommandProcess } from "./command-process.js";
import type { CommandProcess, CommandStream } from "./command-process.js";

const assertOptions = (params: CommandExecParams): void => {
  if (!params.command.length) {
    throw new Error("Expected a nonempty command argv vector");
  }
  if (
    (params.tty || params.streamStdin || params.streamStdoutStderr) &&
    !params.processId
  ) {
    throw new Error("Streaming and PTY commands require a processId");
  }
  if (params.size && !params.tty) {
    throw new Error("A terminal size requires tty mode");
  }
  if (
    params.disableTimeout &&
    params.timeoutMs !== null &&
    params.timeoutMs !== undefined
  ) {
    throw new Error("Cannot combine disableTimeout and timeoutMs");
  }
  if (
    params.disableOutputCap &&
    params.outputBytesCap !== null &&
    params.outputBytesCap !== undefined
  ) {
    throw new Error("Cannot combine disableOutputCap and outputBytesCap");
  }
};

interface CommandOutput {
  bytes: number;
  capped: boolean;
  chunks: Buffer[];
}

class CommandCapture {
  readonly #cap: number;
  readonly #connection: JsonRpcConnection;
  readonly #processId: string;
  readonly #streaming: boolean;
  readonly #stderr: CommandOutput = { bytes: 0, capped: false, chunks: [] };
  readonly #stdout: CommandOutput = { bytes: 0, capped: false, chunks: [] };

  constructor(
    connection: JsonRpcConnection,
    processId: string,
    params: CommandExecParams
  ) {
    this.#connection = connection;
    this.#processId = processId;
    this.#streaming = Boolean(params.tty || params.streamStdoutStderr);
    this.#cap = params.disableOutputCap
      ? Number.POSITIVE_INFINITY
      : Math.max(0, params.outputBytesCap ?? 1024 * 1024);
  }

  append(stream: CommandStream, data: Buffer): void {
    const output = stream === "stdout" ? this.#stdout : this.#stderr;
    const bytes = data.subarray(0, Math.max(0, this.#cap - output.bytes));
    const truncated = bytes.length < data.length;
    output.bytes += bytes.length;
    if (this.#streaming) {
      if (bytes.length || (truncated && !output.capped)) {
        this.#connection.notify("command/exec/outputDelta", {
          capReached: truncated,
          deltaBase64: bytes.toString("base64"),
          processId: this.#processId,
          stream,
        });
      }
    } else if (bytes.length) {
      output.chunks.push(bytes);
    }
    output.capped ||= truncated;
  }

  result(exitCode: number): CommandExecResponse {
    return {
      exitCode,
      stderr: Buffer.concat(this.#stderr.chunks).toString("utf-8"),
      stdout: Buffer.concat(this.#stdout.chunks).toString("utf-8"),
    };
  }
}

export const registerCommandExec = (connection: JsonRpcConnection): void => {
  const processes = new Map<string, CommandProcess>();
  const processFor = (id: string): CommandProcess => {
    const child = processes.get(id);
    if (!child) {
      throw new Error("Unknown command processId");
    }
    return child;
  };
  connection.registerRequest("command/exec", async (params, context) => {
    assertOptions(params);
    context.signal.throwIfAborted();
    const processId = params.processId ?? randomUUID();
    if (processes.has(processId)) {
      throw new Error("Command processId is already running");
    }
    appServerLogger.debug("Host command execution mode", {
      clientId: context.clientId,
      streamStdin: params.streamStdin ?? false,
      streamStdoutStderr: params.streamStdoutStderr ?? false,
      tty: params.tty ?? false,
    });
    const capture = new CommandCapture(connection, processId, params);
    const child = startCommandProcess(params, (stream, bytes) =>
      capture.append(stream, bytes)
    );
    processes.set(processId, child);
    const abort = (): void => child.kill();
    context.signal.addEventListener("abort", abort, { once: true });
    const timeout = params.disableTimeout
      ? undefined
      : setTimeout(abort, params.timeoutMs ?? 30_000);
    timeout?.unref();
    try {
      return capture.result(await child.completion);
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
      processes.delete(processId);
      child.kill();
    }
  });
  connection.registerRequest("command/exec/write", async (params) => {
    const child = processFor(params.processId);
    const written = params.deltaBase64
      ? child.write(Buffer.from(params.deltaBase64, "base64"))
      : undefined;
    if (params.closeStdin) {
      child.closeStdin();
    }
    await written;
    return {};
  });
  connection.registerRequest("command/exec/terminate", (params) => {
    processFor(params.processId).kill();
    return {};
  });
  connection.registerRequest("command/exec/resize", (params) => {
    processFor(params.processId).resize(params.size);
    return {};
  });
};
