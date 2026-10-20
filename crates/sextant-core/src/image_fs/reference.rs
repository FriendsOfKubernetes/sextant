//! Image references (`[registry/]repository[:tag][@digest]`) and the rule for which hosts may be contacted.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use super::{invalid, limits};
use crate::CoreResult;

/// Docker Hub's name in references and the host its API answers on.
pub const DOCKER_HUB: &str = "docker.io";
pub const DOCKER_HUB_API: &str = "registry-1.docker.io";

/// A parsed image reference. `registry` is `host[:port]` in lowercase; `docker.io` stands for Docker Hub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    pub registry: String,
    pub repository: String,
    pub tag: Option<String>,
    /// `sha256:<64 hex>`.
    pub digest: Option<String>,
}

impl ImageRef {
    /// Parses a reference as `docker pull` reads it: the first component is a registry when it has a `.` or a `:` (or
    /// is `localhost`, which [`check_host`] then refuses); Docker Hub's official images get `library/`.
    pub fn parse(text: &str) -> CoreResult<Self> {
        let text = text.trim();
        if text.is_empty() {
            return Err(invalid("the image reference is empty"));
        }
        if text.len() > limits::MAX_REFERENCE_BYTES {
            return Err(invalid("the image reference is too long"));
        }
        if text.contains("://") {
            return Err(invalid(
                "an image reference has no scheme: write registry/repository:tag",
            ));
        }
        let (rest, digest) = match text.split_once('@') {
            Some((rest, digest)) => {
                check_digest(digest)?;
                (rest, Some(digest.to_owned()))
            }
            None => (text, None),
        };
        // A tag is after the last ':' that follows the last '/' (a registry port comes before a '/').
        let last_slash = rest.rfind('/').map_or(0, |i| i + 1);
        let (name, tag) = match rest[last_slash..].rfind(':') {
            Some(i) => {
                let tag = &rest[last_slash + i + 1..];
                check_tag(tag)?;
                (&rest[..last_slash + i], Some(tag.to_owned()))
            }
            None => (rest, None),
        };
        let (registry, repository) = match name.split_once('/') {
            Some((first, path))
                if first.contains('.') || first.contains(':') || first == "localhost" =>
            {
                (first.to_ascii_lowercase(), path.to_owned())
            }
            _ => (DOCKER_HUB.to_owned(), name.to_owned()),
        };
        let registry = match registry.as_str() {
            "index.docker.io" | "registry-1.docker.io" => DOCKER_HUB.to_owned(),
            _ => registry,
        };
        let repository = if registry == DOCKER_HUB && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };
        check_host(&registry)?;
        check_repository(&repository)?;
        Ok(Self {
            registry,
            repository,
            tag,
            digest,
        })
    }

    /// The host (and port) the registry API answers on.
    pub fn api_host(&self) -> &str {
        if self.registry == DOCKER_HUB {
            DOCKER_HUB_API
        } else {
            &self.registry
        }
    }

    /// What `/v2/<repository>/manifests/<…>` asks for: the digest, else the tag, else `latest`.
    pub fn manifest_reference(&self) -> &str {
        self.digest
            .as_deref()
            .or(self.tag.as_deref())
            .unwrap_or("latest")
    }

    /// The same image pinned to `digest`.
    pub fn with_digest(&self, digest: &str) -> CoreResult<Self> {
        check_digest(digest)?;
        Ok(Self {
            digest: Some(digest.to_owned()),
            ..self.clone()
        })
    }

    /// The full reference as shown.
    pub fn display(&self) -> String {
        let mut out = format!("{}/{}", self.registry, self.repository);
        if let Some(tag) = &self.tag {
            out.push(':');
            out.push_str(tag);
        }
        if let Some(digest) = &self.digest {
            out.push('@');
            out.push_str(digest);
        }
        out
    }
}

