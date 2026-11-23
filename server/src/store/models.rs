//! Persists provider and model configuration.
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};

use sqlx::{Row, Sqlite, Transaction};

use crate::{
    model::{
        generate_provider_id, model_hash, normalize_model_input, normalize_provider_input,
        ModelConfig, ModelConfigInput, RequestFormat, ProviderConfig, ProviderConfigInput,
    },
    Error, Result,
};

use super::{now_ms, Store};

const PROVIDER_COLUMNS: &str = r#"
    provider_id, sort_order, name, base_url, api_key,
    custom_headers_enabled, custom_headers_json, created_at_ms, updated_at_ms
"#;

const MODEL_JOIN_COLUMNS: &str = r#"
    m.model_hash, m.provider_id, p.name AS provider_name, m.sort_order, m.display_name,
    m.request_format, m.request_url_override, p.base_url, p.api_key, p.custom_headers_enabled, p.custom_headers_json,
    m.extra_params_enabled, m.extra_params_json, m.tooltip_data, m.model_id, m.reasoning_effort, m.context_window_tokens,
    m.max_output_tokens, m.anthropic_thinking_effort, m.thinking_budget_tokens,
    m.created_at_ms, m.updated_at_ms
"#;

impl Store {
    pub async fn providers(&self) -> Result<Vec<ProviderConfig>> {
        let query = format!(
            "SELECT {PROVIDER_COLUMNS} FROM provider_configs ORDER BY sort_order, name, provider_id"
        );
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(provider_from_row)
            .collect()
    }

    pub async fn provider(&self, provider_id: &str) -> Result<Option<ProviderConfig>> {
        let query =
            format!("SELECT {PROVIDER_COLUMNS} FROM provider_configs WHERE provider_id = ?");
        sqlx::query(&query)
            .bind(provider_id)
            .fetch_optional(&self.pool)
            .await?
            .map(provider_from_row)
            .transpose()
    }

    pub async fn create_provider(&self, input: &ProviderConfigInput) -> Result<ProviderConfig> {
        let mut input = normalize_provider_input(input)?;
        let provider_id = generate_provider_id();
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        if input.sort_order <= 0 {
            input.sort_order = next_provider_sort_order(&mut transaction).await?;
        }
        insert_provider_with_conflict(&mut transaction, &provider_id, &input, now, false).await?;
        transaction.commit().await?;
        Ok(self
            .provider(&provider_id)
            .await?
            .expect("inserted provider must exist"))
    }

