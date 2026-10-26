//! State that the session and the dispatch handler share.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::config::Kind;
use crate::protocol::{AwardNotice, ListedModel};

/// The deployment as `listed` described it, with the `execution_ref` that
/// this agent chose for it.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub model_id: String,
    pub model: String,
    pub tokenizer_id: String,
    pub max_input_tokens: u64,
    pub max_output_tokens: Option<u64>,
    pub reference: String,
    pub kind: Kind,
}

impl Snapshot {
    pub fn from_listed(model: &ListedModel, kind: Kind) -> Result<Self> {
        if model.kind.as_deref().unwrap_or("chat") != kind.as_str() {
            bail!("the deployment is not a {} deployment", kind.as_str());
        }
        // An image deployment can be priced in tokens. The reference prices each image.
        if let Some(unit) = &model.pricing_unit
            && (unit == "tokens") != (kind == Kind::Chat)
        {
            bail!("the pricing unit of the deployment does not match its kind");
        }
        Ok(Self {
            model_id: model.model_id.clone(),
            model: model.model.clone(),
            tokenizer_id: model.tokenizer_id.clone(),
            max_input_tokens: model.max_input_tokens,
            max_output_tokens: model.max_output_tokens,
            reference: Uuid::new_v4().to_string(),
            kind,
        })
    }

    /// True when the registration is unchanged, so the same `execution_ref`
    /// stays valid.
    pub fn same_deployment(&self, other: &Self) -> bool {
        self.model_id == other.model_id
            && self.model == other.model
            && self.tokenizer_id == other.tokenizer_id
            && self.max_input_tokens == other.max_input_tokens
            && self.max_output_tokens == other.max_output_tokens
    }
}

#[derive(Debug, Clone)]
pub struct Award {
    pub notice: AwardNotice,
    /// The `execution_ref` values that were valid when the notice arrived. A
    /// dispatch may use only one of these.
    pub references: Vec<String>,
}

#[derive(Default)]
pub struct Shared {
    provider_id: Mutex<Option<String>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
    awards: Mutex<HashMap<String, Award>>,
    noticed: Notify,
    connected: AtomicBool,
}

impl Shared {
    pub fn provider_id(&self) -> Option<String> {
        lock(&self.provider_id).clone()
    }

    pub fn set_provider_id(&self, id: String) {
        *lock(&self.provider_id) = Some(id);
    }

    pub fn connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn set_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
    }

    pub fn record_snapshot(&self, snapshot: Snapshot) {
        lock(&self.snapshots).insert(snapshot.reference.clone(), snapshot);
    }

    pub fn snapshot(&self, reference: &str) -> Option<Snapshot> {
        lock(&self.snapshots).get(reference).cloned()
    }

    pub fn record_award(&self, notice: AwardNotice) {
        let references = lock(&self.snapshots).keys().cloned().collect();
        lock(&self.awards).insert(notice.award_id.clone(), Award { notice, references });
        self.noticed.notify_waiters();
    }

    pub fn forget_award(&self, award_id: &str) {
        lock(&self.awards).remove(award_id);
    }

    /// Waits for the `award_notice` of a dispatch, which can arrive after the
    /// dispatch itself because the two travel on different connections.
    pub async fn award(&self, award_id: &str, wait: Duration) -> Result<Award> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.noticed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(award) = lock(&self.awards).get(award_id) {
                return Ok(award.clone());
            }
            tokio::time::timeout_at(deadline, notified)
                .await
                .map_err(|_| anyhow!("no award notice for this dispatch"))?;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
