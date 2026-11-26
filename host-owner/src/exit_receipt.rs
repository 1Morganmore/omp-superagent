use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context as _;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    journal_format::{field, object_fields, text_field},
    journal_scan::{before_deadline, scan},
};

const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(crate) struct ExitVerification {
    pub(crate) host: ExitingHost,
    pub(crate) instance_key: Option<Value>,
    pub(crate) run_ordinal: u64,
    pub(crate) observation_failure: bool,
    pub(crate) expected_observations: HashMap<String, Arc<Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExitingHost {
    pub(crate) pid: u32,
    pub(crate) owner_pid: u32,
    pub(crate) session_id: String,
    pub(crate) session_file: String,
    pub(crate) code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) worker_attempt: Option<String>,
    pub(crate) signal: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    #[serde(flatten)]
    host: ExitingHost,
    persisted: bool,
    observations_flushed: bool,
}

impl ExitVerification {
    pub(crate) async fn verify_and_publish(self, socket_path: &Path) -> anyhow::Result<bool> {
        let deadline = Instant::now() + VERIFICATION_TIMEOUT;
        let receipt = tokio::time::timeout_at(
            deadline.into(),
            tokio::task::spawn_blocking(move || self.verify(deadline)),
        )
        .await???;
        let socket_path = socket_path.to_owned();
        // A timed-out scanner cannot publish. The writer also checks the
        // deadline after staging and before the publishing rename.
        let flushed = tokio::time::timeout_at(
            deadline.into(),
            tokio::task::spawn_blocking(move || receipt.publish(&socket_path, deadline)),
        )
        .await???;
        Ok(flushed)
    }

    fn verify(mut self, deadline: Instant) -> io::Result<Receipt> {
        let path = Path::new(&self.host.session_file);
        let mut expected = Observations {
            host_pid: self.host.pid,
            instance_key: self.instance_key.as_ref().filter(|key| !key.is_null()),
            run_ordinal: self.run_ordinal,
            frames: &mut self.expected_observations,
            starts: HashSet::new(),
            duplicate_start: false,
        };
        let persisted = scan(path, &self.host.session_id, deadline, |entry| expected.visit(entry))?;
        let observations_flushed = persisted
            && !self.observation_failure
            && expected.frames.is_empty()
            && !expected.duplicate_start
            && u64::try_from(expected.starts.len()).ok() == Some(self.run_ordinal);
        Ok(Receipt { host: self.host, persisted, observations_flushed })
    }
}

struct Observations<'a> {
    host_pid: u32,
    instance_key: Option<&'a Value>,
    run_ordinal: u64,
    frames: &'a mut HashMap<String, Arc<Value>>,
    starts: HashSet<u64>,
    duplicate_start: bool,
}

impl Observations<'_> {
    fn visit(&mut self, [id, kind, data]: [Option<&str>; 3]) {
        let kind = text_field(kind);
        if !matches!(kind.as_deref(), Some("rpc_prompt_result" | "rpc_agent_start")) {
            return;
        }
        let Some([instance_key, pid, run, stored_frame]) = data.and_then(|data| {
            object_fields(data, ["instanceKey", "hostPid", "runOrdinal", "frame"])
        }) else {
            return;
        };
        // Null/absent launch identity expects a missing key in the journal.
        // Do not let an unparsable present value masquerade as missing.
        let same_instance = match self.instance_key {
            None => instance_key.is_none(),
            Some(Value::String(key)) => {
                text_field(instance_key).as_deref() == Some(key.as_str())
            }
            Some(Value::Bool(key)) => field::<bool>(instance_key) == Some(*key),
            Some(Value::Number(key)) => match (field::<f64>(instance_key), key.as_f64()) {
                (Some(observed), Some(expected)) => observed == expected,
                _ => false,
            },
            // Separately parsed JSON objects are not JS strictly equal.
            Some(Value::Array(_) | Value::Object(_) | Value::Null) => false,
        };
        if !same_instance {
            return;
        }
        match kind.as_deref() {
            Some("rpc_prompt_result") => {
                if let Some(id) = text_field(id)
                    && let Some(frame) = self.frames.get(id.as_ref())
                    && field::<Value>(stored_frame).is_some_and(|stored| equal_json(&stored, frame))
                {
                    self.frames.remove(id.as_ref());
                }
            }
            Some("rpc_agent_start") => {
                if field::<f64>(pid).and_then(safe_integer) == Some(u64::from(self.host_pid))
                    && let Some(run) = field::<f64>(run).and_then(safe_integer)
                    && (1..=self.run_ordinal).contains(&run)
                {
                    self.duplicate_start |= !self.starts.insert(run);
                }
            }
            _ => {}
        }
    }
}

fn safe_integer(number: f64) -> Option<u64> {
    if !(0.0..=MAX_SAFE_INTEGER).contains(&number) || number.fract() != 0.0 {
        return None;
    }
    // JSON numbers are JS doubles; the safe-integer range was checked above.
    Some(number as u64)
}

fn equal_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            // JS compares JSON numbers as doubles (including the sign of zero).
            left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(l, r)| equal_json(l, r))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| right.get(key).is_some_and(|other| equal_json(value, other)))
        }
        _ => left == right,
    }
}

impl Receipt {
    fn publish(self, socket_path: &Path, deadline: Instant) -> anyhow::Result<bool> {
        let mut receipt = socket_path.as_os_str().to_os_string();
        receipt.push(".exit.json");
        let mut staging = receipt.clone();
        staging.push(format!(".{}", Uuid::new_v4()));
        let (receipt, staging) = (PathBuf::from(receipt), PathBuf::from(staging));
        let bytes = serde_json::to_vec(&self)?;
        before_deadline(deadline)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging)
            .context("Could not stage private native exit receipt")?;
        let written = file.write_all(&bytes);
        drop(file);
        if let Err(error) = written
            .and_then(|()| before_deadline(deadline))
            .and_then(|()| fs::rename(&staging, receipt))
        {
            if fs::remove_file(&staging).is_err() {
                eprintln!("Could not remove staged native exit receipt");
            }
            return Err(error).context("Could not publish private native exit receipt");
        }
        Ok(self.observations_flushed)
    }
}
