use anyhow::{Context, Result, ensure};
use std::process;
use uuid::Uuid;

use crate::{adapter::EffectError, store::{HEAD_ROTATION, HibernationChange}};

use super::{
    Lifecycle, Phase, State,
    fs::{alive, remove_dead_socket},
    host_launch::PreparedHost,
    host_rpc::{Head, PROBE_TIMEOUT, Probe, ShutdownRefused, confirmed_exit},
    restart_record::{self, ACTIVE, FENCE, Fence, HEAD, Plan, Record, STOP, Stage},
    rotation::{self, Mode, Rotation, Stage as RotationStage},
};

impl Lifecycle {
    pub(super) async fn probe(&self) -> Result<Probe> {
        let config = &self.0.config;
        let session_file = rotation::session_file(config, &self.0.store)?;
        Probe::open(&config.head_socket, &session_file, PROBE_TIMEOUT).await
    }

    pub(super) async fn authorize(&self, pid: u32, ready_stream: Option<u64>) -> Result<()> {
        let supervision = if self.rotation()?.is_some_and(|plan|
            plan.stage == RotationStage::Launching || plan.stopped_hibernation())
        {
            Some(self.0.supervision.lock().await)
        } else {
            None
        };
        let probe = self.probe().await?;
        let actual = &probe.head;
        ensure!(actual.pid == pid, EffectError::rejected("Gateway client is not the supervised native head"));
        ensure!(actual.loaded_superkit_path.is_some(),
            EffectError::rejected("Native head has not verified its omp-superkit extension; restart the Host"));
        let mut state = self.state()?;
        let mut rotation = self.rotation()?;
        // Only the reserved native process can open a controller stream. That
        // stream must reach /ready before the durable inbox is released.
        if supervision.is_some() && let Some(plan) = rotation.as_mut().filter(|plan|
            plan.mode == Mode::Hibernate && plan.stage == RotationStage::Launching)
        {
            self.verify_replacement(plan, actual, &probe.state)?;
            ensure!(state.phase == Phase::Running && !*self.0.closing.borrow()
                && state.head.is_none() && plan.wake_stop.is_none()
                && plan.config_hash == self.0.config.source_hash
                && self.0.store.get_meta(STOP)? == plan.stop_boundary,
                EffectError::rejected("HEAD wake is not owned by this Gateway"));
            if let Some(revision) = ready_stream {
                self.ensure_wake_publishable(&state, plan)?;
                let hub = self.0.controller.get().and_then(std::sync::Weak::upgrade)
                    .context("Wake controller is unavailable")?;
                hub.with_ready_stream(revision, pid, || self.publish_launch(&mut state, plan, actual))?;
            }
            return Ok(());
        }
        let rotating = rotation.as_ref().is_some_and(|plan| plan.stage == RotationStage::Launching);
        ensure!(!rotation.as_ref().is_some_and(|plan| plan.mode == Mode::Hibernate
            && (plan.stage.active() || plan.stopped_hibernation() || state.phase == Phase::OperatorStopping)),
            EffectError::rejected("HEAD hibernation or stop is in progress"));
        let owns = match &state.head {
            Some(known) => actual.same(known),
            None => !rotating && state.launching_owner == Some(actual.owner_pid),
        };
        ensure!(
            owns && !rotation.as_ref().is_some_and(|plan|
                state.phase == Phase::OperatorStopping
                    && plan.replacement_session_id.as_deref() == Some(actual.session_id.as_str())
                    && plan.replacement_owner_pid == Some(actual.owner_pid)),
            EffectError::rejected("Gateway client is not the supervised native head")
        );
        Ok(())
    }

    fn publish_launch(&self, state: &mut State, plan: &mut Rotation, head: &Head) -> Result<()> {
        self.publish_rotation(plan, head)?;
        state.head = Some(head.clone());
        state.head_error = None;
        if plan.mode == Mode::Hibernate {
            state.next_hibernation_probe = None;
        }
        Ok(())
    }

    fn identify_launch(&self, state: &mut State, plan: &mut Rotation, probe: &Probe) -> Result<()> {
        self.ensure_wake_publishable(state, plan)?;
        self.verify_replacement(plan, &probe.head, &probe.state)?;
        if plan.mode == Mode::Hibernate {
            state.head_error = Some("Waiting for the verified HEAD controller to connect and become ready");
            return Ok(());
        }
        self.publish_launch(state, plan, &probe.head)
    }

