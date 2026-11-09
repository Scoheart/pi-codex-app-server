import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { lock } from "proper-lockfile";
import { z } from "zod";

import type { ClientRequest } from "../../vendor/openai-codex-app-server-protocol/typescript/ClientRequest.js";
import type { ServerNotification } from "../../vendor/openai-codex-app-server-protocol/typescript/ServerNotification.js";
import type { Turn } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/Turn.js";

export const ownerPath = (home: string, threadId: string): string =>
  path.join(
    home,
    "owners",
    createHash("sha256").update(threadId).digest("hex")
  );
export const descriptorSchema = z.object({
  pid: z.number().int().positive(),
  protocolVersion: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .default(1),
  threadId: z.string(),
  token: z.string().uuid(),
  url: z.string().url(),
});
export const packetSchema = z.discriminatedUnion("type", [
  z.object({
    historyTurnCount: z.number().int().nonnegative(),
    turn: z.json().nullable(),
    type: z.literal("snapshot"),
  }),
  z.object({ notification: z.json(), type: z.literal("event") }),
  z.object({
    error: z.string().optional(),
    id: z.string(),
    result: z.json().optional(),
    type: z.literal("response"),
  }),
]);
export type OwnerResult =
  | Turn
  | { readonly turnId: string }
  | Record<string, never>;
export type OwnerPacket =
  | { type: "event"; notification: ServerNotification }
  | ({ type: "snapshot" } & OwnerSnapshot);
export interface OwnerSnapshot {
  readonly historyTurnCount: number;
  readonly turn: Turn | null;
}
export type OwnerRequest = Extract<
  ClientRequest,
  {
    method:
      | "turn/start"
      | "turn/steer"
      | "turn/interrupt"
      | "thread/compact/start"
      | "thread/settings/update"
      | "thread/name/set";
  }
>;

export const acquireSessionLease = async (
  home: string,
  threadId: string
): Promise<() => Promise<void>> => {
  const file = ownerPath(home, threadId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "", { flag: "a", mode: 0o600 });
  return await lock(file, { retries: 0, stale: 30_000, update: 10_000 });
};
