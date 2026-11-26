//! Native Gateway lifecycle and exact-identity ownership of the main Host.
mod config;
mod fs;
mod handoff;
mod hibernation;
mod host_launch;
mod host_rpc;
mod launch_files;
mod maintenance;
mod managed_super;
mod process;
mod restart_record;
mod restart_service;
mod rotation;
mod rotation_plan;
mod rpc_wire;
mod stock_ops;
mod supervision;
mod wake_retry;

pub use config::LifecycleConfig;
pub use handoff::{launch, record_runner_failure, restart_runner};
pub use process::exec_detached;

use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    process as os_process,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify, watch};
use tokio::time::Instant;

use crate::{adapter::EffectError, server::{Hub, Service}, store::{LAST_HEAD_ROTATION, Store}};

use self::{
    fs::{Endpoint, alive, remove_dead_socket},
    host_rpc::Head,
    launch_files::LaunchFiles,
    maintenance::Maintenance,
    managed_super::Ulw,
    restart_record::{ACTIVE, HEAD, SOCKET, Stage},
    wake_retry::{WakeRefusal, WakeRetry},
};

#[derive(Clone)]
pub struct Lifecycle(Arc<Owner>);

struct Owner {
    config: LifecycleConfig,
    store: Arc<Store>,
    state: Mutex<State>,
    /// Serializes native reconciliation/launch against stop and replacement.
    supervision: AsyncMutex<()>,
    /// A distinct stop operation must wait for the preceding shutdown outcome.
    shutdown_head: AsyncMutex<()>,
    config_hash: OnceLock<String>,
    ulw: OnceLock<Ulw>,
    maintenance: Mutex<Maintenance>,
    closing: watch::Sender<bool>,
    notify: OnceLock<Arc<Notify>>,
    controller: OnceLock<Weak<Hub>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Running,
    Accepting,
    Accepted,
    Rotating,
    Hibernating,
    OperatorStopping,
    Held,
}

struct State {
    head: Option<Head>,
    launching_owner: Option<u32>,
    transport_ready: bool,
    phase: Phase,
    stop_generation: u64,
    shutdown_attempt: u64,
    shutdown_result: Option<supervision::ShutdownOutcome>,
    restarting: bool,
    head_error: Option<&'static str>,
    next_rotation_probe: Option<Instant>,
    next_hibernation_probe: Option<Instant>,
    wake_retry: Option<WakeRetry>,
}

impl Lifecycle {
    pub async fn open(config: LifecycleConfig, request: Option<&str>) -> Result<Self> {
        config.validate_spawned_config()?;
        config.preflight_memory().await?;
        config.require_credentials()?;
        let store = if let Some(id) = request {
            handoff::wait_launch_receipt(&config, id).await?
        } else {
            config.prepare_directories()?;
            Store::open(&config.state_dir)?
        };
        let head: Option<Head> = restart_record::meta(store.get_meta(HEAD)?)?;
        LaunchFiles::recover_preparation(&store)?;
        let state = State {
            head,
            launching_owner: None,
            transport_ready: false,
            phase: Phase::Running,
            stop_generation: 0,
            shutdown_attempt: 0,
            shutdown_result: None,
            restarting: false,
            head_error: None,
            next_rotation_probe: None,
            next_hibernation_probe: None,
            wake_retry: None,
        };
        Ok(Self(Arc::new(Owner {
            config,
            store: Arc::new(store),
            state: Mutex::new(state),
            supervision: AsyncMutex::new(()),
            shutdown_head: AsyncMutex::new(()),
            config_hash: OnceLock::new(),
            ulw: OnceLock::new(),
            maintenance: Mutex::default(),
            closing: watch::channel(false).0,
            notify: OnceLock::new(),
            controller: OnceLock::new(),
        })))
    }

    pub fn store(&self) -> Arc<Store> {
        Arc::clone(&self.0.store)
    }

    pub fn set_event_notifier(&self, notifier: Arc<Notify>) {
        self.0.notify.get_or_init(|| notifier);
    }

    pub(crate) fn set_controller(&self, controller: Weak<Hub>) {
        self.0.controller.get_or_init(|| controller);
    }

