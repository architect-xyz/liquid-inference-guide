//! Image, speech and video jobs: the upstream calls, the dispatch events they
//! produce, and the route that serves a finished video.

use anyhow::{Result, anyhow, bail};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use tokio::sync::mpsc;
use tracing::info;

use crate::config::Kind;
use crate::dispatch::{AppState, emit, keep_alive};
use crate::state::Snapshot;

type HmacSha256 = Hmac<Sha256>;

/// The key of the object that bounds a job of this kind.
pub fn bound_key(kind: Kind) -> &'static str {
    match kind {
        Kind::ImageGeneration => "image",
        Kind::AudioSpeech => "audio",
        _ => "video",
    }
}

fn image_type(format: &str) -> &'static str {
    match format {
        "jpeg" | "jpg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn audio_type(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        "opus" => "audio/opus",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "pcm" => "audio/pcm",
        _ => "audio/mpeg",
    }
}

/// The prompt of a media job is the last user turn.
fn prompt_of(body: &Value) -> Result<String> {
    body["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["content"].as_str())
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("a media dispatch needs a user prompt"))
}

/// The last event of a media job. The meter is the unit that the deployment is
/// priced in.
fn done(meters: Value, tokenizer_id: &str) -> Value {
    json!({
        "type": "done",
        "finish_reason": "stop",
        "usage": {"meters": meters, "tokenizer_id": tokenizer_id, "raw": {}},
    })
}

fn text_of<'a>(bound: &'a Value, key: &str) -> Option<&'a str> {
    bound
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn content_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn check(response: reqwest::Response) -> Result<reqwest::Response> {
    Ok(response.error_for_status()?)
}

pub async fn image(
    state: &AppState,
    model: &Snapshot,
    body: &Value,
    sender: &mpsc::Sender<Bytes>,
) -> Result<()> {
    let bound = &body["image"];
    let count = bound["count"]
        .as_u64()
        .ok_or_else(|| anyhow!("the image object needs a count"))?;
    let mut request = Map::from_iter([
        ("model".to_string(), json!(model.model)),
        ("prompt".to_string(), json!(prompt_of(body)?)),
        ("n".to_string(), json!(count)),
    ]);
    for key in ["size", "output_format", "quality", "response_format"] {
        if let Some(value) = text_of(bound, key) {
            request.insert(key.to_string(), json!(value));
        }
    }
    let answer: Value = check(
        state
            .http
            .post(format!("{}/images/generations", state.config.upstream_url))
            .bearer_auth(&state.config.upstream_key)
            .json(&request)
            .send()
            .await?,
    )?
    .json()
    .await?;
    let mime = image_type(
        &text_of(bound, "output_format")
            .unwrap_or("png")
            .to_lowercase(),
    );
    let mut sent = 0u64;
    for (index, item) in answer["data"].as_array().into_iter().flatten().enumerate() {
        // An entry with neither field is not an image, so the buyer does not pay for it.
        let mut event = json!({"type": "image", "index": index, "mime": mime});
        let mut has_image = false;
        for key in ["b64_json", "url"] {
            if let Some(value) = text_of(item, key) {
                event[key] = json!(value);
                has_image = true;
            }
        }
        if has_image {
            emit(sender, &event).await?;
            sent += 1;
        }
    }
    if sent == 0 || sent > count {
        bail!("the upstream returned no image, or more than were asked for");
    }
    emit(sender, &done(json!({"images": sent}), &model.tokenizer_id)).await
}

pub async fn speech(
    state: &AppState,
    model: &Snapshot,
    body: &Value,
    sender: &mpsc::Sender<Bytes>,
) -> Result<()> {
    let bound = &body["audio"];
    let text = prompt_of(body)?;
    let voice = text_of(bound, "voice").ok_or_else(|| anyhow!("the audio object needs a voice"))?;
    let mut request = Map::from_iter([
        ("model".to_string(), json!(model.model)),
        ("input".to_string(), json!(text)),
        ("voice".to_string(), json!(voice)),
    ]);
    for key in ["response_format", "speed"] {
        if let Some(value) = bound.get(key).filter(|value| !value.is_null()) {
            request.insert(key.to_string(), value.clone());
        }
    }
    let answer = check(
        state
            .http
            .post(format!("{}/audio/speech", state.config.upstream_url))
            .bearer_auth(&state.config.upstream_key)
            .json(&request)
            .send()
            .await?,
    )?;
    // The buyer needs the type of the file that came back, not the one that was asked for.
    let mut mime = content_type(&answer);
    let clip = answer.bytes().await?;
    if clip.is_empty() {
        bail!("the upstream returned no audio");
    }
    if mime.is_empty() {
        mime = audio_type(text_of(bound, "response_format").unwrap_or("mp3")).to_string();
    }
    emit(
        sender,
        &json!({"type": "audio", "b64_audio": STANDARD.encode(&clip), "mime": mime}),
    )
    .await?;
    // The exchange counted the characters of the text, and it pays for no more.
    let characters = text.chars().count();
    emit(
        sender,
        &done(json!({"characters": characters}), &model.tokenizer_id),
    )
    .await
}

