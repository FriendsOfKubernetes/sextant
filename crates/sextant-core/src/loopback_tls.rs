//! TLS to the local end of one of Sextant's own port forwards (`127.0.0.1`): the certificate (usually self-signed by
//! the service behind the forward) is skipped for the loopback address only, the handshake's signatures are still
//! checked, HTTP/1.1. Used by an extension's service requests (ADR-0158); written first for the Argo CD API client of
//! ADR-0027, which moved into the Argo CD extension (ADR-0162).

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

/// A TLS connector that skips the certificate only of a server at the loopback address.
pub(crate) fn loopback_tls_connector() -> tokio_rustls::TlsConnector {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(LoopbackVerifier(provider)))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

/// The server name of the loopback end: `127.0.0.1`, the only one [`LoopbackVerifier`] accepts.
pub(crate) fn loopback_server_name() -> ServerName<'static> {
    ServerName::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST).into())
}

/// Accepts the certificate of a server on the loopback address only (the local end of a port forward); the
/// signatures of the handshake are still checked.
#[derive(Debug)]
struct LoopbackVerifier(Arc<CryptoProvider>);

impl ServerCertVerifier for LoopbackVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match server_name {
            ServerName::IpAddress(ip) if IpAddr::from(*ip).is_loopback() => {
                Ok(ServerCertVerified::assertion())
            }
            _ => Err(rustls::Error::General(
                "the certificate is only skipped for 127.0.0.1".into(),
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_certificate_is_skipped_only_for_the_loopback_address() {
        let verifier = LoopbackVerifier(Arc::new(rustls::crypto::ring::default_provider()));
        let cert = CertificateDer::from(vec![0u8; 4]);
        let check = |name: ServerName<'static>| {
            verifier
                .verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
                .is_ok()
        };

        assert!(check(ServerName::IpAddress(
            IpAddr::V4(Ipv4Addr::LOCALHOST).into()
        )));
        assert!(!check(ServerName::try_from("argocd.example.com").unwrap()));
        assert!(!check(ServerName::IpAddress(
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)).into()
        )));
    }
}