    pub(super) async fn ensure_head(&self, restart_request: Option<&str>, startup: bool) -> Result<()> {
        let _supervising = self.0.supervision.lock().await;
        let mut rotation = self.rotation()?;
        if rotation.as_ref().is_some_and(|plan| plan.stage == RotationStage::Stopping) {
            return Ok(());
        }
        if let Some(plan) = rotation.as_ref() {
            match (plan.mode, plan.stage) {
                (Mode::Hibernate, RotationStage::Sleeping) => {
                    if !startup && !self.0.store.has_wake_input()? {
                        return Ok(());
                    }
                    self.validate_hibernation_wake(plan)?;
                }
                (Mode::Hibernate, RotationStage::Launching) => {
                    ensure!(plan.replacement_owner_pid.is_some() && plan.wake_stop.is_none(),
                        "HEAD wake launch ownership remains held");
                }
                (Mode::Rotate, RotationStage::Starting | RotationStage::Launching) => {
                    ensure!(self.0.config.config_hash()? == plan.config_hash,
                        "Gateway configuration changed before replacement HEAD startup");
                }
                (Mode::Hibernate, RotationStage::Starting | RotationStage::Stopping
                    | RotationStage::Complete | RotationStage::Refused)
                | (Mode::Rotate, RotationStage::Sleeping | RotationStage::Stopping
                    | RotationStage::Complete | RotationStage::Refused) => {}
            }
        }
        let head = {
            let state = self.state()?;
            if state.phase != Phase::Running || *self.0.closing.borrow() {
                return Ok(());
            }
            state.head.clone()
        };
        if let Some(plan) = rotation.as_mut().filter(|plan| plan.stage == RotationStage::Launching) {
            if plan.mode == Mode::Hibernate {
                // The reserved controller initiates /attach and /ready itself.
                // A supervisor tick can neither complete it nor justify a
                // second launch. Stop still probes the exact recorded owner.
                self.state()?.head_error = Some("Waiting for the reserved HEAD controller to become ready");
                return Ok(());
            }
            let probe = self.probe().await.context("Replacement HEAD launch ownership remains held")?;
            let mut state = self.state()?;
            return self.identify_launch(&mut state, plan, &probe);
        }
        let waking = rotation.as_ref().is_some_and(|plan| plan.stage == RotationStage::Sleeping);
        let stopped_hibernation = rotation.as_ref().is_some_and(Rotation::stopped_hibernation);
        let start_fence = if stopped_hibernation {
            ensure!(restart_request.is_none(), "A restart successor cannot adopt an operator-stopped HEAD");
            if !startup {
                return Ok(());
            }
            Some(self.0.store.get_meta(STOP)?.context("Missing operator stop fence")?)
        } else {
            None
        };
        if waking || stopped_hibernation {
            ensure!(head.is_none() && self.0.store.get_meta(HEAD)?.as_deref() == Some("null"),
                "Parked HEAD ownership changed");
        }
        if let Some(known) = &head
            && alive(known.pid)?
        {
            let identified = self.probe().await.and_then(|probe| {
                ensure!(probe.head.same(known), "Known native head identity changed");
                Ok(probe.head)
            });
            // A vanished process is ordinary recovery; a live PID with an
            // unverifiable owner/session/inode cannot authorize a second HEAD.
            match identified {
                Ok(head) => {
                    let mut state = self.state()?;
                    state.head_error = head.loaded_superkit_path.is_none().then_some(
                        "Native head has not verified its omp-superkit extension; stop and start the Host",
                    );
                    state.head = Some(head);
                    return Ok(());
                }
                Err(error) if alive(known.pid)? => return Err(error),
                Err(_) => {}
            }
        }
        let config = &self.0.config;
        let restart_plan = restart_request
            .map(|id| restart_record::plan(&self.0.store, id)?.context("Missing replacement plan"))
            .transpose()?;
        if let Some(plan) = &restart_plan {
            restart_record::validate_config(config, plan)?;
        }
        remove_dead_socket(
            &config.head_socket,
            head.as_ref().map(Head::endpoint),
            head.as_ref().map(|head| head.owner_pid),
        )
        .await?;
        {
            let mut state = self.state()?;
            if !waking && !stopped_hibernation {
                self.0.store.set_meta(HEAD, "null")?;
            }
            state.head = None;
            if state.phase != Phase::Running || *self.0.closing.borrow() {
                return Ok(());
            }
        }
        let ulw = self
            .0
            .ulw
            .get()
            .context("Gateway lifecycle has not been prepared")?;
        let mut launch_plan = rotation.as_mut().filter(|plan|
            matches!(plan.stage, RotationStage::Starting | RotationStage::Sleeping) || plan.stopped_hibernation());
        let (replacement, stopped) = if stopped_hibernation {
            (None, launch_plan.as_deref())
        } else {
            (launch_plan.as_deref(), None)
        };
        let prepared = PreparedHost::prepare(
            config, &self.0.store, ulw, replacement, stopped,
        ).await?;
        let session_file = rotation::session_file(config, &self.0.store)?;
        let mut owner = {
            let mut state = self.state()?;
            if state.phase != Phase::Running || *self.0.closing.borrow() {
                return Ok(());
            }
            if let Some(plan) = &restart_plan {
                restart_record::validate_config(config, plan)?;
            }
            if let Some(fence) = &start_fence {
                // Use the new Gateway's config, never the retired wake
                // profile or a newer on-disk config the daemon did not load.
                ensure!(config.matches_config_hash(&config.source_hash)
                    && self.0.store.get_meta(STOP)?.as_ref() == Some(fence),
                    "Gateway configuration or operator stop fence changed before explicit HEAD startup");
            }
            let checkpoint = if let Some(plan) = launch_plan.as_deref_mut() {
                if plan.mode == Mode::Hibernate && !stopped_hibernation {
                    self.validate_hibernation_wake(plan)?;
                }
                plan.stage = RotationStage::Launching;
                plan.replacement_session_id = Some(prepared.expected_session_id().context("Prepared HEAD session ID missing")?.to_owned());
                if plan.mode == Mode::Hibernate {
                    Some(self.reserve_hibernation_wake(plan, start_fence.as_deref())?)
                } else {
                    self.0.store.set_meta(HEAD_ROTATION, &serde_json::to_string(plan)?)?;
                    None
                }
            } else {
                None
            };
            let config_hash = if waking || stopped_hibernation {
                Some(config.source_hash.as_str())
            } else {
                restart_plan.as_ref().map(|plan| plan.config_hash.as_str())
            };
            let owner = match prepared.spawn(&config.cwd, config_hash) {
                Ok(owner) => owner,
                Err(error) => {
                    if let Some((checkpoint, plan)) = checkpoint.zip(launch_plan.as_deref()) {
                        self.0.store
                            .commit_hibernation(
                                &plan.recorded,
                                &checkpoint,
                                HibernationChange::ReleaseUnspawnedWake,
                            )
                            .with_context(|| {
                                format!("{error:#}; could not restore HEAD hibernation checkpoint")
                            })?;
                    }
                    return Err(error);
                }
            };
            state.launching_owner = Some(owner.pid);
            owner
        };
        if let Some(plan) = &mut launch_plan {
            plan.replacement_owner_pid = Some(owner.pid);
            let saved = if plan.mode == Mode::Hibernate {
                self.save_hibernation(plan, HibernationChange::RecordOwner)
            } else {
                self.0.store.set_meta(HEAD_ROTATION, &serde_json::to_string(plan)?)
            };
            if let Err(error) = saved {
                owner.reap(); // Rotation never signals a process, including a failed launch.
                return Err(error);
            }
        }
        let result = owner.identify(config, &session_file).await;
        match result {
            Ok(probe) => {
                // Start the pipe-owner wait before the store commit so even a
                // failed write retains its manifest until that exact process exits.
                owner.reap();
                let mut state = self.state()?;
                state.launching_owner = None;
                if let Some(plan) = launch_plan {
                    self.identify_launch(&mut state, plan, &probe)?;
                } else {
                    state.head = Some(probe.head);
                    self.0.store.set_meta(HEAD, &serde_json::to_string(&state.head)?)?;
                    state.head_error = None;
                }
                Ok(())
            }
            Err(error) => {
                self.state()?.launching_owner = None;
                if launch_plan.is_some() {
                    owner.reap();
                } else if owner.abandon().await.is_err() {
                    eprintln!("Failed HEAD startup owner could not be disposed");
                }
                Err(error)
            }
        }
    }

