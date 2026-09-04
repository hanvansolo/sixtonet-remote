// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 SixtoNet contributors
//! An outbound, one-session adapter for the unmodified RustDesk media services.
//! The SYSTEM RMM agent verifies the signed grant and writes this configuration
//! in its SYSTEM/Administrators-only directory. No browser supplies a host, port,
//! process, Windows session id, or capability bitmap directly to this adapter.

use hbb_common::{bail, config::Config, tokio, ResultType, Stream};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static PASSWORD: OnceLock<String> = OnceLock::new();

pub fn session_password() -> Option<&'static str> {
    PASSWORD.get().map(String::as_str)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionConfig {
    pub port: u16,
    pub nonce: String,
    pub password: String,
    pub expires_at: u64,
    pub input: bool,
    pub clipboard: bool,
    pub audio: bool,
}

impl SessionConfig {
    pub fn validate(&self, now: u64) -> ResultType<()> {
        if self.port < 1024
            || self.nonce.len() != 64
            || self.password.len() != 64
            || !self.nonce.bytes().all(|b| b.is_ascii_hexdigit())
            || !self.password.bytes().all(|b| b.is_ascii_hexdigit())
            || self.expires_at <= now
            || self.expires_at > now.saturating_add(7200)
        {
            bail!("invalid or expired SixtoNet desktop session");
        }
        Ok(())
    }

    fn permissions(&self) -> u64 {
        // RustDesk uses two bits per permission: 1=deny, 2=allow. Explicitly
        // deny every capability first so local settings cannot widen a grant.
        let mut bits = 0x5555_5555_5555_5555u64;
        for (index, allowed) in [(0, self.input), (2, self.clipboard), (4, self.audio)] {
            if allowed {
                bits = (bits & !(3 << (index * 2))) | (2 << (index * 2));
            }
        }
        bits
    }
}

pub fn now() -> ResultType<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

pub fn read_config(path: &Path) -> ResultType<SessionConfig> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > 4096 {
        bail!("desktop session configuration is too large");
    }
    let cfg: SessionConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    cfg.validate(now()?)?;
    Ok(cfg)
}

pub async fn serve(cfg: SessionConfig) -> ResultType<()> {
    cfg.validate(now()?)?;
    PASSWORD
        .set(cfg.password.clone())
        .map_err(|_| hbb_common::anyhow::anyhow!("session already initialized"))?;
    *hbb_common::config::APP_NAME.write().unwrap() = "SixtoNet Remote".to_owned();
    Config::set_option("approve-mode".into(), "password".into());
    Config::set_option("custom-rendezvous-server".into(), "127.0.0.1:9".into());
    Config::set_option("api-server".into(), String::new());
    Config::set_option("direct-server".into(), "N".into());
    // Only connect to the authenticated local agent. Do not start RustDesk's
    // rendezvous mediator, LAN discovery, listener, updater, or desktop client.
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let socket = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect(addr),
    )
    .await??;
    socket.set_nodelay(true)?;
    let mut stream = Stream::from(socket, addr);
    let (_, key) = Config::get_key_pair();
    let ready = serde_json::json!({"nonce": cfg.nonce, "id": Config::get_id(), "public_key": key});
    stream.send_raw(serde_json::to_vec(&ready)?).await?;
    let server = crate::server::new();
    let meta = crate::server::ConnectionMeta {
        control_permissions: Some(hbb_common::rendezvous_proto::ControlPermissions {
            permissions: cfg.permissions(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let remaining = cfg.expires_at.saturating_sub(now()?);
    tokio::time::timeout(
        Duration::from_secs(remaining),
        crate::server::create_tcp_connection(server, stream, addr, true, meta),
    )
    .await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> SessionConfig {
        SessionConfig {
            port: 45000,
            nonce: "a".repeat(64),
            password: "b".repeat(64),
            expires_at: 1060,
            input: false,
            clipboard: false,
            audio: false,
        }
    }
    #[test]
    fn grant_boundaries() {
        let mut c = config();
        assert!(c.validate(1000).is_ok());
        assert!(c.validate(1060).is_err());
        c.expires_at = 8201;
        assert!(c.validate(1000).is_err());
        c.expires_at = 1060;
        c.port = 443;
        assert!(c.validate(1000).is_err());
    }
    #[test]
    fn permissions_are_explicit_and_least_privilege() {
        let mut c = config();
        assert_eq!(c.permissions(), 0x5555_5555_5555_5555);
        c.input = true;
        assert_eq!(c.permissions() & 3, 2);
        assert_eq!((c.permissions() >> 6) & 3, 1); // files not implicitly allowed
        assert_eq!((c.permissions() >> 8) & 3, 1); // audio not implicitly allowed
    }
}
