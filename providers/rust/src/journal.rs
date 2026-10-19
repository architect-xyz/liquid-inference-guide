//! The record of claimed awards. A claim is on disk before any upstream work
//! starts, so a restart cannot run the same award twice.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};

pub struct Journal {
    inner: Mutex<Inner>,
}

struct Inner {
    file: File,
    claimed: HashSet<(String, String)>,
}

impl Journal {
    /// Opens the journal and reads the claims of earlier runs. Each line holds
    /// a provider id and an award id, separated by a tab.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let existing = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error).context("failed to read the award journal"),
        };
        let claimed = existing
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .map(|(provider, award)| (provider.to_string(), award.to_string()))
            .collect();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .context("failed to open the award journal")?;
        Ok(Self {
            inner: Mutex::new(Inner { file, claimed }),
        })
    }

    pub fn contains(&self, provider_id: &str, award_id: &str) -> bool {
        self.lock()
            .claimed
            .contains(&(provider_id.to_string(), award_id.to_string()))
    }

    /// Returns `false` when the award is already claimed. Holding the lock
    /// across the write makes two concurrent claims of one award safe.
    pub fn claim(&self, provider_id: &str, award_id: &str) -> Result<bool> {
        let mut inner = self.lock();
        let key = (provider_id.to_string(), award_id.to_string());
        if inner.claimed.contains(&key) {
            return Ok(false);
        }
        writeln!(inner.file, "{provider_id}\t{award_id}")?;
        inner.file.sync_data()?;
        inner.claimed.insert(key);
        Ok(true)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_once_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("journal-{}", uuid::Uuid::new_v4()));
        let path = dir.join("awards.journal");
        let journal = Journal::open(&path).unwrap();
        assert!(journal.claim("p1", "aw_1").unwrap());
        assert!(!journal.claim("p1", "aw_1").unwrap());
        assert!(journal.claim("p2", "aw_1").unwrap());
        drop(journal);

        let reopened = Journal::open(&path).unwrap();
        assert!(reopened.contains("p1", "aw_1"));
        assert!(!reopened.claim("p1", "aw_1").unwrap());
        assert!(!reopened.contains("p1", "aw_2"));
        fs::remove_dir_all(dir).unwrap();
    }
}
