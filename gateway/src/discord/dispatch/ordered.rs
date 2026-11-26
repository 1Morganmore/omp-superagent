use anyhow::Result;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::{Dispatcher, LiveWire, Pending, State};

const CAPACITY: usize = 1024;

pub(super) enum Intake {
    Owner {
        through: i64,
        wire: Option<LiveWire>,
    },
    Group(Value),
    Voice {
        data: Value,
        text: String,
        connection: mpsc::Sender<Value>,
    },
    Authenticated,
    Reconnect,
}

struct Queued {
    event: Intake,
    after_gap: Option<i64>,
}

pub(in crate::discord) struct IntakeQueue {
    incoming: mpsc::Sender<Queued>,
    gap: watch::Sender<Option<i64>>,
}

pub(in crate::discord) struct Ordered {
    incoming: mpsc::Receiver<Queued>,
    gap: watch::Receiver<Option<i64>>,
}

pub(in crate::discord) fn intake_queue() -> (IntakeQueue, Ordered) {
    let (incoming, receiver) = mpsc::channel(CAPACITY);
    let (gap, watermark) = watch::channel(None);
    (IntakeQueue { incoming, gap }, Ordered { incoming: receiver, gap: watermark })
}

impl Dispatcher {
    pub(in crate::discord) fn initial_login(&self) -> Result<()> {
        self.intake.enqueue(Intake::Authenticated)
    }

    pub(in crate::discord) async fn prepare_ready(&self, reconnect: bool) -> Result<()> {
        // A new READY after the initial login is the gap. Record it before
        // yielding or replacing the websocket session that just went away.
        let gap = if reconnect {
            Some(self.state.ctx.discord_intake().stage_history_gap()
                .map_err(|_| anyhow::anyhow!("Discord history gap could not be recorded"))?)
        } else {
            None
        };
        self.state.channels.write().await.clear();
        if let Some(through) = gap {
            // Only a watermark: each gap and its place in the stream lives
            // in SQLite, even on a full queue or interrupted supervisor.
            self.intake.gap.send_replace(Some(through));
        }
        Ok(())
    }

    pub(in crate::discord) fn reconnect(&self) -> Result<()> {
        self.intake.enqueue(Intake::Reconnect)
    }
}

impl IntakeQueue {
    pub(super) fn enqueue(&self, event: Intake) -> Result<()> {
        self.incoming.try_send(self.queued(event)).map_err(|_| intake_full())
    }

    pub(super) fn owner(&self, state: &State, pending: Pending, wire: Option<LiveWire>) -> Result<()> {
        // Neither a full volatile queue nor a failed durable write may
        // advance this event's resumable websocket sequence.
        let permit = self.incoming.try_reserve().map_err(|_| intake_full())?;
        let through = pending.record(state)
            .map_err(|_| anyhow::anyhow!("Discord candidate could not be recorded; resuming before this event"))?;
        permit.send(self.queued(Intake::Owner { through, wire }));
        Ok(())
    }

    fn queued(&self, event: Intake) -> Queued {
        Queued { event, after_gap: *self.gap.borrow() }
    }
}

fn intake_full() -> anyhow::Error {
    anyhow::anyhow!("Discord candidate intake is full or unavailable; resuming before this event")
}

impl Ordered {
    pub(in crate::discord) async fn run(
        mut self,
        state: &State,
        ready: oneshot::Sender<()>,
        mut backlog: Option<i64>,
    ) {
        if state.ctx.ready().await.is_err() {
            eprintln!("Discord startup readiness failed; intake remains closed");
            return;
        }
        if ready.send(()).is_err() {
            return;
        }
        let mut drained_gap = None;
        loop {
            // Take the watermark before looking for queued events. The
            // socket queued every older live event before publishing it.
            let through = *self.gap.borrow_and_update();
            let queued = match self.incoming.try_recv() {
                Ok(queued) => queued,
                Err(mpsc::error::TryRecvError::Disconnected) => return,
                Err(mpsc::error::TryRecvError::Empty) => {
                    if let Some(through) = through.filter(|&sequence| Some(sequence) > drained_gap) {
                        state.drain_owner_intake(through, None).await;
                        drained_gap = Some(through);
                        continue;
                    }
                    tokio::select! {
                        item = self.incoming.recv() => match item {
                            Some(item) => item,
                            None => return,
                        },
                        update = self.gap.changed() => {
                            if update.is_err() { return; }
                            continue;
                        }
                    }
                }
            };
            if let Some(through) = queued.after_gap.filter(|&sequence| Some(sequence) > drained_gap) {
                state.drain_owner_intake(through, None).await;
                drained_gap = Some(through);
            }
            let result = match queued.event {
                Intake::Owner { through, wire } => {
                    state.drain_owner_intake(through, wire.as_ref()).await;
                    Ok(())
                }
                Intake::Group(data) => state.group_dispatch(&data).await,
                Intake::Voice { data, text, connection } => {
                    state.voice_message(&data, &text, &connection).await
                }
                Intake::Authenticated => {
                    if let Some(through) = backlog.take() {
                        state.drain_owner_intake(through, None).await;
                    }
                    Ok(())
                }
                Intake::Reconnect => state.admit(json!({ "kind": "reconnect" })),
            };
            if result.is_err() {
                eprintln!("Discord owner intake could not be confirmed");
            }
        }
    }
}
