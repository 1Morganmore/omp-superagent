use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{Semaphore, oneshot},
    time::timeout,
};

use super::LifecycleConfig;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;

impl LifecycleConfig {
    /// Refuse unsupported profiles without changing native settings or creating state.
    pub(super) async fn preflight_memory(&self) -> Result<()> {
        let result = async {
            ensure!(
                self.check_memory("preflight").await?,
                "Native OMP memory profile cannot be prepared"
            );
            Ok(())
        }
        .await;
        if result.is_err() {
            eprintln!(
                "Managed sessions require an enabled native OMP memory backend. \
                 Run omp-sa doctor with the same configuration and native profile."
            );
        }
        result
    }

    /// Read back enabled memory without granting permission to repair it.
    pub(super) async fn memory_enabled(&self) -> Result<bool> {
        self.check_memory("enabled").await
    }

    async fn check_memory(&self, operation: &str) -> Result<bool> {
        let (_, args) = self
            .command
            .split_first()
            .context("No OMP executable provided")?;
        let mut check = bun(self, &self.head_environment());
        check
            .arg(self.root.join("src/managed-memory-helper.ts"))
            .arg(operation)
            .args(args);
        tagged_output(
            &capture(check, None, OPERATION_TIMEOUT).await?,
            "MANAGED_MEMORY ",
        )
    }
}

pub(super) async fn inspect_omp(
    config: &LifecycleConfig,
    environment: &BTreeMap<OsString, OsString>,
) -> Result<(Vec<String>, &'static str)> {
    use nix::unistd::{AccessFlags, access};
    let (program, tail) = config
        .command
        .split_first()
        .context("No OMP executable provided")?;
    let path = if Path::new(program).is_absolute() {
        PathBuf::from(program)
    } else {
        let search = environment
            .get(OsStr::new("PATH"))
            .context("Cannot resolve OMP executable without PATH")?;
        env::split_paths(search)
            .filter(|path| !path.as_os_str().is_empty())
            .map(|dir| dir.join(program))
            .find(|path| path.is_file() && access(path, AccessFlags::X_OK).is_ok())
            .context("Cannot find configured stock OMP executable on PATH")?
    };
    let version = omp_probe(&path, environment, &["--version"], Duration::from_secs(10)).await?;
    let identification = version
        .trim()
        .strip_prefix("omp/")
        .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace));
    ensure!(
        identification.is_some(),
        "Configured executable did not identify as stock OMP"
    );
    let help = omp_probe(&path, environment, &["--help"], OPERATION_TIMEOUT).await?;
    ensure!(
        ["--mode", "--resume", "--extension", "--model"]
            .into_iter()
            .all(|flag| has_flag(&help, flag))
            && help
                .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-')
                .any(|word| word == "rpc-ui"),
        "Installed stock OMP is missing RPC, session, extension, or model capabilities"
    );
    let process_help = omp_probe(&path, environment, &["ps", "--help"], OPERATION_TIMEOUT).await?;
    let backend = match (
        has_flag(&process_help, "--global"),
        has_flag(&process_help, "--signal"),
    ) {
        (true, false) => "broker",
        (false, true) => "daemon",
        (true, true) | (false, false) => {
            anyhow::bail!("Installed stock OMP process ownership interface is unrecognized")
        }
    };
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()?.join(path)
    };
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("OMP executable path is not UTF-8"))?;
    let command = std::iter::once(path).chain(tail.iter().cloned()).collect();
    Ok((command, backend))
}

fn has_flag(help: &str, flag: &str) -> bool {
    help.match_indices(flag).any(|(offset, matched)| {
        help[offset + matched.len()..]
            .starts_with(|ch: char| ch.is_whitespace() || ch == ',' || ch == '=')
    })
}

async fn omp_probe(
    path: &Path,
    environment: &BTreeMap<OsString, OsString>,
    args: &[&str],
    limit: Duration,
) -> Result<String> {
    let mut command = Command::new(path);
    command.args(args).env_clear().envs(environment);
    Ok(String::from_utf8(capture(command, None, limit).await?)?)
}

pub(super) fn bun(config: &LifecycleConfig, environment: &BTreeMap<OsString, OsString>) -> Command {
    let mut command = Command::new(&config.bun);
    command
        .args(["--no-env-file", "--no-install"])
        .env_clear()
        .envs(environment)
        .current_dir(&config.cwd);
    command
}