    fn state(&self) -> Result<MutexGuard<'_, State>> {
        self.0
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Gateway lifecycle state is unavailable"))
    }

    pub fn set_transports_ready(&self, ready: bool) {
        match self.state() {
            Ok(mut state) => state.transport_ready = ready,
            Err(error) => eprintln!("{error}"),
        }
    }

    pub fn request_shutdown(&self) {
        self.0.closing.send_replace(true);
    }

    pub async fn shutdown_requested(&self) {
        let mut closing = self.0.closing.subscribe();
        let _received = closing.wait_for(|closing| *closing).await;
    }

    pub async fn prepare(&self, request: Option<&str>) -> Result<()> {
        let store = &self.0.store;
        let config = &self.0.config;
        ensure!(
            config.matches_config_hash(&config.source_hash),
            "Gateway configuration changed during startup"
        );
        if let Some(id) = request {
            self.validate_replacement(id).await?;
        } else {
            ensure!(
                !restart_record::active_record(store)?
                    .is_some_and(|record| record.state.blocks_start()),
                "An owned restart handoff is pending; ordinary startup cannot adopt it"
            );
        }
        let ulw = Ulw::load(config)?;
        ulw.package()?;
        let status = ulw.status()?;
        stock_ops::inspect_omp(config, &config.head_environment()).await?;
        ensure!(
            config.matches_config_hash(&config.source_hash),
            "Gateway configuration changed during startup"
        );
        ensure!(
            self.0.ulw.set(ulw).is_ok()
                && self.0.config_hash.set(config.source_hash.clone()).is_ok(),
            "Gateway lifecycle was already prepared"
        );
        self.0
            .maintenance
            .lock()
            .map_err(|_| anyhow::anyhow!("ULW status is unavailable"))?
            .status = Some(status);
        let old: Option<Endpoint> = restart_record::meta(store.get_meta(SOCKET)?)?;
        remove_dead_socket(&config.gateway_socket, old, None).await?;
        if request.is_some() {
            // The runner prepared this profile after the predecessor's confirmed exit.
            ensure!(config.memory_enabled().await?, "Prepared restart memory is no longer enabled");
        } else {
            host_launch::ensure_launchable_memory(config, self.0.ulw.get().context("Missing managed integration")?).await?;
        }
        self.schedule_maintenance()?;
        Ok(())
    }

    pub async fn activate(&self, request: Option<&str>) -> Result<()> {
        if request.is_none() && self.rotation()?.is_some_and(|plan| plan.stage.active() || plan.stopped_hibernation())
        {
            // An interrupted HEAD lifecycle must not stop the independent
            // Gateway while exact native recovery is still being proved.
            if self.reconcile_head(false, true).await.is_err() {
                eprintln!("Gateway HEAD lifecycle requires reconciliation");
            }
            return Ok(());
        }
        self.ensure_head(request, true).await?;
        if let Some(id) = request {
            let store = &self.0.store;
            let state = self.state()?;
            let head = state
                .head
                .as_ref()
                .context("Replacement native HEAD is unavailable")?;
            let mut record =
                restart_record::record(store, Some(id))?.context("Missing replacement receipt")?;
            let plan = restart_record::plan(store, id)?.context("Missing replacement plan")?;
            restart_record::validate_config(&self.0.config, &plan)?;
            ensure!(
                record.state == Stage::HeadStopped
                    && record.successor_pid == Some(os_process::id())
                    && state.phase == Phase::Running
                    && head.pid != record.head_pid
                    && head.session_id == record.session_id
                    && config::same_path(&head.session_file, &record.session_file)
                    && store.get_meta(ACTIVE)?.as_deref() == Some(id),
                "Replacement native head identity did not match the restart request"
            );
            record.state = Stage::Started;
            record.replacement_pid = Some(head.pid);
            restart_record::save(store, &record)?;
            store.set_meta(ACTIVE, "")?;
        }
        Ok(())
    }

    pub(crate) async fn monitor(&self, controller_ready: bool, admission_ready: bool) -> Result<()> {
        self.schedule_maintenance()?;
        self.reconcile_head(controller_ready, !admission_ready).await
    }

    pub(crate) async fn wake_on_ingress(&self) -> Result<()> {
        let absent = self.state()?.head.is_none();
        if absent && self.rotation()?.is_some_and(|plan| plan.stage == rotation::Stage::Sleeping) {
            return self.record_reconciliation(self.attempt_head(false).await);
        }
        Ok(())
    }

    async fn reconcile_head(&self, controller_ready: bool, startup: bool) -> Result<()> {
        let result = async {
            self.monitor_rotation(controller_ready).await?;
            self.attempt_head(startup).await
        }.await;
        self.record_reconciliation(result)
    }

    fn record_reconciliation(&self, result: Result<()>) -> Result<()> {
        if let Err(error) = result {
            self.state()?.head_error = Some(
                error.downcast_ref::<WakeRefusal>()
                    .map_or("Head ownership/startup requires reconciliation", WakeRefusal::status),
            );
            return Err(error);
        }
        Ok(())
    }

    fn status_value(
        &self,
        connected: bool,
        head_ready: bool,
        admission_ready: bool,
    ) -> Result<Value> {
        let state = self.state()?;
        let rotation = self.rotation()?;
        let closed = *self.0.closing.borrow();
        let live = match &state.head {
            Some(head) => alive(head.pid)?,
            None => false,
        };
        let mut native = json!({"pid": state.head.as_ref().map(|head| head.pid),
            "ready": false, "connected": live && connected, "socketPath": self.0.config.head_socket,
            "error": state.head_error});
        if let Some(head) = &state.head {
            let saved: Option<Value> =
                restart_record::meta(self.0.store.get_meta("head:preset-bootstrap")?)?;
            let initialization = saved.filter(|saved| saved["sessionId"].as_str() == Some(head.session_id.as_str()))
                .unwrap_or_else(|| json!({"sessionId": head.session_id, "state": "checking",
                    "detail": "Waiting for authoritative native HEAD attachment, approval reconciliation and preset inspection."}));
            native["loadedSuperkitPath"] = json!(head.loaded_superkit_path.as_ref().filter(|_| live && connected));
            native["ready"] = json!(live && head_ready && head.loaded_superkit_path.is_some() && initialization["state"] == "complete"
                && !rotation.as_ref().is_some_and(|plan| plan.stage.active()));
            native["initialization"] = initialization;
        }
        if let Some(rotation) = rotation {
            if rotation.mode == rotation::Mode::Hibernate {
                native["hibernation"] = json!({
                    "id": rotation.id, "stage": rotation.stage, "sessionId": rotation.original.session_id,
                });
                if let Some(previous) = restart_record::meta::<rotation::Rotation>(self.0.store.get_meta(LAST_HEAD_ROTATION)?)? {
                    native["rotation"] = rotation_status(&previous);
                }
            } else {
                native["rotation"] = rotation_status(&rotation);
            }
        }
        let mut status = json!({
            "gateway": {"pid": os_process::id(), "ready": state.transport_ready && !closed,
                "admissionReady": admission_ready, "stopping": !matches!(state.phase, Phase::Running | Phase::Hibernating),
                "pendingEvents": if closed { 0 } else { self.0.store.pending()? }},
            "head": native,
        });
        drop(state);
        let maintenance = self
            .0
            .maintenance
            .lock()
            .map_err(|_| anyhow::anyhow!("ULW status is unavailable"))?;
        if let Some(ulw) = &maintenance.status {
            status["ulw"] = ulw.clone();
        }
        Ok(status)
    }
}

