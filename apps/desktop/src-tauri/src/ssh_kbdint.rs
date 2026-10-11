//! Interactive keyboard-interactive (RFC 4256). Each server round is sent to
//! the window that started the operation, and only that window may answer it
//! with the same operation ID. Server text is untrusted plain text; answers
//! stay in `Zeroizing` and are never logged or echoed in errors.
use super::auth::{AuthFailure, Round, MAX_PROMPTS, MAX_SECRET_BYTES};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{oneshot, watch},
    time::Instant,
};
use zeroize::Zeroizing;

/// How long one round may wait for the user before authentication fails closed.
pub const ROUND_DEADLINE: Duration = Duration::from_secs(120);
const MAX_NAME_BYTES: usize = 256;
const MAX_INSTRUCTIONS_BYTES: usize = 2048;
const MAX_PROMPT_BYTES: usize = 512;
/// Rounds waiting across all windows; an operation has at most one.
const MAX_WAITING: usize = 8;
pub(super) const NO_CHANNEL: &str = "SSH keyboard-interactive prompts need an answer channel";
const CANCELLED: &str = "SSH operation cancelled";

/// One round shown to the user. All text came from the server.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    pub operation_id: String,
    /// 1-based; an answer must name the round it answers.
    pub round: u32,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<PromptField>,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PromptField {
    pub text: String,
    /// `false` means the answer is secret and must not be displayed.
    pub echo: bool,
}

/// Delivers a round to the window that started the operation.
pub type PromptSink = Arc<dyn Fn(AuthPrompt) -> Result<(), String> + Send + Sync>;

struct Waiting {
    owner: String,
    round: u32,
    count: usize,
    reply: oneshot::Sender<Vec<Zeroizing<String>>>,
}

/// Rounds waiting for an answer, by operation ID.
pub(crate) struct Prompts {
    waiting: Mutex<HashMap<String, Waiting>>,
    deadline: Duration,
}

impl Default for Prompts {
    fn default() -> Self {
        Self::with_deadline(ROUND_DEADLINE)
    }
}

impl Prompts {
    pub(crate) fn with_deadline(deadline: Duration) -> Self {
        Self {
            waiting: Mutex::default(),
            deadline: deadline.min(ROUND_DEADLINE),
        }
    }

    /// Hands answers to the waiting round. Rejected answers leave it waiting.
    pub(crate) fn respond(
        &self,
        owner: &str,
        id: &str,
        round: u32,
        answers: Vec<Zeroizing<String>>,
    ) -> Result<(), String> {
        if answers.len() > MAX_PROMPTS
            || answers
                .iter()
                .any(|answer| answer.len() > MAX_SECRET_BYTES || answer.contains('\0'))
        {
            return Err("SSH keyboard-interactive answers are limited to 16 of 1024 bytes".into());
        }
        let mut waiting = self.waiting.lock().map_err(|_| "SSH state unavailable")?;
        let entry = waiting
            .get(id)
            .ok_or("No SSH authentication prompt is waiting for this operation")?;
        if entry.owner != owner {
            return Err("SSH operation not owned by this window".into());
        }
        if entry.round != round {
            return Err("SSH authentication prompt is no longer current".into());
        }
        if entry.count != answers.len() {
            return Err("SSH keyboard-interactive answer count mismatch".into());
        }
        let entry = waiting
            .remove(id)
            .ok_or("No SSH authentication prompt is waiting for this operation")?;
        entry
            .reply
            .send(answers)
            .map_err(|_| "SSH authentication prompt is no longer waiting".into())
    }

    /// Drops the owner's waiting rounds; their operations fail as cancelled.
    pub(crate) fn close_owner(&self, owner: &str) {
        self.waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| entry.owner != owner);
    }

    pub(crate) fn clear(&self) {
        self.waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.waiting.lock().unwrap().len()
    }

    fn register<'a>(
        &'a self,
        owner: &str,
        id: &'a str,
        round: u32,
        count: usize,
        reply: oneshot::Sender<Vec<Zeroizing<String>>>,
    ) -> Result<Registered<'a>, AuthFailure> {
        let mut waiting = self
            .waiting
            .lock()
            .map_err(|_| AuthFailure::Failed("SSH state unavailable".into()))?;
        if waiting.contains_key(id) || waiting.len() >= MAX_WAITING {
            return Err(AuthFailure::Failed(
                "SSH authentication prompt capacity reached".into(),
            ));
        }
        waiting.insert(
            id.into(),
            Waiting {
                owner: owner.into(),
                round,
                count,
                reply,
            },
        );
        Ok(Registered {
            prompts: self,
            id,
            round,
        })
    }
}

