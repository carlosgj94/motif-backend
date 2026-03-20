use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::http::StatusCode;

use crate::{error::ApiError, error::ApiResult};

const SIGN_UP_IP_LIMIT: usize = 5;
const SIGN_UP_EMAIL_LIMIT: usize = 3;
const SIGN_UP_WINDOW: Duration = Duration::from_secs(15 * 60);

const SESSION_IP_LIMIT: usize = 20;
const SESSION_EMAIL_LIMIT: usize = 10;
const SESSION_WINDOW: Duration = Duration::from_secs(10 * 60);

const CLEANUP_INTERVAL: u64 = 128;
const RATE_LIMIT_MESSAGE: &str = "Too many authentication attempts, please try again later";

#[derive(Clone, Default)]
pub struct AuthRateLimiter {
    inner: Arc<Mutex<LimiterState>>,
}

impl AuthRateLimiter {
    pub fn check_sign_up(&self, ip: IpAddr, email: &str) -> ApiResult<()> {
        self.check(AuthRoute::SignUp, ip, email, Instant::now())
    }

    pub fn check_session(&self, ip: IpAddr, email: &str) -> ApiResult<()> {
        self.check(AuthRoute::Session, ip, email, Instant::now())
    }

    pub fn check_session_refresh(&self, ip: IpAddr, refresh_token: &str) -> ApiResult<()> {
        self.check(AuthRoute::SessionRefresh, ip, refresh_token, Instant::now())
    }

    fn check(&self, route: AuthRoute, ip: IpAddr, email: &str, now: Instant) -> ApiResult<()> {
        let mut state = self
            .inner
            .lock()
            .expect("auth rate limiter mutex should not be poisoned");
        state.access_count += 1;
        if state.access_count.is_multiple_of(CLEANUP_INTERVAL) {
            cleanup_buckets(&mut state.ip_buckets, now);
            cleanup_buckets(&mut state.email_buckets, now);
        }

        let limits = route.limits();
        let ip_key = RateLimitKey::new(route, ip.to_string());
        let email_key = RateLimitKey::new(route, email.to_string());

        let ip_count = bucket_len(&mut state.ip_buckets, &ip_key, now);
        let email_count = bucket_len(&mut state.email_buckets, &email_key, now);

        if ip_count >= limits.ip_limit || email_count >= limits.email_limit {
            return Err(ApiError::with_status(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                RATE_LIMIT_MESSAGE,
            ));
        }

        record_attempt(&mut state.ip_buckets, ip_key, now);
        record_attempt(&mut state.email_buckets, email_key, now);
        Ok(())
    }
}

#[derive(Default)]
struct LimiterState {
    ip_buckets: HashMap<RateLimitKey, VecDeque<Instant>>,
    email_buckets: HashMap<RateLimitKey, VecDeque<Instant>>,
    access_count: u64,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum AuthRoute {
    SignUp,
    Session,
    SessionRefresh,
}

impl AuthRoute {
    const fn limits(self) -> RateLimitRule {
        match self {
            Self::SignUp => RateLimitRule {
                ip_limit: SIGN_UP_IP_LIMIT,
                email_limit: SIGN_UP_EMAIL_LIMIT,
                window: SIGN_UP_WINDOW,
            },
            Self::Session => RateLimitRule {
                ip_limit: SESSION_IP_LIMIT,
                email_limit: SESSION_EMAIL_LIMIT,
                window: SESSION_WINDOW,
            },
            Self::SessionRefresh => RateLimitRule {
                ip_limit: SESSION_IP_LIMIT,
                email_limit: SESSION_EMAIL_LIMIT,
                window: SESSION_WINDOW,
            },
        }
    }
}

#[derive(Clone, Copy)]
struct RateLimitRule {
    ip_limit: usize,
    email_limit: usize,
    window: Duration,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct RateLimitKey {
    route: AuthRoute,
    value: String,
}

impl RateLimitKey {
    fn new(route: AuthRoute, value: String) -> Self {
        Self { route, value }
    }
}

fn bucket_len(
    buckets: &mut HashMap<RateLimitKey, VecDeque<Instant>>,
    key: &RateLimitKey,
    now: Instant,
) -> usize {
    let Some(bucket) = buckets.get_mut(key) else {
        return 0;
    };

    prune_bucket(bucket, key.route.limits().window, now);
    bucket.len()
}

fn record_attempt(
    buckets: &mut HashMap<RateLimitKey, VecDeque<Instant>>,
    key: RateLimitKey,
    now: Instant,
) {
    let bucket = buckets.entry(key).or_default();
    bucket.push_back(now);
}

fn cleanup_buckets(buckets: &mut HashMap<RateLimitKey, VecDeque<Instant>>, now: Instant) {
    buckets.retain(|key, bucket| {
        prune_bucket(bucket, key.route.limits().window, now);
        !bucket.is_empty()
    });
}

fn prune_bucket(bucket: &mut VecDeque<Instant>, window: Duration, now: Instant) {
    while bucket
        .front()
        .is_some_and(|timestamp| now.duration_since(*timestamp) >= window)
    {
        bucket.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthRateLimiter, AuthRoute};
    use std::{net::IpAddr, str::FromStr, time::Duration};

    fn loopback_ip() -> IpAddr {
        IpAddr::from_str("127.0.0.1").unwrap()
    }

    #[test]
    fn sign_up_rate_limits_per_email() {
        let limiter = AuthRateLimiter::default();
        let email = "user@example.com";
        let now = std::time::Instant::now();

        for second in 0..3 {
            limiter
                .check(
                    AuthRoute::SignUp,
                    loopback_ip(),
                    email,
                    now + Duration::from_secs(second),
                )
                .expect("request should pass");
        }

        assert!(
            limiter
                .check(
                    AuthRoute::SignUp,
                    loopback_ip(),
                    email,
                    now + Duration::from_secs(4)
                )
                .is_err()
        );
    }

    #[test]
    fn session_rate_limits_per_ip() {
        let limiter = AuthRateLimiter::default();
        let now = std::time::Instant::now();

        for second in 0..20 {
            limiter
                .check(
                    AuthRoute::Session,
                    loopback_ip(),
                    &format!("user{second}@example.com"),
                    now + Duration::from_secs(second),
                )
                .expect("request should pass");
        }

        assert!(
            limiter
                .check(
                    AuthRoute::Session,
                    loopback_ip(),
                    "another@example.com",
                    now + Duration::from_secs(21),
                )
                .is_err()
        );
    }

    #[test]
    fn expires_old_buckets_after_window() {
        let limiter = AuthRateLimiter::default();
        let email = "user@example.com";
        let now = std::time::Instant::now();

        for second in 0..3 {
            limiter
                .check(
                    AuthRoute::SignUp,
                    loopback_ip(),
                    email,
                    now + Duration::from_secs(second),
                )
                .expect("request should pass");
        }

        limiter
            .check(
                AuthRoute::SignUp,
                loopback_ip(),
                email,
                now + Duration::from_secs(15 * 60 + 1),
            )
            .expect("window should have reset");
    }
}