    pub async fn stop_head(&self) -> Result<()> {
        if *self.0.closing.borrow() {
            return Ok(());
        }
        let generation = {
            let mut state = self.state()?;
            let store = &self.0.store;
            store.set_meta(STOP, &Uuid::new_v4().to_string())?;
            state.stop_generation = state
                .stop_generation
                .checked_add(1)
                .context("Operator stop generation exhausted")?;
            state.phase = Phase::OperatorStopping;
            if let Some(mut record) = restart_record::active_record(store)?
                && (record.gateway_pid == process::id()
                    || record.successor_pid == Some(process::id()))
                && record.state.pending()
            {
                record.state = Stage::Refused;
                record.reason = Some(
                    "Explicit operator stop superseded the restart; no successor is authorized."
                        .into(),
                );
                restart_record::save(store, &record)?;
                store.set_meta(ACTIVE, "")?;
            }
            state.stop_generation
        };
        let result = self.shutdown_owned_head(None).await;
        if result.as_ref().is_err_and(is_refusal) {
            let mut state = self.state()?;
            if state.stop_generation == generation && state.phase == Phase::OperatorStopping {
                state.phase = if restart_record::active_record(&self.0.store)?
                    .is_some_and(|record| record.state == Stage::Uncertain)
                    || self.rotation()?.is_some_and(|plan|
                        plan.mode == Mode::Hibernate && plan.stage == RotationStage::Launching)
                {
                    Phase::Held
                } else {
                    Phase::Running
                };
            }
        }
        result
    }

