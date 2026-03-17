mod auth;
mod auth_api;
mod config;
mod content;
mod error;
mod profile;
mod rate_limit;
mod saved_content;

use std::{net::SocketAddr, time::Duration};

use axum::{
    Router,
    routing::{get, post, put},
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::{
    auth::SupabaseAuth, auth_api::SupabaseAuthApi, config::Config, rate_limit::AuthRateLimiter,
};

#[derive(Clone)]
pub struct AppState {
    auth: SupabaseAuth,
    auth_api: SupabaseAuthApi,
    auth_rate_limiter: AuthRateLimiter,
    pool: PgPool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("{}=debug", env!("CARGO_CRATE_NAME")).into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env().unwrap_or_else(|error| panic!("{error}"));

    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&config.database_url)
        .await
        .expect("can't connect to database");

    sqlx::migrate!()
        .run(&pool)
        .await
        .expect("failed to run database migrations");

    let app = Router::new()
        .route("/", get(profile::health))
        .route("/health", get(profile::health))
        .route("/auth/signup", post(auth_api::sign_up))
        .route("/auth/session", post(auth_api::create_session))
        .route("/me", get(profile::me))
        .route("/me/profile", put(profile::upsert_my_profile))
        .route(
            "/me/saved-content",
            post(saved_content::save_saved_content).get(saved_content::list_saved_content),
        )
        .route(
            "/me/saved-content/{saved_content_id}",
            get(saved_content::get_saved_content)
                .patch(saved_content::update_saved_content)
                .delete(saved_content::delete_saved_content),
        )
        .route("/me/tags", get(saved_content::list_content_tags))
        .route(
            "/me/content/{content_id}/favicon",
            get(saved_content::get_content_favicon),
        )
        .route("/profiles/{username}", get(profile::public_profile))
        .with_state(AppState {
            auth: SupabaseAuth::new(config.supabase.clone()),
            auth_api: SupabaseAuthApi::new(&config.supabase),
            auth_rate_limiter: AuthRateLimiter::default(),
            pool,
        });

    let listener = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .expect("failed to bind server listener");

    tracing::info!("listening on {}", listener.local_addr().unwrap());

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server exited unexpectedly");
}
