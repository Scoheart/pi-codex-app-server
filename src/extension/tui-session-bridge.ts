import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { ThreadItem } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadItem.js";
import type { ThreadSettingsUpdateParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/ThreadSettingsUpdateParams.js";
import { findAcceptedTurn } from "../pi/accepted-turn.js";
import { projectPiConversation } from "../pi/conversation-projector.js";
import { images, textPrompt } from "../pi/live-session-manager.js";
import {
  emptyTurn,
  finishTurn,
  handleEvent,
  notifyItemStarted,
  notifyItemCompleted,
} from "../pi/live-turn.js";
import type { ActiveTurn } from "../pi/live-turn.js";
import { PiModelCatalog } from "../pi/model-catalog.js";
import { SessionOwnerHost } from "../pi/session-owner-host.js";
import type { OwnerRequest, OwnerResult } from "../pi/session-owner.js";
import {
  applyThreadSettings,
  turnThreadSettings,
  updateThreadSettings,
} from "../pi/thread-settings.js";
import type { ThreadSettingsTarget } from "../pi/thread-settings.js";
import { persistTurnReceipt } from "../pi/turn-receipt.js";
import {
  parseServerNotification,
  parseCodexWireMessage,
} from "../protocol/validation.js";

const userContentSchema = z.union([
  z.string().transform((text) => [{ text, type: "text" as const }]),
  z.array(
    z.discriminatedUnion("type", [
      z.object({ text: z.string(), type: z.literal("text") }),
      z.object({
        data: z.string(),
        mimeType: z.string(),
        type: z.literal("image"),
      }),
    ])
  ),
]);
interface HeldInput {
  readonly action: "handled";
}

export class TuiSessionBridge {
  readonly #pi: ExtensionAPI;
  readonly #home: string;
  #host?: SessionOwnerHost;
  #context?: ExtensionContext;
  #active?: ActiveTurn;
  #last?: ActiveTurn;
  #submittedPrompt?: string;
  #stopping = false;
  #settingsBusy = false;
  #settingsPreparation?: Promise<void>;
  #publishedName?: string;
  #clientMessageId: string | null = null;
  #skipUserMessages = 0;
  #acceptanceTimer?: ReturnType<typeof setTimeout>;
  constructor(pi: ExtensionAPI, home: string) {
    this.#pi = pi;
    this.#home = home;
  }
  async start(context: ExtensionContext): Promise<void> {
    await this.stop();
    this.#context = context;
    this.#stopping = false;
    const host = new SessionOwnerHost({
      handle: (request) => this.#command(request),
      home: this.#home,
      snapshot: () => {
        const active = this.#active ?? this.#last;
        return {
          historyTurnCount: active?.historyTurnCount ?? 0,
          turn: active?.turn ?? null,
        };
      },
      threadId: context.sessionManager.getSessionId(),
    });
    await host.start();
    this.#host = host;
  }
  async guardInput(
    event: InputEvent,
    context: ExtensionContext
  ): Promise<HeldInput | undefined> {
    const host = this.#host;
    if (!host) {
      return undefined;
    }
    if (this.#stopping) {
      return TuiSessionBridge.#holdInput(
        event,
        context,
        "Pi owner is stopping. Wait before sending another message."
      );
    }
    if (this.#settingsBusy && context.isIdle()) {
      return TuiSessionBridge.#holdInput(
        event,
        context,
        "Remote settings are being prepared. Wait for them to finish before sending another message."
      );
    }
    if (
      this.#submittedPrompt === undefined ||
      !context.isIdle() ||
      (event.source === "extension" && event.text === this.#submittedPrompt)
    ) {
      if (context.isIdle()) {
        this.#settingsBusy = true;
        const preparation = applyThreadSettings(this.#settingsTarget(context));
        this.#settingsPreparation = preparation;
        try {
          await preparation;
        } catch (error) {
          context.ui.notify(
            error instanceof Error
              ? error.message
              : "Pi settings could not be applied",
            "error"
          );
          return { action: "handled" };
        } finally {
          if (this.#settingsPreparation === preparation) {
            this.#settingsPreparation = undefined;
            this.#settingsBusy = false;
          }
        }
        if (this.#stopping || this.#host !== host) {
          return { action: "handled" };
        }
      }
      return undefined;
    }
    return TuiSessionBridge.#holdInput(
      event,
      context,
      "A remote message is being prepared. Wait for it to start before sending another message."
    );
  }
  async beforeAgentStart(context: ExtensionContext): Promise<void> {
    const host = this.#host;
    if (!host) {
      return;
    }
    try {
      // All input handlers have finished; Pi has reserved the run, before inference starts.
      await this.#settingsPreparation;
    } catch {
      context.abort();
    }
    if (this.#stopping || this.#host !== host) {
      context.abort();
    }
  }
  static #holdInput(
    event: InputEvent,
    context: ExtensionContext,
    message: string
  ): HeldInput {
    context.ui.notify(message, "warning");
    if (event.source === "interactive") {
      context.ui.setEditorText(event.text);
    }
    return { action: "handled" };
  }
  nameChanged(): void {
    const name = this.#pi.getSessionName();
    if (name === this.#publishedName || !this.#context) {
      return;
    }
    this.#publishedName = name;
    this.#host?.publish({
      method: "thread/name/updated",
      params: {
        threadId: this.#context.sessionManager.getSessionId(),
        threadName: name,
      },
    });
  }
  refresh(): void {
    if (!this.#active) {
      this.#last = undefined;
    }
    this.#host?.publishSnapshot();
  }
  get ownsSession(): boolean {
    return this.#host !== undefined;
  }
  #begin(rootTurnId?: string | null): ActiveTurn {
    const context = this.#context;
    if (!(context && this.#host)) {
      throw new Error("Pi TUI has no session lease");
    }
    const active: ActiveTurn = {
      agentItems: new Map(),
      connection: {
        notify: (method, params) =>
          this.#host?.publish(
            parseServerNotification(
              parseCodexWireMessage(JSON.stringify({ method, params }))
            )
          ),
      },
      historyEntryId: context.sessionManager.getBranch().at(-1)?.id ?? null,
      historyTurnCount: projectPiConversation(
        context.sessionManager.getBranch(),
        context.cwd
      ).length,
      interrupted: false,
      reasoningItems: new Map(),
      startedAtMs: Date.now(),
      threadId: context.sessionManager.getSessionId(),
      toolItems: new Map(),
      turn: emptyTurn(rootTurnId),
    };
    this.#active = active;
    active.connection.notify("thread/status/changed", {
      status: { activeFlags: [], type: "active" },
      threadId: active.threadId,
    });
    active.connection.notify("turn/started", {
      threadId: active.threadId,
      turn: active.turn,
    });
    return active;
  }
  event(event: AgentSessionEvent): void {
    if (!this.#host) {
      return;
    }
    if (event.type === "agent_start") {
      clearTimeout(this.#acceptanceTimer);
      this.#submittedPrompt = undefined;
      this.#active ??= this.#begin();
    }
    if (event.type === "message_start" && event.message.role === "user") {
      const active = this.#active ?? this.#begin();
      if (this.#skipUserMessages > 0) {
        this.#skipUserMessages -= 1;
        return;
      }
      const content = userContentSchema
        .parse(event.message.content)
        .map((part) =>
          part.type === "text"
            ? { text: part.text, text_elements: [], type: "text" as const }
            : {
                type: "image" as const,
                url: `data:${part.mimeType};base64,${part.data}`,
              }
        );
      const item: ThreadItem = {
        clientId: this.#clientMessageId,
        content,
        id: randomUUID(),
        type: "userMessage",
      };
      this.#clientMessageId = null;
      notifyItemStarted(active, item);
      notifyItemCompleted(active, item);
    }
    const active = this.#active;
    if (!active) {
      return;
    }
    handleEvent(active, event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      active.agentItems.clear();
      active.reasoningItems.clear();
    }
    if (event.type === "agent_settled") {
      if (this.#context) {
        persistTurnReceipt({
          append: (type, data) => this.#pi.appendEntry(type, data),
          entries: this.#context.sessionManager.getBranch(),
          historyEntryId: active.historyEntryId,
          threadId: active.threadId,
          turn: active.turn,
        });
      }
      this.#submittedPrompt = undefined;
      clearTimeout(this.#acceptanceTimer);
      active.interrupted ||= "aborted" in event && event.aborted === true;
      this.#last = active;
      this.#active = undefined;
      this.#skipUserMessages = 0;
      finishTurn(active);
    }
  }
  #commandContext(): ExtensionContext {
    const context = this.#context;
    if (!(context && this.#host) || this.#stopping) {
      throw new Error("Pi TUI owner is unavailable");
    }
    if (this.#settingsBusy) {
      throw new Error(
        "Pi thread settings are being prepared. Retry after they finish."
      );
    }
    return context;
  }
  async #command(request: OwnerRequest): Promise<OwnerResult> {
    const context = this.#commandContext();
    if (request.method === "thread/settings/update") {
      return await this.#updateSettings(request.params, context);
    }
    if (request.method === "thread/name/set") {
      this.#pi.setSessionName(request.params.name);
      this.nameChanged();
      return {};
    }
    if (request.method === "turn/interrupt") {
      if (this.#active?.turn.id !== request.params.turnId) {
        throw new Error("Active Pi turn changed");
      }
      this.#active.interrupted = true;
      context.abort();
      return {};
    }
    if (request.method === "thread/compact/start") {
      if (this.#active || !context.isIdle()) {
        throw new Error("Pi session is already running");
      }
      context.compact();
      return {};
    }
    const clientId = request.params.clientUserMessageId;
    const accepted =
      clientId && this.#active && this.#clientMessageId === clientId
        ? structuredClone(this.#active.turn)
        : findAcceptedTurn({
            clientId,
            cwd: context.cwd,
            entries: context.sessionManager.getBranch(),
            live: (this.#active ?? this.#last)?.turn,
          });
    if (accepted) {
      return request.method === "turn/steer"
        ? { turnId: accepted.id }
        : accepted;
    }
    if (request.method === "turn/steer") {
      return await this.#steer(request, context);
    }
    return await this.#startPrompt(request, context);
  }
  async #startPrompt(
    request: Extract<OwnerRequest, { method: "turn/start" }>,
    context: ExtensionContext
  ): Promise<OwnerResult> {
    if (this.#active || !context.isIdle()) {
      throw new Error("Pi session is already running");
    }
    const active = this.#begin(request.params.rootTurnId);
    this.#submittedPrompt = textPrompt(request.params.input);
    try {
      const inputImages = await images(request.params.input);
      await applyThreadSettings(
        this.#settingsTarget(context),
        turnThreadSettings(request.params)
      );
      if (this.#stopping) {
        throw new Error("Pi session owner is shutting down");
      }
      this.#clientMessageId = request.params.clientUserMessageId ?? null;
      this.#acceptanceTimer = setTimeout(() => {
        if (this.#active === active && context.isIdle()) {
          this.#submittedPrompt = undefined;
          active.failure = new Error("Pi did not start the submitted message");
          this.#last = active;
          this.#active = undefined;
          finishTurn(active);
        }
      }, 5000);
      this.#pi.sendUserMessage([
        { text: textPrompt(request.params.input), type: "text" },
        ...inputImages,
      ]);
      return active.turn;
    } catch (error) {
      this.#submittedPrompt = undefined;
      active.failure =
        error instanceof Error
          ? error
          : new Error("Pi rejected the submitted message");
      this.#last = active;
      this.#active = undefined;
      finishTurn(active);
      throw error;
    }
  }
  async #updateSettings(
    params: ThreadSettingsUpdateParams,
    context: ExtensionContext
  ): Promise<OwnerResult> {
    this.#settingsBusy = true;
    const preparation = updateThreadSettings(
      params,
      this.#settingsTarget(context),
      !!this.#active || !context.isIdle()
    );
    this.#settingsPreparation = preparation;
    try {
      await preparation;
      return {};
    } finally {
      if (this.#settingsPreparation === preparation) {
        this.#settingsPreparation = undefined;
        this.#settingsBusy = false;
      }
    }
  }
  #settingsTarget(context: ExtensionContext): ThreadSettingsTarget {
    return {
      append: (type, data) => this.#pi.appendEntry(type, data),
      cwd: context.cwd,
      effort: this.#pi.getThinkingLevel(),
      entries: context.sessionManager.getBranch(),
      model: context.model,
      resolve: (key) =>
        context.modelRegistry
          .getAvailable()
          .find((model) => PiModelCatalog.key(model) === key),
      setEffort: (effort) => this.#pi.setThinkingLevel(effort),
      setModel: async (model) => {
        if (!(await this.#pi.setModel(model))) {
          throw new Error(
            `Pi model is unavailable: ${PiModelCatalog.key(model)}`
          );
        }
      },
    };
  }
  async #steer(
    request: Extract<OwnerRequest, { method: "turn/steer" }>,
    context: ExtensionContext
  ): Promise<OwnerResult> {
    const active = this.#active;
    if (
      !active ||
      active.turn.id !== request.params.expectedTurnId ||
      context.isIdle()
    ) {
      throw new Error("Active Pi turn changed");
    }
    const inputImages = await images(request.params.input);
    this.#pi.sendUserMessage(
      [
        { text: textPrompt(request.params.input), type: "text" },
        ...inputImages,
      ],
      { deliverAs: "steer" }
    );
    const item: ThreadItem = {
      clientId: request.params.clientUserMessageId ?? null,
      content: request.params.input,
      id: randomUUID(),
      type: "userMessage",
    };
    this.#skipUserMessages += 1;
    notifyItemStarted(active, item);
    notifyItemCompleted(active, item);
    return { turnId: active.turn.id };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#submittedPrompt = undefined;
    clearTimeout(this.#acceptanceTimer);
    if (this.#active) {
      this.#active.interrupted = true;
      finishTurn(this.#active);
      this.#context?.abort();
    }
    if (this.#context && !this.#context.isIdle()) {
      this.#context.abort();
    }
    await this.#settingsPreparation?.catch(() => {
      // The originating input or RPC handler reports this failure; shutdown still drains it.
    });
    const deadline = Date.now() + 15_000;
    while (this.#context && !this.#context.isIdle()) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Pi is still stopping; its writer lease is retained. Retry once the session is idle."
        );
      }
      // eslint-disable-next-line no-await-in-loop -- Observe actual SDK idle state, including failed preflight without agent_settled.
      await delay(10);
    }
    await this.#host?.stop();
    this.#host = undefined;
    this.#context = undefined;
    this.#active = undefined;
    this.#last = undefined;
    this.#skipUserMessages = 0;
    this.#publishedName = undefined;
  }
}
