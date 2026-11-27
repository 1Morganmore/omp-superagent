use std::{collections::HashSet, hash::Hash};

use serde::{Deserialize, Deserializer, Serialize};

// On fields using this decoder, an absent value may be omitted, but an
// explicitly present value must satisfy the field's underlying type.
pub(crate) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Marker {
    Radio,
    Checkbox,
}

pub(crate) const fn markable_count(
    explicit: Option<usize>,
    marker: Option<&Marker>,
    options: usize,
) -> usize {
    match explicit {
        Some(count) => count,
        None if marker.is_some() => options,
        None => 0,
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Answer {
    pub(crate) id: String,
    pub(crate) selected_options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) custom_input: Option<String>,
}

pub(crate) fn distinct<T: Eq + Hash>(mut values: impl Iterator<Item = T>) -> bool {
    let mut seen = HashSet::new();
    values.all(|value| seen.insert(value))
}

fn valid_labels<'a>(mut labels: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = HashSet::new();
    labels.all(|label| !label.is_empty() && seen.insert(label))
}

pub(crate) fn valid_choices<'a>(
    labels: impl ExactSizeIterator<Item = &'a str>,
    recommended: Option<usize>,
) -> bool {
    recommended.is_none_or(|index| index < labels.len()) && valid_labels(labels)
}

pub(crate) fn valid_select(
    options: &[String],
    markable: usize,
    checked: &[usize],
    initial: Option<usize>,
) -> bool {
    !options.is_empty()
        && valid_labels(options.iter().map(String::as_str))
        && markable <= options.len()
        && checked.iter().all(|&index| index < markable)
        && distinct(checked.iter())
        && initial.is_none_or(|index| index < options.len())
}
