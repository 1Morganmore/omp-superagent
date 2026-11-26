use std::{
    fmt,
    fs::{self, Metadata},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, ensure};
use tokio::time::Instant;

use crate::store::{HEAD_SESSION_FILE, Store};

use super::{Lifecycle, LifecycleConfig, restart_record::STOP, rotation::{Rotation, Stage}};

const RETRY_DELAY: Duration = Duration::from_secs(5);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Eq, PartialEq)]
enum PathStamp {
    Unavailable(Option<i32>),
    Directory { dev: u64, ino: u64, mode: u32 },
    Entry {
        dev: u64,
        ino: u64,
        mode: u32,
        len: u64,
        changed: (i64, i64),
        modified: (i64, i64),
    },
}

impl PathStamp {
    fn read(stat: std::io::Result<Metadata>) -> Self {
        match stat {
            // Do not treat unrelated writes inside a shared profile/session
            // directory as new launch input. Its identity and mode matter.
            Ok(stat) if stat.is_dir() => Self::Directory {
                dev: stat.dev(), ino: stat.ino(), mode: stat.mode(),
            },
            Ok(stat) => Self::Entry {
                dev: stat.dev(), ino: stat.ino(), mode: stat.mode(), len: stat.len(),
                changed: (stat.ctime(), stat.ctime_nsec()),
                modified: (stat.mtime(), stat.mtime_nsec()),
            },
            Err(error) => Self::Unavailable(error.raw_os_error()),
        }
    }

    fn changed_since(&self, start: (i64, i64)) -> bool {
        matches!(self, Self::Entry { changed, .. } if *changed >= start)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Observation {
    entry: PathStamp,
    target: Option<PathStamp>,
}

impl Observation {
    fn read(path: &Path) -> Self {
        let entry = fs::symlink_metadata(path);
        let target = entry.as_ref().is_ok_and(|stat| stat.is_symlink())
            .then(|| PathStamp::read(fs::metadata(path)));
        Self { entry: PathStamp::read(entry), target }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ProfileInputs(Vec<(PathBuf, Observation)>);

impl ProfileInputs {
    fn unchanged(&self) -> bool {
        self.0.iter().all(|(path, before)| *before == Observation::read(path))
    }

    fn changed_during(&self, started: SystemTime) -> bool {
        let Some(start) = started.duration_since(UNIX_EPOCH).ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok()
                .map(|seconds| (seconds, i64::from(elapsed.subsec_nanos()))))
        else { return false };
        self.0.iter().any(|(_, state)| state.entry.changed_since(start)
            || state.target.as_ref().is_some_and(|target| target.changed_since(start)))
    }
}

#[derive(Debug)]
pub(super) enum WakeRefusal {
    Checkpoint(&'static str),
    ResumeCommand(String),
    Profile(ProfileInputs),
}

impl WakeRefusal {
    pub(super) fn profile(mut paths: Vec<PathBuf>) -> Self {
        paths.sort_unstable();
        paths.dedup();
        Self::Profile(ProfileInputs(paths.into_iter().map(|path| {
            let observed = Observation::read(&path);
            (path, observed)
        }).collect()))
    }

    pub(super) fn status(&self) -> &'static str {
        match self {
            Self::Checkpoint(reason) => reason,
            Self::ResumeCommand(_) => "Native HEAD command or journal refused; correct the input and start with the original profile",
            Self::Profile(_) => "Native HEAD profile changed; restore the original profile before waking",
        }
    }
}

impl fmt::Display for WakeRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ResumeCommand(reason) => f.write_str(reason),
            Self::Checkpoint(_) | Self::Profile(_) => f.write_str(self.status()),
        }
    }
}

impl std::error::Error for WakeRefusal {}

#[derive(Eq, PartialEq)]
struct WakeInputs {
    checkpoint: String,
    stop: Option<String>,
    journal_pointer: Option<String>,
    session_id: Option<String>,
    config: Observation,
    journal: Observation,
}

struct WakeAttempt {
    started: SystemTime,
    inputs: WakeInputs,
}

impl WakeAttempt {
    fn new(config: &LifecycleConfig, store: &Store, plan: Rotation) -> Result<Self> {
        Ok(Self {
            started: SystemTime::now(),
            inputs: WakeInputs {
                checkpoint: plan.recorded,
                stop: store.get_meta(STOP)?,
                journal_pointer: store.get_meta(HEAD_SESSION_FILE)?,
                session_id: store.get_meta("main:sessionId")?,
                config: Observation::read(&config.path),
                journal: Observation::read(&plan.session_file),
            },
        })
    }

    fn after_failure(
        self,
        prior: Option<WakeRetry>,
        error: &anyhow::Error,
        now: Instant,
    ) -> WakeRetry {
        let gate = match error.downcast_ref::<WakeRefusal>() {
            // The helper can report an old profile after dotenv or its
            // symlink changed. Do not pin that result to the corrected files.
            Some(WakeRefusal::Profile(inputs)) if !inputs.changed_during(self.started) => {
                RetryGate::Profile(inputs.clone())
            }
            Some(WakeRefusal::Checkpoint(_) | WakeRefusal::ResumeCommand(_)) => RetryGate::ChangedInput,
            Some(WakeRefusal::Profile(_)) | None => {
                let previous = prior.filter(|retry| retry.inputs == self.inputs)
                    .and_then(|retry| match retry.gate {
                        RetryGate::Backoff { delay, .. } => Some(delay),
                        RetryGate::ChangedInput | RetryGate::Profile(_) => None,
                    });
                let delay = previous.map_or(RETRY_DELAY, |delay| (delay * 2).min(MAX_RETRY_DELAY));
                RetryGate::Backoff { delay, until: now + delay }
            }
        };
        WakeRetry { inputs: self.inputs, gate }
    }
}

