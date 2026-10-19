use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::harness::{Agent, Mode, events};

#[tokio::test]
async fn streams_deltas_and_reports_meters_with_cached_tokens() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;

    let response = agent
        .post("aw_1", Agent::dispatch_body("aw_1", &quote))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "application/x-ndjson");
    let events = events(&response.text().await.unwrap());

    assert_eq!(events[0], json!({"type": "delta", "text": "Hel"}));
    assert_eq!(events[1], json!({"type": "delta", "text": "lo"}));
    let done = &events[2];
    assert_eq!(done["type"], "done");
    assert_eq!(done["finish_reason"], "stop");
    assert_eq!(
        done["usage"]["meters"],
        json!({
            "uncached_input": 8,
            "cache_read": 4,
            "cache_write_short": 0,
            "cache_write_long": 0,
            "generation": 5,
        })
    );
    assert_eq!(done["usage"]["tokenizer_id"], "o200k_base");
    assert_eq!(done["usage"]["reasoning_tokens"], Value::Null);
    assert_eq!(done["usage"]["raw"]["prompt_tokens"], 12);
    assert_eq!(events.len(), 3);

    let requests = agent.upstream.requests.lock().unwrap();
    let (request, auth) = &requests[0];
    assert_eq!(auth, "Bearer upstream-key");
    assert_eq!(request["model"], "gpt-oss-120b");
    assert_eq!(request["max_tokens"], 64);
    assert_eq!(request["temperature"], 0.2);
    assert_eq!(request["stream"], true);
    assert_eq!(request["stream_options"], json!({"include_usage": true}));
    assert_eq!(
        request["messages"],
        json!([
            {"role": "system", "content": "You are terse."},
            {"role": "user", "content": "Hi"},
        ])
    );
}

#[tokio::test]
async fn a_second_delivery_of_one_award_gets_409_and_no_upstream_work() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;
    let body = Agent::dispatch_body("aw_1", &quote);

    assert_eq!(
        agent.post("aw_1", body.clone()).await.status(),
        StatusCode::OK
    );
    let again = agent.post("aw_1", body).await;
    assert_eq!(again.status(), StatusCode::CONFLICT);
    assert_eq!(
        again.json::<Value>().await.unwrap(),
        json!({"error": "duplicate_award"})
    );
    assert_eq!(agent.upstream.call_count(), 1);
}

#[tokio::test]
async fn the_claim_comes_before_the_upstream_work() {
    let agent = Agent::start(Mode::Fail, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;
    let body = Agent::dispatch_body("aw_1", &quote);

    let first = agent.post("aw_1", body.clone()).await.text().await.unwrap();
    let events = events(&first);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "failed");
    assert_eq!(events[0]["code"], "upstream_failed");
    assert_eq!(
        events[0]["message"],
        "upstream returned 500: model overloaded"
    );

    assert_eq!(
        agent.post("aw_1", body).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(agent.upstream.call_count(), 1);
}

#[tokio::test]
async fn refuses_a_dispatch_without_an_award_notice() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (_conn, quote) = agent.ready().await;

    let response = agent
        .post("aw_unknown", Agent::dispatch_body("aw_unknown", &quote))
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid_dispatch"
    );
    assert_eq!(agent.upstream.call_count(), 0);
}

#[tokio::test]
async fn waits_for_an_award_notice_that_arrives_after_the_dispatch() {
    let agent = Agent::start(Mode::Answer, |config| {
        config.award_wait = Duration::from_secs(3)
    })
    .await;
    let (mut conn, quote) = agent.ready().await;

    let post = agent.post("aw_1", Agent::dispatch_body("aw_1", &quote));
    let notice = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        conn.award("aw_1", 64).await;
    };
    let (response, ()) = tokio::join!(post, notice);
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn refuses_a_dispatch_that_differs_from_the_award_without_claiming_it() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;

    let mut with_tools = Agent::dispatch_body("aw_1", &quote);
    with_tools["tools"] = json!([{"name": "lookup"}]);
    assert_eq!(
        agent.post("aw_1", with_tools).await.status(),
        StatusCode::BAD_REQUEST
    );

    let mut too_long = Agent::dispatch_body("aw_1", &quote);
    too_long["max_output_tokens"] = json!(65);
    assert_eq!(
        agent.post("aw_1", too_long).await.status(),
        StatusCode::BAD_REQUEST
    );

    let mut wrong_ref = Agent::dispatch_body("aw_1", &quote);
    wrong_ref["execution_ref"] = json!("00000000-0000-4000-8000-000000000000");
    assert_eq!(
        agent.post("aw_1", wrong_ref).await.status(),
        StatusCode::BAD_REQUEST
    );

    let mut image = Agent::dispatch_body("aw_1", &quote);
    image["messages"][1]["parts"] = json!([{"type": "image_url", "url": "https://x/y.png"}]);
    assert_eq!(
        agent.post("aw_1", image).await.status(),
        StatusCode::BAD_REQUEST
    );

    assert_eq!(agent.upstream.call_count(), 0);
    let good = agent
        .post("aw_1", Agent::dispatch_body("aw_1", &quote))
        .await;
    assert_eq!(good.status(), StatusCode::OK);
}

#[tokio::test]
async fn refuses_an_idempotency_key_that_differs_from_the_award_id() {
    let agent = Agent::start(Mode::Answer, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;

    let response = agent
        .post("aw_other", Agent::dispatch_body("aw_1", &quote))
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn shutdown_finishes_the_dispatch_in_progress() {
    let mut agent = Agent::start(Mode::Held, |_| {}).await;
    let (mut conn, quote) = agent.ready().await;
    conn.award("aw_1", 64).await;

    let response = agent
        .post("aw_1", Agent::dispatch_body("aw_1", &quote))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let reader = tokio::spawn(response.text());

    agent.stop.send(true).unwrap();
    assert_eq!(conn.recv().await["type"], "mass_withdraw");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !agent.task.is_finished(),
        "the server must wait for the dispatch"
    );

    agent.upstream.release();
    let events = events(&reader.await.unwrap().unwrap());
    assert_eq!(events.last().unwrap()["type"], "done");
    tokio::time::timeout(Duration::from_secs(5), &mut agent.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
