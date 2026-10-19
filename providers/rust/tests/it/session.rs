use std::time::Duration;

use serde_json::json;

use crate::harness::{Agent, MODEL_ID, Mode};

#[tokio::test]
async fn logs_in_and_quotes_the_listed_deployment() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let mut conn = agent.exchange.accept().await;

    let (login, quote) = conn.handshake_with_login().await;
    assert_eq!(login["slug"], "acme");
    assert_eq!(login["api_key"], "sk-liquid-test");
    assert_eq!(
        login["dispatch_url"],
        format!("{}/dispatch", agent.dispatch_url)
    );
    assert_eq!(login["capabilities"], json!([]));
    assert_eq!(quote["type"], "quote");
    assert_eq!(
        quote["target"],
        json!({"kind": "registered", "model_id": MODEL_ID})
    );
    assert_eq!(quote["revision"], 1);
    assert_eq!(quote["rate_uncached_input"], 0.1);
    assert_eq!(quote["rate_cache_read"], 0.02);
    assert_eq!(quote["rate_generation"], 0.2);
    assert_eq!(quote["fixed_fee"], 0.0);
    assert_eq!(quote["supported_features"], json!(["text"]));
    assert_eq!(quote["retention_policy_supported"], json!(["none"]));
    assert_eq!(quote["valid_for_ms"], 60000);
    assert_eq!(
        quote["execution_limits"],
        json!({"max_input_tokens": 128000, "max_output_tokens": 4096})
    );
    assert!(uuid::Uuid::parse_str(quote["execution_ref"].as_str().unwrap()).is_ok());
}

#[tokio::test]
async fn quotes_again_before_expiry_with_a_higher_revision() {
    let agent = Agent::start(Mode::Answer, |config| {
        config.quote_lifetime = Duration::from_millis(400);
    })
    .await;
    let mut conn = agent.exchange.accept().await;
    let first = conn.handshake().await;
    conn.ack(&first, 400).await;

    let second = conn.recv().await;
    assert_eq!(second["type"], "quote");
    assert_eq!(second["revision"], 2);
    assert_eq!(second["execution_ref"], first["execution_ref"]);
    conn.ack(&second, 400).await;

    let third = conn.recv().await;
    assert_eq!(third["revision"], 3);
}

#[tokio::test]
async fn a_new_listed_frame_withdraws_a_changed_deployment_and_quotes_again() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, first) = agent.ready().await;

    conn.send(json!({"type": "listed", "models": [{
        "model_id": MODEL_ID,
        "deployment_name": "gpt-oss",
        "model": "gpt-oss-120b",
        "tokenizer_id": "o200k_base",
        "max_input_tokens": 64000,
        "max_output_tokens": 4096,
    }]}))
    .await;
    let withdraw = conn.recv().await;
    assert_eq!(withdraw["type"], "withdraw_quote");
    let second = conn.recv().await;
    assert_eq!(second["revision"], 2);
    assert_ne!(second["execution_ref"], first["execution_ref"]);
}

#[tokio::test]
async fn reconnects_after_the_exchange_closes_the_session() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, _) = agent.ready().await;
    conn.close().await;
    drop(conn);

    let mut again = agent.exchange.accept().await;
    let quote = again.handshake().await;
    assert_eq!(
        quote["revision"], 1,
        "revisions start again with each session"
    );
}

#[tokio::test]
async fn reconnects_with_backoff_after_a_refused_login() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let mut conn = agent.exchange.accept().await;
    assert_eq!(conn.recv().await["type"], "login");
    conn.send(json!({"type": "login_reject", "reason": "unknown key"}))
        .await;
    drop(conn);

    let mut again = agent.exchange.accept().await;
    assert_eq!(again.recv().await["type"], "login");
}

#[tokio::test]
async fn withdraws_every_offer_on_shutdown() {
    let mut agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, _) = agent.ready().await;
    agent.stop.send(true).unwrap();
    assert_eq!(conn.recv().await["type"], "mass_withdraw");
    tokio::time::timeout(Duration::from_secs(5), &mut agent.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
