/* oxlint-disable anti-slop/no-runtime-typeof -- Traverse parsed JSON for a versioned migration; the public Ajv schema validates the resulting contract. */
import type { JsonValue } from "../protocol/validation.js";

const record = (
  value: JsonValue | undefined
): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const addNullable = (value: Record<string, JsonValue>, field: string): void => {
  if (!(field in value)) {
    value[field] = null;
  }
};
const migrateItem = (value: JsonValue): void => {
  const item = record(value);
  if (item?.type === "agentMessage") {
    addNullable(item, "questions");
  }
};
const migrateError = (value: JsonValue | undefined): void => {
  const error = record(value);
  if (error) {
    addNullable(error, "misalignment");
  }
};

// Version 1 owners remain alive across daemon upgrades until Pi runs /reload.
// Migrate their 0.149 fields here, before strict validation against the public snapshot.
export const migrateOwnerTurn = (
  value: JsonValue,
  version: 1 | 2 | 3
): JsonValue => {
  if (version !== 1) {
    return value;
  }
  const migrated = structuredClone(value);
  const turn = record(migrated);
  if (turn) {
    addNullable(turn, "rootTurnId");
    migrateError(turn.error);
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        migrateItem(item);
      }
    }
  }
  return migrated;
};

export const migrateOwnerNotification = (
  value: JsonValue,
  version: 1 | 2 | 3
): JsonValue => {
  if (version !== 1) {
    return value;
  }
  const migrated = structuredClone(value);
  const notification = record(migrated);
  const params = record(notification?.params);
  if (notification && params) {
    if (
      (notification.method === "turn/started" ||
        notification.method === "turn/completed") &&
      params.turn !== undefined
    ) {
      params.turn = migrateOwnerTurn(params.turn, version);
    } else if (
      (notification.method === "item/started" ||
        notification.method === "item/completed") &&
      params.item !== undefined
    ) {
      migrateItem(params.item);
    } else if (notification.method === "error") {
      migrateError(params.error);
    }
  }
  return migrated;
};
