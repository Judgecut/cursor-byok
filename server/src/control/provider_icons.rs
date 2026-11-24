//! Discovers a public upstream's icon for the provider editor.
use std::{future::Future, io::Cursor, sync::LazyLock, time::Duration};

use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use image::{ImageFormat, ImageReader};
use percent_encoding::percent_decode_str;
use quick_xml::{events::Event, Reader};
use reqwest::{header, redirect::Policy};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::{network::safe_web_resolution, Error, Result};

const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_PAGE_BYTES: usize = 512 * 1024;
const MAX_IMAGE_EDGE: u32 = 2048;
const MAX_DECODE_BYTES: usize = 64 * 1024 * 1024;
const MAX_REDIRECTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);

static ICON_LINKS: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("head link[rel][href]").unwrap());

#[derive(Deserialize)]
pub(super) struct DiscoverIcon {
    base_url: String,
}

#[derive(Serialize)]
pub(super) struct IconPreview {
    image: Option<String>,
}

struct Download {
    url: Url,
    bytes: Vec<u8>,
}

pub(super) async fn discover(Json(input): Json<DiscoverIcon>) -> Result<Json<IconPreview>> {
    let sites = site_origins(&input.base_url)?;
    let image = tokio::time::timeout(DISCOVERY_TIMEOUT, find_icon(&sites, download))
        .await
        .unwrap_or_default();
    Ok(Json(IconPreview { image }))
}

fn site_origins(base: &str) -> Result<Vec<Url>> {
    let invalid =
        || Error::Config("provider icon discovery requires a public HTTP(S) address".into());
    let mut origin = Url::parse(base.trim()).map_err(|_| invalid())?;
    if !matches!(origin.scheme(), "http" | "https") {
        return Err(invalid());
    }
    origin.set_scheme("https").map_err(|_| invalid())?;
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);
    if let Some(host) = origin
        .host_str()
        .and_then(|host| host.strip_suffix('.'))
        .map(str::to_owned)
    {
        origin.set_host(Some(&host)).map_err(|_| invalid())?;
    }
    if !valid_destination(&origin) {
        return Err(invalid());
    }

    let mut sites = vec![origin.clone()];
    if origin.port().is_some() {
        origin.set_port(None).map_err(|_| invalid())?;
        sites.push(origin.clone());
    }
    if let Some(Host::Domain(host)) = origin.host() {
        let registrable = psl::domain_str(host).ok_or_else(invalid)?;
        let mut hostname = host;
        while hostname != registrable {
            let Some((_, parent)) = hostname.split_once('.') else {
                break;
            };
            let mut site = origin.clone();
            site.set_host(Some(parent)).map_err(|_| invalid())?;
            sites.push(site);
            hostname = parent;
        }
    }
    Ok(sites)
}