pub async fn video(
    state: &AppState,
    model: &Snapshot,
    body: &Value,
    sender: &mpsc::Sender<Bytes>,
) -> Result<()> {
    let bound = &body["video"];
    let seconds = bound["seconds"]
        .as_u64()
        .ok_or_else(|| anyhow!("the video object needs seconds"))?;
    let mut request = json!({
        "model": model.model,
        "prompt": prompt_of(body)?,
        "seconds": seconds.to_string(),
    });
    if let Some(size) = text_of(bound, "size") {
        request["size"] = json!(size);
    }
    let base = &state.config.upstream_url;
    let created: Value = check(
        state
            .http
            .post(format!("{base}/videos"))
            .bearer_auth(&state.config.upstream_key)
            .json(&request)
            .send()
            .await?,
    )?
    .json()
    .await?;
    let video_id = match created["id"].as_str() {
        Some(id) if !id.is_empty() && !id.contains(['/', '?', '#']) => id.to_string(),
        _ => bail!("the upstream accepted the video job and returned no usable id"),
    };
    info!(%video_id, "video accepted");
    let finished = render(state, &video_id, sender).await?;
    // Read the file's headers before the exchange hears of it. A file that the upstream
    // cannot serve fails the job now, and not as a failed download after the buyer paid.
    let file = check(
        state
            .http
            .get(format!("{base}/videos/{video_id}/content"))
            .bearer_auth(&state.config.upstream_key)
            .send()
            .await?,
    )?;
    let mime = content_type(&file);
    let length = file.headers().get(header::CONTENT_LENGTH);
    let size: u64 = length
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    if !mime.starts_with("video/") || (size == 0 && length.is_some()) {
        bail!("the upstream did not return a video file");
    }
    drop(file);
    let mut ready = json!({
        "type": "video_ready",
        "handle": video_id,
        "token": sign(&state.config.content_key, &video_id),
        "mime": mime,
    });
    if size > 0 {
        ready["bytes"] = json!(size);
    }
    if let Some(expires) = finished["expires_at"].as_i64() {
        ready["expires_at"] = json!(iso8601(expires));
    }
    emit(sender, &ready).await?;
    emit(
        sender,
        &done(json!({"video_seconds": seconds}), &model.tokenizer_id),
    )
    .await
}

/// Asks about the render until it ends. A blank line each time keeps the dispatch open.
async fn render(state: &AppState, video_id: &str, sender: &mpsc::Sender<Bytes>) -> Result<Value> {
    let poll = async {
        loop {
            tokio::time::sleep(state.config.poll_interval).await;
            keep_alive(sender).await?;
            let job: Value = check(
                state
                    .http
                    .get(format!("{}/videos/{video_id}", state.config.upstream_url))
                    .bearer_auth(&state.config.upstream_key)
                    .send()
                    .await?,
            )?
            .json()
            .await?;
            match job["status"].as_str() {
                Some("completed") => return Ok(job),
                Some("queued" | "in_progress") => {}
                other => bail!("the upstream ended the render as {other:?}"),
            }
        }
    };
    tokio::time::timeout(state.config.render_timeout, poll)
        .await
        .map_err(|_| anyhow!("the render did not finish in time"))?
}

fn mac(key: &str) -> HmacSha256 {
    HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC takes a key of any length")
}

fn sign(key: &str, handle: &str) -> String {
    let mut mac = mac(key);
    mac.update(handle.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Checks the token in constant time.
fn verify(key: &str, handle: &str, token: &str) -> bool {
    let bytes = token.as_bytes();
    if !bytes.len().is_multiple_of(2) || !token.is_ascii() {
        return false;
    }
    let decoded: Option<Vec<u8>> = bytes
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect();
    let Some(decoded) = decoded else {
        return false;
    };
    let mut mac = mac(key);
    mac.update(handle.as_bytes());
    mac.verify_slice(&decoded).is_ok()
}

/// Serves a finished video to the exchange, which proves itself with the token.
pub async fn content(State(state): State<AppState>, body: Bytes) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (Some(handle), Some(token)) = (request["handle"].as_str(), request["token"].as_str())
    else {
        return reply(StatusCode::BAD_REQUEST, "invalid_content_request");
    };
    let signed = verify(&state.config.content_key, handle, token);
    if !signed || handle.contains(['/', '?', '#']) {
        return reply(StatusCode::FORBIDDEN, "forbidden");
    }
    let file = state
        .http
        .get(format!(
            "{}/videos/{handle}/content",
            state.config.upstream_url
        ))
        .bearer_auth(&state.config.upstream_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);
    let Ok(file) = file else {
        return reply(StatusCode::BAD_GATEWAY, "upstream_failed");
    };
    let mime = file
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("video/mp4"));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(Body::from_stream(file.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn reply(status: StatusCode, error: &str) -> Response {
    (status, axum::Json(json!({"error": error}))).into_response()
}

/// A unix time as an ISO 8601 string in UTC.
fn iso8601(unix: i64) -> String {
    let (days, rest) = (unix.div_euclid(86_400), unix.rem_euclid(86_400));
    // Civil date from a day count, after Howard Hinnant.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_unix_time() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(iso8601(4_102_444_800), "2100-01-01T00:00:00+00:00");
        assert_eq!(iso8601(1_709_210_096), "2024-02-29T12:34:56+00:00");
    }

    #[test]
    fn signs_and_verifies_a_handle() {
        let token = sign("key", "vid_1");
        assert_eq!(token.len(), 64);
        assert!(verify("key", "vid_1", &token));
        assert!(!verify("key", "vid_2", &token));
        assert!(!verify("other", "vid_1", &token));
        assert!(!verify("key", "vid_1", "00"));
        assert!(!verify("key", "vid_1", "zz"));
        assert!(!verify("key", "vid_1", "é"));
    }
}
