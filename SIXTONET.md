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

Existing runtime changes are limited to two `sixtonet` feature-gated hooks in
`src/server/connection.rs`: use the in-memory session password, and do not start
the separate native connection-manager UI. Both hooks are inactive for ordinary
RustDesk sessions. `Cargo.toml` and `src/lib.rs` register the opt-in adapter.
No other upstream capture, encoding, input, or authorization paths are replaced.
