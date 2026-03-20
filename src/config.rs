use std::{env, net::SocketAddr, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub db_max_connections: u32,
    pub supabase: SupabaseConfig,
}

#[derive(Clone, Debug)]
pub struct SupabaseConfig {
    pub url: String,
    pub issuer: String,
    pub jwks_url: String,
    pub audience: String,
    pub jwks_cache_ttl: Duration,
    pub publishable_key: Option<String>,
    pub service_role_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        dotenvy::dotenv().ok();

        let bind_addr = env::var("APP_BIND_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
            .parse::<SocketAddr>()
            .map_err(|_| ConfigError::invalid("APP_BIND_ADDR", "must be a valid socket address"))?;

        let database_url =
            env::var("DATABASE_URL").map_err(|_| ConfigError::missing("DATABASE_URL"))?;

        let db_max_connections = env::var("DB_MAX_CONNECTIONS")
            .ok()
            .map(|value| {
                value.parse::<u32>().map_err(|_| {
                    ConfigError::invalid("DB_MAX_CONNECTIONS", "must be a positive integer")
                })
            })
            .transpose()?
            .unwrap_or(10);

        let supabase_url =
            env::var("SUPABASE_URL").map_err(|_| ConfigError::missing("SUPABASE_URL"))?;
        let supabase_url = supabase_url.trim_end_matches('/').to_string();

        let publishable_key = env::var("SUPABASE_PUBLISHABLE_KEY")
            .ok()
            .or_else(|| env::var("SUPABASE_ANON_KEY").ok());
        let service_role_key = env::var("SUPABASE_SERVICE_ROLE_KEY").ok();

        let issuer =
            env::var("SUPABASE_JWT_ISSUER").unwrap_or_else(|_| format!("{supabase_url}/auth/v1"));
        let issuer = issuer.trim_end_matches('/').to_string();

        let jwks_url = env::var("SUPABASE_JWKS_URL")
            .unwrap_or_else(|_| format!("{issuer}/.well-known/jwks.json"));

        let audience =
            env::var("SUPABASE_JWT_AUDIENCE").unwrap_or_else(|_| "authenticated".to_string());

        let jwks_cache_ttl = env::var("SUPABASE_JWKS_CACHE_TTL_SECONDS")
            .ok()
            .map(|value| {
                value.parse::<u64>().map_err(|_| {
                    ConfigError::invalid(
                        "SUPABASE_JWKS_CACHE_TTL_SECONDS",
                        "must be a positive integer",
                    )
                })
            })
            .transpose()?
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(300));

        Ok(Self {
            bind_addr,
            database_url,
            db_max_connections,
            supabase: SupabaseConfig {
                url: supabase_url,
                issuer,
                jwks_url,
                audience,
                jwks_cache_ttl,
                publishable_key,
                service_role_key,
            },
        })
    }
}

#[derive(Debug, Clone)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn missing(field: &str) -> Self {
        Self {
            message: format!("{field} must be set"),
        }
    }

    fn invalid(field: &str, message: &str) -> Self {
        Self {
            message: format!("{field} {message}"),
        }
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}
