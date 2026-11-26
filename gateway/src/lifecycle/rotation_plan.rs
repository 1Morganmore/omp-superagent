use std::path::{Path, PathBuf};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::store::{HEAD_ROTATION, HEAD_SESSION_FILE, Store};

use super::{Lifecycle, LifecycleConfig, host_rpc::Head};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Mode {
    #[default]
    #[serde(skip)]
    Rotate,
    Hibernate,
}

impl Mode {
    fn is_rotation(&self) -> bool {
        *self == Self::Rotate
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Stage {
    Stopping,
    Sleeping,
    Starting,
    Launching,
    Complete,
    Refused,
}

impl Stage {
    pub fn active(self) -> bool {
        matches!(self, Self::Stopping | Self::Sleeping | Self::Starting | Self::Launching)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rotation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Mode::is_rotation")]
    pub mode: Mode,
    pub stage: Stage,
    pub original: Head,
    pub session_file: PathBuf,
    pub config_hash: String,
    pub stop_boundary: Option<String>,
    pub attestation: Attestation,
    pub replacement_session_id: Option<String>,
    pub replacement_owner_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_profile_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_stop: Option<Head>,
    #[serde(skip)]
    pub recorded: String,
}

impl Rotation {
    pub fn matches_replacement_session(&self, id: &str) -> bool {
        match self.mode {
            Mode::Rotate => id != self.original.session_id,
            Mode::Hibernate => id == self.original.session_id,
        }
    }

    pub fn hibernation_profile(&self) -> Result<&NativeProfile> {
        self.attestation.hibernation_profile()
            .ok_or_else(|| anyhow::anyhow!("Cannot restore hibernated HEAD without an attested original native OMP profile"))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attestation {
    pub generation: u64,
    pub idle_ms: u64,
    pub context_percent: Option<f64>,
    native_run: u64,
    pub selection: Selection,
    // Opaque to Gateway. Only the runtime may use these source-bound
    // admissions, after verifying the unchanged lane processes and journals.
    pub residents: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hibernation: Option<NativeProfile>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeProfile {
    version: u32,
    agent_dir: PathBuf,
    // Old receipts remain readable but cannot prove the original partition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sessions_dir: Option<PathBuf>,
}

impl NativeProfile {
    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.agent_dir.as_path())
            .chain(self.data_dir.as_deref())
            .chain(self.sessions_dir.as_deref())
    }

    pub fn is_bound(&self) -> bool {
        self.version == 2 && self.data_dir.is_some() && self.sessions_dir.is_some()
            && self.paths().all(Path::is_absolute)
    }
}

impl Attestation {
    fn hibernation_profile(&self) -> Option<&NativeProfile> {
        self.hibernation.as_ref().filter(|proof| proof.is_bound())
    }

    pub fn matches_hibernation_profile(&self, snapshot: &Value) -> bool {
        self.hibernation_profile().is_some_and(|expected|
            serde_json::to_value(expected).is_ok_and(|proof| proof == snapshot["nativeProfile"]))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Selection {
    provider: String,
    model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_identity: Option<String>,
    reasoning: bool,
    thinking_level: Option<String>,
    configured_thinking_level: Option<String>,
    pub model_settings: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_tier: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_tier_defaults: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effective_service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stock_launch_replay: Option<bool>,
}

impl Selection {
    pub fn stock_tier_settings(&self) -> Result<Value> {
        let defaults = self.service_tier_defaults.as_ref()
            .ok_or_else(|| anyhow::anyhow!("HEAD sleep did not attest its native service tier defaults"))?;
        // Stock omits standard processing from its selection map, but omitting
        // the config key would inherit a potentially new (and paid) default.
        Ok(Value::Object(["openai", "anthropic", "google"].into_iter().map(|family| {
            (family.to_owned(), defaults.get(family).cloned().unwrap_or_else(|| Value::from("none")))
        }).collect()))
    }

    pub fn has_exact_stock_resume(&self) -> bool {
        self.stock_launch_replay == Some(true)
            && self.model_identity.as_ref().is_some_and(|identity| !identity.is_empty())
            && self.service_tier.is_some()
            && self.service_tier_defaults.is_some()
            && self.effective_service_tier.as_ref().is_some_and(|tier| !tier.is_empty())
    }

    pub fn configured_effort(&self) -> Option<&str> {
        self.configured_thinking_level.as_deref()
    }

    pub fn matches(&self, state: &Value) -> bool {
        let model = &state["model"];
        let level = state["thinkingLevel"].as_str();
        let configured = state["configuredThinkingLevel"].as_str();
        model["provider"].as_str() == Some(&self.provider)
            && model["id"].as_str() == Some(&self.model_id)
            && model["reasoning"].as_bool() == Some(self.reasoning)
            && self.model_identity.as_deref().is_none_or(|identity| state["modelIdentity"].as_str() == Some(identity))
            && self.service_tier.as_ref().is_none_or(|tier| state["serviceTier"].as_object() == Some(tier))
            && self.effective_service_tier.as_deref().is_none_or(|tier| state["effectiveServiceTier"].as_str() == Some(tier))
            && self.stock_launch_replay.is_none_or(|replay| state["stockLaunchReplay"].as_bool() == Some(replay))
            && state.get("configuredThinkingLevel").is_some()
            && (self.configured_thinking_level.as_deref() == Some("auto")
                || self.effort_matches(self.thinking_level.as_deref(), level))
            && self.effort_matches(self.configured_thinking_level.as_deref(), configured)
            && state["modelSettings"] == self.model_settings
    }

    fn effort_matches(&self, before: Option<&str>, current: Option<&str>) -> bool {
        before == current || (!self.reasoning
            && matches!((before, current), (None, Some("off")) | (Some("off"), None)))
    }
}

fn valid_session_file(config: &LifecycleConfig, path: &Path) -> bool {
    if path == config.head_session {
        return true;
    }
    let Some(parent) = path.parent() else { return false };
    let Some(generation) = parent.file_name().and_then(|id| id.to_str()) else { return false };
    Uuid::parse_str(generation).is_ok()
        && path == rotated_file(config, generation)
}

pub(super) fn rotated_file(config: &LifecycleConfig, id: &str) -> PathBuf {
    config.state_dir.join("sessions/main/rotated").join(id).join("session.jsonl")
}

pub(super) fn session_file(config: &LifecycleConfig, store: &Store) -> Result<PathBuf> {
    session_file_from_meta(config, store.get_meta(HEAD_SESSION_FILE)?)
}

pub(super) fn session_file_from_meta(config: &LifecycleConfig, value: Option<String>) -> Result<PathBuf> {
    let path = value.map_or_else(|| config.head_session.clone(), PathBuf::from);
    ensure!(valid_session_file(config, &path), "Invalid durable HEAD session file");
    Ok(path)
}

impl Lifecycle {
    pub(super) fn rotation(&self) -> Result<Option<Rotation>> {
        let config = &self.0.config;
        let Some(encoded) = self.0.store.get_meta(HEAD_ROTATION)? else { return Ok(None) };
        let Some(mut plan) = serde_json::from_str::<Option<Rotation>>(&encoded)? else { return Ok(None) };
        let valid_target = match plan.mode {
            Mode::Rotate => {
                let target = rotated_file(config, &plan.id);
                plan.stage != Stage::Sleeping && plan.session_file == target && plan.original.session_file != target
            }
            Mode::Hibernate => plan.stage != Stage::Starting && plan.session_file == plan.original.session_file,
        };
        ensure!(Uuid::parse_str(&plan.id).is_ok() && valid_target
            && valid_session_file(config, &plan.original.session_file),
            "Invalid durable HEAD lifecycle plan");
        plan.recorded = encoded;
        Ok(Some(plan))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stock_resume_readback_requires_the_same_upstream_and_effective_tier() -> Result<()> {
        let selection: Selection = serde_json::from_value(json!({
            "provider": "openrouter", "modelId": "model", "modelIdentity": "openrouter/model@together",
            "reasoning": false, "modelSettings": {}, "stockLaunchReplay": true,
            "serviceTier": {"openai": "priority"}, "serviceTierDefaults": {}, "effectiveServiceTier": "none",
        }))?;
        let snapshot = json!({
            "model": {"provider": "openrouter", "id": "model", "reasoning": false},
            "modelIdentity": "openrouter/model@together", "configuredThinkingLevel": null,
            "modelSettings": {}, "serviceTier": {"openai": "priority"}, "effectiveServiceTier": "none", "stockLaunchReplay": true,
        });
        assert!(selection.has_exact_stock_resume() && selection.matches(&snapshot));
        for (key, unexpected) in [
            ("modelIdentity", json!("openrouter/model@fireworks")),
            ("serviceTier", json!({})),
            ("effectiveServiceTier", json!("priority")),
            ("stockLaunchReplay", Value::Null),
        ] {
            let mut observed = snapshot.clone();
            observed[key] = unexpected;
            assert!(!selection.matches(&observed), "unexpected {key} would publish a different HEAD");
        }
        Ok(())
    }

    #[test]
    fn an_old_hibernation_checkpoint_cannot_restore_from_a_config_hash_alone() {
        let mut checkpoint = json!({
            "id": "be10f3c2-4bad-4330-8310-fdc3c0acae18",
            "mode": "hibernate",
            "stage": "sleeping",
            "original": {
                "pid": 10, "ownerPid": 11, "sessionId": "head",
                "sessionFile": "/fixture/head/session.jsonl", "dev": 1, "ino": 2,
            },
            "sessionFile": "/fixture/head/session.jsonl",
            "configHash": "unchanged-config",
            "resumeProfileHash": "unchanged-normalized-config",
            "stopBoundary": null,
            "replacementSessionId": null,
            "replacementOwnerPid": null,
            "attestation": {
                "generation": 0, "nativeRun": 0, "idleMs": 1_800_000,
                "contextPercent": null, "residents": [],
                "selection": {"provider": "owner", "modelId": "head", "reasoning": false, "modelSettings": {}},
            },
        });

        let plan: Rotation = serde_json::from_value(checkpoint.clone()).unwrap();
        assert!(plan.hibernation_profile().is_err());

        checkpoint["attestation"]["hibernation"] = json!({"version": 1, "agentDir": "/fixture/profile"});
        let legacy: Rotation = serde_json::from_value(checkpoint).unwrap();
        assert!(legacy.hibernation_profile().is_err());
    }
}
