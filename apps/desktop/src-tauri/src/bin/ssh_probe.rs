//! Explicit one-shot fixture verifier. Fingerprint must come from the fixture's
//! independent known_hosts, never from this client's first network response.
use new_windterm_desktop::ssh::{Request, Ssh};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err(
            "Usage: ssh_probe HOST PORT USER ABSOLUTE_KEY_PATH EXPECTED_SHA256_FINGERPRINT".into(),
        );
    }
    let request = Request {
        host: args[0].clone(),
        port: args[1].parse().map_err(|_| "Invalid port")?,
        username: args[2].clone(),
        private_key_path: args[3].clone(),
    };
    let service = Ssh::default();
    let scope = service.context("probe")?;
    let challenge = service
        .probe("probe", &uuid::Uuid::new_v4().to_string(), request, &scope)
        .await?;
    if challenge.fingerprint != args[4] {
        service.reject("probe", &challenge.challenge_token)?;
        return Err(
            "Host fingerprint does not match the independently supplied fixture fingerprint".into(),
        );
    }
    let output = service
        .accept(
            "probe",
            &uuid::Uuid::new_v4().to_string(),
            &challenge.challenge_token,
            &scope,
        )
        .await?;
    if output.stdout != "P0_SSH_OK 中文 🌏\n".as_bytes()
        || !output.stderr.is_empty()
        || output.exit_code != 7
    {
        return Err("Unexpected fixture output or exit status".into());
    }
    println!(
        "PASS: independently pinned Ed25519 host, public key authentication, UTF-8 output, exit 7"
    );
    Ok(())
}
