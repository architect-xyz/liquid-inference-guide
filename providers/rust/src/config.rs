use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};

pub const DEFAULT_EXCHANGE_URL: &str = "https://router.inference.ai.exchange";

/// What the deployment sells. It decides the rates, the upstream call and the
/// events of a dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Chat,
    ImageGeneration,
    AudioSpeech,
    VideoGeneration,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::ImageGeneration => "image_generation",
            Self::AudioSpeech => "audio_speech",
            Self::VideoGeneration => "video_generation",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [
            Self::Chat,
            Self::ImageGeneration,
            Self::AudioSpeech,
            Self::VideoGeneration,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == text)
    }

    /// The rate variable of a media kind, and the time in which the kind
    /// commits to finish a job.
    fn media(self) -> Option<(&'static str, u64)> {
        match self {
            Self::Chat => None,
            Self::ImageGeneration => Some(("RATE_PER_IMAGE", 90_000)),
            Self::AudioSpeech => Some(("RATE_PER_CHARACTER", 30_000)),
            Self::VideoGeneration => Some(("RATE_PER_VIDEO_SECOND", 300_000)),
        }
    }
}

/// The settings of one agent. It has no `Debug` impl because it holds keys.
pub struct Config {
    pub exchange_url: String,
    pub slug: String,
    pub provider_key: String,
    pub deployment_name: String,
    pub dispatch_bind: String,
    pub dispatch_url: String,
    pub upstream_url: String,
    pub upstream_key: String,
    pub kind: Kind,
    /// USD per million tokens. A media deployment leaves these at zero.
    pub rate_input: f64,
    pub rate_cache_read: f64,
    pub rate_output: f64,
    /// USD for each image, character or second of video, by `kind`. A chat
    /// deployment leaves it at zero.
    pub unit_rate: f64,
    /// The time in which a media job commits to finish.
    pub completion_ms: u64,
    /// Signs the handle of a finished video.
    pub content_key: String,
    /// How often a video render is asked about.
    pub poll_interval: Duration,
    pub render_timeout: Duration,
    pub retention: String,
    pub award_journal: PathBuf,
    pub quote_lifetime: Duration,
    pub upstream_timeout: Duration,
    pub shutdown_timeout: Duration,
    /// The exchange closes a session after five seconds with no frame.
    pub heartbeat_interval: Duration,
    /// How long a dispatch waits for its `award_notice`, which can arrive
    /// after the HTTP call.
    pub award_wait: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let optional = |name: &str| {
            lookup(&format!("LIQUID_{name}"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let required =
            |name: &str| optional(name).with_context(|| format!("LIQUID_{name} is required"));
        let url = |name: &str, value: String| -> Result<String> {
            let value = value.trim_end_matches('/').to_string();
            let rest = value
                .strip_prefix("https://")
                .or_else(|| value.strip_prefix("http://"));
            match rest {
                Some(rest)
                    if !rest.is_empty() && !rest.split('/').next().unwrap_or("").contains('@') =>
                {
                    Ok(value)
                }
                _ => bail!("LIQUID_{name} must be an HTTP URL without credentials"),
            }
        };
        let rate = |name: &str| -> Result<f64> {
            let text = required(name)?;
            let decimals = text.split_once('.').map_or(0, |(_, tail)| tail.len());
            let plain = text.chars().all(|c| c.is_ascii_digit() || c == '.');
            let value: f64 = text.parse().unwrap_or(f64::NAN);
            if !plain || !value.is_finite() || decimals > 9 {
                bail!(
                    "LIQUID_{name} must be a non-negative decimal price with at most nine decimal places"
                );
            }
            Ok(value)
        };
        let seconds = |name: &str, default: &str| -> Result<Duration> {
            let value: f64 = optional(name)
                .unwrap_or_else(|| default.to_string())
                .parse()
                .with_context(|| format!("LIQUID_{name} must be a number of seconds"))?;
            if !(value > 0.0 && value <= 3600.0) {
                bail!("LIQUID_{name} must be between zero and 3600 seconds");
            }
            Ok(Duration::from_secs_f64(value))
        };

        let kind = match optional("DEPLOYMENT_KIND") {
            None => Kind::Chat,
            Some(text) => Kind::parse(&text).context(
                "LIQUID_DEPLOYMENT_KIND must be one of chat, image_generation, audio_speech, video_generation",
            )?,
        };
        let media = kind.media();
        let content_key = optional("CONTENT_KEY").unwrap_or_default();
        if kind == Kind::VideoGeneration && content_key.is_empty() {
            bail!("LIQUID_CONTENT_KEY is required for a video deployment");
        }
        let completion_ms: u64 = match optional("COMPLETION_MS") {
            Some(text) => text
                .parse()
                .context("LIQUID_COMPLETION_MS must be a whole number")?,
            None => media.map_or(30_000, |(_, default)| default),
        };

        let exchange_url = url(
            "EXCHANGE_URL",
            optional("EXCHANGE_URL").unwrap_or_else(|| DEFAULT_EXCHANGE_URL.to_string()),
        )?;
        let upstream_url = url("UPSTREAM_BASE_URL", required("UPSTREAM_BASE_URL")?)?;
        let dispatch_url = url("DISPATCH_URL", required("DISPATCH_URL")?)?;
        let retention = optional("RETENTION_POLICY").unwrap_or_else(|| "none".to_string());
        if retention != "none" && retention != "allowed" {
            bail!("LIQUID_RETENTION_POLICY must be none or allowed");
        }
        let lifetime_ms: u64 = optional("QUOTE_LIFETIME_MS")
            .unwrap_or_else(|| "60000".to_string())
            .parse()
            .context("LIQUID_QUOTE_LIFETIME_MS must be a whole number")?;
        if lifetime_ms == 0 || lifetime_ms > 600_000 {
            bail!("LIQUID_QUOTE_LIFETIME_MS must be between zero and 600000");
        }
        let dispatch_bind =
            optional("DISPATCH_BIND").unwrap_or_else(|| "127.0.0.1:9110".to_string());
        match dispatch_bind.rsplit_once(':') {
            Some((host, port)) if !host.is_empty() && port.parse::<u16>().is_ok() => {}
            _ => bail!("LIQUID_DISPATCH_BIND must be host:port"),
        }

        Ok(Self {
            exchange_url,
            slug: required("PROVIDER_SLUG")?,
            provider_key: required("PROVIDER_API_KEY")?,
            deployment_name: required("DEPLOYMENT_NAME")?,
            dispatch_bind,
            dispatch_url,
            upstream_url,
            upstream_key: required("UPSTREAM_API_KEY")?,
            kind,
            rate_input: if media.is_none() {
                rate("RATE_INPUT")?
            } else {
                0.0
            },
            rate_cache_read: if media.is_none() {
                rate("RATE_CACHE_READ")?
            } else {
                0.0
            },
            rate_output: if media.is_none() {
                rate("RATE_OUTPUT")?
            } else {
                0.0
            },
            unit_rate: match media {
                Some((name, _)) => rate(name)?,
                None => 0.0,
            },
            completion_ms,
            content_key,
            poll_interval: seconds("UPSTREAM_POLL_SECONDS", "2")?,
            render_timeout: seconds("UPSTREAM_RENDER_TIMEOUT_SECONDS", "540")?,
            retention,
            award_journal: PathBuf::from(
                optional("AWARD_JOURNAL").unwrap_or_else(|| "awards.journal".to_string()),
            ),
            quote_lifetime: Duration::from_millis(lifetime_ms),
            upstream_timeout: seconds("UPSTREAM_TIMEOUT_SECONDS", "30")?,
            shutdown_timeout: seconds("SHUTDOWN_TIMEOUT_SECONDS", "35")?,
            heartbeat_interval: Duration::from_secs(1),
            award_wait: Duration::from_secs(2),
        })
    }

    pub fn session_url(&self) -> String {
        let base = if let Some(rest) = self.exchange_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.exchange_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.exchange_url.clone()
        };
        format!("{base}/v1/provider/ws")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn base() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("LIQUID_PROVIDER_SLUG", "acme"),
            ("LIQUID_PROVIDER_API_KEY", "sk-liquid-test"),
            ("LIQUID_DEPLOYMENT_NAME", "gpt-oss"),
            ("LIQUID_DISPATCH_URL", "https://agent.example.com/dispatch"),
            ("LIQUID_UPSTREAM_BASE_URL", "http://127.0.0.1:9200/v1/"),
            ("LIQUID_UPSTREAM_API_KEY", "key"),
            ("LIQUID_RATE_INPUT", "0.10"),
            ("LIQUID_RATE_CACHE_READ", "0.02"),
            ("LIQUID_RATE_OUTPUT", "0.20"),
        ])
    }

    fn load(vars: &HashMap<&str, &str>) -> Result<Config> {
        Config::from_lookup(|name| vars.get(name).map(|value| value.to_string()))
    }

    #[test]
    fn defaults_and_session_url() {
        let config = load(&base()).unwrap();
        assert_eq!(
            config.session_url(),
            "wss://router.inference.ai.exchange/v1/provider/ws"
        );
        assert_eq!(config.upstream_url, "http://127.0.0.1:9200/v1");
        assert_eq!(config.quote_lifetime, Duration::from_millis(60_000));
        assert_eq!(config.retention, "none");
    }

    #[test]
    fn refuses_bad_values() {
        for (name, value) in [
            ("LIQUID_RATE_INPUT", "-1"),
            ("LIQUID_RATE_INPUT", "0.0000000001"),
            ("LIQUID_RATE_INPUT", "1e3"),
            ("LIQUID_RETENTION_POLICY", "maybe"),
            ("LIQUID_QUOTE_LIFETIME_MS", "0"),
            (
                "LIQUID_DISPATCH_URL",
                "https://user:pw@agent.example.com/dispatch",
            ),
            ("LIQUID_DISPATCH_BIND", "9110"),
        ] {
            let mut vars = base();
            vars.insert(name, value);
            assert!(load(&vars).is_err(), "{name}={value} should fail");
        }
    }

    #[test]
    fn media_kinds_need_only_their_own_rate() {
        for (kind, rate, completion) in [
            ("image_generation", "LIQUID_RATE_PER_IMAGE", 90_000),
            ("audio_speech", "LIQUID_RATE_PER_CHARACTER", 30_000),
            ("video_generation", "LIQUID_RATE_PER_VIDEO_SECOND", 300_000),
        ] {
            let mut vars = base();
            for name in [
                "LIQUID_RATE_INPUT",
                "LIQUID_RATE_CACHE_READ",
                "LIQUID_RATE_OUTPUT",
            ] {
                vars.remove(name);
            }
            vars.insert("LIQUID_DEPLOYMENT_KIND", kind);
            vars.insert("LIQUID_CONTENT_KEY", "key");
            assert!(load(&vars).is_err(), "{kind} without {rate}");
            vars.insert(rate, "0.04");
            let config = load(&vars).unwrap();
            assert_eq!(config.kind.as_str(), kind);
            assert_eq!(config.unit_rate, 0.04);
            assert_eq!(config.completion_ms, completion);
            assert_eq!(config.poll_interval, Duration::from_secs(2));
            assert_eq!(config.render_timeout, Duration::from_secs(540));
        }
    }

    #[test]
    fn refuses_a_bad_kind_or_a_video_without_a_content_key() {
        let mut vars = base();
        vars.insert("LIQUID_DEPLOYMENT_KIND", "embedding");
        let error = load(&vars).err().unwrap();
        assert!(format!("{error:#}").contains("LIQUID_DEPLOYMENT_KIND"));

        let mut vars = base();
        vars.insert("LIQUID_DEPLOYMENT_KIND", "video_generation");
        vars.insert("LIQUID_RATE_PER_VIDEO_SECOND", "0.05");
        let error = load(&vars).err().unwrap();
        assert!(format!("{error:#}").contains("LIQUID_CONTENT_KEY"));
    }

    #[test]
    fn names_the_missing_variable() {
        let mut vars = base();
        vars.remove("LIQUID_PROVIDER_API_KEY");
        let error = load(&vars).err().unwrap();
        assert!(format!("{error:#}").contains("LIQUID_PROVIDER_API_KEY"));
    }
}
