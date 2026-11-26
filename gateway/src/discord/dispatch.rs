use std::sync::Arc;
use std::sync::atomic::Ordering;

use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use super::{
    Identity, State,
    ingress::{CandidateKind, LiveWire},
    model::{Channel, User, snowflake},
    pending::Pending,
};

mod ordered;
use ordered::{Intake, IntakeQueue};
pub(super) use ordered::intake_queue;

#[derive(Deserialize)]
pub(super) struct Ready {
    user: User,
    application: Application,
    pub session_id: String,
    pub resume_gateway_url: String,
}

#[derive(Deserialize)]
struct Application {
    id: String,
}

impl Ready {
    pub fn authenticate(&self, state: &State, expected_account: Option<&str>) -> Result<()> {
        ensure!(
            self.user.bot
                && snowflake(&self.user.id)
                && snowflake(&self.application.id)
                && expected_account.is_none_or(|account| account == self.user.id),
            "Discord Gateway did not identify an authenticated bot and application"
        );
        let identity = Identity {
            account: self.user.id.clone(),
            application: self.application.id.clone(),
        };
        if let Some(prior) = state.identity.get() {
            ensure!(
                prior == &identity,
                "Discord bot or application identity changed during reconnect"
            );
        } else {
            state
                .identity
                .set(identity)
                .map_err(|_| anyhow::anyhow!("Discord identity was already established"))?;
        }
        Ok(())
    }
}

pub(super) struct Dispatcher {
    state: Arc<State>,
    intake: IntakeQueue,
    interactions: TaskTracker,
    cancel: CancellationToken,
}

impl Dispatcher {
    pub fn new(
        state: Arc<State>,
        intake: IntakeQueue,
        interactions: TaskTracker,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            state,
            intake,
            interactions,
            cancel,
        }
    }

    pub fn state(&self) -> &Arc<State> {
        &self.state
    }

    pub async fn event(&self, event: &str, data: Value, connection: &Connection<'_>) -> Result<()> {
        let state = &self.state;
        match event {
            "GUILD_CREATE" => {
                if let Some(guild) = data["id"]
                    .as_str()
                    .filter(|id| snowflake(id) && state.allowed_guild(Some(id)))
                {
                    for channel in ["channels", "threads"]
                        .into_iter()
                        .flat_map(|key| data[key].as_array().into_iter().flatten())
                    {
                        if let Ok(mut channel) = Channel::deserialize(channel) {
                            channel.guild_id = Some(guild.to_owned());
                            state.remember_channel(channel).await;
                        }
                    }
                }
            }
            "GUILD_DELETE" => {
                if let Some(id) = data["id"].as_str() {
                    state
                        .channels
                        .write()
                        .await
                        .retain(|_, channel| channel.guild_id.as_deref() != Some(id));
                }
            }
            "CHANNEL_CREATE" | "CHANNEL_UPDATE" | "THREAD_CREATE" | "THREAD_UPDATE" => {
                if let Ok(channel) = Channel::deserialize(&data) {
                    if state.allowed_guild(channel.guild_id.as_deref()) {
                        state.remember_channel(channel).await;
                    } else {
                        state.channels.write().await.remove(&channel.id);
                    }
                }
            }
            "CHANNEL_DELETE" | "THREAD_DELETE" => {
                if let Some(id) = data["id"].as_str() {
                    state.channels.write().await.retain(|key, channel| {
                        key != id && channel.parent_id.as_deref() != Some(id)
                    });
                }
            }
            "THREAD_LIST_SYNC" => {
                if let Some(guild) = data["guild_id"]
                    .as_str()
                    .filter(|id| state.allowed_guild(Some(id)))
                {
                    if let Some(scope) = data["channel_ids"].as_array() {
                        state.channels.write().await.retain(|_, channel| {
                            channel.guild_id.as_deref() != Some(guild)
                                || !channel.is_thread()
                                || !scope
                                    .iter()
                                    .any(|id| id.as_str() == channel.parent_id.as_deref())
                        });
                    } else {
                        state.channels.write().await.retain(|_, channel| {
                            channel.guild_id.as_deref() != Some(guild) || !channel.is_thread()
                        });
                    }
                    for channel in data["threads"].as_array().into_iter().flatten() {
                        if let Ok(mut channel) = Channel::deserialize(channel) {
                            channel.guild_id = Some(guild.to_owned());
                            state.remember_channel(channel).await;
                        }
                    }
                }
            }
            "MESSAGE_CREATE" | "MESSAGE_UPDATE" => {
                let create = event == "MESSAGE_CREATE";
                let Some(candidate) = state.intake_candidate(&data, create).await else {
                    return Ok(());
                };
                let live = connection.fresh && connection.admission_ready
                    && !state.stopping.load(Ordering::Acquire);
                if let Some(voice) = &state.voice
                    && let Some(command) = state.voice_control(&data, voice)
                {
                    if create && live {
                        if super::voice::Voice::is_priority_control(&command) {
                            if state
                                .voice_message(&data, &command, connection.outbound)
                                .await
                                .is_err()
                            {
                                eprintln!("Discord priority voice command was not completed");
                            }
                        } else {
                            let text = command.into_owned();
                            self.intake.enqueue(Intake::Voice {
                                data,
                                text,
                                connection: connection.outbound.clone(),
                            })?;
                        }
                    }
                    return Ok(());
                }
                match candidate {
                    CandidateKind::Group if create && live => self.intake.enqueue(Intake::Group(data))?,
                    CandidateKind::Group => (),
                    CandidateKind::Owner(route) => {
                        let unresolved = route.is_none();
                        let Some(pending) = Pending::from_dispatch(state, &data, create, route) else {
                            return Ok(());
                        };
                        let wire = (unresolved && data.get("author").is_some()).then_some(LiveWire {
                            group: create && live,
                            data,
                        });
                        self.intake.owner(state, pending, wire)?;
                    }
                }
                return Ok(());
            }
            "INTERACTION_CREATE" => {
                if state.stopping.load(Ordering::Acquire) {
                    return Ok(());
                }
                // Discord callbacks have an independent deadline; never wait for
                // a slow history/reply hydration or an ordinary model turn.
                if self.interactions.len() < 128 {
                    let state = Arc::clone(state);
                    let ready = connection.admission_ready;
                    let cancel = self.cancel.clone();
                    self.interactions.spawn(async move {
                        tokio::select! {
                            biased;
                            () = cancel.cancelled() => (),
                            result = state.interaction(data, ready) => {
                                if result.is_err() {
                                    eprintln!("Discord interaction was not fully processed; no automatic acknowledgement retry");
                                }
                            }
                        }
                    });
                } else {
                    eprintln!("Discord interaction queue is full; interaction was not admitted");
                }
                return Ok(());
            }
            _ => (),
        }
        if let Some(voice) = &state.voice
            && matches!(
                event,
                "READY"
                    | "RESUMED"
                    | "GUILD_CREATE"
                    | "GUILD_DELETE"
                    | "CHANNEL_DELETE"
                    | "VOICE_STATE_UPDATE"
                    | "VOICE_SERVER_UPDATE"
            )
        {
            voice.on_dispatch(event, &data, connection.outbound).await;
        }
        Ok(())
    }
}

pub(super) struct Connection<'a> {
    pub fresh: bool,
    pub admission_ready: bool,
    pub outbound: &'a mpsc::Sender<Value>,
}
