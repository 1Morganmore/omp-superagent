use anyhow::{Context, Result, ensure};

use crate::{adapter::EffectError, store::HibernationChange};

use super::{
    Lifecycle, Phase, State,
    fs::{self, remove_dead_socket},
    host_rpc::{Head, ShutdownRefused, confirmed_exit},
    restart_record::STOP,
    rotation::{self, Mode, Rotation, Stage},
    wake_retry::WakeRefusal,
};

impl Rotation {
    // An operator stop retires automatic wake authority, leaving a one-use
    // checkpoint for an explicit Gateway start to verify and claim.
    pub(super) fn stopped_hibernation(&self) -> bool {
        self.mode == Mode::Hibernate && self.stage == Stage::Complete
            && self.resume_profile_hash.is_none()
            && self.replacement_session_id.is_none() && self.replacement_owner_pid.is_none()
            && self.wake_stop.is_none()
    }

    pub(super) fn matches_replacement_pids(&self, head: &Head) -> bool {
        // Hibernation reserved the replacement only after proving the
        // original exited. Its stale PID numbers cannot disqualify this owner.
        self.replacement_owner_pid == Some(head.owner_pid)
            && (self.mode == Mode::Hibernate
                || (head.pid != self.original.pid && head.owner_pid != self.original.owner_pid))
    }
}

impl Lifecycle {
    pub(super) fn save_hibernation(&self, plan: &mut Rotation, change: HibernationChange<'_>) -> Result<()> {
        let next = serde_json::to_string(plan)?;
        self.0.store.commit_hibernation(&plan.recorded, &next, change)?;
        plan.recorded = next;
        Ok(())
    }

    pub(super) fn validate_hibernation_wake(&self, plan: &Rotation) -> Result<()> {
        let config = &self.0.config;
        ensure!(self.0.store.get_meta(STOP)? == plan.stop_boundary,
            WakeRefusal::Checkpoint("Explicit operator stop superseded HEAD wake"));
        ensure!(plan.resume_profile_hash.as_ref() == Some(&config.resume_profile_hash)
            && config.config_hash()? == config.source_hash
            && (plan.stage != Stage::Launching || plan.config_hash == config.source_hash)
            && rotation::session_file(config, &self.0.store)? == plan.session_file,
            WakeRefusal::Checkpoint("Gateway configuration or session pointer changed before HEAD wake"));
        Ok(())
    }

    pub(super) fn reserve_hibernation_wake(&self, plan: &mut Rotation, explicit_stop: Option<&str>) -> Result<String> {
        let checkpoint = plan.recorded.clone();
        plan.config_hash = self.0.config.source_hash.clone();
        let change = if let Some(stop) = explicit_stop {
            plan.stop_boundary = Some(stop.to_owned());
            plan.resume_profile_hash = Some(self.0.config.resume_profile_hash.clone());
            HibernationChange::ReserveOperatorStart
        } else {
            HibernationChange::ReserveWake
        };
        self.save_hibernation(plan, change)?;
        Ok(checkpoint)
    }

    pub(super) async fn park_head(&self, plan: &mut Rotation) -> Result<()> {
        let identity = plan.wake_stop.as_ref().unwrap_or(&plan.original);
        let socket = &self.0.config.head_socket;
        confirmed_exit(socket, identity).await?;
        remove_dead_socket(socket, Some(identity.endpoint()), Some(identity.owner_pid)).await?;
        if let Some(hub) = self.0.controller.get().and_then(std::sync::Weak::upgrade) {
            hub.retire_head(identity.pid)?;
        }
        let mut state = self.state()?;
        plan.stage = Stage::Sleeping;
        plan.replacement_owner_pid = None;
        plan.replacement_session_id = None;
        plan.wake_stop = None;
        // Parking proves the old process is gone; it does not ratify a
        // newer operator stop fence or make interrupted stop intent wakeable.
        self.save_hibernation(plan, HibernationChange::Park)?;
        state.head = None;
        state.head_error = None;
        if state.phase == Phase::Hibernating {
            state.phase = Phase::Running;
        }
        Ok(())
    }