async fn find_icon<Fut: Future<Output = Option<Download>>>(
    sites: &[Url],
    fetch: impl Fn(Url, &'static str, usize) -> Fut,
) -> Option<String> {
    for site in sites {
        let status = fetch(
            site.join("api/status").ok()?,
            "application/json",
            MAX_PAGE_BYTES,
        )
        .await;
        let panel = status.as_ref().and_then(panel_logo);
        if let Some(logo) = panel.as_deref().filter(|logo| !logo.is_empty()) {
            if let Some(image) = load_icon(logo, &fetch).await {
                return Some(image);
            }
        }

        if let Some(page) = fetch(site.clone(), "text/html", MAX_PAGE_BYTES).await {
            for candidate in page_icons(&page) {
                if panel.is_some() && is_default_panel_icon(&candidate, &page.url) {
                    continue;
                }
                if let Some(image) = load_icon(&candidate, &fetch).await {
                    return Some(image);
                }
            }
        }
        if panel.is_some() {
            return None;
        }
        if let Some(image) = load_icon(site.join("favicon.ico").ok()?.as_str(), &fetch).await {
            return Some(image);
        }
    }
    None
}

#[derive(Deserialize)]
struct SiteStatus {
    success: bool,
    data: SiteStatusData,
}

#[derive(Deserialize)]
struct SiteStatusData {
    #[serde(rename = "system_name")]
    _system_name: String,
    #[serde(default)]
    logo: Option<String>,
}

fn panel_logo(response: &Download) -> Option<String> {
    let status: SiteStatus = serde_json::from_slice(&response.bytes).ok()?;
    if !status.success {
        return None;
    }
    let logo = status
        .data
        .logo
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    Some(resolve_icon_url(&response.url, logo).unwrap_or_default())
}

fn page_icons(page: &Download) -> Vec<String> {
    let html = Html::parse_document(&String::from_utf8_lossy(&page.bytes));
    let mut icons = Vec::new();
    for link in html.select(&ICON_LINKS) {
        let attrs = link.value();
        let rel = attrs.attr("rel").unwrap_or_default();
        let touch = rel.split_ascii_whitespace().any(|rel| {
            rel.eq_ignore_ascii_case("apple-touch-icon")
                || rel.eq_ignore_ascii_case("apple-touch-icon-precomposed")
        });
        let icon = rel
            .split_ascii_whitespace()
            .any(|rel| rel.eq_ignore_ascii_case("icon"));
        if !icon && !touch {
            continue;
        }
        let href = attrs.attr("href").unwrap_or_default().trim();
        if let Some(url) = resolve_icon_url(&page.url, href) {
            let svg = attrs.attr("type") == Some("image/svg+xml")
                || href.starts_with("data:image/svg+xml")
                || href
                    .split(['?', '#'])
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .ends_with(".svg");
            icons.push((!svg, !touch, url));
        }
    }
    icons.sort_by_key(|(raster, standard, _)| (*raster, *standard));
    icons.into_iter().map(|(_, _, url)| url).collect()
}

fn resolve_icon_url(base: &Url, value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if value.starts_with("data:") {
        return Some(value.to_owned());
    }
    let mut url = base.join(value).ok()?;
    url.set_fragment(None);
    Some(url.into())
}

fn is_default_panel_icon(candidate: &str, page: &Url) -> bool {
    let Ok(url) = Url::parse(candidate) else {
        return false;
    };
    url.origin() == page.origin() && matches!(url.path(), "/favicon.ico" | "/logo.png")
}

async fn load_icon<Fut: Future<Output = Option<Download>>>(
    candidate: &str,
    fetch: &impl Fn(Url, &'static str, usize) -> Fut,
) -> Option<String> {
    let bytes = if let Some(data) = candidate.strip_prefix("data:") {
        decode_inline_icon(data)?
    } else {
        fetch(Url::parse(candidate).ok()?, "image/*", MAX_IMAGE_BYTES)
            .await?
            .bytes
    };
    // Raster decoding can be expensive even for small compressed images.
    tokio::task::spawn_blocking(move || {
        let media_type = image_type(&bytes)?;
        Some(format!(
            "data:{media_type};base64,{}",
            STANDARD.encode(bytes)
        ))
    })
    .await
    .ok()
    .flatten()
}

fn decode_inline_icon(data: &str) -> Option<Vec<u8>> {
    let (metadata, body) = data.split_once(',')?;
    if !metadata.to_ascii_lowercase().starts_with("image/") || body.len() > MAX_IMAGE_BYTES * 3 {
        return None;
    }
    let body: Vec<_> = percent_decode_str(body).collect();
    let bytes = if metadata
        .rsplit(';')
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case("base64"))
    {
        STANDARD.decode(body).ok()?
    } else {
        body
    };
    (bytes.len() <= MAX_IMAGE_BYTES).then_some(bytes)
}

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if let Ok(format) = image::guess_format(bytes) {
        match format {
            ImageFormat::Png => validate_png(bytes)?,
            ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP | ImageFormat::Ico => {
                let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(MAX_IMAGE_EDGE);
                limits.max_image_height = Some(MAX_IMAGE_EDGE);
                limits.max_alloc = Some(MAX_DECODE_BYTES as u64);
                reader.limits(limits);
                reader.decode().ok()?;
            }
            _ => return None,
        }
        return Some(format.to_mime_type());
    }
    let mut svg = Reader::from_reader(bytes);
    svg.config_mut().trim_text(true);
    loop {
        match svg.read_event().ok()? {
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) => {}
            Event::Text(text) if text.is_empty() => {}
            Event::Empty(element) if element.local_name().as_ref() == b"svg" => break,
            Event::Start(element) if element.local_name().as_ref() == b"svg" => {
                svg.read_to_end(element.name()).ok()?;
                break;
            }
            _ => return None,
        }
    }
    loop {
        match svg.read_event().ok()? {
            Event::Comment(_) | Event::PI(_) => {}
            Event::Text(text) if text.is_empty() => {}
            Event::Eof => return Some("image/svg+xml"),
            _ => return None,
        }
    }
}