    pub(super) async fn shutdown_owned_head(
        &self,
        restart: Option<(&Plan, &Record)>,
    ) -> Result<()> {
        let (attempt, pending) = {
            let state = self.state()?;
            (
                state.shutdown_attempt,
                state.shutdown_attempt > 0 && state.shutdown_result.is_none(),
            )
        };
        let _shutdown = self.0.shutdown_head.lock().await;
        let _supervising = self.0.supervision.lock().await;
        if *self.0.closing.borrow() {
            return Ok(());
        }
        let head = {
            let state = self.state()?;
            // A simultaneous operator-stop shares the exact native shutdown's
            // outcome, including uncertainty. It cannot send the request again.
            if pending || state.shutdown_attempt > attempt {
                return state
                    .shutdown_result
                    .as_ref()
                    .context("Owned shutdown outcome is unresolved")?
                    .result();
            }
            state.head.clone()
        };
        if restart.is_none() && let Some(mut rotation) = self.rotation()? {
            if rotation.mode == Mode::Hibernate && self.stop_hibernation(&mut rotation).await? {
                return Ok(());
            }
            match rotation.stage {
                RotationStage::Stopping => {
                    // Do not send another shutdown after an ambiguous
                    // automatic request, even on an operator stop.
                    confirmed_exit(&self.0.config.head_socket, &rotation.original).await?;
                    remove_dead_socket(
                        &self.0.config.head_socket,
                        Some(rotation.original.endpoint()),
                        Some(rotation.original.owner_pid),
                    ).await?;
                    self.refuse_rotation(&mut rotation)?;
                    return self.clear_head();
                }
                RotationStage::Launching if head.is_none() => {
                    let actual = self.probe().await.context("Replacement HEAD ownership is unresolved; no stop was sent")?;
                    // Authorize stopping the exact launch even if the
                    // selection readback failed. Explicit stop does not
                    // promote the replacement to a ready HEAD.
                    ensure!(rotation.replacement_owner_pid == Some(actual.head.owner_pid)
                        && rotation.replacement_session_id.as_deref() == Some(actual.head.session_id.as_str()),
                        "Replacement HEAD ownership is unresolved; no stop was sent");
                    let mut probe = actual;
                    if let Err(error) = probe.shutdown().await {
                        if let Some(refusal) = error.downcast_ref::<ShutdownRefused>() {
                            return Err(EffectError::rejected(&refusal.0).into());
                        }
                        return Err(error);
                    }
                    let identity = probe.head;
                    confirmed_exit(&self.0.config.head_socket, &identity).await?;
                    remove_dead_socket(&self.0.config.head_socket, Some(identity.endpoint()), Some(identity.owner_pid)).await?;
                    // The unpublished replacement never received ingress.
                    // Only a subsequent explicit start can relaunch it.
                    rotation.stage = RotationStage::Starting;
                    rotation.replacement_owner_pid = None;
                    self.0.store.set_meta(HEAD_ROTATION, &serde_json::to_string(&rotation)?)?;
                    return self.clear_head();
                }
                RotationStage::Starting | RotationStage::Launching | RotationStage::Complete | RotationStage::Refused => {}
                RotationStage::Sleeping => anyhow::bail!("Invalid durable HEAD rotation stage"),
            }
        }
        if let Some((expected, record)) = restart {
            if !self.restart_still_authorized(expected, record)? {
                return Ok(());
            }
            ensure!(
                head.as_ref().is_some_and(|head| head.same(&expected.head)),
                EffectError::rejected(
                    "Native HEAD ownership changed; restart was refused without a shutdown"
                )
            );
        }
        if let Some(head) = head {
            let socket = &self.0.config.head_socket;
            if alive(head.pid)? {
                let mut probe = self.probe().await?;
                ensure!(
                    probe.head.same(&head),
                    EffectError::rejected("Refusing to stop an unowned native host")
                );
                if let Some((expected, record)) = restart
                    && !self.restart_still_authorized(expected, record)?
                {
                    return Ok(());
                }
                {
                    let mut state = self.state()?;
                    state.shutdown_attempt = state
                        .shutdown_attempt
                        .checked_add(1)
                        .context("Shutdown attempt exhausted")?;
                    state.shutdown_result = None;
                }
                let received = async {
                    if let Err(error) = probe.shutdown().await {
                        if let Some(refused) = error.downcast_ref::<ShutdownRefused>() {
                            return Err(EffectError::rejected(&refused.0).into());
                        }
                        // A lost shutdown response is not permission to kill, retry
                        // or resume supervision. The Gateway remains held.
                        return Err(error);
                    }
                    drop(probe);
                    confirmed_exit(socket, &head).await?;
                    self.clear_head()
                }
                .await;
                self.state()?.shutdown_result = Some(ShutdownOutcome::from_result(&received));
                return received;
            } else if restart.is_some() {
                // Restart cannot treat an unrelated crash as a clean shutdown.
                confirmed_exit(socket, &head).await?;
            } else {
                // A normal operator stop may retire a known already-dead HEAD,
                // but must first eliminate its exact socket and wait out the owner.
                remove_dead_socket(socket, Some(head.endpoint()), Some(head.owner_pid)).await?;
            }
        }
        self.clear_head()
    }

