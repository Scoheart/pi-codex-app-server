import path from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { ThreadSettingsUpdateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSettingsUpdateParams.js";
import type { TurnStartParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/TurnStartParams.js";
import { PiModelCatalog } from "./model-catalog.js";

const SETTINGS_TYPE = "codex-app-server.pending-settings.v1";
const effortSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const settingsSchema = z.strictObject({
  effort: effortSchema.optional(),
  model: z.string().min(1).max(1024).optional(),
});
export type PiThreadSettings = z.infer<typeof settingsSchema>;

export interface ThreadSettingsTarget {
  readonly cwd: string;
  readonly model: Model<string> | undefined;
  readonly effort: string;
  readonly entries: readonly SessionEntry[];
  readonly resolve: (key: string) => Model<string> | undefined;
  readonly append: (type: string, settings: PiThreadSettings) => void;
  readonly setModel: (model: Model<string>) => Promise<void>;
  readonly setEffort: (effort: z.infer<typeof effortSchema>) => void;
}

export const pendingThreadSettings = (
  entries: readonly SessionEntry[]
): PiThreadSettings => {
  const entry = entries.findLast(
    (candidate) =>
      candidate.type === "custom" && candidate.customType === SETTINGS_TYPE
  );
  if (!entry || entry.type !== "custom") {
    return {};
  }
  const parsed = settingsSchema.safeParse(entry.data);
  if (!parsed.success) {
    throw new Error("Invalid persisted Pi thread settings");
  }
  return parsed.data;
};

const unsupported = (field: string): never => {
  throw new Error(`Pi does not support thread setting: ${field}`);
};

export const turnThreadSettings = (
  params: Pick<TurnStartParams, "model" | "effort">
): PiThreadSettings => {
  const settings: PiThreadSettings = {};
  if (params.model !== undefined && params.model !== null) {
    if (!params.model) {
      throw new Error("Unknown Pi model: empty model identifier");
    }
    settings.model = params.model;
  }
  if (params.effort !== undefined && params.effort !== null) {
    const effort = effortSchema.safeParse(
      params.effort === "none" ? "off" : params.effort
    );
    if (!effort.success) {
      unsupported("effort");
    }
    settings.effort = effort.data;
  }
  return settings;
};

type ThreadSettingValue =
  ThreadSettingsUpdateParams[keyof ThreadSettingsUpdateParams];
const assertNeutral = (
  field: string,
  value: ThreadSettingValue,
  expected: string | null = null
): void => {
  if (value !== undefined && value !== null && value !== expected) {
    unsupported(field);
  }
};

const validateNeutralSettings = (
  params: ThreadSettingsUpdateParams,
  cwd: string
): void => {
  if (
    params.cwd !== undefined &&
    params.cwd !== null &&
    path.resolve(params.cwd) !== path.resolve(cwd)
  ) {
    throw new Error(
      "Pi working directories are session-bound. Create a new thread in the selected directory."
    );
  }
  assertNeutral(
    "approvalPolicy (Pi runs without approval enforcement)",
    params.approvalPolicy,
    "never"
  );
  assertNeutral("approvalsReviewer", params.approvalsReviewer, "user");
  assertNeutral(
    "sandboxPolicy (Pi runs with full host access)",
    params.sandboxPolicy?.type,
    "dangerFullAccess"
  );
  assertNeutral("permissions", params.permissions);
  assertNeutral("serviceTier", params.serviceTier);
  assertNeutral("summary", params.summary, "auto");
  if (params.disabledPluginIds?.length) {
    unsupported("disabledPluginIds");
  }
  assertNeutral("collaborationMode", params.collaborationMode);
  // multiAgentMode and personality are inert in the vendored protocol.
};

const resolveSettings = (
  settings: PiThreadSettings,
  target: ThreadSettingsTarget
): Model<string> | undefined => {
  const model = settings.model ? target.resolve(settings.model) : target.model;
  if (settings.model && !model) {
    throw new Error(
      `Unknown Pi model or unavailable provider: ${settings.model}`
    );
  }
  if (
    settings.effort &&
    (!model || !getSupportedThinkingLevels(model).includes(settings.effort))
  ) {
    throw new Error(
      `Pi model does not support reasoning effort: ${settings.effort}`
    );
  }
  return model;
};

export const applyThreadSettings = async (
  target: ThreadSettingsTarget,
  overrides: PiThreadSettings = {}
): Promise<void> => {
  const pending = pendingThreadSettings(target.entries);
  const settings = { ...pending, ...overrides };
  const model = resolveSettings(settings, target);
  if (
    settings.model &&
    model &&
    (!target.model ||
      PiModelCatalog.key(model) !== PiModelCatalog.key(target.model))
  ) {
    await target.setModel(model);
  }
  if (settings.effort) {
    target.setEffort(settings.effort);
  }
  if (Object.keys(pending).length) {
    target.append(SETTINGS_TYPE, {});
  }
};

export const updateThreadSettings = async (
  params: ThreadSettingsUpdateParams,
  target: ThreadSettingsTarget,
  working: boolean
): Promise<void> => {
  validateNeutralSettings(params, target.cwd);
  const changes = turnThreadSettings(params);
  if (params.model !== undefined && params.model !== null) {
    const model = target.resolve(params.model);
    if (!model) {
      throw new Error(
        `Unknown Pi model or unavailable provider: ${params.model}`
      );
    }
    changes.model = PiModelCatalog.key(model);
  }
  const pending = pendingThreadSettings(target.entries);
  const settings = { ...pending, ...changes };
  resolveSettings(settings, target);
  if (working) {
    // Only the leased Pi writer appends this entry. In-flight inference is untouched.
    const modelChanged =
      settings.model !== undefined &&
      settings.model !==
        (pending.model ??
          (target.model ? PiModelCatalog.key(target.model) : undefined));
    const effortChanged =
      settings.effort !== undefined &&
      settings.effort !== (pending.effort ?? target.effort);
    if (modelChanged || effortChanged) {
      target.append(SETTINGS_TYPE, settings);
    }
  } else {
    await applyThreadSettings(target, changes);
  }
};
