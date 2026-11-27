//! Stock v2 chunk envelope shared by the owner codec and its Gateway client.
use serde::Deserialize;

/// Stock output limit, including the newline.
pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// Stock v2 limit on the logical JSON, before base64 encoding.
pub(crate) const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const CHUNK_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chunk {
    pub(crate) chunk_id: String,
    pub(crate) count: usize,
    pub(crate) index: usize,
    pub(crate) byte_length: usize,
    pub(crate) data: String,
}

impl Chunk {
    pub(crate) fn valid_metadata(&self) -> bool {
        (1..=128).contains(&self.chunk_id.encode_utf16().count())
            && (2..=MAX_REASSEMBLED_BYTES / CHUNK_BYTES).contains(&self.count)
            && self.index < self.count
            && (MAX_FRAME_BYTES..=MAX_REASSEMBLED_BYTES).contains(&self.byte_length)
            && self.byte_length <= self.count * CHUNK_BYTES
    }
}

pub(crate) fn valid_encoded_length(data: &str) -> bool {
    !data.is_empty() && data.len() <= CHUNK_BYTES.div_ceil(3) * 4
}