/// `sha256:` and 64 lowercase hex digits; other algorithms are refused.
pub fn check_digest(digest: &str) -> CoreResult<()> {
    match digest.strip_prefix("sha256:") {
        Some(hex)
            if hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            Ok(())
        }
        _ => Err(invalid("only sha256 digests are supported")),
    }
}

fn check_tag(tag: &str) -> CoreResult<()> {
    let ok = !tag.is_empty()
        && tag.len() <= 128
        && tag
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "a tag is letters, digits, '_', '.' and '-' (at most 128)",
        ))
    }
}

fn check_repository(repository: &str) -> CoreResult<()> {
    let ok = !repository.is_empty()
        && repository.len() <= 255
        && repository.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                && part.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
                })
        });
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "a repository is lowercase letters, digits and '.', '_', '-' between slashes",
        ))
    }
}

/// `host[:port]` of a registry, a token realm or a blob redirect: a name or an IP literal (IPv6 in brackets) that is
/// not this machine, link-local (cloud metadata) or otherwise never a registry ([`forbidden_ip`]); `localhost` names
/// are refused too. A name's resolved addresses are checked again when it is resolved (the app's resolver).
pub fn check_host(host_port: &str) -> CoreResult<()> {
    let (host, port) = split_host_port(host_port)?;
    if let Some(port) = port
        && (port.is_empty()
            || port.len() > 5
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().map_or(true, |p| p == 0))
    {
        return Err(invalid("the registry port is not a number from 1 to 65535"));
    }
    check_host_name(host)
}

/// A bare host (no port) by the same rule as [`check_host`].
pub fn check_host_name(host: &str) -> CoreResult<()> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        if forbidden_ip(ip) {
            return Err(invalid(
                "the registry address is this computer or a link-local address, which Sextant never contacts",
            ));
        }
        return Ok(());
    }
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    if lower.is_empty() || lower.len() > 253 || !lower.split('.').all(label_ok) {
        return Err(invalid("the registry host is not a valid name"));
    }
    if lower == "localhost" || lower.ends_with(".localhost") {
        return Err(invalid(
            "the registry is this computer (localhost), which Sextant never contacts",
        ));
    }
    Ok(())
}

fn split_host_port(text: &str) -> CoreResult<(&str, Option<&str>)> {
    if let Some(rest) = text.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| invalid("the registry host is not a valid address"))?;
        let host = &text[..end + 2];
        let after = &rest[end + 1..];
        return match after.strip_prefix(':') {
            Some(port) => Ok((host, Some(port))),
            None if after.is_empty() => Ok((host, None)),
            None => Err(invalid("the registry host is not a valid address")),
        };
    }
    Ok(match text.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (text, None),
    })
}

/// Addresses Sextant never sends a registry request to: loopback, link-local (`169.254.0.0/16` holds cloud metadata
/// services; `fe80::/10`), unspecified, multicast, broadcast, and the IPv4-mapped/compatible forms of those. Private
/// ranges are allowed: in-cluster and corporate registries live there.
pub fn forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => forbidden_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return forbidden_v4(v4);
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xffc0) == 0xfe80
                // IPv4-compatible (deprecated) ::a.b.c.d
                || (v6.segments()[..6].iter().all(|&s| s == 0) && forbidden_v4(ipv4_tail(v6)))
        }
    }
}

fn ipv4_tail(v6: Ipv6Addr) -> Ipv4Addr {
    let o = v6.octets();
    Ipv4Addr::new(o[12], o[13], o[14], o[15])
}

fn forbidden_v4(v4: Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_multicast()
        || v4.is_broadcast()
        || v4.octets()[0] == 0
}

/// The digest in a container status' `imageID` (`docker-pullable://repo@sha256:…`, `repo@sha256:…`), if any.
pub fn digest_of_image_id(image_id: &str) -> Option<String> {
    let (_, digest) = image_id.rsplit_once('@')?;
    check_digest(digest).ok()?;
    Some(digest.to_owned())
}
