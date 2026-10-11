//! Bounded, loopback-only manual fixture. Enter a newline on stdin to stop.
#[path = "../../tests/support/ssh_terminal_fixture.rs"]
mod fixture;
#[tokio::main]
async fn main() {
    let mut server = fixture::Fixture::start().await;
    assert_eq!(server.denial.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(
        server.rekey_limit.load(std::sync::atomic::Ordering::SeqCst),
        1 << 30
    );
    println!("host=127.0.0.1\nport={}\nusername=fixture\nprivateKeyPath={}\nfingerprint={}\nStop: press Enter; automatic stop after 600 seconds", server.port, server.key_path.display(), server.fingerprint());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        let _ = stop.send(());
    });
    tokio::select! { _ = stopped => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => {} }
    server.stop().await;
    println!(
        "Stopped; active fixture sessions={}; auth attempts={}",
        server.active.load(std::sync::atomic::Ordering::SeqCst),
        server
            .authentications
            .load(std::sync::atomic::Ordering::SeqCst)
    );
}
