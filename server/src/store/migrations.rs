//! Runs embedded SQLite migrations with enough progress data to diagnose startup failures.
use std::{
    borrow::Cow,
    collections::HashSet,
    future::Future,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use sqlx::{
    migrate::{Migration, Migrator},
    Row, SqlitePool,
};

use crate::{Error, Result};

const MIGRATION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const MIGRATION_STAGE_TIMEOUT: Duration = Duration::from_secs(30);

static ALL_MIGRATIONS: Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MigrationLineEndings {
    Lf,
    Crlf,
}

impl MigrationLineEndings {
    fn label(self) -> &'static str {
        match self {
            Self::Lf => "lf",
            Self::Crlf => "crlf",
        }
    }
}

#[derive(Debug)]
struct AppliedMigration {
    version: i64,
    description: String,
    success: bool,
    checksum: Vec<u8>,
    execution_time_ns: i64,
}

fn migrator_with_line_endings(line_endings: MigrationLineEndings) -> Migrator {
    let migrations = ALL_MIGRATIONS
        .iter()
        .map(|migration| {
            let lf_sql = migration.sql.replace("\r\n", "\n");
            let sql = match line_endings {
                MigrationLineEndings::Lf => lf_sql,
                MigrationLineEndings::Crlf => lf_sql.replace('\n', "\r\n"),
            };
            Migration::new(
                migration.version,
                migration.description.clone(),
                migration.migration_type,
                Cow::Owned(sql),
                migration.no_tx,
            )
        })
        .collect::<Vec<_>>();
    Migrator {
        migrations: Cow::Owned(migrations),
        ..Migrator::DEFAULT
    }
}

fn history_matches(migrator: &Migrator, applied: &[AppliedMigration]) -> bool {
    applied.iter().all(|applied| {
        applied.success
            && migrator.iter().any(|known| {
                known.version == applied.version && known.checksum.as_ref() == applied.checksum
            })
    })
}

fn select_migrator(applied: &[AppliedMigration]) -> (Migrator, MigrationLineEndings) {
    let lf = migrator_with_line_endings(MigrationLineEndings::Lf);
    if history_matches(&lf, applied) {
        return (lf, MigrationLineEndings::Lf);
    }

    let crlf = migrator_with_line_endings(MigrationLineEndings::Crlf);
    if history_matches(&crlf, applied) {
        return (crlf, MigrationLineEndings::Crlf);
    }

    // Preserve SQLx's exact validation error for dirty, unknown, or genuinely modified history.
    (lf, MigrationLineEndings::Lf)
}

pub(super) async fn run(pool: &SqlitePool, database_path: &Path) -> Result<()> {
    tracing::info!("running database migrations with diagnostics");
    log_database_files(database_path);
    log_sqlite_state(pool).await?;

    let applied = load_applied_migrations(pool).await?;
    let (migrator, line_endings) = select_migrator(&applied);
    tracing::info!(
        line_endings = line_endings.label(),
        "selected database migration line endings"
    );
    let known_versions = migrator
        .iter()
        .map(|migration| migration.version)
        .collect::<HashSet<_>>();
    let applied_versions = applied
        .iter()
        .map(|migration| migration.version)
        .collect::<HashSet<_>>();
    let known = migrator
        .iter()
        .map(|migration| format!("{:04} {}", migration.version, migration.description))
        .collect::<Vec<_>>();
    let pending = migrator
        .iter()
        .filter(|migration| !applied_versions.contains(&migration.version))
        .map(|migration| format!("{:04} {}", migration.version, migration.description))
        .collect::<Vec<_>>();

    tracing::info!(known = ?known, "embedded database migrations");
    if applied.is_empty() {
        tracing::info!("no applied database migrations were found");
    } else {
        for migration in &applied {
            tracing::info!(
                version = migration.version,
                description = %migration.description,
                success = migration.success,
                execution_time_ns = migration.execution_time_ns,
                checksum_bytes = migration.checksum.len(),
                "applied database migration"
            );
        }
    }
    tracing::info!(pending = ?pending, pending_count = pending.len(), "pending database migrations");

    let invalid_history = applied.iter().any(|applied| {
        let Some(known) = migrator
            .iter()
            .find(|migration| migration.version == applied.version)
        else {
            return true;
        };
        !applied.success || known.checksum.as_ref() != applied.checksum
    }) || applied
        .iter()
        .any(|migration| !known_versions.contains(&migration.version));

    if invalid_history {
        tracing::error!(
            "database migration history is dirty, unknown, or has a checksum mismatch; running SQLx validation for the exact error"
        );
        return run_stage("migration history validation", migrator.run(pool)).await;
    }

    for (index, migration) in migrator.iter().enumerate() {
        if applied_versions.contains(&migration.version) {
            continue;
        }

        let stage = format!("{:04} {}", migration.version, migration.description);
        let prefix = Migrator {
            migrations: Cow::Owned(migrator.iter().take(index + 1).cloned().collect()),
            ignore_missing: true,
            ..Migrator::DEFAULT
        };
        run_stage(&stage, prefix.run(pool)).await?;
        log_database_files(database_path);
        log_sqlite_state(pool).await?;
    }

    run_stage("final migration history validation", migrator.run(pool)).await?;
    tracing::info!("database migrations completed");
    Ok(())
}

