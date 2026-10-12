//! Flow control for forwarded connections that share one SSH connection
//! with an interactive terminal: live connection counts and a bounded,
//! stall-limited delivery of server data to the local side.
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

/// Counts one relayed connection for as long as its task exists, including
/// when the task is aborted before it first runs.
pub(super) struct Live(Arc<AtomicUsize>);

impl Live {
    pub(super) fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count.clone())
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Server bytes a relay may hold for a local side that reads slower than
/// they arrive. russh 0.64.1 widens the server's window as soon as data
/// arrives and then waits for room in the channel's bounded queue, so a
/// channel nobody drains holds up every channel of the connection, including
/// a terminal sharing it. Kept small: a terminal can have about a thousand
/// relays (16 forwards of 64 connections, plus remote ones).
const BACKLOG: usize = 64 * 1024;
/// How long a relay may wait only for its local side while it holds more
/// than [`BACKLOG`] (and so holds up the connection): one limit per such
/// episode, which ends once the local side has caught up to the backlog.
/// After the server ended the channel nothing else waits for the relay, so
/// the limit then applies to each write instead. Past it, the relay is
/// disconnected.
pub(super) const STALL: Duration = Duration::from_secs(5);

/// How the server's side of a relayed channel ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Delivery {
    /// Channel EOF: the server sends no more, but may still receive.
    Eof,
    /// Channel close or the connection ended: nothing more in either direction.
    Closed,
    /// The local side failed or stalled past its limit.
    Failed,
}

/// Copies the server's data to `local` until the server ends the channel
/// (everything received was written), or until `local` fails or, with a
/// `stall` limit, stalls past it. The channel keeps being drained while
/// `local` is behind by up to [`BACKLOG`]. Without a limit, a local side
/// over the backlog is simply waited for.
pub(super) async fn deliver<W>(
    from_remote: &mut russh::ChannelReadHalf,
    local: &mut W,
    stall: Option<Duration>,
) -> Delivery
where
    W: tokio::io::AsyncWrite + Unpin,
{
    enum Step {
        Received(Option<russh::ChannelMsg>),
        Wrote(std::io::Result<usize>),
    }
    let mut queue = std::collections::VecDeque::new();
    let (mut held, mut sent) = (0usize, 0usize);
    // Set once the server ended the channel; returned when all is written.
    let mut ended = None;
    // Set while only `local` can make progress; one limit per such episode,
    // so a local side that accepts a byte now and then cannot extend it.
    let mut deadline = None;
    loop {
        let step = match queue.front() {
            None => match ended {
                Some(how) => return how,
                None => Step::Received(from_remote.wait().await),
            },
            Some(front) => {
                // `front` is the `Bytes` of `ChannelMsg::Data`; nothing is copied.
                let pending = &AsRef::<[u8]>::as_ref(front)[sent..];
                if ended.is_none() && held <= BACKLOG {
                    deadline = None;
                    tokio::select! {
                        message = from_remote.wait() => Step::Received(message),
                        written = local.write(pending) => Step::Wrote(written),
                    }
                } else if let Some(limit) = stall {
                    let until =
                        *deadline.get_or_insert_with(|| tokio::time::Instant::now() + limit);
                    match tokio::time::timeout_at(until, local.write(pending)).await {
                        Ok(written) => Step::Wrote(written),
                        Err(_) => return Delivery::Failed,
                    }
                } else {
                    Step::Wrote(local.write(pending).await)
                }
            }
        };
        match step {
            // An empty packet carries nothing (and would read as a closed
            // local side once written).
            Step::Received(Some(russh::ChannelMsg::Data { data })) if !data.is_empty() => {
                held += data.len();
                queue.push_back(data);
            }
            Step::Received(Some(russh::ChannelMsg::Eof)) => ended = Some(Delivery::Eof),
            Step::Received(Some(russh::ChannelMsg::Close) | None) => {
                ended = Some(Delivery::Closed);
            }
            Step::Received(Some(_)) => {}
            Step::Wrote(Ok(n @ 1..)) => {
                held -= n;
                sent += n;
                if queue.front().is_some_and(|front| sent == front.len()) {
                    queue.pop_front();
                    sent = 0;
                }
                if ended.is_some() {
                    deadline = None; // no longer holding up the connection
                }
            }
            Step::Wrote(_) => return Delivery::Failed,
        }
    }
}

/// Waits until the server closes the channel or the connection ends.
pub(super) async fn closed(from_remote: &mut russh::ChannelReadHalf) {
    while let Some(message) = from_remote.wait().await {
        if matches!(message, russh::ChannelMsg::Close) {
            return;
        }
    }
}
