use std::{
    fs, io,
    os::unix::fs::{FileTypeExt, MetadataExt, symlink},
};

use anyhow::Result;
use serde_json::{Value, json};
use tokio::net::UnixStream;

use super::StagedSocket;
use crate::{server::tests::SocketDir, store::Store};

#[tokio::test]
async fn gateway_socket_binds_privately_before_its_recorded_publication() -> Result<()> {
    let root = SocketDir::new()?;
    let store = Store::open(&root.0)?;
    let path = root.0.join("gateway.sock");
    let staged = StagedSocket::bind(&path)?;
    assert_eq!(
        fs::symlink_metadata(&path).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );

    let (_listener, identity) = staged.publish(&store)?;
    let entry = fs::symlink_metadata(&path)?;
    assert!(entry.file_type().is_socket());
    assert_eq!(entry.mode() & 0o777, 0o600);
    assert_eq!(entry.uid(), nix::unistd::geteuid().as_raw());
    let recorded: Value = serde_json::from_str(&store.get_meta("gateway:socket")?.unwrap())?;
    assert_eq!(
        recorded,
        json!({"pid": std::process::id(), "dev": entry.dev(), "ino": entry.ino()})
    );
    let _peer = UnixStream::connect(&path).await?;
    identity.unlink()?;
    Ok(())
}

#[tokio::test]
async fn gateway_socket_publication_refuses_an_endpoint_created_during_startup() -> Result<()> {
    let root = SocketDir::new()?;
    let store = Store::open(&root.0)?;
    let path = root.0.join("gateway.sock");
    let staged = StagedSocket::bind(&path)?;
    symlink("other.sock", &path)?;
    store.set_meta("gateway:socket", "existing owner record")?;

    assert!(staged.publish(&store).is_err());
    assert_eq!(fs::read_link(&path)?.as_os_str(), "other.sock");
    assert_eq!(
        store.get_meta("gateway:socket")?.as_deref(),
        Some("existing owner record")
    );
    Ok(())
}
