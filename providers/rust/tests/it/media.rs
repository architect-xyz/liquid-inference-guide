//! Image, speech and video deployments, against a fake exchange and a fake
//! media upstream.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use liquid_provider::config::Config;
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::harness::{Conn, FakeExchange, MODEL_ID, events};

const FILE: &[u8] = b"\x00\x00\x00\x18ftypmp42video-bytes";
const KEY: &str = "stable-content-key";

/// What the fake upstream does. `Ok` is the good path of every kind.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ok,
    Error,
    Extra,
    Empty,
    Failed,
    NotVideo,
}

#[derive(Clone)]
struct Upstream {
    mode: Mode,
    calls: Arc<Mutex<Vec<(&'static str, Value)>>>,
    polls: Arc<Mutex<u32>>,
}

impl Upstream {
    fn record(&self, name: &'static str, body: &str) {
        self.calls
            .lock()
            .unwrap()
            .push((name, serde_json::from_str(body).unwrap_or(Value::Null)));
    }
}

async fn images(State(up): State<Upstream>, body: String) -> Response {
    up.record("images", &body);
    let data = match up.mode {
        Mode::Error => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Mode::Extra => json!([{"b64_json": "YQ=="}, {"b64_json": "Yg=="}, {"b64_json": "Yw=="}]),
        _ => json!([{"b64_json": "aGVsbG8="}, {"revised_prompt": "no image here"}]),
    };
    axum::Json(json!({"data": data})).into_response()
}

async fn speech(State(up): State<Upstream>, body: String) -> Response {
    up.record("speech", &body);
    let (clip, mime): (&[u8], _) = match up.mode {
        Mode::Empty => (b"", "audio/mpeg"),
        _ => (b"ID3-audio", "audio/wav"),
    };
    ([(header::CONTENT_TYPE, mime)], clip.to_vec()).into_response()
}

async fn create(State(up): State<Upstream>, body: String) -> Response {
    up.record("create", &body);
    axum::Json(json!({"id": "vid_1", "status": "queued"})).into_response()
}

async fn status(State(up): State<Upstream>, Path(_id): Path<String>) -> Response {
    let polls = {
        let mut polls = up.polls.lock().unwrap();
        *polls += 1;
        *polls
    };
    if up.mode == Mode::Failed {
        return axum::Json(json!({"id": "vid_1", "status": "failed"})).into_response();
    }
    axum::Json(json!({
        "id": "vid_1",
        "status": if polls >= 2 { "completed" } else { "in_progress" },
        "expires_at": 4_102_444_800_i64,
    }))
    .into_response()
}

async fn content(State(up): State<Upstream>, Path(_id): Path<String>) -> Response {
    if up.mode == Mode::NotVideo {
        return ([(header::CONTENT_TYPE, "text/html")], "<html>").into_response();
    }
    ([(header::CONTENT_TYPE, "video/mp4")], FILE.to_vec()).into_response()
}

struct Media {
    exchange: FakeExchange,
    upstream: Upstream,
    base: String,
    stop: watch::Sender<bool>,
    _task: JoinHandle<anyhow::Result<()>>,
    http: reqwest::Client,
    journal: std::path::PathBuf,
}

impl Drop for Media {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        let _ = std::fs::remove_file(&self.journal);
    }
}

fn kind_vars(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "image_generation" => ("LIQUID_RATE_PER_IMAGE", "0.04"),
        "audio_speech" => ("LIQUID_RATE_PER_CHARACTER", "0.000015"),
        _ => ("LIQUID_RATE_PER_VIDEO_SECOND", "0.05"),
    }
}

