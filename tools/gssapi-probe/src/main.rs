//! C14 evaluation only. This binary is not part of the desktop product.
mod gss;

use gss::{Error, GssFailure, Kerberos, KERBEROS_DER};
use russh::{
    client,
    keys::{HashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use std::{env, sync::Arc, time::Duration};

struct PinnedHost(String);
impl client::Handler for PinnedHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        Ok(key.fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}

fn required(name: &str) -> Result<String, Error> {
    env::var(name).map_err(|_| format!("missing {name}").into())
}

async fn probe() -> Result<bool, Error> {
    if !cfg!(target_os = "linux") || required("P0_GSSAPI_ISOLATED")? != "1" {
        return Err("only run inside the disposable Linux fixture".into());
    }
    // Keep accidental invocations away from default system/user Kerberos state.
    for key in [
        "KRB5_CONFIG",
        "KRB5_KDC_PROFILE",
        "KRB5CCNAME",
        "KRB5_KTNAME",
        "KRB5_CLIENT_KTNAME",
    ] {
        let value = required(key)?;
        if !value.trim_start_matches("FILE:").starts_with("/fixture/") {
            return Err(format!("{key} must be inside /fixture").into());
        }
    }
    let port = required("P0_GSSAPI_PORT")?.parse::<u16>()?;
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(10)),
        ..Default::default()
    };
    let mut session = client::connect(
        Arc::new(config),
        ("127.0.0.1", port),
        PinnedHost(required("P0_GSSAPI_FINGERPRINT")?),
    )
    .await?;
    let mut kerberos = Kerberos::new(&required("P0_GSSAPI_SERVICE")?)?;
    let result = session
        .authenticate_gssapi_with_mic("p0gss", vec![KERBEROS_DER.to_vec()], &mut kerberos)
        .await;
    let authenticated = match result {
        Ok(result) => result.success(),
        Err(error) => {
            // A transport/protocol/invariant error must fail the fixture, not
            // masquerade as a successful negative authentication case.
            if error.downcast_ref::<GssFailure>().is_none() {
                return Err(error);
            }
            eprintln!("P0_GSSAPI_AUTH_REJECTED {error}");
            false
        }
    };
    if !authenticated {
        session
            .disconnect(Disconnect::ByApplication, "fixture finished", "en")
            .await?;
        return Ok(false);
    }
    let mut channel = session.channel_open_session().await?;
    channel.exec(true, "p0-gssapi-proof").await?;
    let mut output = Vec::new();
    let mut exit = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                if output.len() + data.len() > 1024 {
                    return Err("remote output limit exceeded".into());
                }
                output.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            _ => {}
        }
    }
    if exit != Some(0) || output != b"P0_GSSAPI_REMOTE_OK\n" {
        return Err("authenticated session did not execute the fixture proof".into());
    }
    session
        .disconnect(Disconnect::ByApplication, "fixture finished", "en")
        .await?;
    Ok(true)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let code = match tokio::time::timeout(Duration::from_secs(25), probe()).await {
        Ok(Ok(true)) => {
            println!("P0_GSSAPI_ACCEPTED");
            0
        }
        Ok(Ok(false)) => {
            println!("P0_GSSAPI_REJECTED");
            10
        }
        Ok(Err(error)) => {
            eprintln!("P0_GSSAPI_ERROR {error}");
            2
        }
        Err(_) => {
            eprintln!("P0_GSSAPI_ERROR timeout");
            2
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{
        client::Handler,
        keys::{Algorithm, PrivateKey},
    };

    #[tokio::test]
    async fn host_key_must_match_the_fixture_pin() {
        let private =
            PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap();
        let public = PublicKeyOrCertificate::PublicKey {
            key: private.public_key().clone(),
            hash_alg: None,
        };
        let pin = private
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        assert!(PinnedHost(pin).check_server_key(&public).await.unwrap());
        assert!(!PinnedHost("SHA256:incorrect".into())
            .check_server_key(&public)
            .await
            .unwrap());
    }
}
