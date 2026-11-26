use serde::Deserialize;
use serde_json::{Value, json};

use crate::{adapter::EffectError, commands::accepts_text};

use super::super::wire::{Inbound, digest, now_ms, same_optional, slack_id};
use super::{Ack, Identity, Inner};

const REFUSED: &str = "Superagent refused this command: use a configured command as the authorized owner in this app's workspace and an allowed channel or owner DM. Slash commands cannot target threads.";
const ADMITTED: &str = "Superagent command admitted. The result will appear in this conversation.";

fn js_whitespace(char: char) -> bool {
    matches!(char, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(super) fn control_text(text: String) -> String {
    if let Some(command) = text
        .strip_prefix('!')
        .and_then(|text| text.split(js_whitespace).next())
        && accepts_text(command).is_some()
    {
        return format!("/{}", &text[1..]);
    }
    text
}

#[derive(Debug, PartialEq, Eq)]
enum SlashTextError {
    Unregistered,
    UnexpectedArgument,
}

fn slash_text(name: &str, text: &str) -> Result<String, SlashTextError> {
    let name = name
        .strip_prefix("/superagent-")
        .ok_or(SlashTextError::Unregistered)?;
    let accepts_argument = accepts_text(name).ok_or(SlashTextError::Unregistered)?;
    let text = text.trim_matches(js_whitespace);
    match (text.is_empty(), accepts_argument) {
        (true, _) => Ok(format!("/{name}")),
        (false, true) => Ok(format!("/{name} {text}")),
        (false, false) => Err(SlashTextError::UnexpectedArgument),
    }
}

#[derive(Deserialize)]
struct Slash<'a> {
    team_id: &'a str,
    user_id: &'a str,
    channel_id: &'a str,
    trigger_id: &'a str,
    command: &'a str,
    text: &'a str,
}

async fn respond(ack: Ack, text: &str) -> Result<(), EffectError> {
    ack.send(Some(json!({ "response_type": "ephemeral", "text": text })))
        .await
}

impl Inner {
    fn authorized_slash<'a>(&self, identity: &Identity, body: &'a Value) -> Option<Slash<'a>> {
        let command = Slash::deserialize(body).ok()?;
        if command.team_id != self.team
            || command.user_id != self.owner
            || !same_optional(body, "api_app_id", &identity.app_id)
            || !same_optional(body, "app_id", &identity.app_id)
            || !same_optional(body, "bot_id", &identity.bot_id)
            || !slack_id(command.channel_id)
            || command.trigger_id.is_empty()
            || [
                "ts",
                "message_ts",
                "thread_ts",
                "thread_id",
                "message",
                "container",
            ]
            .iter()
            .any(|name| body.get(name).is_some())
        {
            return None;
        }
        Some(command)
    }

    pub(super) async fn receive_slash(
        &self,
        identity: &Identity,
        body: &Value,
        ack: Ack,
    ) -> Result<(), EffectError> {
        if body["team_id"] == self.team
            && body["channel_id"].as_str().is_some_and(|channel| {
                self.ctx.group_room(Some(&self.team), channel).is_some()
            })
        {
            return ack.send(None).await;
        }
        let Some(command) = self.authorized_slash(identity, body) else {
            return respond(ack, REFUSED).await;
        };
        let text = match slash_text(command.command, command.text) {
            Ok(text) => Some(text),
            Err(SlashTextError::UnexpectedArgument) => None,
            Err(SlashTextError::Unregistered) => return respond(ack, REFUSED).await,
        };
        let route = match self
            .incoming_route(identity, command.channel_id, None)
            .await
        {
            Ok(Some(route)) => route,
            Ok(None) | Err(_) => return respond(ack, REFUSED).await,
        };
        let Some(text) = text else {
            return respond(
                ack,
                &format!(
                    "Superagent refused this command: {} does not take arguments.",
                    command.command,
                ),
            )
            .await;
        };
        let invocation_id = digest(&json!([
            identity.app_id,
            self.team,
            self.owner,
            command.channel_id,
            command.trigger_id
        ]));
        let input = Inbound {
            id: format!(
                "slack:{}:{}:invocation:{invocation_id}",
                identity.account, command.channel_id
            ),
            route,
            message_id: None,
            invocation_id: Some(invocation_id),
            text,
            received_at: json!(now_ms()),
            attachments: Vec::new(),
            unresolved_reply: None,
        };
        self.admit(json!({ "kind": "message", "input": input }))
            .await?;
        respond(ack, ADMITTED).await
    }
}

#[cfg(test)]
#[path = "ingress_tests.rs"]
mod tests;
