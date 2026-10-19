//! The WebSocket session: login, quotes and reconnects.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::watch;
use tokio::time::{Instant, interval_at, sleep, sleep_until};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::Config;
use crate::protocol::{
    ExchangeMessage, ExecutionLimits, ProviderMessage, Quote, QuoteTarget, ServiceClass,
};
use crate::state::{Shared, Snapshot};

const FIRST_BACKOFF: Duration = Duration::from_millis(250);
const LAST_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
pub enum Flow {
    Continue,
    Superseded,
}

/// The state of one session. Revisions belong to the session, so a new
/// connection starts again from revision 1.
pub struct Connection<'a> {
    config: &'a Config,
    shared: &'a Shared,
    logged_in: bool,
    selected: Option<Snapshot>,
    pending: HashMap<u64, (Snapshot, Instant)>,
    revision: u64,
    pub refresh_at: Option<Instant>,
    /// A newer session of this provider quotes now, so this one sends
    /// heartbeats only, until a `listed` makes it current again.
    retiring: bool,
    pub outbox: Vec<ProviderMessage>,
}

impl<'a> Connection<'a> {
    pub fn new(config: &'a Config, shared: &'a Shared) -> Self {
        Self {
            config,
            shared,
            logged_in: false,
            selected: None,
            pending: HashMap::new(),
            revision: 0,
            refresh_at: None,
            retiring: false,
            outbox: vec![],
        }
    }

    pub fn login(&self) -> ProviderMessage {
        ProviderMessage::Login {
            slug: self.config.slug.clone(),
            api_key: self.config.provider_key.clone(),
            dispatch_url: self.config.dispatch_url.clone(),
            capabilities: vec![],
        }
    }

    pub fn logged_in(&self) -> bool {
        self.logged_in
    }

    pub fn quote(&mut self) {
        let Some(model) = self.selected.clone().filter(|_| !self.retiring) else {
            return;
        };
        self.revision += 1;
        self.pending
            .insert(self.revision, (model.clone(), Instant::now()));
        self.outbox.push(ProviderMessage::Quote(Quote {
            target: QuoteTarget::Registered {
                model_id: model.model_id,
            },
            execution_ref: model.reference,
            execution_limits: ExecutionLimits {
                max_input_tokens: model.max_input_tokens,
                max_output_tokens: model.max_output_tokens,
            },
            rate_uncached_input: self.config.rate_input,
            rate_cache_read: self.config.rate_cache_read,
            rate_generation: self.config.rate_output,
            fixed_fee: 0.0,
            service_class: ServiceClass {
                ttft_ms: 1500,
                completion_ms: 30000,
            },
            supported_features: vec!["text".to_string()],
            retention_policy_supported: vec![self.config.retention.clone()],
            valid_for_ms: self.config.quote_lifetime.as_millis() as u64,
            revision: self.revision,
        }));
        self.refresh_at = Some(Instant::now() + self.config.quote_lifetime / 2);
    }

    pub fn receive(&mut self, frame: ExchangeMessage) -> Result<Flow> {
        match frame {
            ExchangeMessage::LoginAck { provider_id, slug } => {
                info!(%provider_id, slug = slug.as_deref().unwrap_or(""), "login accepted");
                self.shared.set_provider_id(provider_id);
                self.logged_in = true;
            }
            ExchangeMessage::LoginReject { reason } => {
                warn!(%reason, "login refused");
                bail!("login refused");
            }
            ExchangeMessage::Listed { models } => {
                if !self.logged_in {
                    bail!("listed arrived before login_ack");
                }
                let matches: Vec<_> = models
                    .iter()
                    .filter(|model| model.deployment_name == self.config.deployment_name)
                    .collect();
                let previous = self.selected.take();
                self.retiring = false;
                self.refresh_at = None;
                self.selected = match matches.as_slice() {
                    [model] => Some(Snapshot::from_listed(model)?),
                    _ => None,
                };
                match (&mut self.selected, previous) {
                    (Some(current), Some(previous)) if current.same_deployment(&previous) => {
                        *current = previous;
                    }
                    (_, Some(previous)) => {
                        self.outbox.push(ProviderMessage::WithdrawQuote {
                            target: QuoteTarget::Registered {
                                model_id: previous.model_id,
                            },
                        });
                    }
                    _ => {}
                }
                info!(
                    deployment = %self.config.deployment_name,
                    available = self.selected.is_some(),
                    "listed"
                );
                self.quote();
            }
            ExchangeMessage::QuoteAck {
                offer_id,
                revision,
                valid_for_ms,
            } => {
                if let Some((model, sent_at)) = self.pending.remove(&revision)
                    && offer_id == model.model_id
                {
                    // The ack states the lifetime as a duration from now, so
                    // the local clock decides when to quote again.
                    let lifetime = match valid_for_ms {
                        0 => self.config.quote_lifetime,
                        ms => Duration::from_millis(ms),
                    };
                    if self.selected.as_ref() == Some(&model) {
                        self.refresh_at = Some(sent_at + lifetime / 2);
                    }
                    self.shared.record_snapshot(model);
                }
                info!(%offer_id, revision, valid_for_ms, "quote acknowledged");
            }
            ExchangeMessage::QuoteReject {
                code,
                field,
                reason,
            } => {
                // One deployment is quoted, so a refusal answers every quote
                // in flight.
                self.pending.clear();
                if code.as_deref() == Some("superseded") {
                    self.retiring = true;
                    self.refresh_at = None;
                }
                warn!(code = code.as_deref().unwrap_or(""), field = field.as_deref().unwrap_or(""), %reason, "quote rejected");
            }
            ExchangeMessage::AwardNotice(notice) => {
                info!(award_id = %notice.award_id, job_id = %notice.job_id, "award notice");
                self.shared.record_award(notice);
            }
            ExchangeMessage::SettlementNotice { award_id, status } => {
                self.shared.forget_award(&award_id);
                info!(%award_id, status = status.as_deref().unwrap_or(""), "settlement notice");
            }
            ExchangeMessage::RiskNotice { severity, message } => {
                info!(
                    severity = severity.as_deref().unwrap_or(""),
                    message = message.as_deref().unwrap_or(""),
                    "risk notice"
                );
            }
            ExchangeMessage::Handover => {
                info!("handover requested; this agent does not support it");
            }
            ExchangeMessage::Superseded => {
                info!("superseded");
                return Ok(Flow::Superseded);
            }
            ExchangeMessage::Heartbeat | ExchangeMessage::Unknown => {}
        }
        Ok(Flow::Continue)
    }
}