    pub(super) fn ensure_wake_publishable(&self, state: &State, plan: &Rotation) -> Result<()> {
        if plan.mode == Mode::Hibernate {
            ensure!(state.phase == Phase::Running && !*self.0.closing.borrow()
                && state.head.is_none() && plan.wake_stop.is_none(),
                "Explicit operator stop superseded HEAD wake");
            self.validate_hibernation_wake(plan)?;
        }
        Ok(())
    }

    pub(super) async fn stop_hibernation(&self, plan: &mut Rotation) -> Result<bool> {
        let stop = self.0.store.get_meta(STOP)?.context("Missing operator stop fence")?;
        match plan.stage {
            Stage::Sleeping => {}
            Stage::Stopping => {
                // The guarded sleep request may have executed but lost its
                // response. Only an exact clean exit can release it.
                self.park_head(plan).await?;
            }
            Stage::Launching => {
                if plan.wake_stop.is_none() {
                    self.request_wake_stop(plan).await?;
                }
                self.park_head(plan).await?;
            }
            Stage::Complete | Stage::Refused => return Ok(false),
            Stage::Starting => anyhow::bail!("Invalid durable HEAD hibernation stage"),
        }
        let state = self.state()?;
        let config = &self.0.config;
        ensure!(state.phase == Phase::OperatorStopping
            && state.head.is_none()
            && state.launching_owner.is_none()
            && fs::metadata(&config.head_socket)?.is_none()
            && rotation::session_file(config, &self.0.store)? == plan.session_file,
            "Sleeping HEAD ownership changed during operator stop");
        plan.stage = Stage::Complete;
        plan.stop_boundary = Some(stop);
        plan.resume_profile_hash = None;
        self.save_hibernation(plan, HibernationChange::OperatorStopped)?;
        Ok(true)
    }

    async fn request_wake_stop(&self, plan: &mut Rotation) -> Result<()> {
        ensure!(plan.replacement_owner_pid.is_some(), "HEAD wake owner is unresolved; no stop was sent");
        let mut probe = self.probe().await.context("HEAD wake ownership is unresolved; no stop was sent")?;
        let head: &Head = &probe.head;
        ensure!(plan.matches_replacement_pids(head) && head.session_file == plan.session_file
            && head.session_id == plan.original.session_id
            && plan.replacement_session_id.as_deref() == Some(head.session_id.as_str()),
            "HEAD wake ownership is unresolved; no stop was sent");
        plan.wake_stop = Some(probe.head.clone());
        self.save_hibernation(plan, HibernationChange::StopWake)?;
        if let Err(error) = probe.shutdown_unpublished_wake().await {
            if let Some(refusal) = error.downcast_ref::<ShutdownRefused>() {
                plan.wake_stop = None;
                self.save_hibernation(plan, HibernationChange::StopWake)?;
                return Err(EffectError::rejected(&refusal.0).into());
            }
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn wake_accepts_recycled_pids_only_with_the_current_reserved_owner() -> Result<()> {
        let mut plan: Rotation = serde_json::from_value(json!({
            "id": "wake", "mode": "hibernate", "stage": "launching",
            "sessionFile": "/saved/main.jsonl", "configHash": "config",
            "original": {
                "pid": 101, "ownerPid": 102, "sessionId": "same",
                "sessionFile": "/saved/main.jsonl", "dev": 1, "ino": 1
            },
            "replacementSessionId": "same",
            "attestation": {
                "generation": 1, "idleMs": 1, "nativeRun": 0, "residents": [],
                "selection": {
                    "provider": "test", "modelId": "local", "reasoning": false, "modelSettings": {}
                }
            }
        }))?;
        let mut head = plan.original.clone();
        head.ino = 2;
        for (pid, owner, valid_for_rotation) in [
            (101, 102, false),
            (101, 202, false),
            (201, 102, false),
            (201, 202, true),
        ] {
            head.pid = pid;
            head.owner_pid = owner;
            plan.replacement_owner_pid = Some(owner);
            plan.mode = Mode::Hibernate;
            assert!(plan.matches_replacement_pids(&head));
            plan.replacement_owner_pid = Some(owner + 1);
            assert!(!plan.matches_replacement_pids(&head));
            plan.replacement_owner_pid = Some(owner);
            plan.mode = Mode::Rotate;
            assert_eq!(plan.matches_replacement_pids(&head), valid_for_rotation);
        }
        Ok(())
    }
}
