use std::{
    future::{Future, ready},
    time::Duration,
};

use serde_json::json;

use super::{Effect, Evidence, LiveWire, Pending, Resolution, State, Verified, broken};

impl State {
    pub(in crate::discord) async fn drain_owner_intake(&self, through: i64, live: Option<&LiveWire>) {
        let journal = self.ctx.discord_intake();
        while let Some((sequence, pending)) = retry(|| ready(
            journal.next(through)
                .and_then(|row| row.map(|(id, data)| {
                    let pending = data.as_deref().map(serde_json::from_str::<Pending>).transpose()?;
                    Ok((id, pending))
                }).transpose())
                .map_err(|_| broken("Discord pending intake could not be read")),
        )).await {
            let Some(mut pending) = pending else {
                retry(|| ready(self.ctx.promote_discord_history_gap(sequence)
                    .map_err(|_| broken("Discord history gap could not be admitted")))).await;
                continue;
            };
            let wire = live.filter(|_| sequence == through);
            let group = match retry(|| pending.resolve(self, wire)).await {
                Resolution::Refused => None,
                Resolution::LiveGroup(route) => Some(route),
                Resolution::Owner(owner) => {
                    let Verified { route, channel, message, needs_pin } = *owner;
                    // Pin immediately after source/authority verification.
                    // A second, independent reply read may fail and must never
                    // cause us to hydrate a now-superseded message revision.
                    if needs_pin {
                        pending.evidence = Evidence::Verified { route: route.clone(), message: message.clone() };
                        pending.coordinate_authority = None;
                        retry(|| ready(
                            serde_json::to_string(&pending)
                                .map_err(Into::into)
                                .and_then(|data| journal.pin(sequence, &data))
                                .map_err(|_| broken("Discord verified source could not be recorded")),
                        )).await;
                    }
                    let addressing = pending.addressing(self, &route);
                    if let Some(input) = retry(|| self.with_context(&message, &route, &channel, addressing)).await {
                        let event = json!({"kind":"message","input":input});
                        // Local admission is idempotent. If its receipt was
                        // committed before interruption, no reaction re-runs.
                        retry(|| ready(self.admit(event.clone()))).await;
                    }
                    None
                }
            };
            retry(|| ready(journal.retire(sequence)
                .map_err(|_| broken("Discord pending intake could not be retired")))).await;
            if let (Some(route), Some(wire)) = (group, wire)
                && self.group_message(&route, &wire.data).is_err()
            {
                eprintln!("Discord live group intake was not confirmed; not retrying");
            }
        }
    }
}

async fn retry<T, F: Future<Output = Effect<T>>>(mut read: impl FnMut() -> F) -> T {
    let mut delay = Duration::from_millis(250);
    loop {
        match read().await {
            Ok(value) => return value,
            Err(error) => {
                if delay == Duration::from_millis(250) {
                    eprintln!("Discord owner intake held pending verification: {error}");
                }
                let wait = error.retry_after_ms.map(Duration::from_millis)
                    .map_or(delay, |advised| delay.max(advised));
                // The supervisor cancels the worker, including a read or wait.
                // Its journal row survives cancellation.
                tokio::time::sleep(wait).await;
                delay = delay.saturating_mul(2).min(Duration::from_secs(30));
            }
        }
    }
}