    pub async fn update_provider(
        &self,
        provider_id: &str,
        input: &ProviderConfigInput,
    ) -> Result<ProviderConfig> {
        let mut input = normalize_provider_input(input)?;
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let existing_sort_order: Option<i64> =
            sqlx::query_scalar("SELECT sort_order FROM provider_configs WHERE provider_id = ?")
                .bind(provider_id)
                .fetch_optional(&mut *transaction)
                .await?;
        let existing_sort_order = existing_sort_order
            .ok_or_else(|| Error::RunNotFound(format!("provider {provider_id}")))?;
        if input.sort_order <= 0 {
            input.sort_order = existing_sort_order;
        }
        let result = sqlx::query(
            r#"UPDATE provider_configs SET
                sort_order = ?, name = ?, base_url = ?, api_key = ?,
                custom_headers_enabled = ?, custom_headers_json = ?,
                updated_at_ms = ?
            WHERE provider_id = ?"#,
        )
        .bind(input.sort_order)
        .bind(&input.name)
        .bind(&input.base_url)
        .bind(&input.api_key)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(now)
        .bind(provider_id)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("provider {provider_id}")));
        }
        transaction.commit().await?;
        Ok(self
            .provider(provider_id)
            .await?
            .expect("updated provider must exist"))
    }

    pub async fn delete_provider(&self, provider_id: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE llm_calls SET model_hash = NULL
             WHERE model_hash IN (SELECT model_hash FROM model_configs WHERE provider_id = ?)",
        )
        .bind(provider_id)
        .execute(&mut *transaction)
        .await?;
        let result = sqlx::query("DELETE FROM provider_configs WHERE provider_id = ?")
            .bind(provider_id)
            .execute(&mut *transaction)
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("provider {provider_id}")));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn models(&self) -> Result<Vec<ModelConfig>> {
        let query = format!(
            "SELECT {MODEL_JOIN_COLUMNS}
             FROM model_configs AS m
             INNER JOIN provider_configs AS p ON p.provider_id = m.provider_id
             ORDER BY p.sort_order, p.name, p.provider_id, m.sort_order, m.display_name, m.model_hash"
        );
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(model_from_row)
            .collect()
    }

    pub async fn model(&self, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!(
            "SELECT {MODEL_JOIN_COLUMNS}
             FROM model_configs AS m
             INNER JOIN provider_configs AS p ON p.provider_id = m.provider_id
             WHERE m.model_hash = ?"
        );
        sqlx::query(&query)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn create_model(&self, input: &ModelConfigInput) -> Result<ModelConfig> {
        let mut models = self.create_models(std::slice::from_ref(input)).await?;
        Ok(models.remove(0))
    }

    pub async fn create_models(&self, inputs: &[ModelConfigInput]) -> Result<Vec<ModelConfig>> {
        if inputs.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let mut checked_providers = HashSet::new();
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            if checked_providers.insert(input.provider_id.clone())
            {
                ensure_provider_exists(&mut transaction, &input.provider_id).await?;
            }
            let hash = model_hash(&input)?;
            if !hashes.insert(hash.clone()) {
                return Err(Error::Config("model configurations must be unique".into()));
            }
            normalized.push((hash, input));
        }
        let mut next_sort_orders = HashMap::new();
        for (hash, input) in &mut normalized {
            if input.sort_order <= 0 {
                let next = match next_sort_orders.entry(input.provider_id.clone()) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let initial =
                            next_model_sort_order(&mut transaction, &input.provider_id).await?;
                        entry.insert(initial)
                    }
                };
                input.sort_order = *next;
                *next += 1;
            } else if let Some(next) = next_sort_orders.get_mut(&input.provider_id) {
                *next = (*next).max(input.sort_order + 1);
            }
            insert_model(&mut transaction, hash, input, now).await?;
        }
        transaction.commit().await?;

        let mut saved = Vec::with_capacity(normalized.len());
        for (hash, _) in normalized {
            saved.push(self.model(&hash).await?.expect("inserted model must exist"));
        }
        Ok(saved)
    }

    pub async fn update_model(
        &self,
        current_hash: &str,
        input: &ModelConfigInput,
    ) -> Result<ModelConfig> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let current = model_in_tx(&mut transaction, current_hash)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("model {current_hash}")))?;
        let mut input = normalize_model_input(input)?;
        if input.provider_id != current.provider_id
        {
            ensure_provider_exists(&mut transaction, &input.provider_id).await?;
        }
        if input.sort_order <= 0 {
            input.sort_order = if input.provider_id == current.provider_id {
                current.sort_order
            } else {
                next_model_sort_order(&mut transaction, &input.provider_id).await?
            };
        }
        let identity_unchanged = current.provider_id == input.provider_id
            && current.model_id == input.model_id
            && current.display_name == input.display_name;
        let next_hash = if identity_unchanged {
            current.model_hash.clone()
        } else {
            model_hash(&input)?
        };
        if next_hash != current.model_hash {
            sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
                .bind(&current.model_hash)
                .execute(&mut *transaction)
                .await?;
        }
        let result = sqlx::query(
            r#"UPDATE model_configs SET
                model_hash = ?, provider_id = ?, sort_order = ?, display_name = ?,
                tooltip_data = ?, model_id = ?, reasoning_effort = ?,
                context_window_tokens = ?, max_output_tokens = ?,
                anthropic_thinking_effort = ?, thinking_budget_tokens = ?, request_format = ?,
                request_url_override = ?, extra_params_enabled = ?, extra_params_json = ?, updated_at_ms = ?
            WHERE model_hash = ?"#,
        )
        .bind(&next_hash)
        .bind(&input.provider_id)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_output_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(input.request_format.as_str())
        .bind(&input.request_url_override)
        .bind(input.extra_params_enabled)
        .bind(serde_json::to_string(&input.extra_params)?)
        .bind(now)
        .bind(current_hash)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {current_hash}")));
        }
        transaction.commit().await?;
        Ok(self
            .model(&next_hash)
            .await?
            .expect("updated model must exist"))
    }

    pub async fn delete_model(&self, hash: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("UPDATE llm_calls SET model_hash = NULL WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        let result = sqlx::query("DELETE FROM model_configs WHERE model_hash = ?")
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        if result.rows_affected() != 1 {
            return Err(Error::RunNotFound(format!("model {hash}")));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn reorder_providers(&self, provider_ids: &[String]) -> Result<Vec<ProviderConfig>> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let current_ids: Vec<String> =
            sqlx::query_scalar("SELECT provider_id FROM provider_configs")
                .fetch_all(&mut *transaction)
                .await?;
        validate_permutation(
            &current_ids,
            provider_ids,
            "provider configuration changed; refresh and try sorting again",
        )?;

        for (index, provider_id) in provider_ids.iter().enumerate() {
            sqlx::query(
                "UPDATE provider_configs SET sort_order = ?, updated_at_ms = ? WHERE provider_id = ?",
            )
            .bind(i64::try_from(index + 1).expect("provider order fits in i64"))
            .bind(now)
            .bind(provider_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.providers().await
    }

    pub async fn reorder_models(
        &self,
        provider_id: &str,
        model_hashes: &[String],
    ) -> Result<Vec<ModelConfig>> {
        let now = now_ms();
        let _write = self.writes.lock().await;
        let mut transaction = self.pool.begin().await?;
        let provider_exists: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM provider_configs WHERE provider_id = ?)",
        )
        .bind(provider_id)
        .fetch_one(&mut *transaction)
        .await?;
        if provider_exists == 0 {
            return Err(Error::RunNotFound(format!("provider {provider_id}")));
        }

        let current_hashes: Vec<String> =
            sqlx::query_scalar("SELECT model_hash FROM model_configs WHERE provider_id = ?")
                .bind(provider_id)
                .fetch_all(&mut *transaction)
                .await?;
        validate_permutation(
            &current_hashes,
            model_hashes,
            "model configuration changed; refresh and try sorting again",
        )?;

        for (index, hash) in model_hashes.iter().enumerate() {
            sqlx::query(
                "UPDATE model_configs SET sort_order = ?, updated_at_ms = ? WHERE model_hash = ? AND provider_id = ?",
            )
            .bind(i64::try_from(index + 1).expect("model order fits in i64"))
            .bind(now)
            .bind(hash)
            .bind(provider_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.models().await
    }
}

fn validate_permutation(
    current: &[String],
    requested: &[String],
    error_message: &str,
) -> Result<()> {
    let current_set = current.iter().map(String::as_str).collect::<HashSet<_>>();
    let requested_set = requested.iter().map(String::as_str).collect::<HashSet<_>>();
    if requested.len() != current.len()
        || requested_set.len() != current.len()
        || requested_set != current_set
    {
        return Err(Error::Config(error_message.into()));
    }
    Ok(())
}

async fn next_provider_sort_order(transaction: &mut Transaction<'_, Sqlite>) -> Result<i64> {
    let next: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM provider_configs")
            .fetch_one(&mut **transaction)
            .await?;
    Ok(next)
}

async fn next_model_sort_order(
    transaction: &mut Transaction<'_, Sqlite>,
    provider_id: &str,
) -> Result<i64> {
    let next: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM model_configs WHERE provider_id = ?",
    )
    .bind(provider_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(next)
}

async fn model_in_tx(
    transaction: &mut Transaction<'_, Sqlite>,
    hash: &str,
) -> Result<Option<ModelConfig>> {
    let query = format!(
        "SELECT {MODEL_JOIN_COLUMNS}
         FROM model_configs AS m
         INNER JOIN provider_configs AS p ON p.provider_id = m.provider_id
         WHERE m.model_hash = ?"
    );
    sqlx::query(&query)
        .bind(hash)
        .fetch_optional(&mut **transaction)
        .await?
        .map(model_from_row)
        .transpose()
}

async fn ensure_provider_exists(transaction: &mut Transaction<'_, Sqlite>, provider_id: &str) -> Result<()>
{
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM provider_configs WHERE provider_id = ?)").bind(provider_id).fetch_one(&mut **transaction).await?;
    if !exists
    {
        return Err(Error::Config(format!("provider {provider_id} not found")));
    }
    Ok(())
}

pub(super) async fn insert_provider_with_conflict(
    transaction: &mut Transaction<'_, Sqlite>,
    provider_id: &str,
    input: &ProviderConfigInput,
    now: i64,
    ignore_existing: bool,
) -> Result<bool> {
    let mut statement = String::from(
        r#"INSERT INTO provider_configs(
            provider_id, sort_order, name, base_url, api_key,
            custom_headers_enabled, custom_headers_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    );
    if ignore_existing {
        statement.push_str(" ON CONFLICT(provider_id) DO NOTHING");
    }
    let result = sqlx::query(&statement)
        .bind(provider_id)
        .bind(input.sort_order)
        .bind(&input.name)
        .bind(&input.base_url)
        .bind(&input.api_key)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

async fn insert_model(
    transaction: &mut Transaction<'_, Sqlite>,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
) -> Result<()> {
    insert_model_with_conflict(transaction, hash, input, now, false).await?;
    Ok(())
}

pub(super) async fn insert_model_with_conflict(
    transaction: &mut Transaction<'_, Sqlite>,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
    ignore_existing: bool,
) -> Result<bool> {
    let mut statement = String::from(
        r#"INSERT INTO model_configs(
            model_hash, provider_id, sort_order, display_name, tooltip_data,
            model_id, reasoning_effort, context_window_tokens, max_output_tokens,
            anthropic_thinking_effort, thinking_budget_tokens, request_format, request_url_override,
            extra_params_enabled, extra_params_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    );
    if ignore_existing {
        statement.push_str(" ON CONFLICT(model_hash) DO NOTHING");
    }
    let result = sqlx::query(&statement)
        .bind(hash)
        .bind(&input.provider_id)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_output_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(input.request_format.as_str())
        .bind(&input.request_url_override)
        .bind(input.extra_params_enabled)
        .bind(serde_json::to_string(&input.extra_params)?)
        .bind(now)
        .bind(now)
        .execute(&mut **transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

fn provider_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ProviderConfig> {
    Ok(ProviderConfig {
        provider_id: row.try_get("provider_id")?,
        sort_order: row.try_get("sort_order")?,
        name: row.try_get("name")?,
        base_url: row.try_get("base_url")?,
        api_key: row.try_get("api_key")?,
        custom_headers_enabled: row.try_get("custom_headers_enabled")?,
        custom_headers: serde_json::from_str(
            row.try_get::<String, _>("custom_headers_json")?.as_str(),
        )?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn model_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelConfig> {
    Ok(ModelConfig {
        model_hash: row.try_get("model_hash")?,
        provider_id: row.try_get("provider_id")?,
        provider_name: row.try_get("provider_name")?,
        sort_order: row.try_get("sort_order")?,
        display_name: row.try_get("display_name")?,
        request_format: RequestFormat::from_str(row.try_get("request_format")?)?,
        request_url_override: row.try_get("request_url_override")?,
        base_url: row.try_get("base_url")?,
        api_key: row.try_get("api_key")?,
        custom_headers_enabled: row.try_get("custom_headers_enabled")?,
        custom_headers: serde_json::from_str(
            row.try_get::<String, _>("custom_headers_json")?.as_str(),
        )?,
        extra_params_enabled: row.try_get("extra_params_enabled")?,
        extra_params: serde_json::from_str(
            row.try_get::<String, _>("extra_params_json")?.as_str(),
        )?,
        tooltip_data: row.try_get("tooltip_data")?,
        model_id: row.try_get("model_id")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        context_window_tokens: optional_u64(&row, "context_window_tokens")?,
        max_output_tokens: optional_u64(&row, "max_output_tokens")?,
        anthropic_thinking_effort: row.try_get("anthropic_thinking_effort")?,
        thinking_budget_tokens: optional_u64(&row, "thinking_budget_tokens")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn optional_u64(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Option<u64>> {
    row.try_get::<Option<i64>, _>(column)?
        .map(|value| {
            u64::try_from(value).map_err(|_| Error::Config(format!("{column} cannot be negative")))
        })
        .transpose()
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Config("token value is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_input(name: &str) -> ProviderConfigInput {
        ProviderConfigInput {
            sort_order: 0,
            name: name.into(),
            base_url: "https://example.com/v1".into(),
            api_key: "test-key".into(),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
        }
    }

    fn model_input(provider_id: &str, display_name: &str) -> ModelConfigInput {
        ModelConfigInput {
            provider_id: provider_id.into(),
            request_format: RequestFormat::OpenAiChat,
            request_url_override: None,
            extra_params_enabled: false,
            extra_params: serde_json::json!({}),
            sort_order: 0,
            display_name: display_name.into(),
            tooltip_data: display_name.into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            context_window_tokens: None,
            max_output_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    async fn test_store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        (directory, store)
    }

    #[tokio::test]
    async fn updating_provider_propagates_to_models_without_changing_model_identity() {
        let (_directory, store) = test_store().await;

        let provider = store
            .create_provider(&provider_input("  My Provider  "))
            .await
            .unwrap();
        assert_eq!(provider.name, "My Provider");

        let created = store
            .create_model(&model_input(&provider.provider_id, "Test Model"))
            .await
            .unwrap();
        assert_eq!(created.provider_name, "My Provider");

        let updated_provider = store
            .update_provider(&provider.provider_id, &provider_input("Renamed Provider"))
            .await
            .unwrap();
        assert_eq!(updated_provider.provider_id, provider.provider_id);
        assert_eq!(updated_provider.name, "Renamed Provider");

        let loaded = store.model(&created.model_hash).await.unwrap().unwrap();
        assert_eq!(loaded.model_hash, created.model_hash);
        assert_eq!(loaded.provider_name, "Renamed Provider");

        let mut edited = model_input(&provider.provider_id, "Test Model");
        edited.max_output_tokens = Some(16_384);
        let updated_model = store
            .update_model(&created.model_hash, &edited)
            .await
            .unwrap();
        assert_eq!(updated_model.model_hash, created.model_hash);
        assert_eq!(updated_model.max_output_tokens, Some(16_384));

        store.delete_provider(&provider.provider_id).await.unwrap();
        assert!(store.providers().await.unwrap().is_empty());
        assert!(store.models().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_and_update_manage_sort_order_per_provider() {
        let (_directory, store) = test_store().await;

        let p1 = store
            .create_provider(&provider_input("Provider One"))
            .await
            .unwrap();
        let p2 = store
            .create_provider(&provider_input("Provider Two"))
            .await
            .unwrap();
        assert_eq!(p1.sort_order, 1);
        assert_eq!(p2.sort_order, 2);

        let batch = store
            .create_models(&[
                model_input(&p1.provider_id, "P1 First"),
                model_input(&p1.provider_id, "P1 Second"),
            ])
            .await
            .unwrap();
        assert_eq!(batch[0].sort_order, 1);
        assert_eq!(batch[1].sort_order, 2);

        let p1_third = store
            .create_model(&model_input(&p1.provider_id, "P1 Third"))
            .await
            .unwrap();
        assert_eq!(p1_third.sort_order, 3);

        let p2_first = store
            .create_model(&model_input(&p2.provider_id, "P2 First"))
            .await
            .unwrap();
        assert_eq!(p2_first.sort_order, 1);

        let updated_p2 = store
            .update_provider(&p2.provider_id, &provider_input("Provider Two Renamed"))
            .await
            .unwrap();
        assert_eq!(updated_p2.sort_order, 2);

        let mut edit_same_provider = model_input(&p1.provider_id, "P1 Second Edited");
        edit_same_provider.sort_order = 0;
        let updated_same = store
            .update_model(&batch[1].model_hash, &edit_same_provider)
            .await
            .unwrap();
        assert_eq!(updated_same.sort_order, 2);

        let mut move_provider = model_input(&p2.provider_id, "P1 Moved to P2");
        move_provider.sort_order = 0;
        let moved = store
            .update_model(&updated_same.model_hash, &move_provider)
            .await
            .unwrap();
        assert_eq!(moved.provider_id, p2.provider_id);
        assert_eq!(moved.sort_order, 2);
    }

    #[tokio::test]
    async fn reorder_providers_and_models_enforce_provider_first_ordering() {
        let (_directory, store) = test_store().await;

        let p1 = store
            .create_provider(&provider_input("Alpha"))
            .await
            .unwrap();
        let p2 = store
            .create_provider(&provider_input("Beta"))
            .await
            .unwrap();

        let p1_a = store
            .create_model(&model_input(&p1.provider_id, "Alpha A"))
            .await
            .unwrap();
        let p1_b = store
            .create_model(&model_input(&p1.provider_id, "Alpha B"))
            .await
            .unwrap();
        let p2_a = store
            .create_model(&model_input(&p2.provider_id, "Beta A"))
            .await
            .unwrap();
        let p2_b = store
            .create_model(&model_input(&p2.provider_id, "Beta B"))
            .await
            .unwrap();

        let reordered_models = store
            .reorder_models(
                &p1.provider_id,
                &[p1_b.model_hash.clone(), p1_a.model_hash.clone()],
            )
            .await
            .unwrap();
        let hashes: Vec<_> = reordered_models
            .iter()
            .map(|m| m.model_hash.as_str())
            .collect();
        assert_eq!(
            hashes,
            vec![
                p1_b.model_hash.as_str(),
                p1_a.model_hash.as_str(),
                p2_a.model_hash.as_str(),
                p2_b.model_hash.as_str(),
            ]
        );
        // Provider 2's model sort_orders remain isolated and untouched.
        assert_eq!(reordered_models[2].sort_order, 1);
        assert_eq!(reordered_models[3].sort_order, 2);

        let reordered_providers = store
            .reorder_providers(&[p2.provider_id.clone(), p1.provider_id.clone()])
            .await
            .unwrap();
        assert_eq!(
            reordered_providers
                .iter()
                .map(|p| (p.provider_id.as_str(), p.sort_order))
                .collect::<Vec<_>>(),
            vec![(p2.provider_id.as_str(), 1), (p1.provider_id.as_str(), 2)]
        );

        let models_after = store.models().await.unwrap();
        assert_eq!(
            models_after
                .iter()
                .map(|m| m.model_hash.as_str())
                .collect::<Vec<_>>(),
            vec![
                p2_a.model_hash.as_str(),
                p2_b.model_hash.as_str(),
                p1_b.model_hash.as_str(),
                p1_a.model_hash.as_str(),
            ]
        );
    }

    #[tokio::test]
    async fn reorder_rejects_mismatched_or_missing_targets() {
        let (_directory, store) = test_store().await;

        let p1 = store
            .create_provider(&provider_input("Alpha"))
            .await
            .unwrap();
        let p2 = store
            .create_provider(&provider_input("Beta"))
            .await
            .unwrap();
        let m1 = store
            .create_model(&model_input(&p1.provider_id, "Alpha 1"))
            .await
            .unwrap();
        let m2 = store
            .create_model(&model_input(&p2.provider_id, "Beta 1"))
            .await
            .unwrap();

        assert!(matches!(
            store
                .reorder_providers(std::slice::from_ref(&p1.provider_id))
                .await,
            Err(Error::Config(_))
        ));
        assert!(matches!(
            store
                .reorder_providers(&[p1.provider_id.clone(), p1.provider_id.clone()])
                .await,
            Err(Error::Config(_))
        ));
        assert!(matches!(
            store
                .reorder_providers(&[p1.provider_id.clone(), "unknown".into()])
                .await,
            Err(Error::Config(_))
        ));

        assert!(matches!(
            store.reorder_models("missing-provider", &[]).await,
            Err(Error::RunNotFound(_))
        ));
        assert!(matches!(
            store
                .reorder_models(&p1.provider_id, std::slice::from_ref(&m2.model_hash))
                .await,
            Err(Error::Config(_))
        ));
        assert!(matches!(
            store
                .reorder_models(
                    &p1.provider_id,
                    &[m1.model_hash.clone(), m1.model_hash.clone()],
                )
                .await,
            Err(Error::Config(_))
        ));
        assert!(matches!(
            store.reorder_models(&p1.provider_id, &[]).await,
            Err(Error::Config(_))
        ));
    }
}
