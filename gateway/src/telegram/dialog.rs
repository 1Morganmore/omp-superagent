use serde::Deserialize;
use serde_json::Value;

use crate::native_dialog::{
    Answer, Marker, distinct, markable_count, present, valid_choices, valid_select,
};
use crate::store::js_trim;

#[derive(Deserialize)]
pub(super) struct Question {
    pub id: String,
    pub question: String,
    #[serde(default, deserialize_with = "present")]
    pub header: Option<String>,
    pub options: Vec<Choice>,
    #[serde(default)]
    pub multi: bool,
    #[serde(default, deserialize_with = "present")]
    pub recommended: Option<usize>,
}

#[derive(Deserialize)]
pub(super) struct Choice {
    pub label: String,
    #[serde(default, deserialize_with = "present")]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub preview: Option<String>,
}

impl Question {
    pub(super) fn matches_answer(&self, answer: &Answer) -> bool {
        let has_custom = answer
            .custom_input
            .as_deref()
            .is_some_and(|value| !js_trim(value).is_empty());
        self.id == answer.id
            && distinct(answer.selected_options.iter().map(String::as_str))
            && answer
                .selected_options
                .iter()
                .all(|label| self.options.iter().any(|choice| &choice.label == label))
            && (self.multi
                || matches!(
                    (answer.selected_options.len(), has_custom),
                    (1, false) | (0, true)
                ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Selection {
    pub title: String,
    pub options: Vec<String>,
    #[serde(default, deserialize_with = "present")]
    pub selection_marker: Option<Marker>,
    pub markable_count: Option<usize>,
    pub checked_indices: Option<Vec<usize>>,
    #[serde(default, deserialize_with = "present")]
    pub initial_index: Option<usize>,
    #[serde(default)]
    pub option_details: Vec<Detail>,
}

#[derive(Deserialize)]
pub(super) struct Detail {
    #[serde(default, deserialize_with = "present")]
    pub description: Option<String>,
}

impl Selection {
    pub fn markable_count(&self) -> usize {
        markable_count(
            self.markable_count,
            self.selection_marker.as_ref(),
            self.options.len(),
        )
    }
}

#[derive(Deserialize)]
pub(super) struct TextQuestion {
    pub title: String,
    #[serde(default, deserialize_with = "present")]
    pub placeholder: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub prefill: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "lowercase")]
pub(super) enum Dialog {
    Confirm { title: String, message: String },
    Select(Selection),
    Input(TextQuestion),
    Editor(TextQuestion),
    Ask { questions: Vec<Question> },
}

impl Dialog {
    pub fn parse(request: &Value) -> Option<Self> {
        if request.get("secret").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let dialog = Self::deserialize(request).ok()?;
        let supported = match &dialog {
            Self::Select(select) => valid_select(
                &select.options,
                select.markable_count(),
                select.checked_indices.as_deref().unwrap_or_default(),
                select.initial_index,
            ),
            Self::Ask { questions } => {
                !questions.is_empty()
                    && distinct(questions.iter().map(|question| question.id.as_str()))
                    && questions.iter().all(|question| {
                        valid_choices(
                            question.options.iter().map(|choice| choice.label.as_str()),
                            question.recommended,
                        )
                    })
            }
            Self::Confirm { .. } | Self::Input(_) | Self::Editor(_) => true,
        };
        supported.then_some(dialog)
    }
}
