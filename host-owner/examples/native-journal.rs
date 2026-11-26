//! Test executable for the same source compiled into Gateway and Host owner.
//! This is a Cargo example, not a packaged command.
#[path = "../src/exit_receipt.rs"]
mod exit_receipt;
#[path = "../../native-journal/format.rs"]
mod journal_format;
#[path = "../../native-journal/header.rs"]
mod journal_header;
#[path = "../../native-journal/scan.rs"]
mod journal_scan;

use std::{env, io, path::PathBuf, process::ExitCode, sync::Arc};

use anyhow::{Context as _, bail};
use exit_receipt::{ExitVerification, ExitingHost};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitInput {
    pid: u32,
    owner_pid: u32,
    session_id: String,
    code: Option<i32>,
    signal: Option<String>,
    instance_key: Option<Value>,
    worker_attempt: Option<String>,
    run_ordinal: u64,
    observation_failure: bool,
    expected_observations: Vec<(String, Value)>,
}

async fn run() -> anyhow::Result<bool> {
    let mut args = env::args().skip(1);
    let operation = args.next().context("Missing fixture operation")?;
    let session_file = args.next().context("Missing fixture journal path")?;
    match operation.as_str() {
        "session-id" => {
            let id = journal_header::read_session_id(session_file.as_ref())?;
            println!("{}", serde_json::to_string(&id)?);
            Ok(true)
        }
        "exit" => {
            let socket_path = PathBuf::from(args.next().context("Missing fixture socket path")?);
            let input: ExitInput = serde_json::from_reader(io::stdin().lock())?;
            let exit = ExitVerification {
                host: ExitingHost {
                    pid: input.pid,
                    owner_pid: input.owner_pid,
                    session_id: input.session_id,
                    session_file,
                    code: input.code,
                    worker_attempt: input.worker_attempt,
                    signal: input.signal,
                },
                instance_key: input.instance_key,
                run_ordinal: input.run_ordinal,
                observation_failure: input.observation_failure,
                expected_observations: input.expected_observations.into_iter()
                    .map(|(id, frame)| (id, Arc::new(frame))).collect(),
            };
            exit.verify_and_publish(&socket_path).await
        }
        _ => bail!("Unknown fixture operation"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) | Err(_) => {
            eprintln!("Native journal operation did not confirm its result");
            ExitCode::FAILURE
        }
    }
}
