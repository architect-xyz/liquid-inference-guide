use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use futures_util::{SinkExt, StreamExt, stream};
use liquid_provider::config::Config;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{WebSocketStream, accept_async};

pub const MODEL_ID: &str = "3f0c0000-0000-4000-8000-000000000001";
pub const PROVIDER_ID: &str = "7c9e0000-0000-4000-8000-000000000002";

pub struct Conn(WebSocketStream<TcpStream>);

impl Conn {
    /// The next frame from the agent. Heartbeats are skipped.
    pub async fn recv(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), self.0.next())
                .await
                .expect("no frame from the agent in 5 seconds")
                .expect("the agent closed the session")
                .expect("websocket error");
            if let Message::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).unwrap();
                if frame["type"] != "heartbeat" {
                    return frame;
                }
            }
        }
    }

    pub async fn send(&mut self, frame: Value) {
        self.0.send(Message::text(frame.to_string())).await.unwrap();
    }

    pub async fn close(&mut self) {
        let _ = self.0.close(None).await;
    }

    /// Logs the agent in, lists one deployment, and returns the first quote.
    pub async fn handshake(&mut self) -> Value {
        self.handshake_with_login().await.1
    }

    pub async fn handshake_with_login(&mut self) -> (Value, Value) {
        self.handshake_listing(json!({
            "model_id": MODEL_ID,
            "unverified": false,
            "deployment_name": "gpt-oss",
            "model": "gpt-oss-120b",
            "tokenizer_id": "o200k_base",
            "max_input_tokens": 128000,
            "max_output_tokens": 4096,
        }))
        .await
    }

    /// Like `handshake_with_login`, with `deployment` as the listed deployment.
    pub async fn handshake_listing(&mut self, deployment: Value) -> (Value, Value) {
        let login = self.recv().await;
        assert_eq!(login["type"], "login");
        self.send(json!({
            "type": "login_ack",
            "provider_id": PROVIDER_ID,
            "slug": "acme",
            "server_time": "2026-09-21T10:00:00Z",
        }))
        .await;
        self.send(json!({
            "type": "listed",
            "models": [
                {
                    "model_id": "00000000-0000-4000-8000-0000000000ff",
                    "deployment_name": "other",
                    "model": "other-model",
                    "tokenizer_id": "x",
                    "max_input_tokens": 1,
                },
                deployment,
            ],
        }))
        .await;
        let quote = self.recv().await;
        assert_eq!(quote["type"], "quote");
        (login, quote)
    }

    pub async fn ack(&mut self, quote: &Value, valid_for_ms: u64) {
        self.send(json!({
            "type": "quote_ack",
            "offer_id": quote["target"]["model_id"],
            "revision": quote["revision"],
            "activation_seq": 1,
            "valid_for_ms": valid_for_ms,
        }))
        .await;
    }

    pub async fn award(&mut self, award_id: &str, max_output_tokens: u64) {
        self.send(json!({
            "type": "award_notice",
            "award_id": award_id,
            "job_id": format!("job_{award_id}"),
            "offer_id": MODEL_ID,
            "served_model": "gpt-oss-120b",
            "cap_usd": 0.01,
            "max_output_tokens": max_output_tokens,
            "schema_version": "2026-09",
        }))
        .await;
    }
}

pub struct FakeExchange {
    listener: TcpListener,
}

impl FakeExchange {
    pub async fn bind() -> Self {
        Self {
            listener: TcpListener::bind("127.0.0.1:0").await.unwrap(),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.listener.local_addr().unwrap())
    }

    pub async fn accept(&self) -> Conn {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(5), self.listener.accept())
            .await
            .expect("the agent did not connect in 5 seconds")
            .unwrap();
        Conn(accept_async(stream).await.unwrap())
    }
}

#[derive(Clone, Copy)]
pub enum Mode {
    Answer,
    Fail,
    /// The answer waits for `FakeUpstream::release` before its last chunk.
    Held,
}

#[derive(Clone)]
pub struct FakeUpstream {
    pub url: String,
    pub requests: Arc<Mutex<Vec<(Value, String)>>>,
    mode: Mode,
    gate: Arc<Notify>,
}

