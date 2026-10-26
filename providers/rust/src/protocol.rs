//! The frames of the provider session. Only the fields that this agent reads
//! or writes are typed; the exchange can add fields at any time.

use serde::{Deserialize, Serialize};

/// Agent to exchange.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderMessage {
    Login {
        slug: String,
        api_key: String,
        dispatch_url: String,
        capabilities: Vec<String>,
    },
    Quote(Quote),
    WithdrawQuote {
        target: QuoteTarget,
    },
    MassWithdraw,
    Heartbeat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QuoteTarget {
    Registered { model_id: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionLimits {
    pub max_input_tokens: u64,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceClass {
    pub ttft_ms: u64,
    pub completion_ms: u64,
}

/// The prices of a quote, as JSON numbers. A chat deployment quotes USD per
/// million tokens. Each media kind quotes one unit rate, in USD, and nothing
/// else.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Rates {
    Tokens {
        rate_uncached_input: f64,
        rate_cache_read: f64,
        rate_generation: f64,
    },
    PerImage {
        rate_per_image: f64,
    },
    PerCharacter {
        rate_per_character: f64,
    },
    PerVideoSecond {
        rate_per_video_second: f64,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct Quote {
    pub target: QuoteTarget,
    pub execution_ref: String,
    pub execution_limits: ExecutionLimits,
    #[serde(flatten)]
    pub rates: Rates,
    pub fixed_fee: f64,
    pub service_class: ServiceClass,
    pub supported_features: Vec<String>,
    pub retention_policy_supported: Vec<String>,
    pub valid_for_ms: u64,
    pub revision: u64,
}

/// Exchange to agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExchangeMessage {
    LoginAck {
        provider_id: String,
        #[serde(default)]
        slug: Option<String>,
    },
    LoginReject {
        #[serde(default)]
        reason: String,
    },
    Listed {
        models: Vec<ListedModel>,
    },
    QuoteAck {
        offer_id: String,
        revision: u64,
        #[serde(default)]
        valid_for_ms: u64,
    },
    QuoteReject {
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        field: Option<String>,
        #[serde(default)]
        reason: String,
    },
    AwardNotice(AwardNotice),
    SettlementNotice {
        award_id: String,
        #[serde(default)]
        status: Option<String>,
    },
    RiskNotice {
        #[serde(default)]
        severity: Option<String>,
        #[serde(default)]
        message: Option<String>,
    },
    Heartbeat,
    Handover,
    Superseded,
    #[serde(other)]
    Unknown,
}

fn provider_native() -> String {
    "provider-native".to_string()
}

/// One deployment in a `listed` frame. A text deployment has `kind` `chat` and
/// `pricing_unit` `tokens`; both default to that when absent.
#[derive(Debug, Clone, Deserialize)]
pub struct ListedModel {
    pub model_id: String,
    pub deployment_name: String,
    pub model: String,
    #[serde(default = "provider_native")]
    pub tokenizer_id: String,
    pub max_input_tokens: u64,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub pricing_unit: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AwardNotice {
    pub award_id: String,
    pub job_id: String,
    pub offer_id: String,
    pub served_model: String,
    pub max_output_tokens: u64,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn quote_serializes_flat_with_type_tag() {
        let frame = ProviderMessage::Quote(Quote {
            target: QuoteTarget::Registered {
                model_id: "m1".into(),
            },
            execution_ref: "r1".into(),
            execution_limits: ExecutionLimits {
                max_input_tokens: 10,
                max_output_tokens: None,
            },
            rates: Rates::Tokens {
                rate_uncached_input: 0.1,
                rate_cache_read: 0.02,
                rate_generation: 0.2,
            },
            fixed_fee: 0.0,
            service_class: ServiceClass {
                ttft_ms: 1500,
                completion_ms: 30000,
            },
            supported_features: vec!["text".into()],
            retention_policy_supported: vec!["none".into()],
            valid_for_ms: 60000,
            revision: 3,
        });
        let value = serde_json::to_value(frame).unwrap();
        assert_eq!(value["type"], "quote");
        assert_eq!(
            value["target"],
            json!({"kind": "registered", "model_id": "m1"})
        );
        assert_eq!(value["execution_limits"]["max_output_tokens"], Value::Null);
        assert_eq!(value["revision"], 3);
        assert_eq!(value["rate_generation"], 0.2);
    }

    #[test]
    fn a_media_quote_carries_only_its_unit_rate() {
        let value = serde_json::to_value(Rates::PerImage {
            rate_per_image: 0.04,
        })
        .unwrap();
        assert_eq!(value, json!({"rate_per_image": 0.04}));
    }

    #[test]
    fn unit_frames_and_unknown_types_parse() {
        let heartbeat: ExchangeMessage =
            serde_json::from_value(json!({"type": "heartbeat"})).unwrap();
        assert!(matches!(heartbeat, ExchangeMessage::Heartbeat));
        let unknown: ExchangeMessage =
            serde_json::from_value(json!({"type": "from_the_future", "x": 1})).unwrap();
        assert!(matches!(unknown, ExchangeMessage::Unknown));
        let mass = serde_json::to_value(ProviderMessage::MassWithdraw).unwrap();
        assert_eq!(mass, json!({"type": "mass_withdraw"}));
    }
}
