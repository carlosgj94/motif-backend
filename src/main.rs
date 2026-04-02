mod auth;
mod auth_api;
mod config;
mod content;
mod embedded_content;
mod error;
mod profile;
mod rate_limit;
mod recommendations;
mod saved_content;
mod source_subscriptions;

use std::{collections::HashSet, net::SocketAddr, time::Duration};

use axum::{
    Router,
    http::{Method, header::ACCEPT, header::AUTHORIZATION, header::CONTENT_TYPE},
    routing::{get, post, put},
};
use sqlx::{
    PgPool,
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
};
use tower_http::cors::CorsLayer;
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

static MIGRATOR: Migrator = sqlx::migrate!();
// This version exists in production's `_sqlx_migrations` history but is not present in git.
const LEGACY_MISSING_MIGRATION_VERSIONS: &[i64] = &[20260320230000];

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
    let cors = build_cors_layer(&config);

    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&config.database_url)
        .await
        .expect("can't connect to database");

    run_database_migrations(&pool)
        .await
        .expect("failed to run database migrations");

    let app = Router::new()
        .route("/", get(profile::health))
        .route("/health", get(profile::health))
        .route("/auth/signup", post(auth_api::sign_up))
        .route("/auth/session", post(auth_api::create_session))
        .route("/auth/session/refresh", post(auth_api::refresh_session))
        .route(
            "/recommendations/topics",
            get(recommendations::list_recommendation_topics),
        )
        .route(
            "/recommendations/sources/preview",
            post(recommendations::preview_source_recommendations),
        )
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
            "/me/content/{content_id}",
            get(recommendations::get_content_detail),
        )
        .route(
            "/me/content/{content_id}/favicon",
            get(saved_content::get_content_favicon),
        )
        .route(
            "/me/recommendations/content",
            get(recommendations::list_content_recommendations),
        )
        .route(
            "/me/recommendations/sources",
            get(recommendations::list_source_recommendations),
        )
        .route(
            "/me/interaction-events/batch",
            post(recommendations::ingest_interaction_events_batch),
        )
        .route(
            "/me/recommendation-preferences",
            get(recommendations::get_recommendation_preferences)
                .put(recommendations::update_recommendation_preferences),
        )
        .route("/me/password", put(auth_api::update_password))
        .route(
            "/me/password/reauthenticate",
            post(auth_api::reauthenticate_password),
        )
        .route(
            "/me/source-subscriptions",
            post(source_subscriptions::create_source_subscription)
                .get(source_subscriptions::list_source_subscriptions),
        )
        .route(
            "/me/source-subscriptions/{subscription_id}",
            axum::routing::delete(source_subscriptions::delete_source_subscription),
        )
        .route("/me/inbox", get(source_subscriptions::list_inbox))
        .route(
            "/me/inbox/{inbox_item_id}",
            get(source_subscriptions::get_inbox_item)
                .patch(source_subscriptions::update_inbox_item),
        )
        .route("/profiles/{username}", get(profile::public_profile))
        .layer(cors)
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

fn build_cors_layer(config: &Config) -> CorsLayer {
    let allowed_origins = config
        .cors_allowed_origins
        .iter()
        .map(|origin| {
            origin
                .parse()
                .unwrap_or_else(|_| panic!("CORS_ALLOWED_ORIGINS contains an invalid origin"))
        })
        .collect::<Vec<_>>();

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, ACCEPT])
}

async fn run_database_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    match MIGRATOR.run(pool).await {
        Ok(()) => Ok(()),
        Err(MigrateError::VersionMissing(version)) => {
            let missing_versions = load_missing_applied_migration_versions(pool).await?;

            if !missing_versions.is_empty()
                && missing_versions
                    .iter()
                    .all(|version| LEGACY_MISSING_MIGRATION_VERSIONS.contains(version))
            {
                tracing::warn!(
                    missing_versions = ?missing_versions,
                    "ignoring legacy database migration versions missing from the bundled migrations"
                );

                let mut migrator = sqlx::migrate!();
                migrator.set_ignore_missing(true);
                migrator.run(pool).await
            } else {
                Err(MigrateError::VersionMissing(version))
            }
        }
        Err(error) => Err(error),
    }
}

async fn load_missing_applied_migration_versions(pool: &PgPool) -> Result<Vec<i64>, MigrateError> {
    let bundled_versions = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .collect::<HashSet<_>>();
    let applied_versions =
        sqlx::query_scalar::<_, i64>("select version from _sqlx_migrations order by version asc")
            .fetch_all(pool)
            .await?;

    Ok(applied_versions
        .into_iter()
        .filter(|version| !bundled_versions.contains(version))
        .collect())
}