#[derive(Debug, PartialEq)]
enum End {
    /// The session ended after a login.
    Closed,
    /// The connection or the login failed.
    Failed,
    Superseded,
    Shutdown,
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send(socket: &mut Socket, frame: &ProviderMessage) -> Result<()> {
    socket
        .send(Message::text(serde_json::to_string(frame)?))
        .await?;
    Ok(())
}

async fn run_connection(
    config: &Config,
    shared: &Shared,
    shutdown: &mut watch::Receiver<bool>,
) -> End {
    let mut socket = match connect_async(config.session_url()).await {
        Ok((socket, _)) => socket,
        Err(error) => {
            warn!(%error, "failed to connect to the exchange");
            return End::Failed;
        }
    };
    let mut connection = Connection::new(config, shared);
    let end = drive(config, &mut connection, &mut socket, shutdown).await;
    shared.set_connected(false);
    info!("session closed");
    match end {
        Ok(end) => end,
        Err(error) => {
            warn!(error = format!("{error:#}"), "session error");
            if connection.logged_in() {
                End::Closed
            } else {
                End::Failed
            }
        }
    }
}

async fn drive(
    config: &Config,
    connection: &mut Connection<'_>,
    socket: &mut Socket,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<End> {
    send(socket, &connection.login()).await?;
    connection.shared.set_connected(true);
    let mut heartbeat = interval_at(
        Instant::now() + config.heartbeat_interval,
        config.heartbeat_interval,
    );
    loop {
        let refresh = connection
            .refresh_at
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<ExchangeMessage>(&text) {
                        Ok(frame) => {
                            if connection.receive(frame)? == Flow::Superseded {
                                return Ok(End::Superseded);
                            }
                        }
                        Err(error) => warn!(%error, "ignored a frame that does not parse"),
                    }
                }
                Some(Ok(Message::Close(_))) | None => return Ok(if connection.logged_in() { End::Closed } else { End::Failed }),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.into()),
            },
            _ = heartbeat.tick() => connection.outbox.push(ProviderMessage::Heartbeat),
            () = sleep_until(refresh), if connection.refresh_at.is_some() => connection.quote(),
            _ = shutdown.changed() => {
                // The offers go first. Dispatches already awarded continue.
                let _ = send(socket, &ProviderMessage::MassWithdraw).await;
                let _ = socket.close(None).await;
                return Ok(End::Shutdown);
            }
        }
        for frame in std::mem::take(&mut connection.outbox) {
            send(socket, &frame).await?;
        }
    }
}

/// Holds a session with the exchange until `shutdown` turns true. After a
/// failed connection it waits 0.25 seconds, then doubles the wait up to 5
/// seconds. After `superseded` it does not connect again: another process
/// of this provider holds the offers.
pub async fn run(config: Arc<Config>, shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    let mut backoff = FIRST_BACKOFF;
    while !*shutdown.borrow() {
        match run_connection(&config, &shared, &mut shutdown).await {
            End::Shutdown => return,
            End::Superseded => {
                info!("standby: another session holds the offers");
                let _ = shutdown.wait_for(|stop| *stop).await;
                return;
            }
            End::Failed => {
                tokio::select! {
                    () = sleep(backoff) => {}
                    _ = shutdown.changed() => return,
                }
                backoff = (backoff * 2).min(LAST_BACKOFF);
            }
            End::Closed => backoff = FIRST_BACKOFF,
        }
    }
}
