use anyhow::{bail, Context, Result};
use native_tls::{Certificate, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use std::str::FromStr;
use std::time::Duration;
use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, Config, NoTls};
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DbTls {
    Disable,
    VerifyFull,
}

impl FromStr for DbTls {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "disable" => Ok(Self::Disable),
            "verify-full" => Ok(Self::VerifyFull),
            _ => bail!("DB_SSL_MODE must be disable or verify-full"),
        }
    }
}

pub async fn connect(
    url: &str,
    mode: DbTls,
    ca: Option<&str>,
    service: &'static str,
) -> Result<Client> {
    let mut config = database_config(url, service)?;
    let client = match mode {
        DbTls::Disable => {
            config.ssl_mode(SslMode::Disable);
            let (client, connection) = config.connect(NoTls).await?;
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    log_connection_error(service, &error);
                }
            });
            client
        }
        DbTls::VerifyFull => {
            config.ssl_mode(SslMode::Require);
            let tls = tls_connector(ca)?;
            let (client, connection) = config.connect(tls).await?;
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    log_connection_error(service, &error);
                }
            });
            client
        }
    };
    Ok(client)
}

fn database_config(url: &str, service: &str) -> Result<Config> {
    let parsed = Url::parse(url).context("database URL is invalid")?;
    if !matches!(parsed.scheme(), "postgres" | "postgresql") {
        bail!("database URL must use postgres or postgresql");
    }
    if parsed.path().trim_matches('/').is_empty() {
        bail!("database URL must name a database");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("database URL must not contain query parameters or fragments");
    }
    let mut config: Config = url
        .parse()
        .context("database URL is not a valid PostgreSQL connection string")?;
    config
        .application_name(service)
        .connect_timeout(Duration::from_secs(5));
    Ok(config)
}

fn tls_connector(ca: Option<&str>) -> Result<MakeTlsConnector> {
    Ok(MakeTlsConnector::new(native_connector(ca)?))
}

fn native_connector(ca: Option<&str>) -> Result<TlsConnector> {
    let mut builder = TlsConnector::builder();
    if let Some(pem) = ca.filter(|value| !value.trim().is_empty()) {
        let normalized = pem.replace("\\n", "\n");
        let certificate = Certificate::from_pem(normalized.as_bytes())
            .context("DB_SSL_CA is not a valid PEM certificate")?;
        builder.add_root_certificate(certificate);
    }
    builder.build().context("database TLS configuration failed")
}

fn log_connection_error(service: &str, error: &tokio_postgres::Error) {
    eprintln!(
        "{{\"level\":\"error\",\"service\":\"{service}\",\"message\":\"postgres connection failed\",\"error\":{error:?}}}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
        IsCa, KeyPair, KeyUsagePurpose,
    };
    use rustls::pki_types::PrivatePkcs8KeyDer;
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::thread;

    fn test_peer() -> (Arc<rustls::ServerConfig>, String) {
        let mut ca_params = CertificateParams::new(vec!["fervor-test-ca".into()]).unwrap();
        ca_params.distinguished_name = DistinguishedName::new();
        ca_params
            .distinguished_name
            .push(DnType::CommonName, "Fervor test CA");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
        ];
        let ca_key = KeyPair::generate().unwrap();
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();

        let mut server_params = CertificateParams::new(vec!["localhost".into()]).unwrap();
        server_params.distinguished_name = DistinguishedName::new();
        server_params
            .distinguished_name
            .push(DnType::CommonName, "localhost");
        server_params.use_authority_key_identifier_extension = true;
        server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let server_key = KeyPair::generate().unwrap();
        let server_cert = server_params
            .signed_by(&server_key, &ca_cert, &ca_key)
            .unwrap();
        let key = PrivatePkcs8KeyDer::from(server_key.serialize_der());
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![server_cert.der().clone()], key.into())
            .unwrap();
        (Arc::new(config), ca_cert.pem())
    }

    fn connect_peer(
        connector: TlsConnector,
        config: Arc<rustls::ServerConfig>,
        host: &str,
    ) -> Result<(), native_tls::HandshakeError<TcpStream>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut connection = rustls::ServerConnection::new(config).unwrap();
            let _ = connection.complete_io(&mut stream);
        });
        let stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let connected = connector.connect(host, stream).map(|_| ());
        server.join().unwrap();
        connected
    }

    #[test]
    fn parses_only_explicit_tls_modes() {
        assert_eq!("disable".parse::<DbTls>().unwrap(), DbTls::Disable);
        assert_eq!("verify-full".parse::<DbTls>().unwrap(), DbTls::VerifyFull);
        assert!("require".parse::<DbTls>().is_err());
    }

    #[test]
    fn rejects_database_url_overrides() {
        assert!(database_config("postgres://core/fervor", "fervor-test").is_ok());
        for value in [
            "https://core/fervor",
            "postgres://core",
            "postgres://core/fervor?sslmode=disable",
            "postgres://core/fervor#other",
        ] {
            assert!(
                database_config(value, "fervor-test").is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn builds_verified_tls_without_unsafe_overrides() {
        assert!(tls_connector(None).is_ok());
        assert!(tls_connector(Some("not a certificate")).is_err());
    }

    #[test]
    fn verifies_tls_peer() {
        let (config, ca) = test_peer();
        connect_peer(
            native_connector(Some(&ca)).unwrap(),
            config.clone(),
            "localhost",
        )
        .unwrap();
        assert!(
            connect_peer(native_connector(None).unwrap(), config.clone(), "localhost").is_err()
        );
        assert!(connect_peer(
            native_connector(Some(&ca)).unwrap(),
            config,
            "wrong.example"
        )
        .is_err());
    }
}
