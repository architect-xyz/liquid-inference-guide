//! The HTTP endpoint that the exchange posts awarded jobs to.

use std::convert::Infallible;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::stream;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::config::Config;
use crate::journal::Journal;
use crate::state::{Shared, Snapshot};
use crate::upstream::{self, UpstreamStatus};

const BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub shared: Arc<Shared>,
    pub journal: Arc<Journal>,
    pub http: reqwest::Client,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/dispatch", post(dispatch))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Response {
    axum::Json(json!({
        "connected": state.shared.connected(),
        "deployment": state.config.deployment_name,
    }))
    .into_response()
}

fn error(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn invalid(error_: &anyhow::Error) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        json!({"error": "invalid_dispatch", "message": format!("{error_:#}")}),
    )
}

async fn dispatch(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let body: Value = match serde_json::from_slice(&body) {
        Ok(body) => body,
        Err(source) => return invalid(&source.into()),
    };
    let Some(award_id) = body
        .get("award_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return invalid(&anyhow!("dispatch requires an award_id"));
    };
    if headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        != Some(&award_id)
    {
        return invalid(&anyhow!("idempotency-key must match award_id"));
    }
    let Some(provider_id) = state.shared.provider_id() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": "session_unavailable"}),
        );
    };
    let duplicate = || error(StatusCode::CONFLICT, json!({"error": "duplicate_award"}));
    if state.journal.contains(&provider_id, &award_id) {
        return duplicate();
    }
    let model = match validate(&state, &body).await {
        Ok(model) => model,
        Err(source) => return invalid(&source),
    };
    // The claim is on disk before the upstream request, so a redelivery or a
    // restart cannot start the job twice.
    let journal = state.journal.clone();
    let claim = {
        let (provider_id, award_id) = (provider_id.clone(), award_id.clone());
        tokio::task::spawn_blocking(move || journal.claim(&provider_id, &award_id)).await
    };
    match claim {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return duplicate(),
        Ok(Err(_)) | Err(_) => {
            warn!("journal unavailable");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "journal_unavailable"}),
            );
        }
    }

    let (sender, receiver) = mpsc::channel::<Bytes>(32);
    tokio::spawn(stream_job(state, model, body, sender));
    let events = stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|bytes| (Ok::<_, Infallible>(bytes), receiver))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .body(Body::from_stream(events))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// The exchange closed the dispatch, so there is no one to write to.
#[derive(Debug)]
struct ClientGone;

impl std::fmt::Display for ClientGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the exchange closed the dispatch")
    }
}

impl std::error::Error for ClientGone {}

async fn emit(sender: &mpsc::Sender<Bytes>, event: &Value) -> Result<()> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    sender
        .send(Bytes::from(line))
        .await
        .map_err(|_| ClientGone.into())
}

async fn stream_job(state: AppState, model: Snapshot, body: Value, sender: mpsc::Sender<Bytes>) {
    let award_id = body["award_id"].as_str().unwrap_or_default().to_string();
    match run_job(&state, &model, &body, &sender).await {
        Ok(()) => info!(%award_id, "dispatch done"),
        Err(source) if source.downcast_ref::<ClientGone>().is_some() => {
            warn!(%award_id, "exchange closed the dispatch");
        }
        Err(source) => {
            warn!(%award_id, error = format!("{source:#}"), "dispatch failed");
            let message = match source.downcast_ref::<UpstreamStatus>() {
                Some(status) => status.to_string(),
                None => "the upstream did not return a valid text response".to_string(),
            };
            let _ = emit(
                &sender,
                &json!({"type": "failed", "code": "upstream_failed", "message": message}),
            )
            .await;
        }
    }
}