pub(super) async fn session_id(path: &Path) -> Result<Option<String>> {
    let path = path.to_owned();
    await_journal_read(move || crate::journal_header::read_session_id(&path)).await
}

pub(super) async fn verify_session_journal(path: &Path, expected_id: &str) -> Result<bool> {
    let path = path.to_owned();
    let id = expected_id.to_owned();
    let deadline = std::time::Instant::now() + OPERATION_TIMEOUT;
    await_journal_read(move || crate::journal_scan::scan(&path, &id, deadline, |_| {})).await
}

async fn await_journal_read<T: Send + 'static>(
    read: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T> {
    // One Gateway owns one HEAD. A filesystem read already in the kernel
    // cannot be cancelled by dropping its future. Keep the slot until the
    // read itself finishes, without making Tokio join a stalled thread on exit.
    static SLOT: Semaphore = Semaphore::const_new(1);
    timeout(OPERATION_TIMEOUT, async {
        let permit = SLOT.acquire().await?;
        let (sender, receiver) = oneshot::channel();
        std::thread::Builder::new()
            .name("head-journal".into())
            .spawn(move || {
                let _permit = permit;
                // A caller that timed out must not consume this stale result.
                let _ = sender.send(read());
            })
            .context("Could not start native session journal read")?;
        receiver.await.context("Native session journal reader stopped")?
            .context("Gateway Host session journal is unavailable")
    }).await.context("Native session journal read timed out")?
}

pub(super) fn tagged_output<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    prefix: &str,
) -> Result<T> {
    let output = std::str::from_utf8(bytes)?;
    let data = output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(prefix))
        .context("Required stock OMP operation did not report a result")?;
    Ok(serde_json::from_str(data)?)
}

pub(super) async fn capture(
    mut command: Command,
    data: Option<&[u8]>,
    limit: Duration,
) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(if data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Could not start stock OMP operation")?;
    let mut output = child
        .stdout
        .take()
        .context("Stock OMP output was not piped")?
        .take(OUTPUT_LIMIT + 1);
    timeout(limit, async {
        let mut buffer = Vec::new();
        let write = async {
            if let Some(data) = data {
                let mut input = child
                    .stdin
                    .take()
                    .context("Stock OMP input was not piped")?;
                input.write_all(data).await?;
            }
            Ok::<_, anyhow::Error>(())
        };
        let read = async {
            output.read_to_end(&mut buffer).await?;
            ensure!(
                u64::try_from(buffer.len())? <= OUTPUT_LIMIT,
                "Stock OMP output exceeded its bound"
            );
            Ok::<_, anyhow::Error>(())
        };
        tokio::try_join!(write, read)?;
        ensure!(
            child.wait().await?.success(),
            "Stock OMP operation failed; private diagnostics suppressed"
        );
        Ok(buffer)
    })
    .await
    .context("Stock OMP operation timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preflight_rejects_a_competing_session_header_even_when_identity_is_readable() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("head.jsonl");
        let valid = "{\"type\":\"session\",\"id\":\"head\"}\n{\"type\":\"custom\",\"id\":\"1\"}\n";
        std::fs::write(&path, valid)?;
        assert!(verify_session_journal(&path, "head").await?);
        std::fs::write(&path, format!("{valid}{{\"type\":\n\"session\",\"id\":\"head\"}}\n"))?;
        assert_eq!(session_id(&path).await?.as_deref(), Some("head"));
        assert!(!verify_session_journal(&path, "head").await?);
        Ok(())
    }

    #[tokio::test]
    async fn a_cancelled_header_read_keeps_its_slot_but_never_supplies_the_next_identity() -> Result<()> {
        let (entered, started) = oneshot::channel();
        let (release, stalled) = std::sync::mpsc::channel();
        let first = tokio::spawn(await_journal_read(move || {
            entered.send(()).unwrap();
            stalled.recv().unwrap();
            Ok(Some("old"))
        }));
        started.await?;
        first.abort(); // Like the operation deadline, this drops the waiter, not the syscall.
        assert!(first.await.unwrap_err().is_cancelled());
        let retry = await_journal_read(|| Ok(Some("current")));
        tokio::pin!(retry);
        assert!(timeout(Duration::from_millis(50), &mut retry).await.is_err());
        release.send(())?;
        assert_eq!(retry.await?, Some("current"));
        Ok(())
    }
}
