use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep};
use uuid::Uuid;

use crate::store::{HEAD_ROTATION, HibernationChange};

use super::{
    Lifecycle, Phase,
    fs::{self, EXIT_TIMEOUT, WAIT_SLICE, alive},
    host_rpc::{Head, Probe, ShutdownRefused, confirmed_exit},
    restart_record::{HEAD, STOP, meta},
    rotation_plan::rotated_file,
};

pub(super) use super::rotation_plan::{Attestation, Mode, Rotation, Stage, session_file, session_file_from_meta};

const MIN_IDLE_MS: u64 = 30 * 60 * 1000;
const PROBE_INTERVAL: Duration = Duration::from_secs(15);
const MIN_HIBERNATION_PROBE_INTERVAL: Duration = Duration::from_secs(2);

impl Lifecycle {
    pub(super) async fn monitor_rotation(&self, controller_ready: bool) -> Result<()> {
        let _supervising = self.0.supervision.lock().await;
        let previous = self.rotation()?;
        if let Some(mut plan) = previous.filter(|plan| plan.stage.active()) {
            if plan.stage == Stage::Stopping {
                // Never reissue shutdown after an unresolved attempt.
                if !alive(plan.original.pid)? {
                    self.finish_rotation_exit(&mut plan).await?;
                } else {
                    self.state()?.head_error =
                        Some("HEAD lifecycle is waiting for verified exit; no shutdown was repeated");
                }
            }
            return Ok(());
        }
        let (head, rotation_due, hibernation_due) = {
            let mut state = self.state()?;
            if state.phase != Phase::Running || !controller_ready || *self.0.closing.borrow() {
                return Ok(());
            }
            let now = Instant::now();
            let rotation_due = state.next_rotation_probe.is_none_or(|next| next <= now);
            let sleep_period = Duration::from_millis(self.0.config.head_idle_ms);
            let hibernation_due = !sleep_period.is_zero()
                && if let Some(next) = state.next_hibernation_probe {
                    next <= now
                } else {
                    // Give a newly ready controller a full idle interval
                    // before asking for an additional native idle snapshot.
                    state.next_hibernation_probe = now.checked_add(sleep_period);
                    false
                };
            if !rotation_due && !hibernation_due {
                return Ok(());
            }
            if rotation_due {
                state.next_rotation_probe = Some(now + PROBE_INTERVAL);
            }
            if hibernation_due {
                state.next_hibernation_probe = Some(now + sleep_period.clamp(
                    MIN_HIBERNATION_PROBE_INTERVAL, PROBE_INTERVAL,
                ));
            }
            (state.head.clone(), rotation_due, hibernation_due)
        };
        let Some(head) = head else { return Ok(()) };
        let mut probe = match self.probe().await {
            Ok(probe) if probe.head.same(&head) => probe,
            _ => return Ok(()), // Ordinary ownership supervision handles outages.
        };
        if !probe.idle_for_restart() {
            return Ok(());
        }
        // Preserve rotation at its existing threshold when both operations
        // are due. Sleep never depends on a context-usage estimate.
        if rotation_due && known_context(&probe.state)
            && let Some(attestation) = probe.rotation_attestation(Mode::Rotate).await?
            && attestation.idle_ms >= MIN_IDLE_MS
            && attestation.context_percent.is_some_and(|percent| percent >= 50.0)
            && attestation.selection.matches(&probe.state)
        {
            return self.begin_head_lifecycle(probe, Mode::Rotate, attestation).await;
        }
        if hibernation_due
            && let Some(attestation) = probe.rotation_attestation(Mode::Hibernate).await?
            && attestation.idle_ms >= self.0.config.head_idle_ms
            && attestation.residents.is_empty()
            && attestation.selection.matches(&probe.state)
        {
            return self.begin_head_lifecycle(probe, Mode::Hibernate, attestation).await;
        }
        Ok(())
    }

    async fn begin_head_lifecycle(&self, mut probe: Probe, mode: Mode, attestation: Attestation) -> Result<()> {
        let store = &self.0.store;
        let id = Uuid::new_v4().to_string();
        let (session_file, resume_profile_hash) = match mode {
            Mode::Rotate => (rotated_file(&self.0.config, &id), None),
            Mode::Hibernate => (
                probe.head.session_file.clone(),
                Some(self.0.config.resume_profile_hash.clone()),
            ),
        };
        let mut plan = Rotation {
            id, mode, stage: Stage::Stopping, session_file, original: probe.head.clone(),
            config_hash: self.0.config.config_hash()?,
            stop_boundary: store.get_meta(STOP)?,
            attestation, replacement_session_id: None, replacement_owner_pid: None,
            resume_profile_hash, wake_stop: None, recorded: String::new(),
        };
        if let Err(error) = super::host_launch::check_head_lifecycle_command(&self.0.config, &plan).await {
            if mode == Mode::Hibernate {
                let idle_period = Duration::from_millis(self.0.config.head_idle_ms);
                self.state()?.next_hibernation_probe = Instant::now().checked_add(idle_period.max(PROBE_INTERVAL));
            }
            eprintln!("HEAD remains resident: {error}");
            return Ok(());
        }
        plan.recorded = serde_json::to_string(&plan)?;
        {
            let mut state = self.state()?;
            let recorded = store.get_meta(HEAD_ROTATION)?;
            let generation = store.get_meta("main:generation")?.as_deref().unwrap_or("0").parse::<u64>()?;
            if state.phase != Phase::Running || *self.0.closing.borrow()
                || generation != plan.attestation.generation
                || self.0.config_hash.get() != Some(&plan.config_hash)
                || !store.begin_rotation(recorded.as_deref(), plan.stop_boundary.as_deref(), &plan.recorded)?
            {
                return Ok(());
            }
            state.phase = if mode == Mode::Hibernate { Phase::Hibernating } else { Phase::Rotating };
        }
        if let Err(error) = probe.shutdown_rotation(&plan.id, mode).await {
            if error.downcast_ref::<ShutdownRefused>().is_some() {
                self.refuse_rotation(&mut plan)?;
                return Ok(());
            }
            // Marker remains stopping: do not reissue shutdown or launch
            // until the exact persistence/exit receipt can be read.
            return Err(error);
        }
        drop(probe);
        self.finish_rotation_exit(&mut plan).await
    }

