use serde::Deserialize;
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::discord::{
    Effect, EffectError, State,
    model::{Channel, Message, Route, snowflake, snowflake_before},
    rest::broken,
};

const PAGE_SIZE: usize = 100;

impl State {
    pub(in crate::discord) async fn fetch_after(
        &self,
        route: &Route,
        cursor: &str,
        before_us: Option<i64>,
    ) -> Effect<Value> {
        let lower = cursor.parse::<u64>().ok().filter(|_| snowflake(cursor)).ok_or_else(|| {
            EffectError::rejected("Catchup requires a stored Discord message snowflake")
        })?;
        let route = route.physical();
        self.assert_route(&route)?;
        if self.group_route(&route) {
            return Err(EffectError::rejected("Discord group rooms do not allow history recovery"));
        }
        let upper = before_us.map(|time| {
            snowflake_before(time).ok_or_else(|| broken("Discord history gap time is invalid"))
        }).transpose()?;
        if upper.is_some_and(|end| end <= lower) {
            return Ok(Value::Array(Vec::new()));
        }
        self.assert_live_intake_drained(&route)?;
        let cached = self.channels.read().await.get(route.destination()).cloned();
        let channel = match cached {
            Some(channel) => channel,
            None => {
                let Some(channel) = self.rest.history_lookup::<Channel>(
                    &format!("channels/{}", route.destination()),
                ).await? else { return Ok(Value::Null) };
                if channel.id != route.destination() {
                    return Err(broken("Discord history channel did not match its requested destination"));
                }
                self.remember_channel(channel.clone()).await;
                channel
            }
        };
        if self.route_for(&channel)? != route {
            return Err(EffectError::rejected("Discord destination identity changed"));
        }
        let channel = channel.sendable()?;
        // Discord makes `before` and `after` mutually exclusive. A bounded
        // read starts at the gap and walks backwards, then emits oldest first.
        let (parameter, mut position) = match upper {
            Some(upper) => ("before", upper),
            None => ("after", lower),
        };
        let mut inputs = Vec::new();
        loop {
            let page: Option<Vec<Value>> = self.rest.history_lookup(&format!(
                "channels/{}/messages?{parameter}={position}&limit={PAGE_SIZE}", channel.id
            )).await?;
            let Some(page) = page else { return Ok(Value::Null) };
            let mut messages = Vec::with_capacity(page.len());
            for raw in page {
                let message = Message::deserialize(&raw)
                    .map_err(|_| broken("Discord history contained an invalid message"))?;
                let id = message.id.parse::<u64>()
                    .map_err(|_| broken("Discord history contained an invalid message ID"))?;
                if !message.matches(&route) {
                    return Err(broken("Discord history destination did not match its request"));
                }
                if if upper.is_some() { id >= position } else { id <= position } {
                    return Err(broken("Discord history cursor did not advance"));
                }
                messages.push((id, message));
            }
            messages.sort_unstable_by_key(|(id, _)| *id);
            let count = messages.len();
            let next = if upper.is_some() { messages.first() } else { messages.last() };
            if let Some((next, _)) = next {
                position = *next;
            }
            for (id, message) in messages {
                if id <= lower || before_us.is_some_and(|before| {
                    message.edited_timestamp.as_deref()
                        .and_then(|stamp| OffsetDateTime::parse(stamp, &Rfc3339).ok())
                        .is_some_and(|stamp| stamp.unix_timestamp_nanos() >= i128::from(before) * 1_000)
                }) {
                    continue;
                }
                if let Some(input) = self.with_context(&message, &route, &channel, self.addressing_enabled(&route)).await? {
                    inputs.push((id, input));
                }
            }
            if count < PAGE_SIZE || position <= lower {
                break;
            }
        }
        self.assert_live_intake_drained(&route)?;
        inputs.sort_unstable_by_key(|(id, _)| *id);
        Ok(Value::Array(inputs.into_iter().map(|(_, input)| input).collect()))
    }
}