impl FakeUpstream {
    pub async fn start(mode: Mode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = Self {
            url: format!("http://{}/v1", listener.local_addr().unwrap()),
            requests: Arc::default(),
            mode,
            gate: Arc::default(),
        };
        let app = Router::new()
            .route("/v1/chat/completions", post(chat))
            .with_state(upstream.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        upstream
    }

    pub fn release(&self) {
        self.gate.notify_waiters();
    }

    pub fn call_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

fn sse(value: Value) -> String {
    format!("data: {value}\n\n")
}

async fn chat(State(upstream): State<FakeUpstream>, headers: HeaderMap, body: String) -> Response {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    upstream
        .requests
        .lock()
        .unwrap()
        .push((serde_json::from_str(&body).unwrap(), auth));
    let mode = upstream.mode;
    if matches!(mode, Mode::Fail) {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("model overloaded"))
            .unwrap();
    }
    let head = [
        sse(json!({"choices": [{"delta": {"role": "assistant", "content": "Hel"}}]})),
        sse(json!({"choices": [{"delta": {"content": "lo"}}]})),
    ]
    .concat();
    let tail = [
        sse(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
        sse(json!({"choices": [], "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 4},
        }})),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat();
    let gate = upstream.gate.clone();
    let parts = stream::once(async move { head })
        .chain(stream::once(async move {
            if matches!(mode, Mode::Held) {
                gate.notified().await;
            }
            tail
        }))
        .map(Ok::<_, std::convert::Infallible>);
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(parts))
        .unwrap()
}

pub struct Agent {
    pub exchange: FakeExchange,
    pub upstream: FakeUpstream,
    pub dispatch_url: String,
    pub stop: watch::Sender<bool>,
    pub task: JoinHandle<anyhow::Result<()>>,
    pub http: reqwest::Client,
    journal: std::path::PathBuf,
}

impl Agent {
    pub async fn start(mode: Mode, tune: impl FnOnce(&mut Config)) -> Self {
        let exchange = FakeExchange::bind().await;
        let upstream = FakeUpstream::start(mode).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dispatch_url = format!("http://{}", listener.local_addr().unwrap());
        let journal = std::env::temp_dir().join(format!("awards-{}.journal", uuid::Uuid::new_v4()));
        let vars: HashMap<&str, String> = HashMap::from([
            ("LIQUID_EXCHANGE_URL", exchange.url()),
            ("LIQUID_PROVIDER_SLUG", "acme".into()),
            ("LIQUID_PROVIDER_API_KEY", "sk-liquid-test".into()),
            ("LIQUID_DEPLOYMENT_NAME", "gpt-oss".into()),
            ("LIQUID_DISPATCH_URL", format!("{dispatch_url}/dispatch")),
            ("LIQUID_UPSTREAM_BASE_URL", upstream.url.clone()),
            ("LIQUID_UPSTREAM_API_KEY", "upstream-key".into()),
            ("LIQUID_RATE_INPUT", "0.10".into()),
            ("LIQUID_RATE_CACHE_READ", "0.02".into()),
            ("LIQUID_RATE_OUTPUT", "0.20".into()),
            ("LIQUID_AWARD_JOURNAL", journal.display().to_string()),
        ]);
        let mut config = Config::from_lookup(|name| vars.get(name).cloned()).unwrap();
        config.award_wait = Duration::from_millis(300);
        tune(&mut config);
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(liquid_provider::serve(config, listener, shutdown));
        Self {
            exchange,
            upstream,
            dispatch_url,
            stop,
            task,
            http: reqwest::Client::new(),
            journal,
        }
    }

    /// Connects, logs in and acknowledges the first quote.
    pub async fn ready(&self) -> (Conn, Value) {
        let mut conn = self.exchange.accept().await;
        let quote = conn.handshake().await;
        conn.ack(&quote, 60000).await;
        (conn, quote)
    }

    pub async fn post(&self, award_id: &str, body: Value) -> reqwest::Response {
        self.http
            .post(format!("{}/dispatch", self.dispatch_url))
            .header("idempotency-key", award_id)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    pub fn dispatch_body(award_id: &str, quote: &Value) -> Value {
        json!({
            "award_id": award_id,
            "job_id": format!("job_{award_id}"),
            "offer_id": MODEL_ID,
            "served_model": "gpt-oss-120b",
            "execution_ref": quote["execution_ref"],
            "messages": [
                {"role": "system", "content": "You are terse."},
                {"role": "user", "content": "Hi", "parts": [{"type": "text", "text": "Hi"}]},
            ],
            "max_output_tokens": 64,
            "temperature": 0.2,
            "stream": true,
        })
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.journal);
    }
}

/// The events of an ndjson response, one value for each line.
pub fn events(body: &str) -> Vec<Value> {
    body.lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