impl Media {
    async fn start(kind: &str, mode: Mode) -> Self {
        let exchange = FakeExchange::bind().await;
        let upstream = Upstream {
            mode,
            calls: Arc::default(),
            polls: Arc::default(),
        };
        let app = Router::new()
            .route("/v1/images/generations", post(images))
            .route("/v1/audio/speech", post(speech))
            .route("/v1/videos", post(create))
            .route("/v1/videos/{id}", get(status))
            .route("/v1/videos/{id}/content", get(content))
            .with_state(upstream.clone());
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}/v1", up_listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(up_listener, app).await.unwrap() });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let journal = std::env::temp_dir().join(format!("awards-{}.journal", uuid::Uuid::new_v4()));
        let (rate_name, rate) = kind_vars(kind);
        let vars: HashMap<&str, String> = HashMap::from([
            ("LIQUID_EXCHANGE_URL", exchange.url()),
            ("LIQUID_PROVIDER_SLUG", "acme".into()),
            ("LIQUID_PROVIDER_API_KEY", "sk-liquid-test".into()),
            ("LIQUID_DEPLOYMENT_NAME", "media".into()),
            ("LIQUID_DEPLOYMENT_KIND", kind.into()),
            ("LIQUID_DISPATCH_URL", format!("{base}/dispatch")),
            ("LIQUID_UPSTREAM_BASE_URL", upstream_url),
            ("LIQUID_UPSTREAM_API_KEY", "upstream-key".into()),
            (rate_name, rate.into()),
            ("LIQUID_CONTENT_KEY", KEY.into()),
            ("LIQUID_UPSTREAM_POLL_SECONDS", "0.01".into()),
            ("LIQUID_AWARD_JOURNAL", journal.display().to_string()),
        ]);
        let mut config = Config::from_lookup(|name| vars.get(name).cloned()).unwrap();
        config.award_wait = Duration::from_millis(300);
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(liquid_provider::serve(config, listener, shutdown));
        Self {
            exchange,
            upstream,
            base,
            stop,
            _task: task,
            http: reqwest::Client::new(),
            journal,
        }
    }

    /// Connects, logs in with a deployment of `kind`, and acknowledges the quote.
    async fn ready(&self, kind: &str) -> (Conn, Value) {
        let mut conn = self.exchange.accept().await;
        let (_, quote) = conn
            .handshake_listing(json!({
                "model_id": MODEL_ID,
                "deployment_name": "media",
                "model": "gpt-oss-120b",
                "kind": kind,
                "max_input_tokens": 1000,
                "max_output_tokens": 1,
            }))
            .await;
        conn.ack(&quote, 60000).await;
        (conn, quote)
    }

    async fn post(&self, award_id: &str, quote: &Value, bound: Value) -> reqwest::Response {
        let mut body = json!({
            "award_id": award_id,
            "job_id": format!("job_{award_id}"),
            "offer_id": MODEL_ID,
            "served_model": "gpt-oss-120b",
            "execution_ref": quote["execution_ref"],
            "messages": [{"role": "user", "content": "A trading floor made of water"}],
            "max_output_tokens": 1,
        });
        body.as_object_mut()
            .unwrap()
            .extend(bound.as_object().cloned().unwrap_or_default());
        self.http
            .post(format!("{}/dispatch", self.base))
            .header("idempotency-key", award_id)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    /// Awards and dispatches one job, and returns the events.
    async fn run(&self, kind: &str, bound: Value) -> (Vec<Value>, Value) {
        let (mut conn, quote) = self.ready(kind).await;
        conn.award("aw_1", 1).await;
        let response = self.post("aw_1", &quote, bound).await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = response.text().await.unwrap();
        (events(&text), quote)
    }

    fn calls(&self) -> Vec<(&'static str, Value)> {
        self.upstream.calls.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn each_media_kind_quotes_only_its_own_rate() {
    for (kind, field, rate, completion) in [
        ("image_generation", "rate_per_image", 0.04, 90_000),
        ("audio_speech", "rate_per_character", 0.000015, 30_000),
        ("video_generation", "rate_per_video_second", 0.05, 300_000),
    ] {
        let media = Media::start(kind, Mode::Ok).await;
        let (_conn, quote) = media.ready(kind).await;
        assert_eq!(quote[field], rate, "{kind}");
        assert_eq!(quote["service_class"]["completion_ms"], completion);
        assert_eq!(quote["service_class"]["ttft_ms"], completion);
        for token_rate in ["rate_uncached_input", "rate_cache_read", "rate_generation"] {
            assert!(
                quote.get(token_rate).is_none(),
                "{kind} quotes {token_rate}"
            );
        }
        assert_eq!(quote["supported_features"], json!(["text"]));
    }
}

#[tokio::test]
async fn an_image_job_counts_only_the_images_it_sends() {
    let media = Media::start("image_generation", Mode::Ok).await;
    let (events, _) = media
        .run(
            "image_generation",
            json!({"image": {"count": 2, "size": "1024x1024", "output_format": "webp"}}),
        )
        .await;
    assert_eq!(
        events[0],
        json!({"type": "image", "index": 0, "b64_json": "aGVsbG8=", "mime": "image/webp"})
    );
    let done = events.last().unwrap();
    assert_eq!(done["type"], "done");
    assert_eq!(done["finish_reason"], "stop");
    assert_eq!(done["usage"]["meters"], json!({"images": 1}));
    assert_eq!(done["usage"]["tokenizer_id"], "provider-native");
    assert_eq!(done["usage"]["raw"], json!({}));
    assert_eq!(events.len(), 2);
    assert_eq!(
        media.calls()[0].1,
        json!({
            "model": "gpt-oss-120b",
            "prompt": "A trading floor made of water",
            "n": 2,
            "size": "1024x1024",
            "output_format": "webp",
        })
    );
}

#[tokio::test]
async fn an_image_failure_never_reports_success() {
    for mode in [Mode::Error, Mode::Extra] {
        let media = Media::start("image_generation", mode).await;
        let (events, _) = media
            .run("image_generation", json!({"image": {"count": 1}}))
            .await;
        let last = events.last().unwrap();
        assert_eq!(last["type"], "failed");
        assert_eq!(last["code"], "upstream_failed");
        assert!(events.iter().all(|event| event["type"] != "done"));
    }
}

#[tokio::test]
async fn speech_sends_the_clip_with_its_own_type_and_the_character_count() {
    let media = Media::start("audio_speech", Mode::Ok).await;
    let (events, _) = media
        .run(
            "audio_speech",
            json!({"audio": {"characters": 29, "voice": "alloy", "response_format": "mp3"}}),
        )
        .await;
    assert_eq!(
        events[0],
        json!({
            "type": "audio",
            "b64_audio": base64::engine::general_purpose::STANDARD.encode(b"ID3-audio"),
            "mime": "audio/wav",
        })
    );
    assert_eq!(
        events.last().unwrap()["usage"]["meters"],
        json!({"characters": 29})
    );
    let request = &media.calls()[0].1;
    assert_eq!(request["voice"], "alloy");
    assert_eq!(request["input"], "A trading floor made of water");
    assert_eq!(request["response_format"], "mp3");
    assert!(request.get("speed").is_none());
}

#[tokio::test]
async fn an_empty_clip_fails_the_job() {
    let media = Media::start("audio_speech", Mode::Empty).await;
    let (events, _) = media
        .run(
            "audio_speech",
            json!({"audio": {"characters": 29, "voice": "a"}}),
        )
        .await;
    let kinds: Vec<_> = events.iter().map(|event| event["type"].clone()).collect();
    assert_eq!(kinds, [json!("failed")]);
}

fn token(handle: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(KEY.as_bytes()).unwrap();
    mac.update(handle.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn a_video_job_waits_for_the_render_and_serves_the_file_with_the_token() {
    let media = Media::start("video_generation", Mode::Ok).await;
    let (events, _) = media
        .run(
            "video_generation",
            json!({"video": {"seconds": 8, "size": "1280x720"}}),
        )
        .await;
    let ready = events
        .iter()
        .find(|event| event["type"] == "video_ready")
        .unwrap();
    assert_eq!(ready["handle"], "vid_1");
    assert_eq!(ready["mime"], "video/mp4");
    assert_eq!(ready["bytes"], FILE.len());
    assert!(
        ready["expires_at"]
            .as_str()
            .unwrap()
            .starts_with("2100-01-01")
    );
    assert_eq!(ready["token"], token("vid_1"));
    let done = events.last().unwrap();
    assert_eq!(done["type"], "done");
    assert_eq!(done["usage"]["meters"], json!({"video_seconds": 8}));
    assert_eq!(events.len(), 2);
    assert_eq!(media.calls()[0].1["seconds"], "8");
    assert_eq!(media.calls()[0].1["size"], "1280x720");

    let url = format!("{}/content", media.base);
    let served = media
        .http
        .post(&url)
        .json(&json!({"handle": "vid_1", "token": ready["token"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(served.headers()["content-type"], "video/mp4");
    assert_eq!(served.bytes().await.unwrap().as_ref(), FILE);

    for body in [
        json!({"handle": "vid_1", "token": "00"}),
        json!({"handle": "../x", "token": token("../x")}),
        json!({"handle": "vid_1", "token": token("vid_2")}),
    ] {
        let refused = media.http.post(&url).json(&body).send().await.unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN, "{body}");
    }
    let malformed = media
        .http
        .post(&url)
        .json(&json!({"handle": 1}))
        .send()
        .await;
    assert_eq!(malformed.unwrap().status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_render_polls_keep_the_dispatch_open_with_blank_lines() {
    let media = Media::start("video_generation", Mode::Ok).await;
    let (mut conn, quote) = media.ready("video_generation").await;
    conn.award("aw_1", 1).await;
    let response = media
        .post("aw_1", &quote, json!({"video": {"seconds": 4}}))
        .await;
    let text = response.text().await.unwrap();
    assert!(text.starts_with("\n\n{"), "{text:?}");
}

#[tokio::test]
async fn a_video_failure_never_reports_success() {
    for mode in [Mode::Failed, Mode::NotVideo] {
        let media = Media::start("video_generation", mode).await;
        let (events, _) = media
            .run("video_generation", json!({"video": {"seconds": 4}}))
            .await;
        assert_eq!(events.last().unwrap()["type"], "failed");
        assert!(
            events
                .iter()
                .all(|event| !["done", "video_ready"].contains(&event["type"].as_str().unwrap()))
        );
    }
}

#[tokio::test]
async fn a_media_dispatch_without_its_bound_starts_no_upstream_work() {
    let media = Media::start("image_generation", Mode::Ok).await;
    let (mut conn, quote) = media.ready("image_generation").await;
    conn.award("aw_1", 1).await;
    let response = media.post("aw_1", &quote, json!({})).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(media.calls().is_empty());
}

#[tokio::test]
async fn only_a_video_deployment_serves_content() {
    let media = Media::start("image_generation", Mode::Ok).await;
    let response = media
        .http
        .post(format!("{}/content", media.base))
        .json(&json!({"handle": "vid_1", "token": token("vid_1")}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
