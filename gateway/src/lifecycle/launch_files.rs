use std::{
    fs::{self, DirBuilder, Metadata},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::store::Store;

use super::fs::metadata;

const PREPARING_HEAD: &str = "gateway:preparing-head";

#[derive(Deserialize, Serialize)]
struct DirectoryIdentity {
    dev: u64,
    ino: u64,
}

impl DirectoryIdentity {
    fn read(stat: &Metadata) -> Result<Self> {
        ensure!(Self::is_private(stat), "HEAD launch directory is not private and owned");
        Ok(Self {
            dev: stat.dev(),
            ino: stat.ino(),
        })
    }

    fn is_private(stat: &Metadata) -> bool {
        stat.is_dir() && stat.uid() == nix::unistd::getuid().as_raw() && stat.mode() & 0o777 == 0o700
    }

    fn matches(&self, stat: &Metadata) -> bool {
        Self::is_private(stat) && self.dev == stat.dev() && self.ino == stat.ino()
    }
}

#[derive(Deserialize, Serialize)]
struct PreparationReceipt {
    id: String,
    parent: DirectoryIdentity,
    directory: DirectoryIdentity,
}

impl PreparationReceipt {
    fn path(&self, run: &Path) -> Result<PathBuf> {
        ensure!(Uuid::parse_str(&self.id).is_ok(), "Invalid HEAD launch receipt identity");
        Ok(run.join(format!(".launch-{}", self.id)))
    }

    fn remove(&self, directory: &Path) -> Result<()> {
        let Some(stat) = metadata(directory)? else { return Ok(()) };
        ensure!(
            directory.parent().map(metadata).transpose()?.flatten()
                .is_some_and(|parent| self.parent.matches(&parent))
                && self.directory.matches(&stat),
            "HEAD preparation directory no longer matches its private receipt; left untouched"
        );
        fs::remove_dir_all(directory)?;
        Ok(())
    }
}

pub(super) struct LaunchFiles {
    directory: PathBuf,
    receipt: PreparationReceipt,
    pub(super) owned_by_child: bool,
}

impl LaunchFiles {
    pub(super) fn create(store: &Store) -> Result<Self> {
        Self::recover_preparation(store)?;
        let run = store.state_dir().join("run");
        let parent = DirectoryIdentity::read(&fs::symlink_metadata(&run)?)?;
        let id = Uuid::new_v4().to_string();
        let directory = run.join(format!(".launch-{id}"));
        DirBuilder::new().mode(0o700).create(&directory)?;
        let receipt = PreparationReceipt {
            id,
            parent,
            directory: DirectoryIdentity::read(&fs::symlink_metadata(&directory)?)?,
        };
        let files = Self { directory, receipt, owned_by_child: false };
        // No helper is given this path until its exact identity is durable.
        store.set_meta(PREPARING_HEAD, &serde_json::to_string(&files.receipt)?)?;
        Ok(files)
    }

    pub(super) fn path(&self) -> &Path {
        &self.directory
    }

    pub(super) fn seal(store: &Store) -> Result<()> {
        // The owner may survive the Gateway. Its complete manifest must no
        // longer be eligible for crash cleanup before a spawn can be attempted.
        store.set_meta(PREPARING_HEAD, "")
    }

    pub(super) fn recover_preparation(store: &Store) -> Result<()> {
        // Store owns the instance lifetime lock, and the live supervisor
        // serializes preparation. A recorded path has never been given to a
        // pipe owner. No filename scan can supply that proof.
        let Some(saved) = store.get_meta(PREPARING_HEAD)?.filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let receipt: PreparationReceipt = serde_json::from_str(&saved)?;
        let directory = receipt.path(&store.state_dir().join("run"))?;
        receipt.remove(&directory)?;
        Self::seal(store)
    }

    pub(super) fn cleanup(&self) {
        if let Err(error) = self.receipt.remove(&self.directory) {
            eprintln!("HEAD launch directory cleanup failed: {error}");
        }
    }
}

impl Drop for LaunchFiles {
    fn drop(&mut self) {
        if !self.owned_by_child {
            self.cleanup();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn new_lifetime_owner_removes_only_the_abandoned_preparation() -> Result<()> {
        let root = tempfile::tempdir()?;
        let run = root.path().join("run");
        super::super::fs::private_directory(&run)?;
        let unverified = run.join(format!(".launch-{}", Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&unverified)?;

        let store = Store::open(root.path())?;
        let live = LaunchFiles::create(&store)?;
        fs::write(live.path().join("owner.json"), "{}")?;
        LaunchFiles::seal(&store)?;
        let live_path = live.path().to_owned();
        std::mem::forget(live);
        let incomplete = LaunchFiles::create(&store)?;
        fs::write(incomplete.path().join("config.json"), "{}")?;
        let incomplete_path = incomplete.path().to_owned();
        std::mem::forget(incomplete); // Simulate a process exit without Drop.
        drop(store);

        let successor = Store::open(root.path())?;
        LaunchFiles::recover_preparation(&successor)?;
        assert!(!incomplete_path.exists());
        assert!(unverified.is_dir());
        assert!(live_path.join("owner.json").is_file());
        Ok(())
    }

    #[test]
    fn prepared_directory_recovery_leaves_a_replacement_symlink_untouched() -> Result<()> {
        let root = tempfile::tempdir()?;
        let run = root.path().join("run");
        super::super::fs::private_directory(&run)?;
        let store = Store::open(root.path())?;
        let files = LaunchFiles::create(&store)?;
        let path = files.path().to_owned();
        std::mem::forget(files);
        let moved = run.join("moved");
        fs::rename(&path, &moved)?;
        symlink(&moved, &path)?;
        drop(store);

        let successor = Store::open(root.path())?;
        assert!(LaunchFiles::recover_preparation(&successor).is_err());
        assert!(fs::symlink_metadata(path)?.is_symlink());
        assert!(moved.is_dir());
        Ok(())
    }
}
