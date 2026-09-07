# SixtoNet Remote

## Existing-user session and notice candidate (2026-09-07)

This branch now requires windows_session_id, windows_username, windows_domain and
operator in the SYSTEM/Admin-only session configuration. It is incompatible with
older agent configurations. The agent selects an existing active Windows user;
parent/child verify the target identity and the child verifies its own session ID.
The parent ends the capture child if that user session disconnects or changes.
No new Windows login, session transfer, RDP disconnect or logoff is performed.

The child prepares a native notice and displays it after remote authentication.
The notice identifies the grant's operator, shows view-only/input-permitted access,
and provides End support session. User close/stop yields exit code 74, propagated
by the parent for the agent to end the support grant. This is an endpoint UI, not
the technician workspace; ordinary users need no technician application.

Standalone Windows notice/session-validation tests and agent/browser fixtures
passed. Full component and integrated selected-RDP-session capture, stop propagation,
lock/UAC transitions and signing require release acceptance. This candidate is not
a claim that the existing minimized-RDP capture problem is fixed. An ordinary notice
window is not visible on Windows secure desktop. Historical console-only selection
and absence-of-notice statements below are superseded for this candidate source.


This is a modified AGPL-3.0 RustDesk distribution, not an upstream RustDesk release.
Upstream: https://github.com/rustdesk/rustdesk (baseline tag `1.4.9`).
Corresponding source: https://github.com/hanvansolo/sixtonet-remote/tree/sixtonet-console-capture

Console-capture correction: browser support selects the physical Windows console,
independently of an active or minimized Microsoft RDP session. It does not transfer
sessions, disconnect RDP, unlock Windows or bypass the Windows logon screen.

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
shares the physical Windows console independently of active RDP sessions,
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

Preview scope: video, monitor selection, fullscreen, quality, mouse and keyboard.
Not yet implemented/verified in the browser: audio, clipboard sync, native file
transfer, chat, recording, privacy mode, remote printing, tunnelling, wake-on-LAN,
reboot/reconnect, mobile control, cross-platform agents and all display/session
transition cases. Do not describe retaining those upstream sources as delivering
those browser features. The existing SixtoNet terminal/files tools are separate.

Release gates: successful Windows build; lab capture/input including lock/UAC and
disconnect tests; visible endpoint session indication; signed release artifacts;
agent bundle checksum/preflight and canary validation. Until those gates pass,
the adapter is an unsigned test artifact, not a customer rollout.
