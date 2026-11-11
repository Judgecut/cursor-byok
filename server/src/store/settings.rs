//! Persists application settings.
use serde::{Deserialize, Deserializer, Serialize};

use crate::Result;

use super::{now_ms, Store};

const PORT_SETTINGS_KEY: &str = "network_ports";
const PROXY_SETTINGS_KEY: &str = "outbound_proxy";
const TAB_SETTINGS_KEY: &str = "cursor_tab";
const INSTALLATION_ID_KEY: &str = "installation_id";
const DESKTOP_SETTINGS_KEY: &str = "desktop_lifecycle";
const COMMIT_SETTINGS_KEY: &str = "commit_settings";
const CURSOR_TAKEOVER_ENABLED_KEY: &str = "cursor_takeover_enabled";
const EXTERNAL_API_SETTINGS_KEY: &str = "external_api";
const INTERFACE_SETTINGS_KEY: &str = "interface_settings";

pub const DEFAULT_HOME_REFRESH_INTERVAL_SECONDS: u64 = 30;

/// Embedded default system prompts for commit message generation.
pub const DEFAULT_COMMIT_PROMPT_ZH_CN: &str = include_str!("../../prompt/cursor/commit/zh-CN.md");
pub const DEFAULT_COMMIT_PROMPT_EN_US: &str = include_str!("../../prompt/cursor/commit/en-US.md");

