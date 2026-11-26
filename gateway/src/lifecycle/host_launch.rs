use anyhow::{Context, Result, ensure};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs::File,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    signal::unix::{Signal as ExitNotifications, SignalKind, signal},
    time::{Instant, sleep, timeout, timeout_at},
};
use uuid::Uuid;

use super::{
    LifecycleConfig, config::RESTART_CONFIG_ENV, fs as owned,
    host_rpc::Probe,
    launch_files::LaunchFiles,
    managed_super::Ulw,
    process::{ChildKind, detached, host_owner_executable},
    rotation::{self, Mode, Rotation},
    rotation_plan::NativeProfile,
    stock_ops::{OUTPUT_LIMIT, bun, capture, inspect_omp, session_id, tagged_output, verify_session_journal},
    wake_retry::WakeRefusal,
};
use crate::store::Store;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const START_POLL: Duration = Duration::from_millis(50);

pub(super) struct PreparedHost<'a> {
    environment: BTreeMap<OsString, OsString>,
    files: LaunchFiles,
    store: &'a Store,
    log: File,
    deadline: Instant,
    session_id: Option<String>,
}

pub(super) struct LaunchedHost {
    files: LaunchFiles,
    child: std::process::Child,
    exits: ExitNotifications,
    pub pid: u32,
    deadline: Instant,
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSettings {
    settings: Value,
    cleared_roles: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    extension_paths: Vec<PathBuf>,
    no_extensions: bool,
    memory_write_dir: Option<PathBuf>,
    native_profile: Option<NativeProfile>,
    native_profile_paths: Option<DiscoveryProfilePaths>,
    #[serde(default)]
    native_dotenv_paths: Vec<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryProfilePaths {
    agent_dir: PathBuf,
    data_dir: PathBuf,
    sessions_dir: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preparation {
    tools_explicitly_selected: bool,
    no_tools: bool,
    inventory: Option<Value>,
    native_profile_binding: Option<Value>,
    replayable_argv_hash: Option<String>,
}

struct HeadLaunch {
    package: PathBuf,
    extensions: [PathBuf; 4],
    environment: BTreeMap<OsString, OsString>,
}

struct LaunchHelper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    leftover: Vec<u8>,
    phase1_deadline: Instant,
    discovery: Discovery,
}

async fn kill_wait(child: &mut Child, deadline: Instant) {
    let _ = child.start_kill();
    // Try to reap the direct child without extending the phase deadline. On
    // drop, Tokio still takes care of a child that has not been reaped yet.
    let _ = timeout_at(deadline, child.wait()).await;
}

impl LaunchHelper {
    async fn start(
        mut command: Command,
        input: &Value,
        phase1_timeout: Duration,
    ) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The diagnostic stream is private and not used by the Gateway.
            // A background child can inherit it, so do not wait for its EOF.
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start Host SDK launch helper")?;
        let mut stdin = child
            .stdin
            .take()
            .context("Host SDK launch input was not piped")?;
        let mut stdout = child
            .stdout
            .take()
            .context("Host SDK launch output was not piped")?;

        let phase1_deadline = Instant::now() + phase1_timeout;
        let mut discovery_line = serde_json::to_vec(input)?;
        discovery_line.push(b'\n');

        let outcome = timeout_at(phase1_deadline, async {
            stdin.write_all(&discovery_line).await?;
            stdin.flush().await?;
            let mut buffer = Vec::new();
            let mut scan_from = 0usize;
            let mut chunk = [0u8; 4096];
            loop {
                while let Some(rel_nl) = buffer[scan_from..].iter().position(|&byte| byte == b'\n') {
                    let line_end = scan_from + rel_nl;
                    let line = buffer[scan_from..line_end]
                        .strip_suffix(b"\r")
                        .unwrap_or(&buffer[scan_from..line_end]);
                    if let Some(payload) = line.strip_prefix(b"MANAGED_ULW_LAUNCH ") {
                        let discovery: Discovery = serde_json::from_slice(payload)?;
                        let leftover = buffer.split_off(line_end + 1);
                        return Ok::<_, anyhow::Error>((discovery, leftover));
                    }
                    if let Some(payload) = line.strip_prefix(b"MANAGED_ULW_LAUNCH_ERROR ") {
                        let message: String = serde_json::from_slice(payload)?;
                        return Err(anyhow::anyhow!(message));
                    }
                    scan_from = line_end + 1;
                }
                let read = stdout.read(&mut chunk).await?;
                if read == 0 {
                    anyhow::bail!("Stock OMP discovery did not return a launch composition");
                }
                let next_len = buffer.len().saturating_add(read);
                ensure!(
                    u64::try_from(next_len)? <= OUTPUT_LIMIT,
                    "Stock OMP discovery output exceeded its bound"
                );
                buffer.extend_from_slice(&chunk[..read]);
            }
        })
        .await;

        match outcome {
            Err(_) => {
                drop(stdin);
                kill_wait(&mut child, phase1_deadline).await;
                anyhow::bail!("Native launch discovery timed out");
            }
            Ok(Err(error)) => {
                drop(stdin);
                kill_wait(&mut child, phase1_deadline).await;
                Err(error)
            }
            Ok(Ok((discovery, leftover))) => Ok(Self {
                child,
                stdin: Some(stdin),
                stdout,
                leftover,
                phase1_deadline,
                discovery,
            }),
        }
    }

    async fn finish_discovery(mut self) -> Result<Discovery> {
        // Closing stdin without writing a manifest selects discovery-only EOF mode.
        drop(self.stdin.take());
        match timeout_at(self.phase1_deadline, self.child.wait()).await {
            Err(_) => {
                kill_wait(&mut self.child, self.phase1_deadline).await;
                anyhow::bail!("Native launch discovery timed out");
            }
            Ok(Err(error)) => {
                kill_wait(&mut self.child, self.phase1_deadline).await;
                Err(error.into())
            }
            Ok(Ok(status)) => {
                ensure!(
                    status.success(),
                    "Stock OMP operation failed; private diagnostics suppressed"
                );
                Ok(self.discovery)
            }
        }
    }

    async fn prepare(mut self, payload: &[u8], phase2_timeout: Duration) -> Result<(Instant, Preparation)> {
        let deadline = Instant::now() + phase2_timeout;
        let outcome = timeout_at(deadline, async {
            let mut stdin = self
                .stdin
                .take()
                .context("Host SDK launch input was already closed")?;
            stdin.write_all(payload).await?;
            stdin.flush().await?;
            drop(stdin);

            let mut chunk = [0u8; 4096];
            loop {
                let read = self.stdout.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                let next_len = self.leftover.len().saturating_add(read);
                ensure!(
                    u64::try_from(next_len)? <= OUTPUT_LIMIT,
                    "Stock OMP output exceeded its bound"
                );
                self.leftover.extend_from_slice(&chunk[..read]);
            }
            let status = self.child.wait().await?;
            ensure!(
                status.success(),
                "Stock OMP operation failed; private diagnostics suppressed"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await;

        match outcome {
            Err(_) => {
                kill_wait(&mut self.child, deadline).await;
                anyhow::bail!("Native session preparation timed out");
            }
            Ok(Err(error)) => {
                kill_wait(&mut self.child, deadline).await;
                Err(error)
            }
            Ok(Ok(())) => {
                let flags: Preparation = serde_json::from_slice(&self.leftover)
                    .context("Native session preparation did not confirm tool selection")?;
                Ok((deadline, flags))
            }
        }
    }
}

impl HeadLaunch {
    fn new(config: &LifecycleConfig, ulw: &Ulw) -> Result<Self> {
        let package = ulw.package()?;
        let source = config.root.join("src");
        let extension = match env::var_os("OMP_SUPERAGENT_TEST_EXTENSION_PATH") {
            Some(path) if ulw.fixture() => PathBuf::from(path),
            _ => source.join("extension.ts"),
        };
        ensure!(
            extension.is_absolute(),
            "Host extension must have an explicit absolute path"
        );
        let extensions = [
            config.root.clone(),
            package.clone(),
            extension,
            source.join("host-extension.ts"),
        ];
        host_owner_executable(&config.root)?;
        let mut environment = config.head_environment();
        environment.insert(
            "OMP_SUPERAGENT_CONFIG".into(),
            config.path.as_os_str().to_os_string(),
        );
        environment.insert("OMP_SUPERAGENT_ROLE".into(), "head".into());
        environment.insert(
            "OMP_SUPERAGENT_MANAGED_ULW_PATH".into(),
            package.as_os_str().to_os_string(),
        );
        Ok(Self { package, extensions, environment })
    }

    async fn start_launch(
        &self,
        config: &LifecycleConfig,
        command: &[String],
        files: (Option<&Path>, &Path),
        expected_profile: Option<&NativeProfile>,
    ) -> Result<LaunchHelper> {
        let default_args = host_args(config, files, &self.extensions, false);
        let (_, prefix) = command.split_first().context("No OMP executable provided")?;
        let mut input = json!({
            "cwd": config.cwd, "managedUlwPath": self.package, "extensionPaths": self.extensions,
            "commandArgs": prefix, "launchArgs": prefix.iter().chain(default_args.iter()).collect::<Vec<_>>(),
        });
        if let Some(profile) = expected_profile {
            input["expectedNativeProfile"] = serde_json::to_value(profile)?;
        }
        let mut launch = bun(config, &self.environment);
        launch.arg(config.root.join("src/host-sdk-helper.ts")).arg("launch");
        LaunchHelper::start(launch, &input, START_TIMEOUT).await
    }

    async fn discover(&self, config: &LifecycleConfig, files: (Option<&Path>, &Path)) -> Result<Discovery> {
        self.start_launch(config, &config.command, files, None).await?.finish_discovery().await
    }
}

/// On the fallback path, validate the same operator flags and extension roots as the
/// real HEAD launch. Its generated overlay carries model/task/goal settings only.
pub(super) async fn ensure_launchable_memory(config: &LifecycleConfig, ulw: &Ulw) -> Result<()> {
    if !config.memory_enabled().await? {
        HeadLaunch::new(config, ulw)?.discover(config, (None, &config.head_session)).await?;
    }
    Ok(())
}

enum ResumeSelection {
    CheckJournal,
    VerifiedSleep,
    Rotation,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResumeCommand {
    Command(Vec<String>),
    Refused(String),
}

pub(super) async fn check_head_lifecycle_command(config: &LifecycleConfig, plan: &Rotation) -> Result<()> {
    ensure!(
        owned::metadata(&plan.original.session_file)?.is_some_and(|stat| stat.is_file()),
        "HEAD shutdown requires a regular native journal, not a symlink"
    );
    let mode = if plan.mode == Mode::Hibernate { ResumeSelection::CheckJournal } else { ResumeSelection::Rotation };
    resume_command(config, &config.command, plan, mode).await?;
    // Scan only at the shutdown boundary, after the stock argument proof.
    ensure!(
        verify_session_journal(&plan.original.session_file, &plan.original.session_id).await?,
        "HEAD journal cannot pass the native exit verifier"
    );
    Ok(())
}

async fn resume_command(
    config: &LifecycleConfig,
    command: &[String],
    plan: &Rotation,
    mode: ResumeSelection,
) -> Result<Vec<String>> {
    let (executable, prefix) = command.split_first().context("No OMP executable provided")?;
    if !matches!(mode, ResumeSelection::Rotation) && !plan.attestation.selection.has_exact_stock_resume() {
        return Err(WakeRefusal::ResumeCommand(
            "The original HEAD did not attest exact stock launch replay, routed model and service tier".into(),
        ).into());
    }
    if matches!(mode, ResumeSelection::VerifiedSleep)
        && !prefix.iter().any(|arg| {
            matches!(
                arg.split('=').next(),
                Some("--model" | "--provider" | "--thinking" | "--service-tier"
                    | "--preset" | "--smol" | "--slow" | "--plan"
                    | "--max-time" | "--plan-yolo" | "--plan-yolo-into" | "--prewalk" | "--prewalk-into"
                    | "--fork" | "--session" | "--resume" | "-r" | "--restore" | "--continue" | "-c"
                    | "--no-session" | "--from-claude" | "--from-codex")
            )
        })
    {
        // The sleep preflight already parsed the unchanged prefix and proved
        // that appending the saved effort changes no other stock option.
        let mut command = command.to_vec();
        if let Some(effort) = plan.attestation.selection.configured_effort() {
            command.push(format!("--thinking={effort}"));
        }
        return Ok(command);
    }
    let input = serde_json::to_vec(&json!({
        "argv": prefix, "sessionFile": plan.original.session_file,
        "sessionId": plan.original.session_id,
        "selection": plan.attestation.selection,
        "checkJournal": matches!(mode, ResumeSelection::CheckJournal),
        "rotationOnly": matches!(mode, ResumeSelection::Rotation),
    }))?;
    let mut helper = bun(config, &config.head_environment());
    helper.arg(config.root.join("src/host-sdk-helper.ts")).arg("head-resume-command");
    let output = capture(helper, Some(&input), START_TIMEOUT).await?;
    match tagged_output(&output, "MANAGED_HEAD_RESUME ")? {
        ResumeCommand::Command(prefix) => {
            Ok(std::iter::once(executable.clone()).chain(prefix).collect())
        }
        ResumeCommand::Refused(reason) => Err(WakeRefusal::ResumeCommand(reason).into()),
    }
}

impl<'a> PreparedHost<'a> {
    pub async fn prepare(
        config: &LifecycleConfig,
        store: &'a Store,
        ulw: &Ulw,
        rotation: Option<&Rotation>,
        stopped: Option<&Rotation>,
    ) -> Result<Self> {
        let launch = HeadLaunch::new(config, ulw)?;
        let source = config.root.join("src");
        let session_file = rotation::session_file(config, store)?;
        if session_file != config.head_session {
            // Rotated sessions live under a unique trusted directory, never
            // under a reused journal pathname or a symlink.
            owned::private_directory(config.head_session.parent().context("HEAD session directory missing")?)?;
            owned::private_directory(&config.state_dir.join("sessions/main/rotated"))?;
        }
        owned::private_directory(session_file.parent().context("HEAD session directory missing")?)?;
        let wake = rotation.filter(|plan| plan.mode == Mode::Hibernate);
        let sleep_resume = wake.or(stopped);
        let expected_profile = sleep_resume.map(Rotation::hibernation_profile).transpose()
            .map_err(|_| WakeRefusal::Checkpoint(
                "Cannot restore hibernated HEAD without an attested original native OMP profile",
            ))?;
        let journal = owned::metadata(&session_file)?;
        if sleep_resume.is_some() {
            ensure!(
                journal.as_ref().is_some_and(|stat| stat.is_file()),
                WakeRefusal::Checkpoint("HEAD wake requires the original regular native journal"),
            );
        }
        let restoring = journal.is_some();
        let mut expected_id = if restoring { session_id(&session_file).await? } else { None };
        if let Some(expected) = store
            .get_meta("main:sessionId")?
            .filter(|id| !id.is_empty())
        {
            ensure!(
                expected_id.as_deref() == Some(expected.as_str()),
                WakeRefusal::Checkpoint("Stored head settings belong to a different native session; refusing startup"),
            );
        }
        let settings_key = rotation.map(|plan| &plan.original.session_id).or(expected_id.as_ref());
        let mut settings = match settings_key {
            Some(id) => store
                .get_meta(&format!("head:model-settings:{id}"))?
                .map(|value| serde_json::from_str::<SavedSettings>(&value))
                .transpose()?,
            None => None,
        };
        if let Some(plan) = rotation.or(stopped) {
            settings = Some(SavedSettings {
                settings: plan.attestation.selection.model_settings.clone(),
                cleared_roles: settings.map_or_else(Vec::new, |previous| previous.cleared_roles),
            });
        }
        ensure!(
            owned::metadata(&config.head_socket)?.is_none(),
            "Existing HEAD endpoint requires explicit adoption"
        );
        let (mut command, backend) = inspect_omp(config, &launch.environment).await?;
        if let Some(plan) = sleep_resume {
            ensure!(session_file == plan.original.session_file
                && expected_id.as_deref() == Some(plan.original.session_id.as_str()),
                WakeRefusal::Checkpoint("Hibernating HEAD journal is missing or has changed identity"));
            // The parked plan already proved this pinned command against the
            // live journal. Manual start can supply new arguments; prove those
            // against the journal before even requesting session preparation.
            let check = if stopped.is_some() { ResumeSelection::CheckJournal } else { ResumeSelection::VerifiedSleep };
            command = resume_command(config, &command, plan, check).await?;
        }
        let run_dir = config
            .head_socket
            .parent()
            .context("Host run directory missing")?;
        let log = owned::log(&config.head_log)?;
        let mut config_data = settings_config(config, settings.as_ref(), restoring)?;
        if let Some(plan) = sleep_resume {
            config_data["tier"] = plan.attestation.selection.stock_tier_settings()?;
        }
        let files = LaunchFiles::create(store)?;
        let config_path = files.path().join("config.json");
        owned::private_json(&config_path, &config_data)?;
        let launch_helper = launch.start_launch(config, &command, (Some(&config_path), &session_file), expected_profile).await?;
        if let Some(expected) = expected_profile {
            if launch_helper.discovery.native_profile.as_ref() != Some(expected) {
                let discovery = launch_helper.finish_discovery().await?;
                let mut paths = discovery.native_dotenv_paths;
                paths.extend(expected.paths().map(Path::to_path_buf));
                if let Some(observed) = discovery.native_profile_paths {
                    paths.extend([observed.agent_dir, observed.data_dir, observed.sessions_dir]);
                }
                return Err(WakeRefusal::profile(paths).into());
            }
        }
        let HeadLaunch { package, mut environment, .. } = launch;
        let args = host_args(
            config,
            (Some(&config_path), &session_file),
            &launch_helper.discovery.extension_paths,
            launch_helper.discovery.no_extensions,
        );
        let socket_id = Uuid::new_v4().simple().to_string();
        let native_socket = run_dir.join(format!(".n-{}.sock", &socket_id[..8]));
        let helper = source.join("host-sdk-helper.ts");
        let mut manifest = json!({
            "options": { "command": command, "cwd": config.cwd, "sessionFile": session_file, "managedUlwPath": package,
                "socketPath": config.head_socket, "modelSettings": settings.as_ref().map(|saved| &saved.settings) },
            "args": args, "configPath": config_path, "memoryWriteDir": launch_helper.discovery.memory_write_dir, "processBackend": backend,
            "helperPath": helper, "nativeSocket": native_socket,
        });
        if let Some(plan) = rotation.filter(|plan| plan.mode == Mode::Rotate) {
            manifest["headRotationSelection"] = serde_json::to_value(&plan.attestation.selection)?;
        }
        if let Some(plan) = sleep_resume {
            manifest["headHibernationSessionId"] = json!(plan.original.session_id);
            manifest["expectedNativeProfile"] = serde_json::to_value(expected_profile)?;
        }
        let discovered_profile = launch_helper.discovery.native_profile.as_ref()
            .filter(|profile| profile.is_bound()).context("Native discovery did not confirm a HEAD profile")?;
        let discovered_profile = serde_json::to_value(discovered_profile)?;
        let payload = serde_json::to_vec(&manifest)?;
        let (deadline, flags) = launch_helper.prepare(&payload, START_TIMEOUT).await?;
        manifest["toolsExplicitlySelected"] = json!(flags.tools_explicitly_selected);
        manifest["replayableArgvHash"] = json!(flags.replayable_argv_hash);
        manifest["noTools"] = json!(flags.no_tools);
        manifest["inventory"] = json!(flags.inventory);
        let binding = flags.native_profile_binding.context("Native preparation did not bind HEAD discovery")?;
        ensure!(binding["profile"] == discovered_profile, "Native HEAD profile changed during journal preparation");
        manifest["nativeProfileBinding"] = binding;
        if let Some(plan) = rotation {
            expected_id = session_id(&session_file).await?;
            ensure!(expected_id.as_ref().is_some_and(|id| plan.matches_replacement_session(id)),
                "Prepared native HEAD journal does not match the lifecycle plan");
        }
        owned::private_json(&files.path().join("owner.json"), &manifest)?;
        let token = store.token()?;
        environment.insert("OMP_SUPERAGENT_GATEWAY_TOKEN".into(), token.into());
        Ok(Self {
            environment,
            files,
            store,
            log,
            deadline,
            session_id: expected_id,
        })
    }

    pub fn expected_session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// An error proves that no pipe owner was started. In particular, install
    /// the exit listener before spawning: Tokio's Command can fail to register
    /// its reaper *after* the underlying process has already started.
    pub fn spawn(
        mut self,
        cwd: &Path,
        restart_config_hash: Option<&str>,
    ) -> Result<LaunchedHost> {
        ensure!(
            Instant::now() < self.deadline,
            "Native Host startup timed out before launch"
        );
        if let Some(hash) = restart_config_hash {
            self.environment.insert(RESTART_CONFIG_ENV.into(), hash.into());
        }
        let mut command = detached(ChildKind::HeadOwner, &self.log)?;
        command
            .arg(self.files.path().join("owner.json"))
            .current_dir(cwd)
            .env_clear()
            .envs(self.environment);
        let exits = signal(SignalKind::child()).context("Could not watch for owned Host exit")?;
        LaunchFiles::seal(self.store)?;
        ensure!(
            Instant::now() < self.deadline,
            "Native Host startup timed out before launch"
        );
        let child = command
            .spawn()
            .context("Could not spawn owned Host process")?;
        // The owner needs the manifest for an exit proof even if the Gateway
        // disappears. After spawn only a confirmed owner exit may clean it.
        self.files.owned_by_child = true;
        let pid = child.id();
        Ok(LaunchedHost {
            files: self.files,
            child,
            exits,
            pid,
            deadline: self.deadline,
            session_id: self.session_id,
        })
    }
}

impl LaunchedHost {
    pub async fn identify(&mut self, config: &LifecycleConfig, session_file: &Path) -> Result<Probe> {
        let mut observed_socket = None;
        while Instant::now() < self.deadline {
            ensure!(
                self.child.try_wait()?.is_none(),
                "Owned OMP host exited during startup; inspect private log"
            );
            if let Some(stat) = owned::metadata(&config.head_socket)? {
                ensure!(
                    stat.file_type().is_socket() && stat.uid() == nix::unistd::getuid().as_raw(),
                    "Launched RPC endpoint is not an owned socket"
                );
                let inode = (stat.dev(), stat.ino());
                ensure!(
                    *observed_socket.get_or_insert(inode) == inode,
                    "Launched RPC socket changed"
                );
                if stat.mode() & 0o777 == 0o600 {
                    let probe = Probe::open(
                        &config.head_socket,
                        session_file,
                        self.deadline.saturating_duration_since(Instant::now()),
                    )
                    .await?;
                    let head = &probe.head;
                    ensure!(
                        (head.dev, head.ino) == inode && head.owner_pid == self.pid,
                        "Endpoint does not belong to the launched pipe owner"
                    );
                    ensure!(
                        self.session_id
                            .as_ref()
                            .is_none_or(|id| id == &head.session_id),
                        "Launched host resumed a different session identity"
                    );
                    ensure!(
                        self.child.try_wait()?.is_none(),
                        "Owned OMP host exited during startup; inspect private log"
                    );
                    return Ok(probe);
                }
            } else {
                ensure!(
                    observed_socket.is_none(),
                    "Launched RPC socket disappeared during startup"
                );
            }
            sleep(START_POLL).await;
        }
        anyhow::bail!("OMP host startup timed out; inspect private log")
    }

    async fn wait(&mut self) -> Result<()> {
        // SIGCHLD is only a wakeup. Reap the exact child even when notifications
        // coalesce with another child exit or arrive before this task polls.
        while self.child.try_wait()?.is_none() {
            self.exits
                .recv()
                .await
                .context("Owned Host exit listener closed")?;
        }
        Ok(())
    }

    pub fn reap(mut self) {
        tokio::spawn(async move {
            if self.wait().await.is_ok() {
                self.files.cleanup();
            } else {
                eprintln!("Could not reap the owned HEAD pipe process");
            }
        });
    }

    pub async fn abandon(mut self) -> Result<()> {
        let result = self.terminate().await;
        if result.is_ok() {
            self.files.cleanup();
        } else {
            self.reap();
        }
        result
    }

    async fn terminate(&mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            let result = kill(Pid::from_raw(i32::try_from(self.pid)?), Signal::SIGTERM);
            if let Err(error) = result
                && error != nix::errno::Errno::ESRCH
            {
                return Err(error.into());
            }
            match timeout(Duration::from_secs(1), self.wait()).await {
                Ok(exit) => exit?,
                Err(_) => {
                    self.child.kill()?;
                    self.wait().await?;
                }
            }
        }
        Ok(())
    }
}

fn settings_config(
    config: &LifecycleConfig,
    settings: Option<&SavedSettings>,
    restoring: bool,
) -> Result<Value> {
    let mut output = json!({"task": {"maxConcurrency": config.concurrency}, "goal": {"continuationModes": ["rpc"]}});
    if let Some(saved) = settings {
        let roles = saved.settings["modelRoles"]
            .as_object()
            .context("Saved model settings have no model roles")?;
        let mut merged: serde_json::Map<_, _> = saved
            .cleared_roles
            .iter()
            .cloned()
            .map(|key| (key, Value::Null))
            .collect();
        merged.extend(roles.clone());
        output["modelRoles"] = Value::Object(merged);
        if let Some(thinking) = saved.settings.get("defaultThinkingLevel") {
            output["defaultThinkingLevel"] = thinking.clone();
        }
    } else if !restoring && let Some(model) = &config.model {
        output["modelRoles"] = json!({ "default": model });
    }
    Ok(output)
}

fn host_args(
    config: &LifecycleConfig,
    files: (Option<&Path>, &Path),
    extensions: &[PathBuf],
    no_extensions: bool,
) -> Vec<String> {
    let mut args = vec![
        "--mode".into(),
        "rpc-ui".into(),
        "--session".into(),
        files.1.to_string_lossy().into_owned(),
        "--cwd".into(),
        config.cwd.to_string_lossy().into_owned(),
    ];
    if no_extensions {
        args.push("--no-extensions".into());
    }
    for extension in extensions {
        args.extend(["-e".into(), extension.to_string_lossy().into_owned()]);
    }
    if let Some(overlay) = files.0 {
        args.extend(["--config".into(), overlay.to_string_lossy().into_owned()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    use tempfile::tempdir;

    #[tokio::test]
    async fn prepared_host_spawn_deadline_and_syscall_failure_leave_no_owner_manifest() -> Result<()> {
        let root = tempdir()?;
        owned::private_directory(&root.path().join("run"))?;
        let store = Store::open(root.path())?;
        let now = Instant::now();
        for (name, deadline, cwd, syscall) in [
            ("expired", now, root.path().to_path_buf(), false),
            ("missing-cwd", now + START_TIMEOUT, root.path().join("absent"), true),
        ] {
            let files = LaunchFiles::create(&store)?;
            let directory = files.path().to_owned();
            fs::write(directory.join("owner.json"), b"{}")?;
            let prepared = PreparedHost {
                environment: BTreeMap::new(),
                files,
                store: &store,
                log: File::create(root.path().join("launch.log"))?,
                deadline,
                session_id: None,
            };
            let error = match prepared.spawn(&cwd, None) {
                Err(error) => error,
                Ok(mut owner) => {
                    // A regression must not leave a process or a manifest in
                    // the test's directory after exercising the actual spawn.
                    timeout(Duration::from_secs(2), owner.wait()).await??;
                    owner.files.cleanup();
                    anyhow::bail!("Unexpected owner spawned in {name}");
                }
            };
            if syscall {
                assert_eq!(
                    error.downcast_ref::<std::io::Error>().map(std::io::Error::kind),
                    Some(std::io::ErrorKind::NotFound)
                );
            } else {
                assert!(error.to_string().contains("timed out before launch"));
            }
            assert!(!directory.exists(), "{name} retained an unowned manifest");
        }
        Ok(())
    }

    #[tokio::test]
    async fn owned_host_wait_reaps_a_child_that_exits_after_wait_begins() -> Result<()> {
        let root = tempdir()?;
        owned::private_directory(&root.path().join("run"))?;
        let store = Store::open(root.path())?;
        let mut files = LaunchFiles::create(&store)?;
        LaunchFiles::seal(&store)?;
        files.owned_by_child = true;
        let exits = signal(SignalKind::child())?;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "IFS= read -r line; exit 7"])
            .stdin(Stdio::piped())
            .spawn()?;
        let release = child.stdin.take().context("Missing child test pipe")?;
        let mut owner = LaunchedHost {
            files,
            pid: child.id(),
            child,
            exits,
            deadline: Instant::now() + START_TIMEOUT,
            session_id: None,
        };
        {
            let mut wait = std::pin::pin!(owner.wait());
            assert!(futures_util::poll!(wait.as_mut()).is_pending());
            drop(release);
            timeout(Duration::from_secs(2), wait).await??;
        }
        assert_eq!(owner.child.try_wait()?.and_then(|exit| exit.code()), Some(7));
        Ok(())
    }

    fn mock_launch_command(script: &Path) -> Command {
        Command::new(script)
    }

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o700);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[tokio::test]
    async fn launch_helper_supports_discovery_only_prepare_errors_and_phase_timeout() {
        let tmp = tempdir().unwrap();

        let discovery_only = write_script(
            tmp.path(),
            "discovery-only.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH {"extensionPaths":["/ext/a"],"noExtensions":true,"memoryWriteDir":"/mem"}\n'
rest=$(cat)
if [ -n "$rest" ]; then exit 9; fi
# Inherit only stderr. Discovery must not wait for this background child.
sleep 4 </dev/null >/dev/null &
"#,
        );
        let helper = LaunchHelper::start(mock_launch_command(&discovery_only), &json!({"ok":true}), Duration::from_secs(5))
            .await
            .unwrap();
        let discovery = timeout(Duration::from_secs(2), helper.finish_discovery())
            .await
            .expect("discovery waited on inherited stderr")
            .unwrap();
        assert_eq!(discovery.extension_paths, vec![PathBuf::from("/ext/a")]);
        assert!(discovery.no_extensions);
        assert_eq!(discovery.memory_write_dir, Some(PathBuf::from("/mem")));

        let full_prepare = write_script(
            tmp.path(),
            "full-prepare.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH {"extensionPaths":[],"noExtensions":false,"memoryWriteDir":null}\n{"toolsExplicitlySelected":true,'
rest=$(cat)
case "$rest" in
  *'"phase":"two"'*) printf '"noTools":false}\n' ;;
  *) exit 8 ;;
esac
"#,
        );
        let helper = LaunchHelper::start(mock_launch_command(&full_prepare), &json!({"phase":"one"}), Duration::from_secs(5))
            .await
            .unwrap();
        let (_deadline, prep) = helper.prepare(br#"{"phase":"two"}"#, Duration::from_secs(5)).await.unwrap();
        assert!(prep.tools_explicitly_selected);
        assert!(!prep.no_tools);

        let refused = write_script(
            tmp.path(),
            "refused.sh",
            r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH_ERROR "custom discovery refusal"\n'
exec sleep 4
"#,
        );
        let err = LaunchHelper::start(mock_launch_command(&refused), &json!({}), Duration::from_secs(5))
            .await
            .err()
            .unwrap();
        assert!(err.to_string().contains("custom discovery refusal"), "{err}");

        let slow = write_script(
            tmp.path(),
            "slow.sh",
            r#"
IFS= read -r _input
sleep 5
"#,
        );
        let err = timeout(
            Duration::from_secs(2),
            LaunchHelper::start(mock_launch_command(&slow), &json!({}), Duration::from_millis(50)),
        )
        .await
        .expect("timeout cleanup waited on a background child")
        .err()
        .unwrap();
        assert!(err.to_string().contains("Native launch discovery timed out"), "{err}");
    }

    #[tokio::test]
    async fn launch_helper_preparation_failure_and_held_stdout_are_bounded() {
        let tmp = tempdir().unwrap();
        for (name, tail, deadline, expected) in [
            ("nonzero", "exit 7", Duration::from_secs(2), "Stock OMP operation failed"),
            ("inherited-stdout", "sleep 4 &", Duration::from_millis(50), "Native session preparation timed out"),
        ] {
            let script = write_script(
                tmp.path(),
                name,
                &format!(
                    r#"
IFS= read -r _input
printf '\nMANAGED_ULW_LAUNCH {{"extensionPaths":[],"noExtensions":true,"memoryWriteDir":null}}\n'
cat >/dev/null
{tail}
"#,
                ),
            );
            let helper = LaunchHelper::start(mock_launch_command(&script), &json!({}), Duration::from_secs(2))
                .await
                .unwrap();
            let error = timeout(Duration::from_secs(2), helper.prepare(b"{}", deadline))
                .await
                .expect("preparation waited on a background child")
                .err()
                .unwrap();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }
}