async fn run_job(
    state: &AppState,
    model: &Snapshot,
    body: &Value,
    sender: &mpsc::Sender<Bytes>,
) -> Result<()> {
    let messages: Vec<Value> = body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|message| json!({"role": message["role"], "content": message["content"]}))
        .collect();
    let mut request = json!({
        "model": model.model,
        "messages": messages,
        "max_tokens": body["max_output_tokens"],
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    if let Some(temperature) = body.get("temperature").filter(|value| !value.is_null()) {
        request["temperature"] = temperature.clone();
    }

    let mut first_output = true;
    let outcome = upstream::stream_chat(
        &state.http,
        &state.config.upstream_url,
        &state.config.upstream_key,
        &request,
        |text| {
            let log_first = std::mem::take(&mut first_output);
            async move {
                if log_first {
                    info!("first output");
                }
                emit(sender, &json!({"type": "delta", "text": text})).await
            }
        },
    )
    .await?;
    let usage = upstream::usage_report(&outcome.usage, &model.tokenizer_id)?;
    emit(
        sender,
        &json!({"type": "done", "finish_reason": outcome.finish_reason, "usage": usage}),
    )
    .await
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(fields)) => !fields.is_empty(),
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::Bool(true)) => true,
    }
}

/// Checks the dispatch against the award notice and against what this agent
/// quoted. The agent runs only what it priced.
async fn validate(state: &AppState, body: &Value) -> Result<Snapshot> {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let award_id = text("award_id").unwrap_or_default();
    let award = state
        .shared
        .award(award_id, state.config.award_wait)
        .await?;
    let notice = &award.notice;
    for (key, expected) in [
        ("award_id", &notice.award_id),
        ("job_id", &notice.job_id),
        ("offer_id", &notice.offer_id),
        ("served_model", &notice.served_model),
    ] {
        if text(key) != Some(expected) {
            bail!("dispatch {key} does not match the award");
        }
    }
    let model = text("execution_ref")
        .and_then(|reference| state.shared.snapshot(reference))
        .filter(|model| award.references.contains(&model.reference));
    let Some(model) = model else {
        bail!("dispatch execution_ref does not match the award");
    };
    if model.model_id != notice.offer_id || model.model != notice.served_model {
        bail!("dispatch does not match the deployment");
    }
    let Some(limit) = body.get("max_output_tokens").and_then(Value::as_u64) else {
        bail!("dispatch requires max_output_tokens");
    };
    let allowed = model
        .max_output_tokens
        .map_or(notice.max_output_tokens, |max| {
            max.min(notice.max_output_tokens)
        });
    if limit == 0 || limit > allowed {
        bail!("dispatch exceeds the output limit");
    }

    const UNSUPPORTED: [&str; 16] = [
        "tools",
        "tool_choice",
        "response_format",
        "top_p",
        "stop",
        "seed",
        "logprobs",
        "top_logprobs",
        "logit_bias",
        "frequency_penalty",
        "presence_penalty",
        "reasoning",
        "image",
        "audio",
        "video",
        "pricing_unit",
    ];
    if UNSUPPORTED.iter().any(|key| truthy(body.get(*key))) {
        bail!("dispatch requires an unsupported feature");
    }
    match body.get("cache") {
        None | Some(Value::Null) => {}
        Some(Value::Object(cache)) => {
            if ["breakpoints", "key", "scope"]
                .iter()
                .any(|key| truthy(cache.get(*key)))
            {
                bail!("dispatch requires prompt cache support");
            }
        }
        Some(_) => bail!("dispatch requires a valid cache object"),
    }

    let messages = match body.get("messages").and_then(Value::as_array) {
        Some(messages) if !messages.is_empty() => messages,
        _ => bail!("dispatch requires text messages"),
    };
    for message in messages {
        let Some(message) = message.as_object() else {
            bail!("dispatch requires a message object");
        };
        let role = message.get("role").and_then(Value::as_str);
        if !matches!(role, Some("system" | "user" | "assistant" | "developer")) {
            bail!("dispatch requires a text role");
        }
        if !message.get("content").is_some_and(Value::is_string) {
            bail!("dispatch requires text content");
        }
        if ["tool_calls", "tool_call_id", "reasoning"]
            .iter()
            .any(|key| truthy(message.get(*key)))
        {
            bail!("dispatch requires an unsupported message feature");
        }
        let parts_ok = match message.get("parts") {
            None | Some(Value::Null) => true,
            Some(Value::Array(parts)) => parts
                .iter()
                .all(|part| part.get("type").and_then(Value::as_str) == Some("text")),
            Some(_) => false,
        };
        if !parts_ok {
            bail!("dispatch requires an unsupported input modality");
        }
    }
    Ok(model)
}
