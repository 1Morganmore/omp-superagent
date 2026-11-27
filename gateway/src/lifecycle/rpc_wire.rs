use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};

use crate::rpc_chunk::{CHUNK_BYTES, Chunk, MAX_FRAME_BYTES, valid_encoded_length};

pub(super) async fn frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Value> {
    let mut line = Vec::new();
    let first = physical(reader, &mut line).await?;
    if first["type"] != "rpc_chunk" {
        return Ok(first);
    }
    let first: Chunk = serde_json::from_value(first)?;
    ensure!(
        first.index == 0 && first.valid_metadata(),
        "Invalid owned adapter chunk metadata"
    );
    let mut logical = Vec::new();
    append(&mut logical, &first)?;
    for index in 1..first.count {
        let envelope = physical(reader, &mut line).await?;
        ensure!(
            envelope["type"] == "rpc_chunk",
            "Interrupted owned adapter chunk sequence"
        );
        let chunk: Chunk = serde_json::from_value(envelope)?;
        ensure!(
            chunk.chunk_id == first.chunk_id
                && chunk.count == first.count
                && chunk.index == index
                && chunk.byte_length == first.byte_length,
            "Invalid owned adapter chunk sequence"
        );
        append(&mut logical, &chunk)?;
    }
    ensure!(
        logical.len() == first.byte_length,
        "Incomplete owned adapter chunk sequence"
    );
    let frame: Value =
        serde_json::from_slice(&logical).context("Invalid reassembled owned adapter frame")?;
    ensure!(frame.is_object(), "Owned adapter frame is not an object");
    Ok(frame)
}

async fn physical(reader: &mut (impl AsyncBufRead + Unpin), line: &mut Vec<u8>) -> Result<Value> {
    line.clear();
    let limit = u64::try_from(MAX_FRAME_BYTES)? + 1;
    let count = reader.take(limit).read_until(b'\n', line).await?;
    ensure!(
        count > 0,
        "Owned adapter disconnected; request outcome may be unknown"
    );
    ensure!(
        count <= MAX_FRAME_BYTES && line.last() == Some(&b'\n'),
        "Owned adapter frame exceeds size bound"
    );
    let frame: Value = serde_json::from_slice(line)?;
    ensure!(frame.is_object(), "Owned adapter frame is not an object");
    Ok(frame)
}

fn append(logical: &mut Vec<u8>, chunk: &Chunk) -> Result<()> {
    ensure!(
        valid_encoded_length(&chunk.data),
        "Owned adapter chunk exceeds its encoded bound"
    );
    let bytes = STANDARD.decode(&chunk.data)?;
    let total = logical.len().saturating_add(bytes.len());
    ensure!(
        bytes.len() <= CHUNK_BYTES && total <= chunk.byte_length,
        "Owned adapter chunk exceeds its decoded bound"
    );
    logical.extend_from_slice(&bytes);
    Ok(())
}
