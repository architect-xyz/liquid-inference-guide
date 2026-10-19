//! The call to an OpenAI-compatible upstream, and the mapping of its output
//! to dispatch events.

use std::fmt;

use anyhow::{Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};

/// The upstream answered with an error status. Its body goes to the exchange
/// in the `failed` event.
#[derive(Debug)]
pub struct UpstreamStatus(pub String);

impl fmt::Display for UpstreamStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UpstreamStatus {}

/// Maps the usage object of an OpenAI-compatible upstream to the meters of a
/// `done` event. Each input token counts in exactly one meter.
pub fn usage_report(raw: &Value, tokenizer_id: &str) -> Result<Value> {
    let prompt = count(raw.get("prompt_tokens"))?;
    let output = count(raw.get("completion_tokens"))?;
    let cached = optional_count(raw.pointer("/prompt_tokens_details/cached_tokens"))?;
    if cached > prompt {
        bail!("cached input exceeds total input");
    }
    if optional_count(raw.pointer("/completion_tokens_details/reasoning_tokens"))? != 0 {
        bail!("the reference does not support reasoning");
    }
    if optional_count(raw.pointer("/prompt_tokens_details/cache_write_tokens"))? != 0 {
        bail!("the reference does not support cache writes");
    }
    Ok(json!({
        "meters": {
            "uncached_input": prompt - cached,
            "cache_read": cached,
            "cache_write_short": 0,
            "cache_write_long": 0,
            "generation": output,
        },
        "tokenizer_id": tokenizer_id,
        "reasoning_tokens": null,
        "raw": raw,
    }))
}

fn count(value: Option<&Value>) -> Result<u64> {
    match value.and_then(Value::as_u64) {
        Some(count) => Ok(count),
        None => bail!("usage must contain non-negative integer counts"),
    }
}

fn optional_count(value: Option<&Value>) -> Result<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        value => count(value),
    }
}

/// What one streamed chunk adds to the answer.
#[derive(Default)]
pub struct Parsed {
    pub text: Vec<String>,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
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

/// Reads one streamed chunk. A tool call or reasoning fails the job, because
/// the quote declares only `text`.
pub fn parse_chunk(chunk: &Value) -> Result<Parsed> {
    let mut parsed = Parsed::default();
    if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
        parsed.usage = Some(usage.clone());
    }
    for choice in chunk
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let delta = choice.get("delta");
        let field = |name: &str| delta.and_then(|delta| delta.get(name));
        if truthy(field("tool_calls")) || truthy(field("function_call")) {
            bail!("upstream returned a tool call");
        }
        if ["reasoning", "reasoning_content", "reasoning_details"]
            .iter()
            .any(|name| truthy(field(name)))
        {
            bail!("upstream returned reasoning");
        }
        if let Some(text) = field("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            parsed.text.push(text.to_string());
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            parsed.finish_reason = Some(reason.to_string());
        }
    }
    Ok(parsed)
}

/// What a whole stream produced, so the caller can check it before `done`.
pub struct Outcome {
    pub usage: Value,
    pub finish_reason: String,
}

/// Sends the request and calls `on_text` for each piece of output text, in
/// order. `on_text` returns an error to stop, for example when the exchange
/// closed the dispatch.
pub async fn stream_chat<F, Fut>(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    request: &Value,
    mut on_text: F,
) -> Result<Outcome>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let response = http
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(request)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(1000).collect();
        return Err(
            UpstreamStatus(format!("upstream returned {}: {body}", status.as_u16())).into(),
        );
    }

    let mut usage = None;
    let mut finish_reason = None;
    let mut buffer: Vec<u8> = vec![];
    let mut stream = response.bytes_stream();
    let mut done = false;
    while !done {
        match stream.next().await {
            Some(chunk) => buffer.extend_from_slice(&chunk?),
            None => {
                done = true;
                buffer.push(b'\n');
            }
        }
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let parsed = parse_chunk(&serde_json::from_str(data)?)?;
            if parsed.usage.is_some() {
                usage = parsed.usage;
            }
            if parsed.finish_reason.is_some() {
                finish_reason = parsed.finish_reason;
            }
            for text in parsed.text {
                on_text(text).await?;
            }
        }
    }
    match (usage, finish_reason) {
        (Some(usage), Some(reason))
            if matches!(reason.as_str(), "stop" | "length" | "content_filter") =>
        {
            Ok(Outcome {
                usage,
                finish_reason: reason,
            })
        }
        _ => bail!("upstream ended without valid usage and finish_reason"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_cached_tokens_to_the_cache_read_meter() {
        let raw = json!({
            "prompt_tokens": 100,
            "completion_tokens": 7,
            "prompt_tokens_details": {"cached_tokens": 40},
        });
        let report = usage_report(&raw, "o200k_base").unwrap();
        assert_eq!(
            report["meters"],
            json!({
                "uncached_input": 60,
                "cache_read": 40,
                "cache_write_short": 0,
                "cache_write_long": 0,
                "generation": 7,
            })
        );
        assert_eq!(report["raw"], raw);
        assert_eq!(report["tokenizer_id"], "o200k_base");
    }

    #[test]
    fn refuses_usage_it_cannot_meter() {
        for raw in [
            json!({"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 2}}),
            json!({"prompt_tokens": 1, "completion_tokens": 1, "completion_tokens_details": {"reasoning_tokens": 1}}),
            json!({"prompt_tokens": 1, "completion_tokens": 1, "prompt_tokens_details": {"cache_write_tokens": 1}}),
            json!({"prompt_tokens": -1, "completion_tokens": 1}),
            json!({"prompt_tokens": 1.5, "completion_tokens": 1}),
            json!({"completion_tokens": 1}),
        ] {
            assert!(usage_report(&raw, "t").is_err(), "{raw}");
        }
    }

    #[test]
    fn chunks_with_tool_calls_or_reasoning_fail() {
        let tool = json!({"choices": [{"delta": {"tool_calls": [{"index": 0}]}}]});
        assert!(parse_chunk(&tool).is_err());
        let reasoning = json!({"choices": [{"delta": {"reasoning_content": "hmm"}}]});
        assert!(parse_chunk(&reasoning).is_err());
        let empty = json!({"choices": [{"delta": {"reasoning_content": "", "content": "hi"}}]});
        assert_eq!(parse_chunk(&empty).unwrap().text, vec!["hi".to_string()]);
    }
}