fn validate_png(bytes: &[u8]) -> Option<()> {
    let limits = png::Limits {
        bytes: MAX_DECODE_BYTES,
    };
    let mut decoder = png::Decoder::new_with_limits(Cursor::new(bytes), limits);
    decoder.set_ignore_text_chunk(true);
    let mut reader = decoder.read_info().ok()?;
    let info = reader.info();
    if info.width > MAX_IMAGE_EDGE || info.height > MAX_IMAGE_EDGE {
        return None;
    }
    let mut pixels = vec![0; reader.output_buffer_size()?];
    reader.next_frame(&mut pixels).ok()?;
    // next_frame reads the pixels. finish also checks the ending chunks and CRC.
    reader.finish().ok()
}

fn valid_destination(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && match url.host() {
            Some(Host::Domain(host)) => {
                psl::domain(host.as_bytes()).is_some_and(|domain| domain.suffix().is_known())
            }
            Some(Host::Ipv4(ip)) => safe_web_resolution(ip.into(), false),
            Some(Host::Ipv6(ip)) => safe_web_resolution(ip.into(), false),
            None => false,
        }
}

async fn download(url: Url, accept: &'static str, limit: usize) -> Option<Download> {
    tokio::time::timeout(REQUEST_TIMEOUT, download_with_redirects(url, accept, limit))
        .await
        .ok()
        .flatten()
}

