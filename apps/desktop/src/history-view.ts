import type { ITheme, Terminal } from "@xterm/xterm";
import type { SessionHistory } from "./history-capture";
import { observeWrites } from "./terminal-core";
import { paintRun, segments, type MatchRange, type ParsedLine } from "./history-sgr";
import { searchHistory, type SearchMatch, type SearchOutcome, type SearchQuery } from "./history-search";
import { RegexWorker, searchHistoryRegex } from "./history-regex";
import { searchStatusText } from "./history-search-text";
import { LineStore, RowMap, takeSnapshot, type RowItem, type Snapshot, type ViewMarkKind } from "./history-view-model";
import { HISTORY_COPY_MAX_LINES, HISTORY_REGEX_BATCH_TIMEOUT_MS, HISTORY_SEARCH_MAX_MATCHES, HISTORY_VIEW_MAX_CHARS } from "./history-budget";
import { icon } from "./icons";

/**
 * Read-only history view of one session (P1 slice 5, step 7; Q06, G20, G21): an overlay on the
 * session's own terminal pane that lists the session's history, from the archive and the screen,
 * one logical line per row, with plain-text and regular-expression search, jumping and copying.
 * A regular expression is only compiled and run in the view's worker (history-regex.ts).
 *
 * It is a projection, not a second terminal. It never writes to the terminal, never parses its
 * byte stream and never changes its buffer, scroll position, selection or modes; output keeps
 * flowing into the terminal underneath and is ACKed as before, and the view only notes that there
 * is new output. While the view is open the terminal element is `inert`, so keys cannot reach a
 * terminal the user cannot see. Rows are virtualised: only the rows in view (plus a margin) exist
 * in the DOM, and every piece of terminal text reaches the DOM as `textContent`.
 *
 * `dispose` (the tab closing, or the view closing) aborts a running search, drops the snapshot and
 * every cache, and removes the overlay and its listeners (requirement R2).
 */

export interface HistoryViewTarget {
  readonly key: number;
  readonly name: string;
  readonly terminal: Terminal;
  /** The session's terminal pane; the overlay is placed in it. */
  readonly element: HTMLElement;
  readonly history?: SessionHistory;
}

export interface HistoryViewHost {
  notify(message: string): void;
  /** The view was closed; `returnFocus` when the user closed it and the terminal should get focus. */
  closed(view: HistoryView, returnFocus: boolean): void;
}

const ROW = 20;
const OVERSCAN = 12;
/** Scroll height used at most; longer histories scroll proportionally (WebKit and float precision). */
const MAX_SCROLL_PX = 8_000_000;
const STATUS_INTERVAL_MS = 400;

interface SearchState {
  readonly query: SearchQuery;
  readonly controller: AbortController;
  /** Newest first (see history-search.ts); grows while the search runs. */
  matches: readonly SearchMatch[];
  current: number;
  /** A new search selects the nearest match at or above this line. */
  readonly anchor: number;
  /** Cleared when the user moves before a match is chosen: the search then stops moving the view. */
  follow: boolean;
  outcome?: SearchOutcome;
}

const MARK_TEXT: Readonly<Record<ViewMarkKind, string>> = Object.freeze({
  gap: "此处有缺口：部分输出在保存进历史之前已被终端裁掉",
  clear: "此处终端被复位或清除了回滚；以上各行只保留在历史中",
  screen: "以下为打开历史时的屏幕内容",
});

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className?: string): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

/** `[from, to)` of a line to draw: at most HISTORY_VIEW_MAX_CHARS, around `focus` if given, never splitting a surrogate pair. */
function drawRange(text: string, focus?: number): [number, number] {
  if (text.length <= HISTORY_VIEW_MAX_CHARS) return [0, text.length];
  let from = focus === undefined || focus < HISTORY_VIEW_MAX_CHARS - 200 ? 0 : focus - 200;
  let to = Math.min(text.length, from + HISTORY_VIEW_MAX_CHARS);
  const low = (i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? "");
  if (from > 0 && low(from)) from++;
  if (to < text.length && low(to)) to--;
  return [from, to];
}

const pressed = (toggle: HTMLElement) => toggle.getAttribute("aria-pressed") === "true";

let nextViewId = 1;

