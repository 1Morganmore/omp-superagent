use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixStream,
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

use super::{
    config::same_path,
    fs::{self, EXIT_TIMEOUT, Endpoint, WAIT_SLICE, alive, socket_stat},
    rpc_wire::frame,
    rotation::{Attestation, Mode},
};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Head {
    pub pid: u32,
    pub owner_pid: u32,
    pub session_id: String,
    pub session_file: PathBuf,
    pub dev: u64,
    pub ino: u64,
    /// A live launch receipt, never recovered from the coordination store.
    #[serde(skip)]
    pub loaded_superkit_path: Option<PathBuf>,
}

impl Head {
    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            pid: self.pid,
            dev: self.dev,
            ino: self.ino,
        }
    }

    pub fn same(&self, other: &Self) -> bool {
        self.endpoint() == other.endpoint()
            && self.owner_pid == other.owner_pid
            && self.session_id == other.session_id
            && same_path(&self.session_file, &other.session_file)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostState {
    host_pid: u32,
    adapter_owner_pid: u32,
    adapter_protocol: String,
    session_id: String,
    session_file: PathBuf,
    loaded_superkit_path: Option<PathBuf>,
}

pub(super) struct Probe {
    stream: BufReader<UnixStream>,
    hibernation_attested: bool,
    pub head: Head,
    pub state: Value,
}

#[derive(Debug)]
pub(super) struct ShutdownRefused(pub String);

impl std::fmt::Display for ShutdownRefused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ShutdownRefused {}

impl Probe {
    pub async fn open(path: &Path, session: &Path, limit: Duration) -> Result<Self> {
        timeout(limit, async {
            let before = socket_stat(path, true)?;
            let mut stream = BufReader::new(UnixStream::connect(path).await?);
            let ready = frame(&mut stream).await?;
            ensure!(
                ready["type"] == "ready" && ready["protocolVersion"] == 1,
                "Endpoint did not offer the owned adapter JSONL protocol"
            );
            ensure!(
                ready["supportedProtocolVersions"]
                    .as_array()
                    .is_some_and(|supported| supported
                        .iter()
                        .any(|version| version.as_u64() == Some(2))),
                "Endpoint did not offer bounded v2 responses"
            );
            let negotiation = request(
                &mut stream,
                "negotiate_protocol",
                json!({"protocolVersion": 2}),
            )
            .await?;
            ensure!(
                negotiation["success"] == true && negotiation["data"]["protocolVersion"] == 2,
                "Endpoint rejected owned adapter protocol negotiation"
            );
            let mut response = request(&mut stream, "get_state", Value::Null).await?;
            ensure!(
                response["success"] == true,
                "Owned host state is unavailable"
            );
            let state = response
                .as_object_mut()
                .and_then(|response| response.swap_remove("data"))
                .context("Missing owned host state")?;
            let identity = HostState::deserialize(&state)?;
            let after = socket_stat(path, true)?;
            ensure!(
                after.dev() == before.dev() && after.ino() == before.ino(),
                "Owned HEAD socket changed during its identity probe"
            );
            ensure!(
                identity.host_pid > 0
                    && identity.adapter_owner_pid > 0
                    && identity.adapter_protocol == "owned-stock-stdio-v1"
                    && !identity.session_id.is_empty()
                    && same_path(&identity.session_file, session),
                "Endpoint did not identify the owned stock-stdio adapter and expected session"
            );
            Ok(Self {
                stream,
                hibernation_attested: false,
                state,
                head: Head {
                    pid: identity.host_pid,
                    owner_pid: identity.adapter_owner_pid,
                    session_id: identity.session_id,
                    session_file: identity.session_file,
                    dev: after.dev(),
                    ino: after.ino(),
                    loaded_superkit_path: identity.loaded_superkit_path.filter(|path| path.is_absolute()),
                },
            })
        })
        .await
        .context("Owned HEAD identity probe timed out")?
    }

    pub fn idle_for_restart(&self) -> bool {
        self.state["isSettled"] == true
            && self.state["isStreaming"] == false
            && self.state["isCompacting"] == false
            && self.state["queuedMessageCount"].as_u64() == Some(0)
            && self.state["hasPendingAsyncWork"] == false
            && self.state["hasOwnedRunningWork"] == false
            && self.state["pendingUiRequests"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && self
                .state
                .get("goal")
                .is_some_and(|goal| goal.is_null() || goal["enabled"] == false)
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        self.shutdown_with(Value::Null, false).await
    }

    pub async fn shutdown_unpublished_wake(&mut self) -> Result<()> {
        self.shutdown_with(Value::Null, true).await
    }

    pub async fn shutdown_rotation(&mut self, id: &str, mode: Mode) -> Result<()> {
        let mut body = json!({ "headRotation": id });
        if mode == Mode::Hibernate {
            ensure!(std::mem::take(&mut self.hibernation_attested),
                "HEAD hibernation shutdown requires a fresh native profile attestation");
            body["mode"] = json!(mode);
        }
        self.shutdown_with(body, mode == Mode::Hibernate).await
    }

    pub async fn rotation_attestation(&mut self, mode: Mode) -> Result<Option<Attestation>> {
        self.hibernation_attested = false;
        let body = if mode == Mode::Hibernate { json!({"mode": mode}) } else { Value::Null };
        let response = timeout(
            RPC_TIMEOUT,
            request(&mut self.stream, "get_head_rotation", body),
        ).await.context("HEAD rotation attestation timed out")??;
        if response["success"] != true {
            return Ok(None);
        }
        let attestation = Option::<Attestation>::deserialize(&response["data"])?;
        if mode == Mode::Hibernate {
            // An older Host may ignore mode and return an ordinary rotation
            // receipt. Accept only a positive sleep proof bound to this Host.
            self.hibernation_attested = attestation.as_ref()
                .is_some_and(|proof| proof.matches_hibernation_profile(&self.state));
            if !self.hibernation_attested {
                return Ok(None);
            }
        }
        Ok(attestation)
    }

    async fn shutdown_with(&mut self, body: Value, strict: bool) -> Result<()> {
        let response = timeout(
            RPC_TIMEOUT,
            request(&mut self.stream, "shutdown_host", body),
        )
        .await
        .context("Owned shutdown request outcome is unresolved")??;
        if response["success"] == false {
            ensure!(!strict || response["code"] == "session_busy" || response["error"] == "session_busy",
                "Owned shutdown request outcome is unresolved");
            return Err(ShutdownRefused(
                response["error"]
                    .as_str()
                    .unwrap_or("Native head refused busy shutdown")
                    .to_owned(),
            )
            .into());
        }
        if strict {
            let receipt = &response["data"];
            ensure!(receipt["shutdown"] == true
                && receipt["sessionId"].as_str() == Some(self.head.session_id.as_str())
                && receipt["sessionFile"].as_str().is_some_and(|file| Path::new(file) == self.head.session_file.as_path()),
                "Owned shutdown receipt did not identify the requested HEAD");
        }
        Ok(())
    }
}

async fn request(
    stream: &mut BufReader<UnixStream>,
    command: &str,
    mut body: Value,
) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    body["id"] = json!(id);
    body["type"] = json!(command);
    let mut bytes = serde_json::to_vec(&body)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    loop {
        let response = frame(stream).await?;
        if response["type"] != "response" || response["id"] != id {
            continue;
        }
        ensure!(
            response["command"] == command
                && response["success"].is_boolean()
                && (response["success"] == true || response["error"].is_string()),
            "Invalid owned Host response envelope"
        );
        return Ok(response);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitReceipt {
    pid: u32,
    owner_pid: u32,
    session_id: String,
    session_file: PathBuf,
    code: i32,
    signal: Value,
    persisted: bool,
    observations_flushed: bool,
}

pub(super) async fn confirmed_exit(path: &Path, head: &Head) -> Result<()> {
    let deadline = Instant::now() + EXIT_TIMEOUT;
    loop {
        if !alive(head.pid)? && fs::metadata(path)?.is_none() {
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Native head exit/persistence is pending; Gateway supervision remains stopped"
        );
        sleep(WAIT_SLICE).await;
    }
    let mut receipt_path = path.as_os_str().to_os_string();
    receipt_path.push(".exit.json");
    let receipt_path = PathBuf::from(receipt_path);
    let receipt: ExitReceipt = fs::read_private_json(&receipt_path)?;
    ensure!(
        receipt.pid == head.pid
            && receipt.owner_pid == head.owner_pid
            && receipt.session_id == head.session_id
            && receipt.session_file == head.session_file
            && receipt.code == 0
            && receipt.signal.is_null()
            && receipt.persisted
            && receipt.observations_flushed,
        "Native head exit and durable persistence were not confirmed; Gateway supervision remains stopped"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    #[tokio::test]
    async fn only_hibernation_proof_matching_the_owned_profile_can_send_sleep_shutdown() {
        let session_file = "/fixture/session.jsonl";
        let profile = json!({"version": 2, "agentDir": "/fixture/profile",
            "dataDir": "/fixture/native-data", "sessionsDir": "/fixture/native-data/sessions"});
        for (proof, accepted) in [
            (None, false), // An older peer returns a successful ordinary rotation receipt.
            (Some(json!({"version": 2, "agentDir": "/fixture/profile"})), false),
            (Some(json!({"version": 1, "agentDir": "/fixture/profile"})), false),
            (Some(json!({"version": 2, "agentDir": "/fixture/profile",
                "dataDir": "/fixture/other-data", "sessionsDir": "/fixture/other-data/sessions"})), false),
            (Some(profile.clone()), true),
        ] {
            let (client, peer) = UnixStream::pair().unwrap();
            let mut probe = Probe {
                stream: BufReader::new(client),
                hibernation_attested: false,
                head: Head {
                    pid: 100, owner_pid: 101, session_id: "head".into(),
                    session_file: session_file.into(), dev: 1, ino: 1, loaded_superkit_path: None,
                },
                state: json!({"nativeProfile": profile}),
            };
            let mut receipt = json!({
                "generation": 1, "nativeRun": 2, "idleMs": 1_800_000,
                "contextPercent": 80, "residents": [],
                "selection": {"provider": "owner", "modelId": "main", "reasoning": false, "modelSettings": {}},
            });
            if let Some(proof) = proof {
                receipt["hibernation"] = proof;
            }
            let peer = tokio::spawn(async move {
                let mut peer = BufReader::new(peer);
                let request = frame(&mut peer).await.unwrap();
                assert_eq!(request["type"], "get_head_rotation");
                let mut response = serde_json::to_vec(&json!({
                    "id": request["id"], "type": "response", "command": "get_head_rotation", "success": true, "data": receipt,
                })).unwrap();
                response.push(b'\n');
                peer.write_all(&response).await.unwrap();

                let mut line = String::new();
                if peer.read_line(&mut line).await.unwrap() == 0 {
                    return false;
                }
                let shutdown: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(shutdown["mode"], "hibernate");
                assert_eq!(shutdown["type"], "shutdown_host");
                let mut response = serde_json::to_vec(&json!({
                    "id": shutdown["id"], "type": "response", "command": "shutdown_host", "success": true,
                    "data": {"shutdown": true, "sessionId": "head", "sessionFile": session_file},
                })).unwrap();
                response.push(b'\n');
                peer.write_all(&response).await.unwrap();
                true
            });

            let attestation = probe.rotation_attestation(Mode::Hibernate).await.unwrap();
            let shutdown = probe.shutdown_rotation("attempt", Mode::Hibernate).await;
            drop(probe);
            assert_eq!(attestation.is_some(), accepted);
            assert_eq!(shutdown.is_ok(), accepted);
            assert_eq!(peer.await.unwrap(), accepted);
        }
    }
}
