use anyhow::Result;
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use tokio::time;

use crate::discord::{State, dispatch::Ready, login::gateway_url};

use super::End;

#[derive(Default)]
pub(in crate::discord) struct Session {
    pub resume: Option<Resume>,
    pub(super) presence_account: Option<String>,
    pub(super) presence_allowed: Option<time::Instant>,
}

impl Session {
    pub fn new(presence_account: Option<String>) -> Self {
        Self { presence_account, ..Self::default() }
    }

    pub(super) fn prepare_ready(
        &self,
        state: &State,
        data: &Value,
        sequence: u64,
    ) -> Result<Result<Resume, End>> {
        let ready = Ready::deserialize(data)
            .map_err(|_| anyhow::anyhow!("Discord Gateway READY is invalid"))?;
        let url = gateway_url(&ready.resume_gateway_url)?;
        if ready.authenticate(state, self.presence_account.as_deref()).is_err()
            || ready.session_id.is_empty()
        {
            return Ok(Err(End::Fatal(4004)));
        }
        Ok(Ok(Resume { url, id: ready.session_id, sequence }))
    }
}

pub(in crate::discord) struct Resume {
    pub url: Url,
    pub(super) id: String,
    pub(super) sequence: u64,
}
