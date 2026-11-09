import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { spawn as PtySpawn } from "node-pty";

import type { CommandExecParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/CommandExecParams.js";
import type { CommandExecTerminalSize } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/CommandExecTerminalSize.js";

export type CommandStream = "stderr" | "stdout";
type OutputListener = (stream: CommandStream, bytes: Buffer) => void;

export interface CommandProcess {
  closeStdin: () => void;
  completion: Promise<number>;
  kill: () => void;
  resize: (size: CommandExecTerminalSize) => void;
  write: (bytes: Buffer) => Promise<void>;
}

const commandEnvironment = (params: CommandExecParams): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(params.env ?? {})) {
    if (value === null) {
      Reflect.deleteProperty(env, key);
    } else if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

const startPipe = (
  params: CommandExecParams,
  output: OutputListener
): CommandProcess => {
  const child = spawn(params.command[0] ?? "", params.command.slice(1), {
    cwd: path.resolve(params.cwd ?? process.cwd()),
    detached: process.platform !== "win32",
    env: commandEnvironment(params),
    stdio: "pipe",
    windowsHide: true,
  });
  const completion = Promise.withResolvers<number>();
  let closed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, value);
      } else {
        child.kill(value);
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        throw error;
      }
    }
  };
  child.once("error", () =>
    completion.reject(new Error("Could not start command process"))
  );
  // Pending writes receive callback errors; process completion still follows close.
  child.stdin.on("error", () => child.stdin.destroy());
  child.once("close", (code) => {
    closed = true;
    completion.resolve(code ?? -1);
  });
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (bytes: Buffer) => output(stream, bytes));
  }
  if (!params.streamStdin) {
    child.stdin.end();
  }
  return {
    closeStdin: () => child.stdin.end(),
    completion: completion.promise,
    kill: () => {
      if (closed || !child.pid || escalation) {
        return;
      }
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 1000);
    },
    resize: () => {
      throw new Error("Only PTY commands can be resized");
    },
    write: async (bytes) => {
      if (!params.streamStdin || child.stdin.writableEnded) {
        throw new Error("Command stdin is closed");
      }
      const written = Promise.withResolvers<undefined>();
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- The writable callback reports completion and errors for these bytes.
      child.stdin.write(bytes, (error) =>
        error
          ? written.reject(new Error("Could not write command stdin"))
          : written.resolve()
      );
      await written.promise;
    },
  };
};

const startPty = (
  params: CommandExecParams,
  output: OutputListener
): CommandProcess => {
  const native: { spawn: typeof PtySpawn } = createRequire(import.meta.url)(
    "node-pty"
  );
  if (process.platform === "darwin") {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(
      packageRoot,
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper"
    );
    if (existsSync(helper)) {
      try {
        accessSync(helper, constants.X_OK);
      } catch {
        chmodSync(helper, 0o755);
      }
    }
  }
  const terminal = native.spawn(
    params.command[0] ?? "",
    params.command.slice(1),
    {
      cols: params.size?.cols ?? 80,
      cwd: path.resolve(params.cwd ?? process.cwd()),
      encoding: null,
      env: commandEnvironment(params),
      name: "xterm-256color",
      rows: params.size?.rows ?? 24,
    }
  );
  const completion = Promise.withResolvers<number>();
  let closed = false;
  let stdinClosed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  terminal.onData((data) => output("stdout", Buffer.from(data)));
  terminal.onExit(({ exitCode, signal }) => {
    closed = true;
    completion.resolve(signal ? -1 : exitCode);
  });
  return {
    closeStdin: () => {
      if (!closed && !stdinClosed) {
        terminal.write("\u0004");
      }
      stdinClosed = true;
    },
    completion: completion.promise,
    kill: () => {
      if (closed || escalation) {
        return;
      }
      const signal = (value: NodeJS.Signals): void => {
        if (process.platform === "win32") {
          terminal.kill();
        } else {
          try {
            process.kill(-terminal.pid, value);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            ) {
              throw error;
            }
          }
        }
      };
      signal("SIGHUP");
      escalation = setTimeout(() => signal("SIGKILL"), 1000);
    },
    resize: ({ cols, rows }) => terminal.resize(cols, rows),
    write: (bytes) => {
      if (closed || stdinClosed) {
        throw new Error("Command stdin is closed");
      }
      terminal.write(bytes);
      return Promise.resolve();
    },
  };
};

export const startCommandProcess = (
  params: CommandExecParams,
  output: OutputListener
): CommandProcess => {
  try {
    return params.tty ? startPty(params, output) : startPipe(params, output);
  } catch {
    throw new Error("Could not start command process");
  }
};