async fn download_with_redirects(
    mut url: Url,
    accept: &'static str,
    limit: usize,
) -> Option<Download> {
    for _ in 0..=MAX_REDIRECTS {
        if !valid_destination(&url) {
            return None;
        }
        let mut client = reqwest::Client::builder()
            .use_native_tls()
            .no_proxy()
            .redirect(Policy::none());
        if let Some(Host::Domain(host)) = url.host() {
            let port = url.port_or_known_default()?;
            let addresses: Vec<_> = tokio::net::lookup_host((host, port)).await.ok()?.collect();
            if addresses.is_empty()
                || addresses
                    .iter()
                    .any(|address| !safe_web_resolution(address.ip(), true))
            {
                return None;
            }
            // Pin these addresses so the connection cannot resolve the name again.
            client = client.resolve_to_addrs(host, &addresses);
        }
        let response = client
            .build()
            .ok()?
            .get(url.clone())
            .header(header::ACCEPT, accept)
            .header(header::USER_AGENT, "CursorBYOK")
            .send()
            .await
            .ok()?;
        if response.status().is_redirection() {
            url = url
                .join(response.headers().get(header::LOCATION)?.to_str().ok()?)
                .ok()?;
            continue;
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > limit as u64)
        {
            return None;
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.ok()?;
            if bytes.len() + chunk.len() > limit {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Some(Download { url, bytes });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" /></svg>"#;

    #[test]
    fn finds_site_origins_without_crossing_the_public_suffix() {
        let origins =
            site_origins("https://api.region.example.co.uk:8443/v1?key=example#fragment").unwrap();
        assert_eq!(
            origins.iter().map(Url::as_str).collect::<Vec<_>>(),
            [
                "https://api.region.example.co.uk:8443/",
                "https://api.region.example.co.uk/",
                "https://region.example.co.uk/",
                "https://example.co.uk/",
            ]
        );
        assert_eq!(
            site_origins("https://api.region.example.co.uk.:8443/v1").unwrap(),
            origins
        );
        assert_eq!(
            site_origins("https://example.com./").unwrap(),
            [Url::parse("https://example.com/").unwrap()]
        );
        for base in [
            "https://co.uk/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://user@example.com/",
            "https://relay.local/",
        ] {
            assert!(site_origins(base).is_err(), "{base}");
        }
    }

    #[tokio::test]
    async fn prefers_the_panel_status_logo_over_the_homepage() {
        let origins = site_origins("https://api.example.com/v1").unwrap();
        let icon = find_icon(&origins, |url, _, _| async move {
            let text = match url.path() {
                "/api/status" => {
                    r#"{"success":true,"data":{"system_name":"Example Relay","logo":"relay.svg"}}"#
                }
                "/api/relay.svg" => SVG,
                path => panic!("unexpected request for {path}"),
            };
            Some(Download {
                url,
                bytes: text.as_bytes().to_vec(),
            })
        })
        .await;
        assert_eq!(
            icon,
            Some(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(SVG)
            ))
        );
    }

    #[tokio::test]
    async fn skips_a_png_with_truncated_pixels_or_an_invalid_ending() {
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(3, 2)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let png = encoded.into_inner();
        assert_eq!(image_type(&png), Some("image/png"));
        let data_offset = png.windows(4).position(|chunk| chunk == b"IDAT").unwrap() + 4;
        let mut invalid_crc = png.clone();
        *invalid_crc.last_mut().unwrap() ^= 1;
        let origins = site_origins("https://api.example.com/v1").unwrap();
        for broken in [&png[..data_offset], &png[..png.len() - 4], &invalid_crc] {
            let icon = find_icon(&origins, |url, _, _| async move {
                let bytes = match url.path() {
                    "/api/status" => br#"{"success":true,"data":{"system_name":"Example Relay","logo":"/broken.png"}}"#.to_vec(),
                    "/broken.png" => broken.to_vec(),
                    "/" => br#"<head><link rel="icon" href="/brand.svg"></head>"#.to_vec(),
                    "/brand.svg" => SVG.as_bytes().to_vec(),
                    path => panic!("unexpected request for {path}"),
                };
                Some(Download { url, bytes })
            }).await;
            assert_eq!(
                icon,
                Some(format!(
                    "data:image/svg+xml;base64,{}",
                    STANDARD.encode(SVG)
                ))
            );
        }
    }

    #[tokio::test]
    async fn skips_default_panel_icons_and_keeps_the_current_choice_when_no_brand_is_found() {
        let origins = site_origins("https://api.example.com/v1").unwrap();
        let icon = find_icon(&origins, |url, _, _| async move {
            let text = match url.path() {
                "/api/status" => r#"{"success":true,"data":{"system_name":"New API","logo":""}}"#,
                "/" => r#"<head><link rel="icon" href="/logo.png?v=1"><link rel="shortcut icon" href="/favicon.ico"></head>"#,
                path => panic!("unexpected request for {path}"),
            };
            assert_eq!(url.host_str(), Some("api.example.com"));
            Some(Download { url, bytes: text.as_bytes().to_vec() })
        }).await;
        assert_eq!(icon, None);
    }

    #[tokio::test]
    async fn falls_back_to_a_parent_sites_declared_icon() {
        let origins = site_origins("https://api.example.com/v1").unwrap();
        let icon = find_icon(&origins, |url, _, _| async move {
            if url.host_str() == Some("api.example.com") || url.path() == "/api/status" {
                return None;
            }
            let text = match url.path() {
                "/" => r#"<head><link rel="icon" href="/bad.svg"><link rel="icon" href="/brand.svg"><link rel="apple-touch-icon" href="/touch.png"></head>"#,
                "/bad.svg" => r#"<html><svg></svg></html>"#,
                "/brand.svg" => SVG,
                path => panic!("unexpected request for {path}"),
            };
            Some(Download { url, bytes: text.as_bytes().to_vec() })
        }).await;
        assert_eq!(
            icon,
            Some(format!(
                "data:image/svg+xml;base64,{}",
                STANDARD.encode(SVG)
            ))
        );
    }
}