    fn clear_head(&self) -> Result<()> {
        let mut state = self.state()?;
        self.0.store.set_meta(HEAD, "null")?;
        state.head = None;
        Ok(())
    }

    fn restart_still_authorized(&self, plan: &Plan, record: &Record) -> Result<bool> {
        let state = self.state()?;
        if state.phase != Phase::Accepted {
            return Ok(false);
        }
        if !self.is_accepted(&record.request.request_id)? {
            self.check_accepted_config(plan)?;
            self.check_runner_rejection(record)?;
            return Ok(false);
        }
        let store = &self.0.store;
        let fence: Option<Fence> = restart_record::meta(store.get_meta(FENCE)?)?;
        let stop = store.get_meta(STOP)?;
        ensure!(
            fence.is_some_and(
                |fence| fence.matches(&record.request, &plan.head) && fence.stop_boundary == stop
            ),
            EffectError::rejected("HEAD restart fence changed before native shutdown")
        );
        let prepared = restart_record::plan(store, &record.request.request_id)?;
        ensure!(
            prepared.is_some_and(|ready| ready.runner_ready == Some(true)
                && plan.matches_preparation(&ready)),
            EffectError::rejected("Successor preparation changed before native shutdown")
        );
        self.check_accepted_config(plan)?;
        Ok(true)
    }
}

pub(super) fn is_refusal(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<EffectError>()
        .is_some_and(|error| error.certainty == "rejected")
}

pub(super) enum ShutdownOutcome {
    Confirmed,
    Refused(String),
    Uncertain,
}

impl ShutdownOutcome {
    fn from_result(result: &Result<()>) -> Self {
        match result {
            Ok(()) => Self::Confirmed,
            Err(error) if is_refusal(error) => Self::Refused(error.to_string()),
            Err(_) => Self::Uncertain,
        }
    }

    fn result(&self) -> Result<()> {
        match self {
            Self::Confirmed => Ok(()),
            Self::Refused(error) => Err(EffectError::rejected(error).into()),
            Self::Uncertain => {
                Err(EffectError::uncertain("Owned shutdown outcome is unresolved").into())
            }
        }
    }
}
