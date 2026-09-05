# SixtoNet Remote

This is a modified AGPL-3.0 RustDesk distribution, not an upstream RustDesk release.
Upstream: https://github.com/rustdesk/rustdesk (baseline tag `1.4.9`).
Corresponding source: https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet

Keep `LICENCE`, upstream copyright notices, submodule source references, and this
source offer with every binary and in the browser viewer's About/Source link.

## Integration boundary

`sixtonet-desktop` is a Windows-only, outbound adapter around RustDesk's existing
video, cursor, input, audio and protocol services. It runs only for an audited,
time-limited SixtoNet session. It does not use public RustDesk servers, create a
public listener, install a technician app, or store a reusable desktop password.
The existing RMM agent validates the signed grant before starting it.

The agent supplies a SYSTEM/Administrators-only
`%ProgramData%\SixtoNet\desktop\session.json`, with a random local IPC port,
64-hex-character IPC nonce and session password, expiry (at most two hours), and
explicit input/clipboard/audio permissions. The adapter opens an outbound local
connection, identifies itself with the nonce and signing public key, then speaks
RustDesk's framed protocol. The agent carries those frames through its authenticated
relay. Browser and adapter negotiate RustDesk's encrypted stream using the attested
public key. Removing the session file closes the native process.

## Status and regression surface

This is integration work in progress, not a claim of browser feature parity.
The RustDesk native code is retained in full. The browser viewer and agent relay
must pass end-to-end tests before this adapter can be released to endpoints.

Existing runtime changes include `sixtonet` feature-gated hooks in
`src/server/connection.rs`: use the in-memory session password, and do not start
the separate native connection-manager UI. Both hooks are inactive for ordinary
RustDesk sessions. `Cargo.toml` and `src/lib.rs` register the opt-in adapter.
`src/server.rs` additionally refuses the legacy unencrypted handshake fallback
only for the initialized SixtoNet adapter. Ordinary RustDesk paths are unchanged.
No upstream capture, encoding, or input implementations are replaced. The adapter
follows the active Windows user session (including an active non-console session),
without performing a Windows logon or bypassing its lock screen. Clipboard hooks
restrict the browser adapter to uncompressed UTF-8 text, at most 1 MiB, when the
signed session separately grants two-way clipboard sharing.

`sixtonet-web` contains the AGPL browser adapter and its pinned npm build. It uses
the pinned `hbb_common` protobuf schema, TweetNaCl and WebCodecs VP9; no screenshots,
WASM codec downloads, external CDN scripts, or technician-side native executable.
Run `npm ci`, `npm test`, and `npm run build` in that directory. The generated
`dist/desktop.js` is the asset served by the SixtoNet console. Preserve its source
notice. The source here plus the recursively pinned native submodules and build
workflow are the reproducible source for this component.

Preview scope: video, monitor selection, fullscreen, quality, mouse and keyboard,
exact Unicode character typing, fit/actual size, and a browser pop-out that retains
the existing encrypted connection. Keep the dashboard open; closing it ends the
pop-out too. Text clipboard sharing is separately granted in the session dialog:
Ctrl+V or Paste local clipboard sends local text; Copy remote clipboard retrieves
received text using a browser clipboard-write gesture. No background local clipboard
reads/writes, rich clipboard formats, or clipboard logging. Native acceptance of
the text clipboard/session-selection changes still requires the canary checks.
Not yet implemented/verified in the browser: audio, native file
transfer, chat, recording, privacy mode, remote printing, tunnelling, wake-on-LAN,
reboot/reconnect, mobile control, cross-platform agents and all display/session
transition cases. Do not describe retaining those upstream sources as delivering
those browser features. The existing SixtoNet terminal/files tools are separate.

Release gates: successful Windows build; lab capture/input including lock/UAC and
disconnect tests; visible endpoint session indication; signed release artifacts;
agent bundle checksum/preflight and canary validation. Until those gates pass,
the adapter is an unsigned test artifact, not a customer rollout.
