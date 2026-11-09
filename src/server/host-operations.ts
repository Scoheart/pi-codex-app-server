import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { appServerLogger } from "../logging/app-server-logger.js";
import type { JsonRpcConnection } from "../protocol/json-rpc-connection.js";
import { registerCommandExec } from "./command-exec.js";

interface ProcessOutput {
  buffers: Buffer[];
  count: number;
  reached: boolean;
}
const createOutput = (): ProcessOutput => ({
  buffers: [],
  count: 0,
  reached: false,
});

const absolutePath = (value: string): string => {
  if (!path.isAbsolute(value)) {
    throw new Error("Expected an absolute host path");
  }
  return path.resolve(value);
};

export const registerHostOperations = (connection: JsonRpcConnection): void => {
  registerCommandExec(connection);
  const processes = new Map<string, ChildProcessWithoutNullStreams>();
  const watches = new Map<string, FSWatcher>();
  let watchingConnection = false;
  connection.registerRequest("fs/watch", async (params, context) => {
    const file = absolutePath(params.path);
    let target = file;
    let directory = false;
    try {
      const info = await stat(file);
      directory = info.isDirectory();
      target = await realpath(file);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    const watched = directory ? target : path.dirname(target);
    const watcher = watch(
      watched,
      { recursive: directory },
      (_event, filename) => {
        const changed = filename
          ? path.resolve(watched, filename.toString())
          : target;
        if (
          watches.get(params.watchId) !== watcher ||
          (!directory && changed !== target)
        ) {
          return;
        }
        connection.notify("fs/changed", {
          changedPaths: [changed],
          watchId: params.watchId,
        });
      }
    );
    watcher.on("error", (error) => {
      watcher.close();
      if (watches.get(params.watchId) === watcher) {
        watches.delete(params.watchId);
      }
      appServerLogger.warn(error, { watchId: params.watchId });
    });
    if (context.signal.aborted) {
      watcher.close();
      throw new Error("Filesystem watch connection is closed");
    }
    watches.get(params.watchId)?.close();
    watches.set(params.watchId, watcher);
    if (!watchingConnection) {
      watchingConnection = true;
      context.signal.addEventListener(
        "abort",
        () => {
          for (const current of watches.values()) {
            current.close();
          }
          watches.clear();
        },
        { once: true }
      );
    }
    return { path: target };
  });
  connection.registerRequest("fs/unwatch", (params) => {
    watches.get(params.watchId)?.close();
    watches.delete(params.watchId);
    return {};
  });
  connection.registerRequest("fs/createDirectory", async (params) => {
    await mkdir(absolutePath(params.path), {
      recursive: params.recursive ?? true,
    });
    return {};
  });
  connection.registerRequest("fs/getMetadata", async (params) => {
    const file = absolutePath(params.path);
    const link = await lstat(file);
    const target = link.isSymbolicLink() ? await stat(file) : link;
    return {
      createdAtMs: Math.trunc(target.birthtimeMs),
      isDirectory: target.isDirectory(),
      isFile: target.isFile(),
      isSymlink: link.isSymbolicLink(),
      modifiedAtMs: Math.trunc(target.mtimeMs),
    };
  });
  connection.registerRequest("fs/readFile", async (params) => {
    const bytes = await readFile(absolutePath(params.path));
    return { dataBase64: bytes.toString("base64") };
  });
  connection.registerRequest("fs/readDirectory", async (params) => {
    const directory = await readdir(absolutePath(params.path), {
      withFileTypes: true,
    });
    return {
      entries: await Promise.all(
        directory.map(async (entry) => {
          const target = entry.isSymbolicLink()
            ? await stat(path.join(params.path, entry.name))
            : entry;
          return {
            fileName: entry.name,
            isDirectory: target.isDirectory(),
            isFile: target.isFile(),
          };
        })
      ),
    };
  });
  connection.registerRequest("fs/remove", async (params) => {
    const file = absolutePath(params.path);
    if (path.parse(file).root === file) {
      throw new Error("Cannot remove a filesystem root");
    }
    await rm(file, {
      force: params.force ?? true,
      recursive: params.recursive ?? true,
    });
    return {};
  });
  connection.registerRequest("process/spawn", async (params, context) => {
    if (params.tty || params.size) {
      throw new Error("PTY processes are not supported by the Pi host");
    }
    if (!params.command.length || processes.has(params.processHandle)) {
      throw new Error("Expected a command and an unused process handle");
    }
    const env = { ...process.env };
    for (const [key, value] of Object.entries(params.env ?? {})) {
      if (value === null) {
        Reflect.deleteProperty(env, key);
      } else if (value !== undefined) {
        env[key] = value;
      }
    }
    const child = spawn(params.command[0] ?? "", params.command.slice(1), {
      cwd: absolutePath(params.cwd),
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    child.on("error", (error) => {
      appServerLogger.warn(error, { processHandle: params.processHandle });
    });
    let started = false;
    child.once("spawn", () => {
      started = true;
    });
    processes.set(params.processHandle, child);
    const cap =
      params.outputBytesCap === null
        ? Number.POSITIVE_INFINITY
        : (params.outputBytesCap ?? 1024 * 1024);
    const outputs = {
      stderr: createOutput(),
      stdout: createOutput(),
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (data: Buffer) => {
        const output = outputs[stream];
        const remaining = Math.max(0, cap - output.count);
        const bytes = data.subarray(0, remaining);
        output.count += bytes.length;
        const capped = data.length > remaining;
        if (params.streamStdoutStderr) {
          if (bytes.length || (capped && !output.reached)) {
            connection.notify("process/outputDelta", {
              capReached: capped,
              deltaBase64: bytes.toString("base64"),
              processHandle: params.processHandle,
              stream,
            });
          }
        } else if (bytes.length) {
          output.buffers.push(bytes);
        }
        output.reached ||= capped;
      });
    }
    const abort = (): void => {
      child.kill();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    const timeout =
      params.timeoutMs === null
        ? undefined
        : setTimeout(abort, params.timeoutMs ?? 30_000);
    timeout?.unref();
    child.once("close", (code) => {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
      if (processes.get(params.processHandle) === child) {
        processes.delete(params.processHandle);
      }
      if (started && !context.signal.aborted) {
        connection.notify("process/exited", {
          exitCode: code ?? -1,
          processHandle: params.processHandle,
          stderr: Buffer.concat(outputs.stderr.buffers).toString("utf-8"),
          stderrCapReached: outputs.stderr.reached,
          stdout: Buffer.concat(outputs.stdout.buffers).toString("utf-8"),
          stdoutCapReached: outputs.stdout.reached,
        });
      }
    });
    try {
      await once(child, "spawn");
    } catch (error) {
      processes.delete(params.processHandle);
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
      throw error;
    }
    if (!params.streamStdin) {
      child.stdin.end();
    }
    return {};
  });
  connection.registerRequest("process/kill", (params) => {
    const child = processes.get(params.processHandle);
    if (!child) {
      throw new Error("Unknown process handle");
    }
    child.kill();
    return {};
  });
  connection.registerRequest("process/writeStdin", async (params) => {
    const child = processes.get(params.processHandle);
    if (!child || child.stdin.writableEnded) {
      throw new Error("Process stdin is closed");
    }
    if (params.deltaBase64) {
      const bytes = Buffer.from(params.deltaBase64, "base64");
      const write = Promise.withResolvers<undefined>();
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Node's writable callback reports completion and write errors for these bytes.
      child.stdin.write(bytes, (error) => {
        if (error) {
          write.reject(error);
        } else {
          write.resolve();
        }
      });
      await write.promise;
    }
    if (params.closeStdin) {
      child.stdin.end();
    }
    return {};
  });
};