fn rotation_status(plan: &rotation::Rotation) -> Value {
    json!({"id": plan.id, "stage": plan.stage, "previousSessionId": plan.original.session_id,
        "replacementSessionId": plan.replacement_session_id})
}

#[async_trait]
impl Service for Lifecycle {
    fn status(&self, connected: bool, head_ready: bool, admission_ready: bool) -> Result<Value> {
        self.status_value(connected, head_ready, admission_ready)
    }
    async fn authorize_head(&self, pid: u32) -> Result<()> {
        self.authorize(pid, None).await
    }
    async fn controller_ready(&self, pid: u32, revision: u64) -> Result<()> {
        if self.rotation()?.is_some_and(|plan| plan.mode == rotation::Mode::Hibernate && plan.stage.active()) {
            self.authorize(pid, Some(revision)).await?;
        }
        Ok(())
    }
    async fn stop(&self) -> Result<()> {
        self.stop_head().await
    }
    fn finish_stop(&self) {
        // The operator client rechecks endpoint identity after reading the
        // receipt headers. Keep the committed, flushed socket briefly present.
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            service.request_shutdown();
        });
    }
    async fn restart(&self, request: Value) -> std::result::Result<Value, EffectError> {
        self.accept_restart(request).await
    }
    fn run_restart(&self, request: &str) -> Result<()> {
        self.schedule_restart(request)
    }
}
