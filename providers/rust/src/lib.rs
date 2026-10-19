//! A reference provider agent for one text deployment of the Liquid Inference
//! exchange.
//!
//! [`session`] keeps the WebSocket session and the quote. [`dispatch`] serves
//! the awarded jobs over HTTP. [`protocol`] holds the wire types.

pub mod config;
pub mod dispatch;
pub mod journal;
pub mod protocol;
pub mod session;
pub mod state;
pub mod upstream;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::{info, warn};

use crate::config::Config;
use crate::dispatch::AppState;
use crate::journal::Journal;
use crate::state::Shared;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Runs the session and the dispatch server until `shutdown` turns true, then
/// finishes the dispatches that are in progress.
pub async fn serve(
    config: Config,
    listener: TcpListener,
    shutdown: watch::Receiver<bool>,
) -> Result<()> {
    let config = Arc::new(config);
    let shared = Arc::new(Shared::default());
    let journal = Arc::new(Journal::open(&config.award_journal)?);
    let http = reqwest::Client::builder()
        .connect_timeout(config.upstream_timeout)
        .read_timeout(config.upstream_timeout)
        .build()?;

    let session = tokio::spawn(session::run(
        config.clone(),
        shared.clone(),
        shutdown.clone(),
    ));
    let app = dispatch::router(AppState {
        config: config.clone(),
        shared,
        journal,
        http,
    });

    let mut graceful = shutdown.clone();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = graceful.wait_for(|stop| *stop).await;
    });
    let mut deadline = shutdown;
    let limit = config.shutdown_timeout;
    tokio::select! {
        result = server.into_future() => result?,
        () = async move {
            let _ = deadline.wait_for(|stop| *stop).await;
            tokio::time::sleep(limit).await;
        } => warn!("dispatches still in progress at the shutdown timeout"),
    }

    if tokio::time::timeout(Duration::from_secs(5), session)
        .await
        .is_err()
    {
        warn!("session did not stop in time");
    }
    info!("stopped");
    Ok(())
}