enum RetryGate {
    ChangedInput,
    Profile(ProfileInputs),
    Backoff { delay: Duration, until: Instant },
}

pub(super) struct WakeRetry {
    inputs: WakeInputs,
    gate: RetryGate,
}

impl WakeRetry {
    fn holds(&self, attempt: &WakeAttempt, now: Instant) -> bool {
        self.inputs == attempt.inputs && match &self.gate {
            RetryGate::ChangedInput => true,
            RetryGate::Profile(inputs) => inputs.unchanged(),
            RetryGate::Backoff { until, .. } => now < *until,
        }
    }
}

impl Lifecycle {
    pub(super) async fn attempt_head(&self, startup: bool) -> Result<()> {
        let plan = self.rotation()?;
        let Some(plan) = plan.filter(|plan| plan.stage == Stage::Sleeping || plan.stopped_hibernation()) else {
            self.state()?.wake_retry = None;
            return self.ensure_head(None, startup).await;
        };
        let store = &self.0.store;
        let stopped = plan.stopped_hibernation();
        if !startup && (stopped || !store.has_wake_input()?) {
            return Ok(());
        }
        let config = &self.0.config;
        let attempt = WakeAttempt::new(config, store, plan)?;
        let prior = self.state()?.wake_retry.take();
        if prior.as_ref().is_some_and(|retry| retry.holds(&attempt, Instant::now())) {
            self.state()?.wake_retry = prior;
            return Ok(());
        }
        let result = async {
            ensure!(
                !stopped || config.config_hash()? == config.source_hash,
                WakeRefusal::Checkpoint("Gateway configuration changed before explicit HEAD startup"),
            );
            self.ensure_head(None, startup).await
        }.await;
        self.state()?.wake_retry = result.as_ref().err()
            .map(|error| attempt.after_failure(prior, error, Instant::now()));
        result
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn attempt(root: &Path) -> WakeAttempt {
        WakeAttempt {
            started: SystemTime::now(),
            inputs: WakeInputs {
                checkpoint: "exact checkpoint".into(),
                stop: None,
                journal_pointer: None,
                session_id: None,
                config: Observation::read(&root.join("config.json")),
                journal: Observation::read(&root.join("session.jsonl")),
            },
        }
    }

    #[test]
    fn definitive_resume_refusal_waits_for_changed_input_not_elapsed_ticks() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let root = fixture.path();
        let config = root.join("config.json");
        fs::write(&config, br#"{"command":["omp","--max-time=2m"]}"#)?;
        let now = Instant::now();
        let refusal = WakeRefusal::ResumeCommand("Stock --max-time starts a new deadline".into()).into();
        let gate = attempt(root).after_failure(None, &refusal, now);

        assert!(gate.holds(&attempt(root), now + Duration::from_secs(3_600)));
        fs::write(&config, br#"{"command":["omp"]}"#)?;
        assert!(!gate.holds(&attempt(root), now));
        Ok(())
    }

    #[test]
    fn profile_refusal_ignores_directory_activity_and_retries_after_symlink_restoration() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let root = fixture.path();
        let wrong = root.join("wrong");
        let right = root.join("right");
        let effective = root.join("effective");
        fs::create_dir(&wrong)?;
        fs::create_dir(&right)?;
        symlink(&wrong, &effective)?;
        let now = Instant::now();
        let refusal = WakeRefusal::profile(vec![effective.clone(), wrong.clone(), right.clone()]).into();
        let gate = attempt(root).after_failure(None, &refusal, now);

        fs::write(wrong.join("unrelated-session"), "{}")?;
        assert!(gate.holds(&attempt(root), now + Duration::from_secs(3_600)));
        let replacement = root.join("replacement");
        symlink(&right, &replacement)?;
        fs::rename(replacement, effective)?;
        assert!(!gate.holds(&attempt(root), now));
        Ok(())
    }

    #[test]
    fn transient_helper_failure_retries_with_bounded_backoff() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let root = fixture.path();
        let mut tick = Instant::now();
        let error = anyhow::anyhow!("Stock OMP operation timed out");
        let mut prior = None;
        for delay in [5, 10, 20, 40, 60, 60] {
            let gate = attempt(root).after_failure(prior, &error, tick);
            assert!(gate.holds(&attempt(root), tick + Duration::from_secs(delay - 1)));
            tick += Duration::from_secs(delay);
            assert!(!gate.holds(&attempt(root), tick));
            prior = Some(gate);
        }
        Ok(())
    }

    #[test]
    fn changed_dotenv_during_discovery_does_not_make_a_stale_profile_refusal_sticky() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let root = fixture.path();
        let dotenv = root.join(".env");
        let mut in_flight = attempt(root);
        // Files stamped after the start could have been restored while the
        // helper was still reporting an older selection.
        in_flight.started = UNIX_EPOCH;
        fs::write(&dotenv, "XDG_DATA_HOME=/restored\n")?;
        let refusal = WakeRefusal::profile(vec![dotenv]).into();
        let now = Instant::now();
        let gate = in_flight.after_failure(None, &refusal, now);
        assert!(!gate.holds(&attempt(root), now + MAX_RETRY_DELAY));
        Ok(())
    }
}
