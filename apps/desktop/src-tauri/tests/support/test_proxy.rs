//! Loopback HTTP CONNECT and SOCKS5 proxies for tests. Each records the
//! tunnels it opened, so a test can show that an operation really crossed
//! the proxy. Upstream connections only ever go to 127.0.0.1.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Http,
    Socks5,
}

pub struct Proxy {
    pub address: SocketAddr,
    /// Upstream ports of the tunnels opened so far, in order.
    pub tunnels: Arc<Mutex<Vec<u16>>>,
    task: JoinHandle<()>,
}

impl Proxy {
    pub fn tunnels(&self) -> Vec<u16> {
        self.tunnels.lock().unwrap().clone()
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts a proxy; with `credentials`, clients must authenticate.
pub async fn start(kind: Kind, credentials: Option<(&'static str, &'static str)>) -> Proxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let tunnels = Arc::new(Mutex::new(Vec::new()));
    let opened = tunnels.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let opened = opened.clone();
            tokio::spawn(async move {
                let target = match kind {
                    Kind::Http => http(&mut client, credentials).await,
                    Kind::Socks5 => socks5(&mut client, credentials).await,
                };
                if let Some(port) = target {
                    let Ok(mut upstream) = TcpStream::connect(("127.0.0.1", port)).await else {
                        return;
                    };
                    opened.lock().unwrap().push(port);
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                }
            });
        }
    });
    Proxy {
        address,
        tunnels,
        task,
    }
}

pub fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                TABLE[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    out
}

async fn http(client: &mut TcpStream, credentials: Option<(&str, &str)>) -> Option<u16> {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(client.read_u8().await.ok()?);
    }
    let text = String::from_utf8(header).ok()?;
    let authorized = credentials.is_none_or(|(user, password)| {
        text.contains(&format!(
            "Proxy-Authorization: Basic {}",
            base64(format!("{user}:{password}").as_bytes())
        ))
    });
    if !authorized {
        let _ = client
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
            .await;
        return None;
    }
    let port = text
        .split_whitespace()
        .nth(1)?
        .rsplit(':')
        .next()?
        .parse()
        .ok()?;
    client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await
        .ok()?;
    Some(port)
}

async fn socks5(client: &mut TcpStream, credentials: Option<(&str, &str)>) -> Option<u16> {
    let mut greeting = [0; 2];
    client.read_exact(&mut greeting).await.ok()?;
    let mut methods = vec![0; greeting[1] as usize];
    client.read_exact(&mut methods).await.ok()?;
    if let Some((user, password)) = credentials {
        if !methods.contains(&2) {
            let _ = client.write_all(&[5, 0xff]).await;
            return None;
        }
        client.write_all(&[5, 2]).await.ok()?;
        let mut version = [0; 2];
        client.read_exact(&mut version).await.ok()?;
        let mut name = vec![0; version[1] as usize];
        client.read_exact(&mut name).await.ok()?;
        let length = client.read_u8().await.ok()?;
        let mut secret = vec![0; length as usize];
        client.read_exact(&mut secret).await.ok()?;
        let ok = name == user.as_bytes() && secret == password.as_bytes();
        client.write_all(&[1, u8::from(!ok)]).await.ok()?;
        if !ok {
            return None;
        }
    } else {
        client.write_all(&[5, 0]).await.ok()?;
    }
    let mut request = [0; 4];
    client.read_exact(&mut request).await.ok()?;
    let length = match request[3] {
        1 => 4,
        4 => 16,
        _ => client.read_u8().await.ok()? as usize,
    };
    let mut address = vec![0; length + 2];
    client.read_exact(&mut address).await.ok()?;
    client
        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        .await
        .ok()?;
    Some(u16::from_be_bytes([address[length], address[length + 1]]))
}
