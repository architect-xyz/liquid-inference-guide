use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};

pub const DEFAULT_EXCHANGE_URL: &str = "https://router.inference.ai.exchange";

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
    /// USD per million tokens.
    pub rate_input: f64,
    pub rate_cache_read: f64,
    pub rate_output: f64,
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
            rate_input: rate("RATE_INPUT")?,
            rate_cache_read: rate("RATE_CACHE_READ")?,
            rate_output: rate("RATE_OUTPUT")?,
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
    fn names_the_missing_variable() {
        let mut vars = base();
        vars.remove("LIQUID_PROVIDER_API_KEY");
        let error = load(&vars).err().unwrap();
        assert!(format!("{error:#}").contains("LIQUID_PROVIDER_API_KEY"));
    }
}
