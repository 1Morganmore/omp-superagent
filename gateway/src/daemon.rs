use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context as _, Result};
use serde_json::Value;
use tokio::{
    signal::unix::{SignalKind, signal},
    time,
};

use crate::{
    adapter,
    lifecycle::{Lifecycle, LifecycleConfig},
    server::{self, Server},
    store::Store,
};

pub async fn serve(
    config: &Value,
    lifecycle: LifecycleConfig,
    request: Option<&str>,
    adapters: impl FnOnce(&Value, Arc<Store>) -> Result<Arc<adapter::Hub>>,
) -> Result<()> {
    let state_dir = Path::new(
        config["stateDir"]
            .as_str()
            .context("Missing state directory")?,
    );
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let service = Arc::new(Lifecycle::open(lifecycle, request).await?);
    service.prepare(request).await?;
    let store = service.store();
    let adapters = adapters(config, store.clone())?;
    service.set_event_notifier(adapters.changed.clone());
    let hub = Arc::new(server::Hub::new(
        store.clone(),
        service.clone(),
        adapters.clone(),
    ));
    service.set_controller(Arc::downgrade(&hub));
    // An existing HEAD reconnects as soon as this endpoint appears, before
    // activate() runs. It must never restore cards or read history through a
    // partially authenticated adapter set. Ingress still waits for /ready.
    adapters.start().await?;
    let server = match Server::listen(&state_dir.join("run/gateway.sock"), hub.clone()).await {
        Ok(server) => server,
        Err(error) => {
            adapters.stop().await.context("Stopping adapters after Gateway socket startup failed")?;
            return Err(error);
        }
    };
    service.set_transports_ready(true);
    // Keep stop admission independent from slow startup/monitor probes, but
    // never cancel a lifecycle future halfway through an owned process spawn.
    let on_signal = async {
        loop {
            tokio::select! {
                _ = service.shutdown_requested() => return,
                _ = term.recv() => (),
                _ = interrupt.recv() => (),
            }
            if service.stop_head().await.is_ok() {
                service.request_shutdown();
                return;
            }
            eprintln!("Gateway refused shutdown of a busy or unverified HEAD");
        }
    };
    let monitor = async {
        service.activate(request).await?;
        let period = Duration::from_secs(1);
        let mut tick = time::interval_at(time::Instant::now() + period, period);
        tick.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = service.shutdown_requested() => break,
                _ = tick.tick() => {
                    if service.monitor(hub.head_ready(), hub.admission_ready()).await.is_err() { eprintln!("Gateway HEAD ownership requires reconciliation"); }
                }
                _ = store.ingress_changed() => {
                    if service.wake_on_ingress().await.is_err() {
                        eprintln!("Gateway HEAD wake requires reconciliation");
                    }
                }
            }
        }
        Ok(())
    };
    let (active, ()) = tokio::join!(
        async {
            let result = monitor.await;
            service.request_shutdown();
            result
        },
        on_signal
    );
    service.set_transports_ready(false);
    service.wait_maintenance().await;
    let closed = server.close().await;
    let stopped = adapters.stop().await;
    active.and(closed).and(stopped)
}
