use anyhow::{Context, Result};
use liquid_provider::config::Config;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let config = Config::from_env()?;
    info!(version = liquid_provider::VERSION, "starting");
    let listener = TcpListener::bind(&config.dispatch_bind)
        .await
        .with_context(|| format!("failed to bind {}", config.dispatch_bind))?;
    info!(address = %listener.local_addr()?, "dispatch bound");

    let (stop, shutdown) = watch::channel(false);
    tokio::spawn(async move {
        wait_for_signal().await;
        info!("shutting down");
        let _ = stop.send(true);
    });
    liquid_provider::serve(config, listener, shutdown).await
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
