use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderValue};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout_at};
#[cfg(test)]
use tokio_util::task::TaskTracker;

use super::{Effect, EffectError, model::Interaction, snowflake};

const API: &str = "https://discord.com/api/v10";
pub(super) const FILE_LIMIT: usize = 8 * 1024 * 1024;

pub(super) fn broken(message: &str) -> EffectError {
    EffectError::uncertain(message)
}

pub(super) fn no_mentions() -> Value {
    json!({ "parse": [], "replied_user": false })
}

pub(super) struct Rest {
    pub client: Client,
    pub(super) api: String,
    token: String,
    authorization: HeaderValue,
    #[cfg(test)]
    detached: TaskTracker,
}

#[derive(Default, Deserialize)]
struct Failure {
    code: Option<u64>,
    retry_after: Option<f64>,
}

pub(super) enum Lookup<T> {
    Found(T),
    Missing,
}

impl Rest {
    pub fn new(client: Client, token: String) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !token.trim().is_empty(),
            "Configured Discord credential is empty"
        );
        let mut authorization = HeaderValue::from_str(&format!("Bot {token}"))
            .map_err(|_| anyhow::anyhow!("Invalid Discord credential"))?;
        authorization.set_sensitive(true);
        Ok(Self {
            client,
            api: API.to_owned(),
            token,
            authorization,
            #[cfg(test)]
            detached: TaskTracker::new(),
        })
    }

    /// Runs a one-shot write whose latency or rejection must not change the
    /// result the caller already confirmed.
    pub(super) fn detach<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        #[cfg(test)]
        let _ = self.detached.spawn(task);
        #[cfg(not(test))]
        let _ = tokio::spawn(task);
    }

    #[cfg(test)]
    pub(super) async fn settled(&self) {
        self.detached.close();
        self.detached.wait().await;
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}/{path}", self.api))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(Duration::from_secs(15))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Effect<T> {
        Self::response(self.request(Method::GET, path)).await
    }

    pub async fn lookup<T: DeserializeOwned>(&self, path: &str) -> Effect<Lookup<T>> {
        Self::lookup_response(send(self.request(Method::GET, path)).await?, &[10003, 10008]).await
    }

    /// A history destination is gone only on Discord's Unknown Channel code.
    pub async fn history_lookup<T: DeserializeOwned>(&self, path: &str) -> Effect<Option<T>> {
        match Self::lookup_response(send(self.request(Method::GET, path)).await?, &[10003]).await? {
            Lookup::Found(value) => Ok(Some(value)),
            Lookup::Missing => Ok(None),
        }
    }

    /// Read-only intake retries an unproved read even when a request failed
    /// before it was sent. Only Discord's explicit absence/access errors are
    /// terminal evidence; a rate limit or transport error is not denial.
    pub async fn evidence<T: DeserializeOwned>(&self, path: &str) -> Effect<Option<T>> {
        let response = send(self.request(Method::GET, path)).await?;
        if response.status() == StatusCode::FORBIDDEN {
            let failure = response.json::<Failure>().await
                .map_err(|_| broken("Discord lookup authority could not be verified"))?;
            if matches!(failure.code, Some(50001 | 50013)) {
                return Ok(None);
            }
            return Err(broken("Discord lookup authority could not be verified"));
        }
        match Self::lookup_response(response, &[10003, 10008]).await? {
            Lookup::Found(value) => Ok(Some(value)),
            Lookup::Missing => Ok(None),
        }
    }

    async fn lookup_response<T: DeserializeOwned>(
        response: reqwest::Response,
        missing_codes: &[u64],
    ) -> Effect<Lookup<T>> {
        if response.status() == StatusCode::NOT_FOUND {
            let failure = response
                .json::<Failure>()
                .await
                .map_err(|_| broken("Discord lookup outcome is unknown"))?;
            if failure.code.is_some_and(|code| missing_codes.contains(&code)) {
                return Ok(Lookup::Missing);
            }
            return Err(EffectError::rejected("Discord lookup was rejected (404)"));
        }
        decode(check(response, None).await?)
            .await
            .map(Lookup::Found)
    }

    pub async fn response<T: DeserializeOwned>(request: RequestBuilder) -> Effect<T> {
        decode(check(send(request).await?, None).await?).await
    }

    pub async fn response_before<T: DeserializeOwned>(
        request: RequestBuilder,
        deadline: Instant,
    ) -> Effect<T> {
        let expired = || broken("Discord output deadline expired awaiting a message receipt");
        let response = timeout_at(deadline, send(request))
            .await
            .map_err(|_| expired())??;
        let response = check(response, Some(deadline)).await?;
        timeout_at(deadline, decode(response))
            .await
            .map_err(|_| expired())?
    }

    pub async fn empty(request: RequestBuilder) -> Effect<()> {
        check(send(request).await?, None).await.map(|_| ())
    }

    pub async fn callback(&self, interaction: &Interaction, body: Value) -> Effect<()> {
        // The URL is a per-interaction credential; never put it in diagnostics.
        if !snowflake(&interaction.id)
            || interaction.token.is_empty()
            || interaction.token.len() > 512
            || !interaction
                .token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        {
            return Err(EffectError::rejected("Invalid Discord interaction receipt"));
        }
        Self::empty(
            self.client
                .post(format!(
                    "{}/interactions/{}/{}/callback",
                    self.api, interaction.id, interaction.token
                ))
                .timeout(Duration::from_secs(3))
                .json(&body),
        )
        .await
    }

    pub async fn ephemeral(&self, interaction: &Interaction, text: &str) -> Effect<()> {
        self.callback(interaction, json!({
            "type": 4, "data": { "content": text, "flags": 64, "allowed_mentions": no_mentions() }
        })).await
    }
}