    async fn finish_rotation_exit(&self, plan: &mut Rotation) -> Result<()> {
        if plan.mode == Mode::Hibernate {
            return self.park_head(plan).await;
        }
        let config = &self.0.config;
        confirmed_exit(&config.head_socket, &plan.original).await?;
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while alive(plan.original.owner_pid)? {
            ensure!(Instant::now() < deadline, "Rotating HEAD pipe owner has not exited");
            sleep(WAIT_SLICE).await;
        }
        ensure!(fs::metadata(&config.head_socket)?.is_none(), "Rotating HEAD socket ownership changed");
        let mut state = self.state()?;
        let store = &self.0.store;
        if state.phase == Phase::OperatorStopping || *self.0.closing.borrow()
            || store.get_meta(STOP)? != plan.stop_boundary
        {
            return Ok(());
        }
        let generation = plan.attestation.generation.checked_add(1).context("HEAD generation exhausted")?;
        ensure!(generation <= 9_007_199_254_740_991, "HEAD generation exhausted");
        ensure!(config.config_hash()? == plan.config_hash, "Gateway configuration changed during HEAD rotation");
        let current: Head = meta(store.get_meta(HEAD)?)?.context("Missing rotating HEAD")?;
        ensure!(plan.original.same(&current), "Rotating HEAD ownership changed");
        plan.stage = Stage::Starting;
        store.advance_rotation(generation, plan.session_file.to_str().context("Non-UTF8 HEAD session path")?,
            &serde_json::to_string(plan)?)?;
        state.head = None;
        state.phase = Phase::Running;
        Ok(())
    }

    pub(super) fn refuse_rotation(&self, plan: &mut Rotation) -> Result<()> {
        let mut state = self.state()?;
        plan.stage = Stage::Refused;
        if plan.mode == Mode::Hibernate {
            self.save_hibernation(plan, HibernationChange::Refused)?;
        } else {
            self.0.store.set_meta(HEAD_ROTATION, &serde_json::to_string(plan)?)?;
        }
        if matches!(state.phase, Phase::Rotating | Phase::Hibernating) {
            state.phase = Phase::Running;
        }
        state.head_error = None;
        if let Some(changed) = self.0.notify.get() {
            changed.notify_one();
        }
        Ok(())
    }

    pub(super) fn verify_replacement(&self, plan: &Rotation, head: &Head, snapshot: &Value) -> Result<()> {
        ensure!(plan.stage == Stage::Launching
            && plan.matches_replacement_pids(head)
            && alive(head.pid)? && alive(head.owner_pid)?
            && plan.matches_replacement_session(&head.session_id) && head.session_file == plan.session_file
            && plan.replacement_session_id.as_deref() == Some(head.session_id.as_str())
            && plan.attestation.selection.matches(snapshot),
            "Replacement HEAD identity or exact stock selection is not confirmed");
        ensure!(plan.mode != Mode::Hibernate || plan.attestation.matches_hibernation_profile(snapshot),
            "Awakened HEAD did not verify the original native OMP profile");
        ensure!(plan.mode != Mode::Hibernate || plan.attestation.selection.has_exact_stock_resume(),
            "Awakened HEAD lacks an exact stock resume attestation");
        ensure!(plan.mode != Mode::Hibernate || head.loaded_superkit_path.is_some(),
            "Awakened HEAD did not verify its managed integration");
        Ok(())
    }

    pub(super) fn publish_rotation(&self, plan: &mut Rotation, head: &Head) -> Result<()> {
        plan.stage = Stage::Complete;
        if plan.mode == Mode::Hibernate {
            self.save_hibernation(plan, HibernationChange::Publish(&json!(head)))?;
        } else {
            self.0.store.finish_rotation(&json!(head), &serde_json::to_string(plan)?)?;
        }
        if let Some(changed) = self.0.notify.get() {
            changed.notify_one();
        }
        Ok(())
    }
}

fn known_context(state: &Value) -> bool {
    let usage = &state["contextUsage"];
    usage["tokens"].as_u64().is_some()
        && usage["contextWindow"].as_u64().is_some_and(|size| size > 0)
        && usage["percent"].as_f64().is_some_and(|percent| percent >= 50.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_requires_known_stock_context_at_or_above_half() {
        for (context, qualifies) in [
            (json!(null), false),
            (json!({"tokens":null,"contextWindow":100,"percent":50}), false),
            (json!({"tokens":50,"contextWindow":0,"percent":50}), false),
            (json!({"tokens":49,"contextWindow":100,"percent":49.99}), false),
            (json!({"tokens":50,"contextWindow":100,"percent":50}), true),
        ] {
            assert_eq!(known_context(&json!({"contextUsage": context})), qualifies);
        }
    }
}
