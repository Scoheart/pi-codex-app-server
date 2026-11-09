# Changelog

## 0.3.0 (unreleased source fork)

- Add the mobile folder picker command protocol: buffered/streamed output, stdin, PTY sizing, resize and termination.
- Keep backpressured commands interruptible, preserve stdin close ordering, and clean up POSIX process groups after disconnects or timeouts.
- Sanitize process-start errors so command arguments do not enter diagnostics.
- Honor proxy environment variables for standalone HTTP requests and relay WebSockets, including NO_PROXY bypass.
- Retain upstream attribution and mark the package private; this source fork is not published to npm.

## 0.2.1 (2026-10-23)

- Fix the extension exiting native Pi when `pi -c` opens a session whose app-server lease is already held by another window.
- Keep native Pi input available when app-server attachment fails, with a short disconnected status in the footer.
- Replace the verbose daemon footer with `codex: connected` or `codex: disconnected`. Keep connection details in `/codex-server status` and prevent daemon commands from overwriting a failed session attachment status.

The app-server lease remains exclusive. Disconnected windows use native Pi behavior; the app-server does not coordinate their history writes with the attached owner. No launcher or Pi runtime changes are required.

## 0.2.0 (2026-10-15)

- Publish the fork identity as `@pi-switch/pi-codex-app-server`, retaining the `pi-codex-app-server` command.
- Share native Pi TUI sessions with Codex through a single-writer owner bridge.
- Recover desktop history, runtime status, and relay sequence state across reconnects.
- Deliver turn completion before idle status so clients can release their streams safely.
- Preserve completed-turn and client message identities in Pi history across owner and daemon reconnects.
- Suppress duplicate execution of accepted client message identities and redundant desktop thread announcements.
- Discover native desktop host tools by capability when saved endpoints become stale.
- Show Codex model names without the redundant provider prefix.
- Synchronize newly published chats through native desktop host tools.
- Add session publication controls and protocol generation with verified artifact digests.
- Remove the bundled skill collection and replace generic guidance with project contracts.
- Add user, architecture, development, packaging, and acceptance documentation.
- Verify pull requests and package installation before release.
- Target Pi 1.2.0 with matching SDK dependencies and a 1.2.x peer contract.
- Reuse unchanged session summaries, coalesce catalog scans, and batch metadata writes during client startup.
- Publish only active sessions by default and refresh recent desktop section order across hosts.
- Add reusable `just` sidebar recovery commands for local, WSL, and exported remote catalogs, with preview, backup, and offline apply.

The releases below are retained upstream history from Lqm1/pi-codex-app-server.

## [0.1.2](https://github.com/Lqm1/pi-codex-app-server/compare/pi-codex-app-server-v0.1.1...pi-codex-app-server-v0.1.2) (2026-10-14)


### Bug Fixes

* harden remote control stream lifecycle ([#6](https://github.com/Lqm1/pi-codex-app-server/issues/6)) ([7748520](https://github.com/Lqm1/pi-codex-app-server/commit/7748520979dc6c52a5c307a5f977464e4f398647))
* ignore system messages when projecting Pi history ([#7](https://github.com/Lqm1/pi-codex-app-server/issues/7)) ([0caef0b](https://github.com/Lqm1/pi-codex-app-server/commit/0caef0b49507d9ce1322e9786f057a3b912371e9))

## [0.1.1](https://github.com/Lqm1/pi-codex-app-server/compare/pi-codex-app-server-v0.1.0...pi-codex-app-server-v0.1.1) (2026-08-24)


### Bug Fixes

* install Pi runtime dependencies for daemon ([e210406](https://github.com/Lqm1/pi-codex-app-server/commit/e21040653a69bd9f8522439df8baf92a91eaca84))

## 0.1.0 (2026-08-24)

### Features

- implement Pi-backed Codex app server ([b57a170](https://github.com/Lqm1/pi-codex-app-server/commit/b57a1707cdae64146839a16708c8ed2e75ce5447))
- improve Codex server extension controls ([04d120f](https://github.com/Lqm1/pi-codex-app-server/commit/04d120fe01c170a2fb5a4db44df43b31dfe82f85))

### Bug Fixes

- show pairing QR code in an overlay ([b3d3033](https://github.com/Lqm1/pi-codex-app-server/commit/b3d3033751eb5b041637636d22c4e6449d2c4458))
- show provider names in model catalog ([ea5b261](https://github.com/Lqm1/pi-codex-app-server/commit/ea5b2613d1d4c0a51c03d35c5ae1b0baacd97c00))

### Miscellaneous Chores

- prepare initial release ([9c1c371](https://github.com/Lqm1/pi-codex-app-server/commit/9c1c371037fcce662980c4271b755824e3c821d4))