/// Removes a round that ended without an answer (cancel, timeout, error).
struct Registered<'a> {
    prompts: &'a Prompts,
    id: &'a str,
    round: u32,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        let mut waiting = self
            .prompts
            .waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if waiting
            .get(self.id)
            .is_some_and(|entry| entry.round == self.round)
        {
            waiting.remove(self.id);
        }
    }
}

/// Asks one operation's window to answer server rounds.
pub(crate) struct Prompter {
    pub(crate) prompts: Arc<Prompts>,
    pub(crate) owner: String,
    pub(crate) id: String,
    pub(crate) sink: PromptSink,
    pub(crate) clock: Clock,
}

impl Prompter {
    pub(super) async fn ask(
        &self,
        number: u32,
        round: Round,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Vec<Zeroizing<String>>, AuthFailure> {
        let cancelled = || AuthFailure::Failed(CANCELLED.into());
        if *cancel.borrow_and_update() {
            return Err(cancelled());
        }
        let (reply, answer) = oneshot::channel();
        // Registered before the window sees the round, so no answer can race it.
        let _registered =
            self.prompts
                .register(&self.owner, &self.id, number, round.prompts.len(), reply)?;
        let event = AuthPrompt {
            operation_id: self.id.clone(),
            round: number,
            name: plain(&round.name, MAX_NAME_BYTES),
            instructions: plain(&round.instructions, MAX_INSTRUCTIONS_BYTES),
            prompts: round
                .prompts
                .iter()
                .map(|(text, echo)| PromptField {
                    text: plain(text, MAX_PROMPT_BYTES),
                    echo: *echo,
                })
                .collect(),
            expires_in_seconds: self.prompts.deadline.as_secs().max(1),
        };
        (self.sink)(event).map_err(|_| {
            AuthFailure::Failed("SSH authentication prompt could not be shown".into())
        })?;
        // The operation's network deadline does not run while the user types.
        let _paused = self.clock.pause();
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(cancelled()),
            answer = tokio::time::timeout(self.prompts.deadline, answer) => match answer {
                Ok(Ok(answers)) => Ok(answers),
                Ok(Err(_)) => Err(cancelled()),
                Err(_) => Err(AuthFailure::Failed(
                    "SSH keyboard-interactive prompt timed out".into(),
                )),
            },
        }
    }
}

#[derive(Clone, Copy)]
enum Phase {
    Running(Instant),
    Paused(Duration),
}

/// Network deadline of one operation. Time spent waiting for the user is
/// excluded; each wait is bounded separately by the round deadline.
#[derive(Clone)]
pub(crate) struct Clock(Arc<watch::Sender<Phase>>);

impl Clock {
    pub(crate) fn new(budget: Duration) -> Self {
        Self(Arc::new(watch::Sender::new(Phase::Running(
            Instant::now() + budget,
        ))))
    }

