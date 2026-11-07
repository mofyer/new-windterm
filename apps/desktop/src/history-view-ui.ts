import { HistoryView, type HistoryViewTarget } from "./history-view";

/**
 * Entry points of the read-only history view (P1 slice 5, step 7): one text button in the
 * terminal tool bar, next to the other actions on the current session, and one command palette
 * entry. Both act on the active tab. Each session has at most one view; it lives in the session's
 * pane and is attached to the session's close path (`Session.historyView`, requirement R2), so
 * closing the tab disposes it with its search and caches.
 */
export interface HistoryViewSession extends HistoryViewTarget {
  /** Set while a view is open; the session lifecycle disposes it on close. */
  historyView?: { dispose(): void };
  readonly disposed: boolean;
  readonly closing: boolean;
}

export interface HistoryViewsHost {
  active(): HistoryViewSession | undefined;
  notify(message: string): void;
}

export interface HistoryViews {
  /** Opens the active session's view, or focuses it if open. */
  open(): void;
  /** Focuses the view of `session` if one is open; false otherwise. */
  focus(session: HistoryViewSession): boolean;
  /** Reflects whether the active session has an open view on the tool bar button. */
  paint(session: HistoryViewSession | undefined): void;
  readonly command: { readonly name: string; readonly action: () => void };
}

export function createHistoryViews(toolbar: HTMLElement, host: HistoryViewsHost): HistoryViews {
  const views = new Map<HistoryViewSession, HistoryView>();
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "history-view-toggle";
  toggle.textContent = "历史与搜索";
  toggle.title = "查看并搜索当前会话的全部历史（含已压缩的部分）";
  toggle.setAttribute("aria-pressed", "false");
  toolbar.insertBefore(toggle, toolbar.querySelector(".terminal-actions") ?? toolbar.querySelector("#sample-run"));

  /** Drops every reference the registry and the session hold to a closed view. */
  function forget(session: HistoryViewSession, view: HistoryView, handle: { dispose(): void }) {
    if (views.get(session) === view) views.delete(session);
    if (session.historyView === handle) session.historyView = undefined;
  }

  function open() {
    const session = host.active();
    if (!session || session.disposed || session.closing) {
      host.notify("历史与搜索需要一个打开的会话。");
      return;
    }
    const existing = views.get(session);
    if (existing?.open) {
      existing.focus();
      return;
    }
    // What the session's close path disposes; it also drops the registry entry.
    const handle = {
      dispose: () => {
        view.dispose();
        forget(session, view, handle);
      },
    };
    const view: HistoryView = new HistoryView(session, {
      notify: host.notify,
      closed: (closed, returnFocus) => {
        forget(session, closed, handle);
        paint(host.active());
        if (returnFocus && !session.disposed) session.terminal.focus();
      },
    });
    session.historyView = handle;
    views.set(session, view);
    paint(session);
    view.focus();
  }

  function paint(session: HistoryViewSession | undefined) {
    const pressed = String(!!session && !!views.get(session)?.open);
    if (toggle.getAttribute("aria-pressed") !== pressed) toggle.setAttribute("aria-pressed", pressed);
  }

  toggle.addEventListener("click", () => {
    const session = host.active();
    const view = session && views.get(session);
    if (session && view?.open) {
      session.historyView?.dispose();
      paint(session);
      session.terminal.focus();
    } else open();
  });

  return {
    open,
    focus(session) {
      const view = views.get(session);
      if (!view?.open) return false;
      view.focus();
      return true;
    },
    paint,
    command: Object.freeze({ name: "历史与搜索 · 当前会话 · 含已压缩的历史", action: open }),
  };
}
