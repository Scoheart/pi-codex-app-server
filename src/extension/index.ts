import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/app-server-config.js";
import { PiSessionPresence } from "../pi/session-presence.js";
import type { CodexServerContext } from "./codex-server-experience.js";
import { createCodexServerExperience } from "./codex-server-experience.js";
import { AppDaemonController } from "./daemon-controller.js";
import { PairingOverlay } from "./pairing-overlay.js";
import { renderPairingQrCode } from "./pairing-qr-code.js";
import { TuiSessionBridge } from "./tui-session-bridge.js";

const toCodexServerContext = (
  context: ExtensionContext,
  bridge: TuiSessionBridge
): CodexServerContext => ({
  hasUi: context.hasUI,
  notify: (message, level) => {
    context.ui.notify(message, level);
  },
  sessionId: context.sessionManager.getSessionId(),
  setStatus: (key, text) => {
    if (bridge.ownsSession) {
      context.ui.setStatus(key, text);
    }
  },
  showPairing: async ({ compactLines, fullLines }) => {
    await context.ui.custom<null>(
      (tui, _theme, _keybindings, done) =>
        new PairingOverlay({
          compactLines,
          fullLines,
          onClose: () => {
            done(null);
          },
          terminalRows: () => tui.terminal.rows,
        }),
      {
        overlay: true,
        overlayOptions: {
          margin: 1,
          maxHeight: "90%",
          width: "90%",
        },
      }
    );
  },
});

export default function piCodexAppServerExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const bridge = new TuiSessionBridge(pi, config.paths.home);
  const presence = new PiSessionPresence(config.paths.home);
  const experience = createCodexServerExperience({
    autoStart: config.autoStart,
    control: new AppDaemonController(config),
    paths: config.paths,
    remoteControlEnabled: config.remoteControl.enabled,
    renderQrCode: renderPairingQrCode,
  });

  pi.registerCommand("codex-server", {
    description: "Control the shared Codex App Server daemon",
    getArgumentCompletions: experience.getArgumentCompletions,
    handler: async (args, context) => {
      await experience.handleCommand(
        args,
        toCodexServerContext(context, bridge)
      );
    },
  });
  pi.on("session_start", async (_event, context) => {
    if (process.env.PI_CODEX_APP_SERVER_INTERNAL !== String(process.pid)) {
      await presence.start(context.sessionManager.getSessionId());
      try {
        await bridge.start(context);
      } catch (error) {
        const sessionInUse =
          error instanceof Error && "code" in error && error.code === "ELOCKED";
        context.ui.setStatus(
          "codex-server",
          sessionInUse
            ? "codex: disconnected (session in use)"
            : "codex: disconnected (bridge unavailable)"
        );
        return;
      }
    }
    await experience.handleSessionStart(toCodexServerContext(context, bridge));
  });
  pi.on("input", (event, context) => bridge.guardInput(event, context));
  pi.on("before_agent_start", (_event, context) =>
    bridge.beforeAgentStart(context)
  );
  pi.on("session_tree", () => bridge.refresh());
  pi.on("session_compact", () => bridge.refresh());
  pi.on("session_info_changed", () => bridge.nameChanged());
  pi.on("agent_start", (event) => bridge.event(event));
  pi.on("message_start", (event) => bridge.event(event));
  pi.on("message_update", (event) => bridge.event(event));
  pi.on("message_end", (event) => bridge.event(event));
  pi.on("tool_execution_start", (event) => bridge.event(event));
  pi.on("tool_execution_update", (event) => bridge.event(event));
  pi.on("tool_execution_end", (event) => bridge.event(event));
  pi.on("agent_settled", (event) => bridge.event(event));
  pi.on("session_shutdown", async (_event, context) => {
    await bridge.stop();
    await presence.stop();
    context.ui.setStatus("codex-server", undefined);
  });
}
