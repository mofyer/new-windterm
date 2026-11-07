<!--
SUBMITTED 2026-11-07T07:20:07Z as https://github.com/xtermjs/xterm.js/issues/6302 (author mofyer),
after the user approved this text unchanged (G-CONTRIB). The body below the rule matches the posted
issue except for one trailing newline. Earlier note: draft written for user review; nothing above
the rule is part of the issue.
-->

**Title:** RIS (`ESC c`) keeps a hidden cursor (DECTCEM) and line feed/new line mode (LNM) set

---

### Details

- `@xterm/xterm` version: 6.0.0 (npm `latest`)
- Renderer: DOM; also reproduced without a renderer (terminal not opened)
- Browser: Chrome (also observed in Node, through the reply and buffer checks below)

### Steps to reproduce

```js
const term = new Terminal();
const replies = [];
term.onData(data => replies.push(data));
// Hide the cursor (DECTCEM reset), set LNM, then full reset (RIS).
term.write('\x1b[?25l\x1b[20h\x1bc');
// Ask for both modes (DECRQM), then print "A", LF, "B".
term.write('\x1b[?25$p\x1b[20$p', () => console.log(JSON.stringify(replies.join(''))));
term.write('A\nB', () => console.log(term.buffer.active.getLine(1).translateToString(true)));
```

### Expected

RIS returns the terminal to its power-on state:

- the cursor is visible: DECRQM `?25` answers `CSI ? 25 ; 1 $ y`, and the DOM renderer draws the cursor;
- LNM is reset: DECRQM `20` answers `CSI 20 ; 2 $ y`, and LF only moves down, so `B` is printed in column 2 (line 1 is `" B"`).

### Actual

- DECRQM `?25` answers `CSI ? 25 ; 2 $ y` and no cursor is drawn until the host sends `CSI ? 25 h` or DECSTR (`CSI ! p`).
- DECRQM `20` answers `CSI 20 ; 1 $ y` and every LF still returns to column 1 (line 1 is `"B"`).

The public `Terminal.reset()`, documented as a full reset (RIS), shows the same two results.

### References

- VT100 User Guide, chapter 3: RIS "Reset the VT100 to its initial state, i.e., the state it has after it is powered on". New Line (LNM) is one of the SET-UP features the host can change; its reset state is line feed only.
- VT510 Programmer Reference: RIS sets "all features listed on set-up screens to their saved settings"; the DECTCEM default is "visible" and the LNM default is "line feed". The RIS entry does not name DECTCEM explicitly, so "cursor visible after RIS" follows from the power-on default.
- xterm (`charproc.c`, `ReallyReset`): both the hard and the soft reset make the cursor visible first, and the hard reset restores the mode flags to their initial values, LNM (LINEFEED) included.

### Where this seems to come from (6.0.0 source)

- The hidden cursor is `CoreService.isCursorHidden`, a field outside `modes` / `decPrivateModes`. `CoreService.reset()` rebuilds only those two mode objects, and the RIS path (`InputHandler.fullReset()` → `onRequestReset` → `CoreBrowserTerminal.reset()` → `CoreTerminal.reset()`) never touches the field. Only DECSET 25 and `softReset()` (DECSTR) set it back to false.
- LNM has no mode bit of its own: `setMode(20)` / `resetMode(20)` write `optionsService.options.convertEol`, and `lineFeed()` and DECRQM 20 read that option. The reset path restores no option.
- From reading the source on master (`08829c7`), these parts appear unchanged; that was not run.

### Possible fixes (for discussion)

1. DECTCEM: set `isCursorHidden = false` in the RIS path (for example in `CoreService.reset()` or `fullReset()`), as `softReset()` already does.
2. LNM: making RIS write `convertEol = false` would override embedders who set `convertEol: true` on purpose (the option is documented for non-PTY data sources). An alternative is a separate LNM mode bit, initialised from the option and restored to it by RIS, which may also touch #4119 (Enter under LNM does not send CR LF). This one probably needs a maintainer decision first.

Related but different: #814 and #1532 (cursor disappearing after reset, both closed, caused by setup code at the time).