    /// Completes once the unpaused time exceeds the budget.
    pub(crate) async fn expired(&self) {
        let mut phase = self.0.subscribe();
        loop {
            let current = *phase.borrow_and_update();
            match current {
                Phase::Running(at) => tokio::select! {
                    _ = tokio::time::sleep_until(at) => return,
                    changed = phase.changed() => if changed.is_err() { return },
                },
                Phase::Paused(_) => {
                    if phase.changed().await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    fn pause(&self) -> Paused<'_> {
        self.0.send_modify(|phase| {
            if let Phase::Running(at) = *phase {
                *phase = Phase::Paused(at.saturating_duration_since(Instant::now()));
            }
        });
        Paused(self)
    }
}

struct Paused<'a>(&'a Clock);

impl Drop for Paused<'_> {
    fn drop(&mut self) {
        self.0 .0.send_modify(|phase| {
            if let Phase::Paused(rest) = *phase {
                *phase = Phase::Running(Instant::now() + rest);
            }
        });
    }
}

/// Server text as bounded plain text: control and bidirectional override
/// characters are made visible so a prompt cannot disguise itself.
fn plain(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars().filter(|c| *c != '\r') {
        let c = if (c.is_control() && c != '\n' && c != '\t')
            || matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        {
            '\u{FFFD}'
        } else {
            c
        };
        if out.len() + c.len_utf8() > max {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers(items: &[&str]) -> Vec<Zeroizing<String>> {
        items
            .iter()
            .map(|s| Zeroizing::new(s.to_string()))
            .collect()
    }

    fn round(prompts: &[(&str, bool)]) -> Round {
        Round {
            name: "name".into(),
            instructions: "instructions".into(),
            prompts: prompts.iter().map(|(t, e)| (t.to_string(), *e)).collect(),
        }
    }

    #[test]
    fn server_text_is_bounded_and_controls_are_visible() {
        assert_eq!(plain("a\r\nb\tc", 64), "a\nb\tc");
        assert_eq!(plain("x\u{1b}[31m\u{202E}y", 64), "x\u{FFFD}[31m\u{FFFD}y");
        assert_eq!(plain("<b>Code</b>: ", 64), "<b>Code</b>: ");
        let long = plain(&"中".repeat(100), 10);
        assert_eq!(long, "中中中…");
    }

    #[test]
    fn answers_are_bound_to_owner_round_and_count() {
        let prompts = Prompts::default();
        let (reply, mut answer) = oneshot::channel();
        let registered = prompts.register("main", "op", 2, 1, reply).unwrap();
        assert!(prompts
            .register("main", "op", 3, 1, oneshot::channel().0)
            .is_err());
        let err = |r: Result<(), String>| r.unwrap_err();
        assert_eq!(
            err(prompts.respond("other", "op", 2, answers(&["x"]))),
            "SSH operation not owned by this window"
        );
        assert!(
            err(prompts.respond("main", "op", 1, answers(&["x"]))).contains("no longer current")
        );
        assert!(err(prompts.respond("main", "op", 2, answers(&[]))).contains("count mismatch"));
        assert!(err(prompts.respond("main", "op", 2, answers(&["a\0"]))).contains("limited"));
        let long = "x".repeat(MAX_SECRET_BYTES + 1);
        assert!(err(prompts.respond("main", "op", 2, answers(&[&long]))).contains("limited"));
        assert!(err(prompts.respond("main", "missing", 2, answers(&["x"]))).contains("No SSH"));
        // Rejected attempts leave the round waiting; the right one is taken once.
        assert!(answer.try_recv().is_err());
        prompts.respond("main", "op", 2, answers(&["ok"])).unwrap();
        assert_eq!(answer.try_recv().unwrap()[0].as_str(), "ok");
        assert!(prompts.respond("main", "op", 2, answers(&["ok"])).is_err());
        drop(registered);
        assert_eq!(prompts.len(), 0);
    }

    #[test]
    fn closing_an_owner_or_dropping_a_round_removes_it() {
        let prompts = Prompts::default();
        let (reply, mut answer) = oneshot::channel();
        let registered = prompts.register("main", "op", 1, 1, reply).unwrap();
        prompts.close_owner("other");
        assert_eq!(prompts.len(), 1);
        prompts.close_owner("main");
        assert_eq!(prompts.len(), 0);
        assert!(answer.try_recv().is_err());
        drop(registered);
        let registered = prompts
            .register("main", "op", 1, 1, oneshot::channel().0)
            .unwrap();
        drop(registered);
        assert_eq!(prompts.len(), 0);
    }

    fn prompter(
        prompts: Arc<Prompts>,
        clock: Clock,
    ) -> (Prompter, tokio::sync::mpsc::UnboundedReceiver<AuthPrompt>) {
        let (sender, events) = tokio::sync::mpsc::unbounded_channel();
        let sink: PromptSink = Arc::new(move |p| sender.send(p).map_err(|e| e.to_string()));
        let prompter = Prompter {
            prompts,
            owner: "main".into(),
            id: "op".into(),
            sink,
            clock,
        };
        (prompter, events)
    }

    #[tokio::test]
    async fn waiting_pauses_the_network_deadline_and_times_out() {
        let prompts = Arc::new(Prompts::with_deadline(Duration::from_millis(300)));
        let clock = Clock::new(Duration::from_millis(100));
        let (prompter, mut events) = prompter(prompts.clone(), clock.clone());
        let (_cancel, receiver) = watch::channel(false);
        let ask = prompter.ask(1, round(&[("Code: ", true)]), receiver);
        tokio::pin!(ask);
        // The round outlives the 100 ms network budget without expiring it.
        tokio::select! {
            _ = clock.expired() => panic!("deadline ran while waiting for the user"),
            result = &mut ask => assert_eq!(result.err().unwrap().message(), "SSH keyboard-interactive prompt timed out"),
        }
        let event = events.recv().await.unwrap();
        assert_eq!((event.round, event.prompts[0].echo), (1, true));
        assert_eq!(prompts.len(), 0);
        // Resumed afterwards: the remaining budget still expires.
        tokio::time::timeout(Duration::from_secs(1), clock.expired())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancellation_ends_a_waiting_round() {
        let prompts = Arc::new(Prompts::default());
        let (prompter, mut events) = prompter(prompts.clone(), Clock::new(Duration::from_secs(5)));
        let (cancel, receiver) = watch::channel(false);
        let task = async {
            events.recv().await.unwrap();
            cancel.send_replace(true);
        };
        let (result, ()) = tokio::join!(
            prompter.ask(1, round(&[("Password: ", false)]), receiver),
            task
        );
        assert_eq!(result.err().unwrap().message(), CANCELLED);
        assert_eq!(prompts.len(), 0);
    }
}