async fn send(request: RequestBuilder) -> Effect<reqwest::Response> {
    request.send().await.map_err(|error| {
        if error.is_builder() || error.is_connect() {
            EffectError::rejected("Discord REST request could not be sent")
        } else {
            broken("Discord REST transport outcome is uncertain")
        }
    })
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Effect<T> {
    response
        .json()
        .await
        .map_err(|_| broken("Discord REST response could not be verified"))
}

async fn check(
    response: reqwest::Response,
    deadline: Option<Instant>,
) -> Effect<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status.is_client_error() && status != StatusCode::REQUEST_TIMEOUT {
        let retry = status == StatusCode::TOO_MANY_REQUESTS;
        let header = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<f64>().ok());
        let mut error = EffectError::rejected(format!(
            "Discord REST request rejected ({})",
            status.as_u16()
        ));
        if retry {
            // The status already confirms rejection. Only the optional retry
            // delay depends on the body; expiry cannot undo that certainty.
            let retry_delay = async {
                response
                    .json::<Failure>()
                    .await
                    .map_or(header, |value| value.retry_after.or(header))
            };
            let delay = match deadline {
                Some(deadline) => timeout_at(deadline, retry_delay).await.unwrap_or(header),
                None => retry_delay.await,
            };
            error.retry_after_ms = delay
                .and_then(|secs| Duration::try_from_secs_f64(secs).ok())
                .and_then(|duration| u64::try_from(duration.as_millis()).ok());
        }
        return Err(error);
    }
    Err(EffectError::uncertain(format!(
        "Discord REST outcome is uncertain ({})",
        status.as_u16()
    )))
}

#[cfg(test)]
mod tests {
    use axum::{Router, body::Body, response::IntoResponse};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn rate_limit_remains_rejected_when_its_body_misses_the_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(|| async {
            let body = Body::from_stream(futures_util::stream::pending::<
                Result<&'static str, std::io::Error>,
            >());
            (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "2")], body).into_response()
        });
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let response = send(Client::new().post(url).timeout(Duration::from_secs(5)))
            .await
            .unwrap();
        tokio::time::pause();
        let error = tokio::time::timeout(
            Duration::from_secs(1),
            check(response, Some(Instant::now())),
        )
        .await
        .expect("the optional body cannot hold the rejected receipt past its deadline")
        .unwrap_err();
        assert_eq!(error.certainty, "rejected");
        assert_eq!(error.retry_after_ms, Some(2_000));
        server.abort();
    }
}