pub const PUBLIC_TAB_SERVICE_URL: &str = "https://tab.leokun.cn";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct PortSettings {
    pub proxy_port: u16,
    pub service_port: u16,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct ExternalApiSettings {
    pub enabled: bool,
    pub api_key: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    #[default]
    Default,
    Custom,
}

impl ProxyMode {
    pub fn is_custom(self) -> bool {
        self == Self::Custom
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabMode {
    #[default]
    Public,
    Direct,
    Custom,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TabSettings {
    pub mode: TabMode,
    pub address: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub silent_start: bool,
    #[serde(default = "default_true")]
    pub show_dock_icon: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            silent_start: false,
            show_dock_icon: true,
        }
    }
}

fn default_true() -> bool {
    true
}

impl TabSettings {
    pub fn service_url(&self) -> Option<&str> {
        match self.mode {
            TabMode::Public => Some(PUBLIC_TAB_SERVICE_URL),
            TabMode::Direct => None,
            TabMode::Custom => Some(&self.address),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum CommitPromptLocale {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl CommitPromptLocale {
    pub fn from_interface_language(value: &str) -> Self {
        if value.eq_ignore_ascii_case("zh-CN") {
            Self::ZhCn
        } else {
            Self::EnUs
        }
    }

    pub fn default_prompt(self) -> &'static str {
        match self {
            Self::ZhCn => DEFAULT_COMMIT_PROMPT_ZH_CN.trim(),
            Self::EnUs => DEFAULT_COMMIT_PROMPT_EN_US.trim(),
        }
    }
}

impl<'de> Deserialize<'de> for CommitPromptLocale {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_interface_language(&value))
    }
}

/// User preferences for Git commit message generation.
///
/// Empty `model_id` means 直连: forward the original Cursor RPC unchanged.
/// A non-empty value is the stable identifier of a configured built-in or
/// plugin model, and the request is generated locally through that model.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct CommitSettings {
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub prompt_locale: CommitPromptLocale,
}

impl CommitSettings {
    pub fn is_direct(&self) -> bool {
        self.model_id.trim().is_empty()
    }

    pub fn effective_prompt(&self) -> &str {
        let trimmed = self.prompt.trim();
        if trimmed.is_empty() {
            self.prompt_locale.default_prompt()
        } else {
            trimmed
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct ProxySettingsInput {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ProxySettings {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub has_password: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct ProxySettingsSecret {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub enum InterfaceLocale {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "pt-BR")]
    PtBr,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub enum InterfaceTheme {
    #[serde(rename = "system")]
    System,
    #[default]
    #[serde(rename = "default-dark")]
    DefaultDark,
    #[serde(rename = "default-light")]
    DefaultLight,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub enum DisplayCurrency {
    #[default]
    #[serde(rename = "USD")]
    Usd,
    #[serde(rename = "CNY")]
    Cny,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OverviewChartMode {
    #[default]
    Tokens,
    Cost,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OverviewChartType {
    #[default]
    Bar,
    Line,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct InterfaceSettings {
    #[serde(default)]
    pub locale: InterfaceLocale,
    #[serde(default)]
    pub theme: InterfaceTheme,
    #[serde(default)]
    pub currency: DisplayCurrency,
    #[serde(default)]
    pub cny_rate: Option<String>,
    #[serde(default)]
    pub overview_chart_mode: OverviewChartMode,
    #[serde(default)]
    pub overview_chart_type: OverviewChartType,
    #[serde(default = "default_home_refresh_interval_seconds")]
    pub home_refresh_interval_seconds: u64,
}

impl Default for InterfaceSettings {
    fn default() -> Self {
        Self {
            locale: InterfaceLocale::default(),
            theme: InterfaceTheme::default(),
            currency: DisplayCurrency::default(),
            cny_rate: None,
            overview_chart_mode: OverviewChartMode::default(),
            overview_chart_type: OverviewChartType::default(),
            home_refresh_interval_seconds: DEFAULT_HOME_REFRESH_INTERVAL_SECONDS,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct InterfaceSettingsPatch {
    #[serde(default)]
    pub locale: Option<InterfaceLocale>,
    #[serde(default)]
    pub theme: Option<InterfaceTheme>,
    #[serde(default)]
    pub currency: Option<DisplayCurrency>,
    #[serde(default, deserialize_with = "deserialize_optional_nullable_string")]
    pub cny_rate: Option<Option<String>>,
    #[serde(default)]
    pub overview_chart_mode: Option<OverviewChartMode>,
    #[serde(default)]
    pub overview_chart_type: Option<OverviewChartType>,
    #[serde(default)]
    pub home_refresh_interval_seconds: Option<u64>,
}

fn default_home_refresh_interval_seconds() -> u64 {
    DEFAULT_HOME_REFRESH_INTERVAL_SECONDS
}

fn deserialize_optional_nullable_string<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn normalize_cny_rate(raw: &str) -> Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 64 {
        return Err(crate::Error::Config("CNY exchange rate is too long".into()));
    }
    if trimmed.starts_with('-') {
        return Err(crate::Error::Config(
            "CNY exchange rate must be greater than 0".into(),
        ));
    }
    let unsigned = trimmed.strip_prefix('+').unwrap_or(trimmed);
    let (raw_int, raw_frac) = match unsigned.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (unsigned, ""),
    };
    if (raw_int.is_empty() && raw_frac.is_empty())
        || !raw_int.bytes().all(|byte| byte.is_ascii_digit())
        || !raw_frac.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(crate::Error::Config(format!(
            "invalid CNY exchange rate: {raw}"
        )));
    }
    let trimmed_int = raw_int.trim_start_matches('0');
    let int_part = if trimmed_int.is_empty() {
        "0"
    } else {
        trimmed_int
    };
    let frac_part = raw_frac.trim_end_matches('0');
    if int_part == "0" && frac_part.is_empty() {
        return Err(crate::Error::Config(
            "CNY exchange rate must be greater than 0".into(),
        ));
    }
    Ok(Some(if frac_part.is_empty() {
        int_part.to_owned()
    } else {
        format!("{int_part}.{frac_part}")
    }))
}

fn normalize_loaded_interface_settings(mut settings: InterfaceSettings) -> InterfaceSettings {
    settings.cny_rate = settings
        .cny_rate
        .as_deref()
        .and_then(|rate| normalize_cny_rate(rate).ok().flatten());
    if settings.home_refresh_interval_seconds == 0 {
        settings.home_refresh_interval_seconds = DEFAULT_HOME_REFRESH_INTERVAL_SECONDS;
    }
    settings
}

/// Reads the persisted outbound proxy row, falling back to "no proxy" when it
/// no longer parses.
///
/// `mode` is a closed enum whose stored wire value has already changed once, so
/// a row written by an older build can be unreadable by this one. Propagating
/// that error would be unrecoverable rather than merely noisy: every outbound
/// client is built from this value, and `set_proxy_settings` reads the row
/// before it writes, so the settings page could neither load nor replace the
/// row that broke it.
fn read_proxy_settings(value: &str) -> ProxySettingsSecret {
    serde_json::from_str(value).unwrap_or_else(|error| {
        tracing::warn!(%error, "ignoring unreadable outbound proxy settings");
        ProxySettingsSecret::default()
    })
}

impl Store {
    pub async fn external_api_settings(&self) -> Result<ExternalApiSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(EXTERNAL_API_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(ExternalApiSettings::default()))
    }

    pub async fn set_external_api_settings(
        &self,
        mut settings: ExternalApiSettings,
    ) -> Result<ExternalApiSettings> {
        settings.api_key = settings.api_key.trim().to_owned();
        if settings.enabled && settings.api_key.is_empty() {
            return Err(crate::Error::Config(
                "external API key is required when enabled".into(),
            ));
        }
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(EXTERNAL_API_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        Ok(settings)
    }

    pub(crate) async fn cursor_takeover_enabled(&self) -> Result<bool> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(CURSOR_TAKEOVER_ENABLED_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or(Ok(true))
    }

    pub(crate) async fn set_cursor_takeover_enabled(&self, enabled: bool) -> Result<()> {
        let value_json = serde_json::to_string(&enabled)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(CURSOR_TAKEOVER_ENABLED_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub(crate) async fn installation_id(&self) -> Result<String> {
        let generated = uuid::Uuid::new_v4().to_string();
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO NOTHING",
        )
        .bind(INSTALLATION_ID_KEY)
        .bind(serde_json::to_string(&generated)?)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(INSTALLATION_ID_KEY)
        .fetch_one(&self.pool)
        .await?;
        let installation_id = serde_json::from_str::<String>(&value)?;
        uuid::Uuid::parse_str(&installation_id).map_err(|error| {
            crate::Error::Store(format!("invalid persisted installation ID: {error}"))
        })?;
        Ok(installation_id)
    }

    pub(crate) async fn proxy_settings_secret(&self) -> Result<ProxySettingsSecret> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PROXY_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        Ok(value
            .as_deref()
            .map_or_else(ProxySettingsSecret::default, read_proxy_settings))
    }

    pub async fn proxy_settings(&self) -> Result<ProxySettings> {
        let settings = self.proxy_settings_secret().await?;
        Ok(ProxySettings {
            mode: settings.mode,
            address: settings.address,
            auth_enabled: settings.auth_enabled,
            username: settings.username,
            has_password: !settings.password.is_empty(),
        })
    }

    pub async fn set_proxy_settings(&self, input: ProxySettingsInput) -> Result<ProxySettings> {
        let existing = self.proxy_settings_secret().await?;
        let address = input.address.trim().to_owned();
        if input.mode.is_custom() {
            let parsed = url::Url::parse(&address)
                .map_err(|error| crate::Error::Config(format!("invalid proxy address: {error}")))?;
            if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
                return Err(crate::Error::Config(
                    "proxy address must use http, https, socks5, or socks5h".into(),
                ));
            }
            reqwest::Proxy::all(&address)?;
        }
        let password = if input.auth_enabled {
            input
                .password
                .filter(|password| !password.is_empty())
                .unwrap_or(existing.password)
        } else {
            String::new()
        };
        let settings = ProxySettingsSecret {
            mode: input.mode,
            address,
            auth_enabled: input.auth_enabled,
            username: input.username.trim().to_owned(),
            password,
        };
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(PROXY_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        self.proxy_settings().await
    }

    pub async fn tab_settings(&self) -> Result<TabSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(TAB_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(TabSettings::default()))
    }

    pub async fn set_tab_settings(&self, mut settings: TabSettings) -> Result<TabSettings> {
        settings.address = settings.address.trim().trim_end_matches('/').to_owned();
        if settings.mode == TabMode::Custom {
            let parsed = url::Url::parse(&settings.address).map_err(|error| {
                crate::Error::Config(format!("invalid TAB service address: {error}"))
            })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(crate::Error::Config(
                    "TAB service address must use http or https".into(),
                ));
            }
            if parsed.host_str().is_none()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(crate::Error::Config(
                    "TAB service address must be a base URL without a query or fragment".into(),
                ));
            }
        }
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(TAB_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        Ok(settings)
    }

    pub async fn port_settings(&self) -> Result<PortSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PORT_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(PortSettings::default()))
    }

    pub async fn set_port_settings(&self, settings: PortSettings) -> Result<()> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(PORT_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_service_port(&self, port: u16) -> Result<()> {
        let mut settings = self.port_settings().await?;
        settings.service_port = port;
        self.set_port_settings(settings).await
    }

    pub async fn set_proxy_port(&self, port: u16) -> Result<()> {
        let mut settings = self.port_settings().await?;
        settings.proxy_port = port;
        self.set_port_settings(settings).await
    }

    pub async fn desktop_settings(&self) -> Result<DesktopSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(DESKTOP_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(DesktopSettings::default()))
    }

    pub async fn set_desktop_settings(&self, settings: DesktopSettings) -> Result<()> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(DESKTOP_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn commit_settings(&self) -> Result<CommitSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(COMMIT_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(CommitSettings::default()))
    }

    pub async fn set_commit_settings(&self, settings: CommitSettings) -> Result<CommitSettings> {
        let settings = CommitSettings {
            model_id: settings.model_id.trim().to_owned(),
            prompt: settings.prompt.trim().to_owned(),
            prompt_locale: settings.prompt_locale,
        };
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(COMMIT_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(settings)
    }

    pub async fn interface_settings(&self) -> Result<InterfaceSettings> {
        read_interface_settings(&self.pool).await
    }

    pub async fn update_interface_settings(
        &self,
        patch: InterfaceSettingsPatch,
    ) -> Result<InterfaceSettings> {
        let _write = self.writes.lock().await;
        let mut settings = read_interface_settings(&self.pool).await?;
        if let Some(locale) = patch.locale {
            settings.locale = locale;
        }
        if let Some(theme) = patch.theme {
            settings.theme = theme;
        }
        if let Some(overview_chart_mode) = patch.overview_chart_mode {
            settings.overview_chart_mode = overview_chart_mode;
        }
        if let Some(overview_chart_type) = patch.overview_chart_type {
            settings.overview_chart_type = overview_chart_type;
        }
        if let Some(interval) = patch.home_refresh_interval_seconds {
            if interval == 0 {
                return Err(crate::Error::Config(
                    "home refresh interval must be greater than 0 seconds".into(),
                ));
            }
            settings.home_refresh_interval_seconds = interval;
        }
        if let Some(rate_patch) = patch.cny_rate {
            settings.cny_rate = match rate_patch {
                None => None,
                Some(raw) => normalize_cny_rate(&raw)?,
            };
        }
        if let Some(currency) = patch.currency {
            settings.currency = currency;
        }
        let value_json = serde_json::to_string(&settings)?;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(INTERFACE_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(settings)
    }
}

async fn read_interface_settings(pool: &sqlx::SqlitePool) -> Result<InterfaceSettings> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT value_json FROM service_settings WHERE setting_key = ?",
    )
    .bind(INTERFACE_SETTINGS_KEY)
    .fetch_optional(pool)
    .await?;
    let settings = match value {
        Some(value) => serde_json::from_str(&value)?,
        None => InterfaceSettings::default(),
    };
    Ok(normalize_loaded_interface_settings(settings))
}

#[cfg(test)]
mod tests {
    use super::{
        read_proxy_settings, CommitPromptLocale, CommitSettings, DisplayCurrency,
        ExternalApiSettings, InterfaceLocale, InterfaceSettings, InterfaceSettingsPatch,
        InterfaceTheme, OverviewChartMode, OverviewChartType, ProxyMode, ProxySettingsInput,
        ProxySettingsSecret, Store, DEFAULT_COMMIT_PROMPT_EN_US, DEFAULT_COMMIT_PROMPT_ZH_CN,
        DEFAULT_HOME_REFRESH_INTERVAL_SECONDS, PROXY_SETTINGS_KEY,
    };

    /// The `outbound_proxy` row exactly as builds before the `system` -> `default`
    /// rename wrote it.
    const LEGACY_PROXY_ROW: &str =
        r#"{"mode":"system","address":"","auth_enabled":false,"username":"","password":""}"#;

    #[test]
    fn commit_prompt_locale_maps_unknown_interface_languages_to_english() {
        assert_eq!(
            serde_json::from_str::<CommitPromptLocale>(r#""zh-CN""#).unwrap(),
            CommitPromptLocale::ZhCn
        );
        assert_eq!(
            serde_json::from_str::<CommitPromptLocale>(r#""en-US""#).unwrap(),
            CommitPromptLocale::EnUs
        );
        assert_eq!(
            serde_json::from_str::<CommitPromptLocale>(r#""pt-BR""#).unwrap(),
            CommitPromptLocale::EnUs
        );
        assert_eq!(
            serde_json::to_string(&CommitPromptLocale::EnUs).unwrap(),
            r#""en-US""#
        );
    }

    #[test]
    fn default_commit_prompt_follows_its_saved_locale() {
        for (prompt_locale, expected) in [
            (CommitPromptLocale::ZhCn, DEFAULT_COMMIT_PROMPT_ZH_CN),
            (CommitPromptLocale::EnUs, DEFAULT_COMMIT_PROMPT_EN_US),
        ] {
            let settings = CommitSettings {
                prompt_locale,
                ..CommitSettings::default()
            };
            assert_eq!(settings.effective_prompt(), expected.trim());
        }
    }

    #[test]
    fn custom_commit_prompt_does_not_change_with_locale() {
        for prompt_locale in [CommitPromptLocale::ZhCn, CommitPromptLocale::EnUs] {
            let settings = CommitSettings {
                prompt: "custom prompt".into(),
                prompt_locale,
                ..CommitSettings::default()
            };
            assert_eq!(settings.effective_prompt(), "custom prompt");
        }
    }

    #[test]
    fn default_proxy_mode_uses_the_default_wire_value() {
        assert_eq!(ProxyMode::default(), ProxyMode::Default);
        assert_eq!(
            serde_json::to_string(&ProxyMode::default()).unwrap(),
            "\"default\""
        );
        assert_eq!(
            serde_json::from_str::<ProxyMode>("\"default\"").unwrap(),
            ProxyMode::Default
        );
        assert!(serde_json::from_str::<ProxyMode>("\"system\"").is_err());
    }

    #[test]
    fn an_unreadable_proxy_row_reads_as_no_proxy() {
        assert!(serde_json::from_str::<ProxySettingsSecret>(LEGACY_PROXY_ROW).is_err());

        let settings = read_proxy_settings(LEGACY_PROXY_ROW);
        assert_eq!(settings.mode, ProxyMode::Default);
        assert!(settings.address.is_empty());
        assert!(!settings.auth_enabled);
    }

    #[tokio::test]
    async fn a_proxy_row_from_an_older_build_stays_replaceable() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, 0)",
        )
        .bind(PROXY_SETTINGS_KEY)
        .bind(LEGACY_PROXY_ROW)
        .execute(store.pool())
        .await
        .unwrap();

        // Reading must not fail: every outbound client is built from this value.
        assert_eq!(
            store.proxy_settings().await.unwrap().mode,
            ProxyMode::Default
        );

        // And the settings page must be able to overwrite the row that broke it.
        let saved = store
            .set_proxy_settings(ProxySettingsInput {
                mode: ProxyMode::Custom,
                address: "http://127.0.0.1:7890".into(),
                auth_enabled: false,
                username: String::new(),
                password: None,
            })
            .await
            .unwrap();
        assert_eq!(saved.mode, ProxyMode::Custom);
        assert_eq!(saved.address, "http://127.0.0.1:7890");
    }

    #[tokio::test]
    async fn external_api_requires_a_key_and_persists_its_switch() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();

        assert_eq!(
            store.external_api_settings().await.unwrap(),
            ExternalApiSettings::default()
        );
        assert!(store
            .set_external_api_settings(ExternalApiSettings {
                enabled: true,
                api_key: String::new(),
            })
            .await
            .is_err());
        let settings = ExternalApiSettings {
            enabled: true,
            api_key: "local-test-key".into(),
        };
        assert_eq!(
            store
                .set_external_api_settings(settings.clone())
                .await
                .unwrap(),
            settings
        );
        assert_eq!(
            Store::connect(&url)
                .await
                .unwrap()
                .external_api_settings()
                .await
                .unwrap(),
            settings
        );
    }

    #[test]
    fn interface_settings_patch_distinguishes_omitted_null_and_string_cny_rate() {
        let omitted: InterfaceSettingsPatch =
            serde_json::from_str(r#"{"theme":"system"}"#).unwrap();
        assert_eq!(omitted.cny_rate, None);

        let cleared: InterfaceSettingsPatch = serde_json::from_str(r#"{"cny_rate":null}"#).unwrap();
        assert_eq!(cleared.cny_rate, Some(None));

        let updated: InterfaceSettingsPatch =
            serde_json::from_str(r#"{"cny_rate":"7.20"}"#).unwrap();
        assert_eq!(updated.cny_rate, Some(Some("7.20".into())));
    }

    #[tokio::test]
    async fn interface_settings_persist_partially_and_enforce_currency_and_rate_rules() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();

        assert_eq!(
            store.interface_settings().await.unwrap(),
            InterfaceSettings {
                locale: InterfaceLocale::System,
                theme: InterfaceTheme::DefaultDark,
                currency: DisplayCurrency::Usd,
                cny_rate: None,
                overview_chart_mode: OverviewChartMode::Tokens,
                overview_chart_type: OverviewChartType::Bar,
                home_refresh_interval_seconds: DEFAULT_HOME_REFRESH_INTERVAL_SECONDS,
            }
        );

        // Can switch to CNY before configuring a custom rate (display uses the default rate).
        let cny_with_default = store
            .update_interface_settings(InterfaceSettingsPatch {
                currency: Some(DisplayCurrency::Cny),
                ..InterfaceSettingsPatch::default()
            })
            .await
            .unwrap();
        assert_eq!(cny_with_default.currency, DisplayCurrency::Cny);
        assert_eq!(cny_with_default.cny_rate, None);

        let reopened_default_rate = Store::connect(&url).await.unwrap();
        assert_eq!(
            reopened_default_rate.interface_settings().await.unwrap(),
            cny_with_default
        );

        // Reject zero/negative/invalid rates and zero refresh interval.
        for bad_rate in ["0", "0.00", "-7.2", "abc", ".", "+"] {
            assert!(
                store
                    .update_interface_settings(InterfaceSettingsPatch {
                        cny_rate: Some(Some(bad_rate.into())),
                        ..InterfaceSettingsPatch::default()
                    })
                    .await
                    .is_err(),
                "expected rate {bad_rate:?} to be rejected"
            );
        }
        assert!(store
            .update_interface_settings(InterfaceSettingsPatch {
                home_refresh_interval_seconds: Some(0),
                ..InterfaceSettingsPatch::default()
            })
            .await
            .is_err());

        // Partial updates preserve previous fields and normalize decimals.
        let saved = store
            .update_interface_settings(InterfaceSettingsPatch {
                theme: Some(InterfaceTheme::System),
                cny_rate: Some(Some("07.20".into())),
                ..InterfaceSettingsPatch::default()
            })
            .await
            .unwrap();
        assert_eq!(saved.theme, InterfaceTheme::System);
        assert_eq!(saved.cny_rate.as_deref(), Some("7.2"));

        let saved = store
            .update_interface_settings(InterfaceSettingsPatch {
                locale: Some(InterfaceLocale::EnUs),
                currency: Some(DisplayCurrency::Cny),
                overview_chart_mode: Some(OverviewChartMode::Cost),
                overview_chart_type: Some(OverviewChartType::Line),
                home_refresh_interval_seconds: Some(15),
                ..InterfaceSettingsPatch::default()
            })
            .await
            .unwrap();
        assert_eq!(saved.locale, InterfaceLocale::EnUs);
        assert_eq!(saved.theme, InterfaceTheme::System);
        assert_eq!(saved.currency, DisplayCurrency::Cny);
        assert_eq!(saved.cny_rate.as_deref(), Some("7.2"));
        assert_eq!(saved.overview_chart_mode, OverviewChartMode::Cost);
        assert_eq!(saved.overview_chart_type, OverviewChartType::Line);
        assert_eq!(saved.home_refresh_interval_seconds, 15);

        // Reconnecting to SQLite preserves every field.
        let reopened = Store::connect(&url).await.unwrap();
        assert_eq!(reopened.interface_settings().await.unwrap(), saved);

        // Clearing the rate restores unconfigured state (default rate) while preserving currency and other fields.
        let cleared = reopened
            .update_interface_settings(InterfaceSettingsPatch {
                cny_rate: Some(None),
                ..InterfaceSettingsPatch::default()
            })
            .await
            .unwrap();
        assert_eq!(cleared.cny_rate, None);
        assert_eq!(cleared.currency, DisplayCurrency::Cny);
        assert_eq!(cleared.theme, InterfaceTheme::System);
        assert_eq!(cleared.locale, InterfaceLocale::EnUs);
        assert_eq!(cleared.home_refresh_interval_seconds, 15);
    }
}