async fn run_stage<F>(stage: &str, future: F) -> Result<()>
where
    F: Future<Output = std::result::Result<(), sqlx::migrate::MigrateError>>,
{
    run_stage_with_limits(
        stage,
        MIGRATION_HEARTBEAT_INTERVAL,
        MIGRATION_STAGE_TIMEOUT,
        future,
    )
    .await
}

async fn run_stage_with_limits<F>(
    stage: &str,
    heartbeat_interval: Duration,
    stage_timeout: Duration,
    future: F,
) -> Result<()>
where
    F: Future<Output = std::result::Result<(), sqlx::migrate::MigrateError>>,
{
    let started = Instant::now();
    let mut heartbeat = tokio::time::interval(heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let deadline = tokio::time::sleep(stage_timeout);
    tokio::pin!(deadline);
    tokio::pin!(future);

    tracing::info!(
        stage,
        timeout_seconds = stage_timeout.as_secs_f64(),
        "database migration stage started"
    );
    loop {
        tokio::select! {
            result = &mut future => {
                let elapsed_ms = started.elapsed().as_millis();
                return match result {
                    Ok(()) => {
                        tracing::info!(stage, elapsed_ms, "database migration stage completed");
                        Ok(())
                    }
                    Err(error) => {
                        tracing::error!(stage, elapsed_ms, %error, "database migration stage failed");
                        Err(error.into())
                    }
                };
            }
            _ = heartbeat.tick() => {
                tracing::warn!(
                    stage,
                    elapsed_ms = started.elapsed().as_millis(),
                    "database migration stage is still running; the database may be locked by another process"
                );
            }
            _ = &mut deadline => {
                let elapsed_seconds = started.elapsed().as_secs();
                tracing::error!(stage, elapsed_seconds, "database migration stage timed out");
                return Err(Error::MigrationTimeout {
                    stage: stage.to_owned(),
                    timeout_seconds: stage_timeout.as_secs(),
                });
            }
        }
    }
}

async fn load_applied_migrations(pool: &SqlitePool) -> Result<Vec<AppliedMigration>> {
    tracing::info!("reading database migration history");
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = '_sqlx_migrations'
         )",
    )
    .fetch_one(pool)
    .await?;
    if table_exists == 0 {
        tracing::info!("database migration history table does not exist");
        return Ok(Vec::new());
    }

    let rows = sqlx::query(
        "SELECT version, description, success, checksum, execution_time
         FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await?;
    tracing::info!(row_count = rows.len(), "database migration history loaded");
    rows.into_iter()
        .map(|row| {
            Ok(AppliedMigration {
                version: row.try_get("version")?,
                description: row.try_get("description")?,
                success: row.try_get("success")?,
                checksum: row.try_get("checksum")?,
                execution_time_ns: row.try_get("execution_time")?,
            })
        })
        .collect::<std::result::Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

async fn log_sqlite_state(pool: &SqlitePool) -> Result<()> {
    tracing::info!(
        pool_size = pool.size(),
        pool_idle = pool.num_idle(),
        "reading SQLite runtime state"
    );
    let sqlite_version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(pool)
        .await?;
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    let locking_mode: String = sqlx::query_scalar("PRAGMA locking_mode")
        .fetch_one(pool)
        .await?;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    let busy_timeout_ms: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(pool)
        .await?;
    let schema_version: i64 = sqlx::query_scalar("PRAGMA schema_version")
        .fetch_one(pool)
        .await?;
    let user_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(pool)
        .await?;
    let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await?;
    let freelist_count: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await?;

    tracing::info!(
        %sqlite_version,
        %journal_mode,
        %locking_mode,
        foreign_keys,
        busy_timeout_ms,
        schema_version,
        user_version,
        page_size,
        page_count,
        freelist_count,
        "SQLite runtime state"
    );
    Ok(())
}

fn log_database_files(database_path: &Path) {
    tracing::info!(
        database_path = %database_path.display(),
        process_id = std::process::id(),
        "SQLite database files"
    );
    log_file("database", database_path);
    log_file("wal", &sidecar_path(database_path, "-wal"));
    log_file("shm", &sidecar_path(database_path, "-shm"));
    log_file("journal", &sidecar_path(database_path, "-journal"));
}

fn log_file(kind: &str, path: &Path) {
    match std::fs::metadata(path) {
        Ok(metadata) => tracing::info!(
            kind,
            path = %path.display(),
            exists = true,
            size_bytes = metadata.len(),
            readonly = metadata.permissions().readonly(),
            "SQLite file state"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => tracing::info!(
            kind,
            path = %path.display(),
            exists = false,
            "SQLite file state"
        ),
        Err(error) => {
            tracing::warn!(kind, path = %path.display(), %error, "failed to read SQLite file state")
        }
    }
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    #[test]
    fn normalized_checksums_match_the_published_lf_and_windows_crlf_migrations() {
        let lf = migrator_with_line_endings(MigrationLineEndings::Lf);
        let crlf = migrator_with_line_endings(MigrationLineEndings::Crlf);
        let lf_initial = lf.iter().find(|migration| migration.version == 1).unwrap();
        let crlf_initial = crlf
            .iter()
            .find(|migration| migration.version == 1)
            .unwrap();

        assert_eq!(
            hex::encode(lf_initial.checksum.as_ref()),
            "ddf1bc573e460bfd93ea50b60d003e8fc6bb9a1b32de71139cb0fc0d898e88c401c08c8a8b57abbe68f55927e7f004d9"
        );
        assert_eq!(
            hex::encode(crlf_initial.checksum.as_ref()),
            "7c5995693dbd5f9d50880fc874784cb67c499762abcee4a562b54c9afd8239bae125074696b78f90aca0fc136b802a2b"
        );
    }

    #[tokio::test]
    async fn lf_and_crlf_migration_histories_upgrade_without_rewriting_checksums() {
        for line_endings in [MigrationLineEndings::Lf, MigrationLineEndings::Crlf] {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            let historical = migrator_with_line_endings(line_endings);
            let first_four = Migrator {
                migrations: Cow::Owned(historical.iter().take(4).cloned().collect()),
                ..Migrator::DEFAULT
            };
            first_four.run(&pool).await.unwrap();
            let checksum_before: Vec<u8> =
                sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();

            run(&pool, Path::new("line-ending-compatibility.db"))
                .await
                .unwrap();

            let checksum_after: Vec<u8> =
                sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let versions: Vec<i64> =
                sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let checkpoint_table_exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'conversation_checkpoints'
                 )",
            )
            .fetch_one(&pool)
            .await
            .unwrap();

            let argument_error_column_exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('tool_round_calls')
                    WHERE name = 'argument_error'
                 )",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let pricing_catalog_exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'pricing_catalog_models'
                 )",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let cost_status_column_exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('llm_calls')
                    WHERE name = 'cost_status'
                 )",
            )
            .fetch_one(&pool)
            .await
            .unwrap();

            assert_eq!(checksum_after, checksum_before);
            assert_eq!(versions, historical.iter().map(|migration| migration.version).collect::<Vec<_>>());
            assert_eq!(checkpoint_table_exists, 1);
            assert_eq!(argument_error_column_exists, 1);
            assert_eq!(pricing_catalog_exists, 1);
            assert_eq!(cost_status_column_exists, 1);
        }
    }

    #[tokio::test]
    async fn migration_0010_preserves_calls_and_drops_legacy_global_pricing() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let first_nine = Migrator {
            migrations: Cow::Owned(historical.iter().take(9).cloned().collect()),
            ..Migrator::DEFAULT
        };
        first_nine.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms)
             VALUES ('token_pricing', '{\"input_per_million\":5.0}', 100)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, input_tokens, output_tokens,
                message_count, tool_count, detailed
            ) VALUES (
                'legacy-call', 'run', 'conv', 0, NULL,
                'openai-responses', 'https://api.openai.com/v1/responses',
                'openai-responses', 'https://api.openai.com/v1/responses',
                'gpt-5', 'Legacy GPT-5', 'completed', 100, 1000, 200,
                1, 0, 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        run(&pool, Path::new("upgrade-v9-to-v10.db")).await.unwrap();

        let legacy_setting_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM service_settings WHERE setting_key = 'token_pricing')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(legacy_setting_exists, 0);

        let total_cost_nano: Option<i64> = sqlx::query_scalar(
            "SELECT total_cost_nano FROM llm_calls WHERE call_id = 'legacy-call'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(total_cost_nano, None);
    }

    /// History written before the timing columns existed must keep unknown
    /// timing, so old calls report an unavailable rate instead of a guessed one.
    #[tokio::test]
    async fn migration_0011_keeps_historical_calls_with_unknown_timing() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let first_ten = Migrator {
            migrations: Cow::Owned(historical.iter().take(10).cloned().collect()),
            ..Migrator::DEFAULT
        };
        first_ten.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, input_tokens, output_tokens,
                message_count, tool_count, detailed
            ) VALUES (
                'timed-before-upgrade', 'run', 'conv', 0, NULL,
                'openai-chat', 'https://api.openai.com/v1/chat/completions',
                'openai-chat', 'https://api.openai.com/v1/chat/completions',
                'gpt-5', 'Legacy GPT-5', 'completed', 100, 1000, 200,
                1, 0, 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        run(&pool, Path::new("upgrade-v10-to-v11.db"))
            .await
            .unwrap();

        let (origin, streaming, ttfo, generation, observed_thinking): (
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            i64,
        ) = sqlx::query_as(
            "SELECT call_origin, streaming, ttfo_ms, generation_ms, observed_thinking
             FROM llm_calls WHERE call_id = 'timed-before-upgrade'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(origin, "run");
        assert_eq!(streaming, None);
        assert_eq!(ttfo, None);
        assert_eq!(generation, None);
        assert_eq!(observed_thinking, 0);
    }

    #[test]
    fn sqlite_sidecar_paths_preserve_the_database_path() {
        let database = Path::new(r"C:\Users\Test User\cursor-byok.db");
        assert_eq!(
            sidecar_path(database, "-wal"),
            PathBuf::from(r"C:\Users\Test User\cursor-byok.db-wal")
        );
    }

    #[tokio::test]
    async fn generation_event_migration_preserves_usage_without_trusting_old_speed() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let previous = Migrator {
            migrations: Cow::Owned(historical.iter().take(12).cloned().collect()),
            ..Migrator::DEFAULT
        };
        previous.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO llm_calls(call_id, run_id, conversation_id, provider_call_index, provider_type, provider_url, request_type, request_url, model_id, display_name, status, created_at_ms, output_tokens, message_count, tool_count, detailed, streaming, ttfo_ms, generation_ms) VALUES ('legacy-speed', 'run', 'conv', 0, 'openai-chat', 'https://example.com', 'openai-chat', 'https://example.com', 'test', 'Test', 'completed', 100, 200, 1, 0, 0, 1, 100, 1000)").execute(&pool).await.unwrap();
        run(&pool, Path::new("generation-events.db")).await.unwrap();
        let store = crate::store::Store {
            pool: pool.clone(),
            writes: Default::default(),
        };
        let call = store.llm_call("legacy-speed").await.unwrap().unwrap();
        assert_eq!(call.output_tokens, Some(200));
        assert_eq!(call.generation_ms, Some(1_000));
        assert_eq!(call.generation_output_events, None);
        assert_eq!(call.performance.tokens_per_second, None);
        assert_eq!(
            call.performance.reason,
            Some(crate::model::SpeedUnavailableReason::InsufficientOutputEvents)
        );
        assert!(sqlx::query(
            "UPDATE llm_calls SET generation_output_events = -1 WHERE call_id = 'legacy-speed'"
        )
        .execute(&pool)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn stalled_migration_stage_returns_a_timeout_error() {
        let result = run_stage_with_limits(
            "0006 rename revisions to checkpoints",
            Duration::from_millis(2),
            Duration::from_millis(10),
            std::future::pending(),
        )
        .await;

        assert!(matches!(
            result,
            Err(Error::MigrationTimeout { stage, .. })
                if stage == "0006 rename revisions to checkpoints"
        ));
    }

    #[tokio::test]
    async fn migration_0012_splits_providers_and_preserves_models() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let first_eleven = Migrator {
            migrations: Cow::Owned(historical.iter().take(11).cloned().collect()),
            ..Migrator::DEFAULT
        };
        first_eleven.run(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO model_configs(
                model_hash, sort_order, display_name, group_name, model_type, base_url,
                use_full_url, api_key, tooltip_data, model_id, reasoning_effort,
                openai_endpoint, openai_extra_params_enabled, openai_extra_params_json,
                custom_headers_enabled, custom_headers_json,
                anthropic_extra_params_enabled, anthropic_extra_params_json,
                context_window_tokens, max_completion_tokens, anthropic_max_tokens,
                anthropic_thinking_effort, thinking_budget_tokens, created_at_ms, updated_at_ms
             ) VALUES
             (
                'hash-oai-1', 1, 'GPT-5', 'My OpenAI', 'openai', 'https://api.openai.com/v1',
                0, 'sk-oai', 'OpenAI flagship', 'gpt-5', 'high',
                '/v1/responses', 1, '{\"seed\":42}',
                0, '{}', 0, '{}',
                400000, 16384, NULL, NULL, NULL, 100, 150
             ),
             (
                'hash-oai-2', 2, 'GPT-5 Mini', NULL, 'openai', 'https://api.openai.com/v1',
                0, 'sk-oai', 'OpenAI mini', 'gpt-5-mini', 'medium',
                '/v1/responses', 1, '{\"seed\":42}',
                0, '{}', 0, '{}',
                200000, 8192, NULL, NULL, NULL, 120, 200
             ),
             (
                'hash-ant-1', 3, 'Claude 4', NULL, 'anthropic', 'https://api.anthropic.com:8443/v1',
                0, 'sk-ant', 'Anthropic model', 'claude-4', NULL,
                '', 0, '{}',
                1, '{\"x-test\":\"1\"}', 1, '{\"top_k\":5}',
                200000, NULL, 32768, 'high', 4096, 130, 180
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, message_count, tool_count, detailed
             ) VALUES
             (
                'call-oai-1', 'run-1', 'conv-1', 1, 'hash-oai-1',
                'openai-responses', 'https://api.openai.com/v1', 'responses',
                'https://api.openai.com/v1/responses', 'gpt-5', 'GPT-5',
                'completed', 200, 1, 0, 1
             ),
             (
                'call-ant-1', 'run-2', 'conv-2', 1, 'hash-ant-1',
                'anthropic', 'https://api.anthropic.com:8443/v1', 'messages',
                'https://api.anthropic.com:8443/v1/messages', 'claude-4', 'Claude 4',
                'completed', 210, 1, 0, 0
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_requests(call_id, headers_json, body_json, byte_count)
             VALUES ('call-oai-1', '{}', '{}', 2)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_response_chunks(call_id, seq, received_offset_ms, data, byte_count)
             VALUES ('call-oai-1', 1, 10, X'6162', 2)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let first_twelve = Migrator {
            migrations: Cow::Owned(historical.iter().take(12).cloned().collect()),
            ..Migrator::DEFAULT
        };
        first_twelve.run(&pool).await.unwrap();

        let fk_violations: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(fk_violations.is_empty());

        let providers: Vec<(String, String, String, i64, String)> = sqlx::query_as(
            "SELECT provider_id, name, model_type, extra_params_enabled, extra_params_json
             FROM provider_configs ORDER BY sort_order, provider_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            providers,
            vec![
                (
                    "hash-oai-1".into(),
                    "My OpenAI".into(),
                    "openai".into(),
                    1,
                    "{\"seed\":42}".into(),
                ),
                (
                    "hash-ant-1".into(),
                    "api.anthropic.com".into(),
                    "anthropic".into(),
                    1,
                    "{\"top_k\":5}".into(),
                ),
            ]
        );

        let models: Vec<(String, String, Option<i64>, Option<String>)> = sqlx::query_as(
            "SELECT model_hash, provider_id, max_output_tokens, anthropic_thinking_effort
             FROM model_configs ORDER BY sort_order",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            models,
            vec![
                ("hash-oai-1".into(), "hash-oai-1".into(), Some(16384), None),
                ("hash-oai-2".into(), "hash-oai-1".into(), Some(8192), None),
                (
                    "hash-ant-1".into(),
                    "hash-ant-1".into(),
                    Some(32768),
                    Some("high".into())
                ),
            ]
        );

        let call_hashes: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT call_id, model_hash FROM llm_calls ORDER BY created_at_ms")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            call_hashes,
            vec![
                ("call-oai-1".into(), Some("hash-oai-1".into())),
                ("call-ant-1".into(), Some("hash-ant-1".into())),
            ]
        );
    }

    #[tokio::test]
    async fn migration_0015_moves_request_settings_without_changing_existing_calls()
    {
        use crate::model::{resolve_request_url, RequestFormat};

        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(SqliteConnectOptions::from_str("sqlite::memory:").unwrap().foreign_keys(true)).await.unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let before = Migrator {
            migrations: Cow::Owned(historical.iter().take(14).cloned().collect()),
            ..Migrator::DEFAULT
        };
        before.run(&pool).await.unwrap();
        sqlx::raw_sql(r#"
            INSERT INTO provider_configs(provider_id, name, model_type, base_url, use_full_url, api_key, openai_endpoint, extra_params_enabled, extra_params_json, created_at_ms, updated_at_ms) VALUES
                ('chat', 'Chat', 'openai', 'https://example.com/prefix/v2', 0, 'test-key', '/v1/chat/completions', 0, '{"temperature":0.5}', 1, 2),
                ('responses', 'Responses', 'openai', 'https://example.com/relay/v2/responses?route=1', 1, 'test-key', '/v1/responses', 1, '{"top_p":0.8}', 1, 2),
                ('anthropic', 'Anthropic', 'anthropic', 'https://example.com:8443/custom?route=2', 1, 'test-key', '', 0, '{}', 1, 2);
            INSERT INTO model_configs(model_hash, provider_id, sort_order, display_name, tooltip_data, model_id, created_at_ms, updated_at_ms)
            SELECT provider_id || '-hash', provider_id, 7, name, name, provider_id || '-upstream', 3, 4 FROM provider_configs;
            INSERT INTO llm_calls(call_id, run_id, conversation_id, provider_call_index, model_hash, provider_type, provider_url, request_type, request_url, model_id, display_name, status, created_at_ms, message_count, tool_count, detailed)
            VALUES ('original-call', 'run', 'conversation', 0, 'responses-hash', 'openai-responses', 'https://example.com/relay/v2/responses?route=1', 'openai-responses', 'https://example.com/relay/v2/responses?route=1', 'responses-upstream', 'Responses', 'completed', 3, 1, 0, 0);
        "#).execute(&pool).await.unwrap();

        run(&pool, Path::new("upgrade-v14-to-v15.db")).await.unwrap();
        for (id, expected_format, expected_base, expected_url, expected_extra_enabled, expected_extra) in [
            ("chat", RequestFormat::OpenAiChat, "https://example.com/prefix/v2", "https://example.com/prefix/v2/chat/completions", false, r#"{"temperature":0.5}"#),
            ("responses", RequestFormat::OpenAiResponses, "https://example.com/relay/v2", "https://example.com/relay/v2/responses?route=1", true, r#"{"top_p":0.8}"#),
            ("anthropic", RequestFormat::Anthropic, "https://example.com:8443", "https://example.com:8443/custom?route=2", false, "{}"),
        ]
        {
            let row = sqlx::query("SELECT m.model_hash, m.sort_order, m.request_format, m.request_url_override, m.extra_params_enabled, m.extra_params_json, p.base_url FROM model_configs m JOIN provider_configs p ON p.provider_id = m.provider_id WHERE p.provider_id = ?").bind(id).fetch_one(&pool).await.unwrap();
            let format = RequestFormat::from_str(row.get::<&str, _>("request_format")).unwrap();
            let base = row.get::<&str, _>("base_url");
            let override_url = row.get::<Option<&str>, _>("request_url_override");
            assert_eq!(row.get::<&str, _>("model_hash"), format!("{id}-hash"));
            assert_eq!(row.get::<i64, _>("sort_order"), 7);
            assert_eq!(format, expected_format);
            assert_eq!(base, expected_base);
            assert_eq!(override_url, (id != "chat").then_some(expected_url));
            assert_eq!(resolve_request_url(format, base, override_url, "upstream").unwrap(), expected_url);
            assert_eq!(row.get::<bool, _>("extra_params_enabled"), expected_extra_enabled);
            assert_eq!(row.get::<&str, _>("extra_params_json"), expected_extra);
        }
        let model_hash: String = sqlx::query_scalar("SELECT model_hash FROM llm_calls WHERE call_id = 'original-call'").fetch_one(&pool).await.unwrap();
        assert_eq!(model_hash, "responses-hash");
        assert!(sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn migration_0004_with_referenced_calls_upgrades_through_0012() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let first_four = Migrator {
            migrations: Cow::Owned(historical.iter().take(4).cloned().collect()),
            ..Migrator::DEFAULT
        };
        first_four.run(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO model_configs(
                model_hash, sort_order, display_name, model_type, base_url,
                use_full_url, api_key, tooltip_data, model_id, reasoning_effort,
                openai_endpoint, openai_extra_params_enabled, openai_extra_params_json,
                custom_headers_enabled, custom_headers_json,
                anthropic_extra_params_enabled, anthropic_extra_params_json,
                context_window_tokens, max_completion_tokens, anthropic_max_tokens,
                anthropic_thinking_effort, thinking_budget_tokens, created_at_ms, updated_at_ms
             ) VALUES (
                'hash-v4-1', 1, 'GPT-4.1', 'openai', 'https://api.openai.com/v1',
                0, 'sk-oai', 'OpenAI v4', 'gpt-4.1', 'medium',
                '/v1/responses', 0, '{}', 0, '{}', 0, '{}',
                200000, 16384, NULL, NULL, NULL, 100, 150
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, message_count, tool_count, detailed
             ) VALUES (
                'call-v4-1', 'run-v4', 'conv-v4', 1, 'hash-v4-1',
                'openai-responses', 'https://api.openai.com/v1', 'responses',
                'https://api.openai.com/v1/responses', 'gpt-4.1', 'GPT-4.1',
                'completed', 200, 1, 0, 1
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_requests(call_id, headers_json, body_json, byte_count)
             VALUES ('call-v4-1', '{}', '{}', 2)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO llm_call_response_chunks(call_id, seq, received_offset_ms, data, byte_count)
             VALUES ('call-v4-1', 1, 10, X'6162', 2)",
        )
        .execute(&pool)
        .await
        .unwrap();

        run(&pool, Path::new("upgrade-v4-to-v12.db")).await.unwrap();

        let fk_violations: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(fk_violations.is_empty());

        let preserved: (String, Option<String>) =
            sqlx::query_as("SELECT call_id, model_hash FROM llm_calls WHERE call_id = 'call-v4-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(preserved, ("call-v4-1".into(), Some("hash-v4-1".into())));

        let model_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM model_configs WHERE model_hash = 'hash-v4-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(model_count, 1);
    }

    #[tokio::test]
    async fn migration_0014_backfills_omitted_cache_priced_calls_using_frozen_rates() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("upgrade-v13-to-v14.db");
        let db_url = format!("sqlite://{}", db_path.display());
        let connect_options = SqliteConnectOptions::from_str(&db_url)
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(connect_options)
            .await
            .unwrap();
        let historical = migrator_with_line_endings(MigrationLineEndings::Lf);
        let previous = Migrator {
            migrations: Cow::Owned(historical.iter().take(13).cloned().collect()),
            ..Migrator::DEFAULT
        };
        previous.run(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, finished_at_ms, duration_ms, call_origin,
                input_tokens, output_tokens, total_tokens,
                cache_read_tokens, cache_write_tokens,
                pricing_source, pricing_snapshot_at_ms,
                unit_input_per_million, unit_output_per_million,
                unit_cache_read_per_million, unit_cache_write_per_million,
                cost_status, input_cost_nano, output_cost_nano, cache_read_cost_nano, cache_write_cost_nano, total_cost_nano,
                cost_calculated_at_ms, cost_backfilled,
                message_count, tool_count, detailed
            ) VALUES (
                'v13-reported', 'r1', 'c1', 0, 'mh-1',
                'openai-chat', 'https://gateway.example/v1', 'openai-chat', 'https://gateway.example/v1/chat/completions', 'gpt-5', 'GPT-5',
                'completed', 1000, 1100, 100, 'run',
                1000000, 100000, 1100000,
                200000, 0,
                'custom', 1000,
                '1.5', '7.5', '0.075', '0.375',
                'priced', 1200000000, 750000000, 15000000, 0, 1965000000,
                1100, 0,
                1, 0, 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO llm_calls(
                call_id, run_id, conversation_id, provider_call_index, model_hash,
                provider_type, provider_url, request_type, request_url, model_id, display_name,
                status, created_at_ms, finished_at_ms, duration_ms, call_origin,
                input_tokens, output_tokens, total_tokens,
                cache_read_tokens, cache_write_tokens,
                pricing_source, pricing_snapshot_at_ms,
                unit_input_per_million, unit_output_per_million,
                unit_cache_read_per_million, unit_cache_write_per_million,
                cost_status, input_cost_nano, output_cost_nano, cache_read_cost_nano, cache_write_cost_nano, total_cost_nano,
                cost_calculated_at_ms, cost_backfilled,
                message_count, tool_count, detailed
            ) VALUES (
                'v13-omitted', 'r2', 'c2', 0, 'mh-2',
                'anthropic', 'https://gateway.example/v1', 'anthropic', 'https://gateway.example/v1/messages', 'gemini-2.5-pro', 'Gemini-2.5-Pro',
                'completed', 2000, 2100, 100, 'run',
                1000000, 100000, 1100000,
                NULL, NULL,
                'custom', 1000,
                '1.5', '7.5', '0.075', '0.375',
                'priced', 1500000000, 750000000, 0, 0, 2250000000,
                2100, 0,
                1, 0, 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let store = crate::store::Store::connect(&db_url).await.unwrap();
        let reported = store.llm_call("v13-reported").await.unwrap().unwrap();
        assert_eq!(reported.cost_basis.as_deref(), Some("reported"));
        assert_eq!(reported.assumed_cache_hit_rate_bps, None);
        assert_eq!(reported.estimated_cache_read_tokens, None);
        assert_eq!(reported.total_cost.as_deref(), Some("1.965"));

        let before_backfill = store.llm_call("v13-omitted").await.unwrap().unwrap();
        assert_eq!(before_backfill.cost_basis, None);

        let token = tokio_util::sync::CancellationToken::new();
        let updated = crate::pricing::backfill::run_backfill_once(&store, &token)
            .await
            .unwrap();
        assert_eq!(updated, 1);

        let after_backfill = store.llm_call("v13-omitted").await.unwrap().unwrap();
        assert_eq!(after_backfill.cost_basis.as_deref(), Some("assumed_cache"));
        assert_eq!(after_backfill.assumed_cache_hit_rate_bps, Some(9_000));
        assert_eq!(after_backfill.estimated_cache_read_tokens, Some(900_000));
        assert_eq!(after_backfill.cache_read_tokens, None);
        assert_eq!(after_backfill.cache_write_tokens, None);
        assert_eq!(after_backfill.billed_input_tokens, Some(100_000));
        assert_eq!(
            after_backfill.unit_input_per_million.as_deref(),
            Some("1.5")
        );
        assert_eq!(after_backfill.input_cost.as_deref(), Some("0.15"));
        assert_eq!(after_backfill.cache_read_cost.as_deref(), Some("0.0675"));
        assert_eq!(after_backfill.output_cost.as_deref(), Some("0.75"));
        assert_eq!(after_backfill.total_cost.as_deref(), Some("0.9675"));
        assert!(!after_backfill.cost_backfilled);

        let second_pass = crate::pricing::backfill::run_backfill_once(&store, &token)
            .await
            .unwrap();
        assert_eq!(second_pass, 0);
    }
}