export class HistoryView {
  readonly root: HTMLElement;
  private readonly id = `history-${nextViewId++}`;
  private readonly list: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rowsWindow: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly regexToggle: HTMLButtonElement;
  /** Started by the first regex search; terminated by every early end of one and by dispose. */
  private readonly regexWorker = new RegexWorker();
  private readonly status: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly copy: HTMLButtonElement;
  private snapshot!: Snapshot;
  private rows!: RowMap;
  private store!: LineStore;
  private focusLine = -1;
  private anchorLine = -1;
  private search: SearchState | undefined;
  private frame = 0;
  private syncTimer = 0;
  private statusAt = 0;
  private newOutput = false;
  private droppedSince = 0;
  private theme: ITheme | undefined;
  private revealCurrent = false;
  /** First row in view (fractional) at the last render while shown; restored after a hidden tab. */
  private lastTop = -1;
  private hidden = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly target: HistoryViewTarget, private readonly host: HistoryViewHost) {
    this.root = element("section", "history-view");
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", `「${target.name}」的历史`);
    const head = element("div", "history-head");
    const title = element("div", "history-title");
    title.append(element("strong", undefined, "历史"), element("span", "history-name", target.name));
    this.summary = element("span", "history-summary");
    title.append(this.summary);
    const actions = element("div", "history-head-actions");
    const refresh = button("刷新");
    refresh.addEventListener("click", () => this.refresh());
    const close = button("", "icon-button history-close");
    close.setAttribute("aria-label", "关闭历史，回到终端");
    close.title = "关闭（Esc）";
    // The only markup in the view: a static icon from icons.ts, no terminal or session text.
    close.innerHTML = icon("close");
    close.addEventListener("click", () => this.close(true));
    actions.append(refresh, close);
    head.append(title, actions);
    this.notice = element("p", "history-notice");
    const find = element("div", "history-find");
    this.input = element("input", "history-search");
    this.input.type = "search";
    this.input.maxLength = 1000;
    this.input.placeholder = "搜索历史";
    this.input.setAttribute("aria-label", "搜索历史");
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.caseToggle = button("区分大小写", "history-case");
    this.caseToggle.setAttribute("aria-pressed", "false");
    this.regexToggle = button("正则", "history-regex");
    this.regexToggle.setAttribute("aria-pressed", "false");
    this.regexToggle.title = `按 JavaScript 正则表达式搜索（在后台线程中运行，一批行超过 ${(HISTORY_REGEX_BATCH_TIMEOUT_MS / 1000).toLocaleString()} 秒即停止）`;
    this.status = element("span", "history-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.previous = button("上一处");
    this.previous.title = "较早的匹配（Enter、F3）";
    this.next = button("下一处");
    this.next.title = "较新的匹配（Shift+Enter、Shift+F3）";
    this.stop = button("停止");
    this.stop.hidden = true;
    this.copy = button("复制所选行");
    find.append(this.input, this.caseToggle, this.regexToggle, this.status, this.previous, this.next, this.stop, this.copy);
    this.list = element("div", "history-list");
    this.list.id = `${this.id}-list`;
    this.list.tabIndex = 0;
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "历史行");
    this.list.setAttribute("aria-multiselectable", "true");
    this.spacer = element("div", "history-spacer");
    this.rowsWindow = element("div", "history-window");
    this.list.append(this.spacer, this.rowsWindow);
    this.root.append(head, this.notice, find, this.list);
    this.wire();
    this.take();
    target.element.append(this.root);
    // Keys must not reach a terminal hidden under the overlay; inert is a DOM attribute only.
    if (target.terminal.element) target.terminal.element.inert = true;
    this.scrollToRow(this.rows.rowCount - 1, "end");
    this.render();
  }

  /** Puts keyboard focus in the search field. */
  focus(): void {
    this.input.focus();
  }

  get open(): boolean {
    return !this.disposed;
  }

  private wire() {
    const on = <K extends keyof HTMLElementEventMap>(node: HTMLElement, type: K, fn: (event: HTMLElementEventMap[K]) => void) => {
      node.addEventListener(type, fn);
      this.cleanups.push(() => node.removeEventListener(type, fn));
    };
    on(this.list, "scroll", () => this.schedule());
    on(this.root, "keydown", (event) => this.onRootKey(event));
    on(this.input, "keydown", (event) => this.onInputKey(event));
    on(this.list, "keydown", (event) => this.onListKey(event));
    on(this.list, "mousedown", (event) => this.onListMouseDown(event));
    on(this.list, "wheel", () => this.userMoved());
    on(this.list, "click", (event) => this.onListClick(event));
    for (const toggle of [this.caseToggle, this.regexToggle]) {
      on(toggle, "click", () => {
        toggle.setAttribute("aria-pressed", String(!pressed(toggle)));
        this.input.placeholder = pressed(this.regexToggle) ? "正则表达式" : "搜索历史";
        if (this.input.value) this.startSearch();
      });
    }
    on(this.previous, "click", () => this.step(1));
    on(this.next, "click", () => this.step(-1));
    on(this.stop, "click", () => this.cancelSearch());
    on(this.copy, "click", () => void this.copySelection());
    // A hidden tab's pane is `display: none`, which may reset the scroll offset: put it back.
    const resize = new ResizeObserver(() => {
      const shown = this.list.clientHeight > 0;
      if (shown && this.hidden && this.lastTop >= 0) this.setTop(this.lastTop);
      this.hidden = !shown;
      this.schedule();
    });
    resize.observe(this.list);
    this.cleanups.push(() => resize.disconnect());
    const writes = observeWrites(this.target.terminal, () => this.scheduleSync());
    this.cleanups.push(() => writes.dispose());
  }

  /** (Re)takes the snapshot; keeps the selection and position by line number where it can. */
  private take() {
    this.store?.dispose();
    const reader = this.target.history?.reader();
    this.snapshot = takeSnapshot(reader, this.target.terminal, !!this.target.history && !reader);
    this.rows = new RowMap(this.snapshot);
    this.store = new LineStore(this.snapshot, reader);
    this.newOutput = false;
    this.droppedSince = 0;
    this.root.style.setProperty("--history-gutter", `${Math.max(4, String(this.rows.end).length + 2)}ch`);
    const last = this.rows.lastLine;
    const clamp = (line: number) => (line < 0 || last < 0 ? last : Math.min(Math.max(line, this.snapshot.first), last));
    this.focusLine = clamp(this.focusLine);
    this.anchorLine = clamp(this.anchorLine);
    this.paintHeader();
  }

  /** New snapshot, same query; the search runs again on it. */
  refresh(): void {
    if (this.disposed) return;
    const query = this.search?.query;
    this.cancelSearch(true);
    this.take();
    this.scrollToRow(this.focusLine >= 0 ? this.rows.rowOf(this.focusLine) : this.rows.rowCount - 1, "center");
    if (query && this.input.value) this.startSearch();
    else this.paintStatus();
    this.schedule();
  }

  private paintHeader() {
    const { first, source, dropped, cleared, marksOmitted } = this.snapshot;
    this.summary.textContent = this.rows.lineCount
      ? `第 ${(first + 1).toLocaleString()}–${this.rows.end.toLocaleString()} 行 · 共 ${this.rows.lineCount.toLocaleString()} 行`
      : "没有历史行";
    const notes: string[] = [];
    if (source === "buffer") notes.push(`此会话没有压缩历史，只显示终端中的 ${this.rows.lineCount.toLocaleString()} 行`);
    if (source === "stopped") notes.push(`此会话的历史记录已停止，只显示终端中的 ${this.rows.lineCount.toLocaleString()} 行`);
    if (first > 0) {
      const parts = [dropped && `${dropped.toLocaleString()} 行超出历史预算已丢弃`, cleared && `${cleared.toLocaleString()} 行已由清除回滚删除`];
      notes.push(`最早的 ${first.toLocaleString()} 行已不在历史中：${parts.filter(Boolean).join("，")}`);
    }
    if (marksOmitted) notes.push(`另有 ${marksOmitted.toLocaleString()} 处缺口或复位未标出位置`);
    if (this.droppedSince) notes.push(`打开后又有 ${this.droppedSince.toLocaleString()} 行超出历史预算被丢弃`);
    if (this.newOutput) notes.push("打开后有新输出，点「刷新」查看");
    const text = notes.join("；");
    if (this.notice.textContent !== text) this.notice.textContent = text;
    this.notice.hidden = !text;
  }

  /** New output or archive changes: announced in the header; a user clear takes a new snapshot. */
  private scheduleSync() {
    if (this.syncTimer || this.disposed) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = 0;
      this.sync();
    }, 200);
  }

  private sync() {
    if (this.disposed) return;
    this.newOutput = true;
    const reader = this.target.history?.reader();
    if (reader && this.snapshot.source === "archive") {
      const stats = reader.stats();
      if (stats.clearedLines !== this.snapshot.cleared) {
        // The user cleared the history this snapshot shows (T32): nothing of it is held any more.
        this.refresh();
        this.host.notify(`「${this.target.name}」的历史已清除，历史视图已刷新。`);
        return;
      }
      const dropped = stats.droppedLines - this.snapshot.dropped;
      if (dropped !== this.droppedSince) {
        this.droppedSince = dropped;
        // Rows of dropped lines that are not cached yet now read as no longer held.
        this.schedule();
      }
    }
    this.paintHeader();
  }

  // ---- Viewport ----

  private metrics() {
    const height = this.list.clientHeight || ROW;
    const visible = Math.max(1, height / ROW);
    const total = this.rows.rowCount;
    const spacer = Math.min(total * ROW, MAX_SCROLL_PX);
    const maxScroll = Math.max(0, spacer - height);
    const maxTop = Math.max(0, total - visible);
    const top = maxScroll > 0 ? (this.list.scrollTop / maxScroll) * maxTop : 0;
    return { visible, total, spacer, maxScroll, maxTop, top };
  }

  private scrollToRow(row: number, mode: "nearest" | "center" | "end") {
    const { visible, top } = this.metrics();
    let next = top;
    if (mode === "center") next = row - visible / 2 + 0.5;
    else if (mode === "end") next = row + 1 - visible;
    else if (row < top) next = row;
    else if (row + 1 > top + visible) next = row + 1 - visible;
    this.setTop(next);
  }

  /** Scrolls so that row `top` (fractional) is the first in view. */
  private setTop(top: number) {
    this.spacer.style.height = `${Math.min(this.rows.rowCount * ROW, MAX_SCROLL_PX)}px`;
    const { maxScroll, maxTop } = this.metrics();
    const next = Math.min(Math.max(0, top), maxTop);
    this.list.scrollTop = maxTop > 0 ? (next / maxTop) * maxScroll : 0;
  }

  private schedule() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render() {
    if (this.disposed) return;
    // Hidden tab: nothing to draw, and the position must not be taken from a reset offset.
    if (!this.list.clientHeight) {
      this.hidden = true;
      return;
    }
    this.applyTheme();
    const { visible, total, spacer, top } = this.metrics();
    this.lastTop = top;
    this.spacer.style.height = `${spacer}px`;
    const first = Math.max(0, Math.floor(top) - OVERSCAN);
    const offset = this.list.scrollTop - (top - first) * ROW;
    const fit = Math.max(1, Math.floor((spacer - offset) / ROW));
    const last = Math.min(total - 1, Math.ceil(top + visible) + OVERSCAN, first + fit - 1);
    const nodes: HTMLElement[] = [];
    let missingFrom = Infinity;
    let missingTo = -1;
    for (let row = first; row <= last; row++) {
      const item = this.rows.item(row);
      if (item.kind === "line" && this.store.get(item.line) === undefined) {
        missingFrom = Math.min(missingFrom, item.line);
        missingTo = Math.max(missingTo, item.line);
      }
      nodes.push(this.renderRow(item, row));
    }
    this.rowsWindow.replaceChildren(...nodes);
    this.rowsWindow.style.transform = `translateY(${offset}px)`;
    const active = this.focusLine >= 0 ? this.rowsWindow.querySelector(`[data-line="${this.focusLine}"]`) : null;
    if (active) this.list.setAttribute("aria-activedescendant", active.id);
    else this.list.removeAttribute("aria-activedescendant");
    if (missingTo >= 0) {
      void this.store.load(missingFrom, missingTo + 1).then((arrived) => { if (arrived) this.schedule(); });
    }
    if (this.revealCurrent) this.revealMatch();
    this.paintControls();
  }

  /** Terminal theme colours for the 16 palette entries and the defaults (read only). */
  private applyTheme() {
    const theme = this.target.terminal.options.theme;
    if (theme === this.theme) return;
    this.theme = theme;
    const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
    const value = (key: keyof ITheme) => (typeof theme?.[key] === "string" ? (theme[key] as string) : "");
    names.forEach((name, i) => {
      this.root.style.setProperty(`--history-ansi-${i}`, value(name) || "inherit");
      const bright = `bright${name[0].toUpperCase()}${name.slice(1)}` as keyof ITheme;
      this.root.style.setProperty(`--history-ansi-${i + 8}`, value(bright) || value(name) || "inherit");
    });
    this.root.style.setProperty("--history-fg", value("foreground") || "var(--text)");
    this.root.style.setProperty("--history-bg", value("background") || "var(--terminal)");
  }

  private renderRow(item: RowItem, row: number): HTMLElement {
    const node = element("div", "history-row");
    node.setAttribute("role", "option");
    node.setAttribute("aria-posinset", String(row + 1));
    node.setAttribute("aria-setsize", String(this.rows.rowCount));
    if (item.kind !== "line") {
      const text = item.kind === "top" ? this.topText() : MARK_TEXT[item.mark.kind];
      node.classList.add("history-mark");
      node.dataset.mark = item.kind === "top" ? "unavailable" : item.mark.kind;
      node.setAttribute("aria-disabled", "true");
      node.append(element("span", "history-gutter"), element("span", "history-text", text));
      return node;
    }
    const { line } = item;
    node.id = `${this.id}-line-${line}`;
    node.dataset.line = String(line);
    const [low, high] = this.selectionRange();
    const selected = this.focusLine >= 0 && line >= low && line <= high;
    node.setAttribute("aria-selected", String(selected));
    if (selected) node.classList.add("selected");
    if (line === this.focusLine) node.classList.add("active");
    const gutter = element("span", "history-gutter", String(line + 1));
    gutter.setAttribute("aria-hidden", "true");
    const text = element("span", "history-text");
    node.append(gutter, text);
    const state = this.store.get(line);
    if (state === undefined) {
      node.setAttribute("aria-busy", "true");
      node.setAttribute("aria-label", `第 ${line + 1} 行，正在读取`);
    } else if (state === null) {
      node.classList.add("history-gone");
      text.textContent = "此行已不在历史中（已丢弃或已清除）";
      node.setAttribute("aria-label", `第 ${line + 1} 行，${text.textContent}`);
    } else {
      const drawn = this.paintLine(text, line, state);
      node.setAttribute("aria-label", `第 ${line + 1} 行 ${drawn}`);
    }
    return node;
  }

  private topText(): string {
    const { first, dropped, cleared } = this.snapshot;
    const range = `第 1–${first.toLocaleString()} 行`;
    if (!cleared) return `${range}已因超出历史预算丢弃`;
    if (!dropped) return `${range}已清除（清除回滚）`;
    return `${range}已不在历史中（已丢弃或已清除）`;
  }

  /** Draws a parsed line with its colours and matches; returns the text drawn. */
  private paintLine(target: HTMLElement, line: number, parsed: ParsedLine): string {
    const matches = this.matchesOn(line);
    const current = matches.find((m) => m.current);
    const [from, to] = drawRange(parsed.text, current?.start);
    if (from > 0) target.append(element("span", "history-elided", "…"));
    for (const part of segments(parsed, from, to, matches)) {
      const span = element("span", undefined, parsed.text.slice(part.start, part.end));
      if (part.style) paintRun(span, part.style);
      if (part.match) span.classList.add(part.match === 2 ? "history-match-current" : "history-match");
      target.append(span);
    }
    if (to < parsed.text.length) {
      target.append(element("span", "history-elided", `…（本行共 ${parsed.text.length.toLocaleString()} 个字符）`));
    }
    return parsed.text.slice(from, to);
  }

  /** Matches on `line`, sorted by start; the current one flagged. */
  private matchesOn(line: number): MatchRange[] {
    const state = this.search;
    if (!state?.matches.length) return [];
    const list = state.matches;
    // Descending by line: find the first index with list[i].line <= line.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].line > line) low = middle + 1;
      else high = middle;
    }
    const result: MatchRange[] = [];
    for (let i = low; i < list.length && list[i].line === line; i++) {
      result.push({ start: list[i].start, end: list[i].end, current: i === state.current });
    }
    return result.reverse();
  }

  /** Scrolls the current match into view horizontally once its row is drawn. */
  private revealMatch() {
    const mark = this.rowsWindow.querySelector<HTMLElement>(".history-match-current");
    if (!mark) return;
    this.revealCurrent = false;
    const list = this.list.getBoundingClientRect();
    const box = mark.getBoundingClientRect();
    if (box.left < list.left + 48 || box.right > list.right - 16) {
      this.list.scrollLeft += box.left - list.left - list.width / 3;
    }
  }

  // ---- Selection and keys ----

  private selectionRange(): [number, number] {
    return this.anchorLine <= this.focusLine ? [this.anchorLine, this.focusLine] : [this.focusLine, this.anchorLine];
  }

  /** The user moved: a search still looking for its first match must not move the view any more. */
  private userMoved() {
    if (this.search) this.search.follow = false;
  }

  private moveTo(line: number, extend: boolean) {
    this.userMoved();
    const last = this.rows.lastLine;
    if (last < 0) return;
    this.focusLine = Math.min(Math.max(line, this.snapshot.first), last);
    if (!extend || this.anchorLine < 0) this.anchorLine = this.focusLine;
    this.scrollToRow(this.rows.rowOf(this.focusLine), "nearest");
    this.schedule();
  }

  private onRootKey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (mod && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.input.focus();
      this.input.select();
    } else if (event.key === "F3") {
      event.preventDefault();
      this.navigate(event.shiftKey ? -1 : 1);
    }
  }

  /** Enter continues upward (older), as the view opens at the newest line; Shift+Enter goes down. */
  private onInputKey(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    this.navigate(event.shiftKey ? -1 : 1);
  }

  private onListKey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    const page = Math.max(1, Math.floor(this.metrics().visible) - 1);
    const start = this.focusLine >= 0 ? this.focusLine : this.rows.lastLine;
    const moves: Record<string, number | undefined> = {
      ArrowUp: start - 1, ArrowDown: start + 1, PageUp: start - page, PageDown: start + page,
      Home: this.snapshot.first, End: this.rows.lastLine,
    };
    if (event.key in moves && !event.altKey) {
      event.preventDefault();
      this.moveTo(moves[event.key]!, event.shiftKey);
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.anchorLine = this.snapshot.first;
      this.focusLine = this.rows.lastLine;
      this.schedule();
    } else if (mod && event.key.toLowerCase() === "c") {
      const selection = document.getSelection();
      // A text selection inside the rows is copied by the WebView itself.
      if (selection && !selection.isCollapsed && this.list.contains(selection.anchorNode)) return;
      event.preventDefault();
      void this.copySelection();
    }
  }

  /** Shift+click extends the row selection; it must not also extend a text selection. */
  private onListMouseDown(event: MouseEvent) {
    if (event.shiftKey && (event.target as Element).closest(".history-row[data-line]")) event.preventDefault();
  }

  private onListClick(event: MouseEvent) {
    const row = (event.target as Element).closest<HTMLElement>(".history-row[data-line]");
    if (!row) return;
    const selection = document.getSelection();
    const extend = event.shiftKey && this.anchorLine >= 0;
    // A drag that selected text keeps its text selection for the WebView's own copy.
    if (!extend && selection && !selection.isCollapsed && !(event.target as Element).closest(".history-gutter")) return;
    const line = Number(row.dataset.line);
    this.userMoved();
    if (extend) {
      selection?.removeAllRanges();
      this.focusLine = line;
    } else this.anchorLine = this.focusLine = line;
    this.list.focus({ preventScroll: true });
    this.schedule();
  }

  // ---- Search ----

  private query(): SearchQuery {
    return { text: this.input.value, caseSensitive: pressed(this.caseToggle), regex: pressed(this.regexToggle) };
  }

  private navigate(direction: 1 | -1) {
    const query = this.query();
    const state = this.search;
    const same = state && state.query.text === query.text && state.query.caseSensitive === query.caseSensitive
      && !!state.query.regex === query.regex;
    if (!query.text) {
      this.cancelSearch(true);
      this.paintStatus();
      this.schedule();
    } else if (!same || state.outcome?.cancelled || state.outcome?.failure) {
      this.startSearch();
    } else this.step(direction);
  }

  /** `direction` 1: older (上一处), -1: newer (下一处); wraps around. */
  private step(direction: 1 | -1) {
    const state = this.search;
    if (!state?.matches.length) return;
    const count = state.matches.length;
    this.select(state.current < 0 ? 0 : (state.current + direction + count) % count);
  }

  private select(index: number) {
    const state = this.search!;
    state.current = index;
    const match = state.matches[index];
    this.anchorLine = this.focusLine = match.line;
    this.revealCurrent = true;
    const row = this.rows.rowOf(match.line);
    const { top, visible } = this.metrics();
    if (row < top + 1 || row > top + visible - 2) this.scrollToRow(row, "center");
    this.paintStatus(true);
    this.schedule();
  }

  private startSearch() {
    this.cancelSearch(true);
    const query = this.query();
    const { top, visible } = this.metrics();
    const bottom = this.rows.item(Math.min(this.rows.rowCount - 1, Math.max(0, Math.ceil(top + visible) - 1)));
    const anchor = bottom.kind === "line" ? bottom.line : this.rows.lastLine;
    const state: SearchState = { query, controller: new AbortController(), matches: [], current: -1, anchor, follow: true };
    this.search = state;
    this.stop.hidden = false;
    this.paintStatus(true);
    const pick = () => {
      if (state.current >= 0 || !state.follow || this.search !== state) return;
      const index = state.matches.findIndex((m) => m.line <= state.anchor);
      if (index >= 0) this.select(index);
    };
    const options = {
      limit: HISTORY_SEARCH_MAX_MATCHES,
      signal: state.controller.signal,
      progress: (matches: readonly SearchMatch[]) => {
        if (this.search !== state) return;
        state.matches = matches;
        pick();
        this.paintStatus();
        this.schedule();
      },
    };
    const source = this.store.searchSource();
    // The user's pattern never runs on this thread: a regex search only sends text to the worker.
    const running = query.regex ? searchHistoryRegex(source, query, options, this.regexWorker) : searchHistory(source, query, options);
    void running.then((outcome) => {
      if (this.search !== state || this.disposed) return;
      state.outcome = outcome;
      state.matches = outcome.matches;
      pick();
      if (state.current < 0 && state.follow && state.matches.length) this.select(state.matches.length - 1);
      this.stop.hidden = true;
      this.paintStatus(true);
      this.schedule();
    });
  }

  /** Stops a running search; `silent` when a new one replaces it. */
  private cancelSearch(silent = false) {
    const state = this.search;
    if (!state) return;
    state.controller.abort();
    if (silent) {
      this.search = undefined;
      this.stop.hidden = true;
      return;
    }
    if (!state.outcome) {
      state.outcome = Object.freeze({
        matches: state.matches, complete: false, limited: false, cancelled: true, scannedLines: 0,
      });
    }
    this.stop.hidden = true;
    this.paintStatus(true);
  }

  private paintStatus(force = false) {
    const now = performance.now();
    if (!force && now - this.statusAt < STATUS_INTERVAL_MS) return;
    this.statusAt = now;
    const state = this.search;
    const text = state ? searchStatusText(state.matches.length, state.current, state.outcome) : "";
    if (this.status.textContent !== text) this.status.textContent = text;
    if (state?.outcome?.failure === "invalid") this.input.setAttribute("aria-invalid", "true");
    else this.input.removeAttribute("aria-invalid");
    this.paintControls();
  }

  private paintControls() {
    const none = !this.search?.matches.length;
    this.previous.disabled = none;
    this.next.disabled = none;
    this.copy.disabled = this.focusLine < 0;
  }

  // ---- Copy ----

  private async copySelection() {
    if (this.focusLine < 0) {
      this.host.notify("请先在历史中选择要复制的行。");
      return;
    }
    const [low, high] = this.selectionRange();
    const count = high - low + 1;
    if (count > HISTORY_COPY_MAX_LINES) {
      this.host.notify(`所选 ${count.toLocaleString()} 行超过单次复制上限 ${HISTORY_COPY_MAX_LINES.toLocaleString()} 行，请缩小范围。`);
      return;
    }
    const lines = await this.store.plain(low, high);
    if (this.disposed) return;
    const kept = lines.filter((line): line is string => line !== null);
    const missing = count - kept.length;
    try {
      await navigator.clipboard.writeText(kept.join("\n"));
      this.host.notify(`已复制 ${kept.length.toLocaleString()} 行${missing ? `；其中 ${missing.toLocaleString()} 行已不在历史中，未复制` : ""}。`);
    } catch {
      this.host.notify("复制失败：WebView 未允许写入剪贴板。");
    }
  }

  // ---- Close ----

  private close(returnFocus: boolean) {
    if (this.disposed) return;
    this.dispose();
    this.host.closed(this, returnFocus);
  }

  /** Aborts the search and releases the snapshot, caches, listeners and overlay. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.search?.controller.abort();
    this.search = undefined;
    this.regexWorker.dispose();
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.syncTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.store.dispose();
    this.rowsWindow.replaceChildren();
    this.root.remove();
    if (this.target.terminal.element) this.target.terminal.element.inert = false;
  }
}
