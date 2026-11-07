import { icon } from "./icons";
import {
  BELL_INTERVAL_MAX_SECONDS, BELL_STYLES, BELL_STYLE_LABELS, parseBellSettings,
  type BellStyle, type TerminalBell,
} from "./terminal-bell";

/**
 * The terminal bell settings sheet, opened from the command palette. It edits the one in-memory
 * setting shared by every session; nothing is written to disk or browser storage. All markup is
 * static; values are read back through form controls only.
 */
const STYLE_NOTES: Readonly<Record<BellStyle, string>> = Object.freeze({
  off: "不发声、不闪烁，也不标记标签。",
  visual: "终端区域边缘短暂高亮一次；系统开启“减少动态效果”时改为不闪烁的静态边框。",
  sound: "播放应用内合成的短提示音，不使用系统提示音或音频文件，音量不随系统提示音量变化。部分 WebView 需要先在窗口中点击或按键一次才允许发声。",
});

export interface BellSettingsSheet {
  open(): void;
}

export function createBellSettingsSheet(bell: TerminalBell): BellSettingsSheet {
  const dialog = document.createElement("dialog");
  dialog.id = "bell-dialog";
  dialog.setAttribute("aria-labelledby", "bell-title");
  const options = BELL_STYLES.map((style) => `<option value="${style}">${BELL_STYLE_LABELS[style]}</option>`).join("");
  dialog.innerHTML = `
    <form id="bell-form" novalidate>
      <div class="dialog-heading"><div class="sheet-title"><div class="dialog-icon">${icon("bell")}</div><h2 id="bell-title">终端响铃</h2></div><button type="button" id="bell-close" class="icon-button" aria-label="关闭终端响铃设置">${icon("close")}</button></div>
      <label for="bell-style">收到响铃（BEL）时<select id="bell-style" aria-describedby="bell-style-note">${options}</select></label>
      <p id="bell-style-note"></p>
      <label for="bell-interval">忽略重复响铃的间隔（秒）<input id="bell-interval" type="number" inputmode="numeric" min="0" max="${BELL_INTERVAL_MAX_SECONDS}" step="1" aria-describedby="bell-interval-note"/></label>
      <p id="bell-interval-note">每个会话单独计算：一次提示后，这段时间内再收到的响铃被忽略，时间从那次提示算起。填 0 时，同一会话两次提示之间仍至少相隔 0.4 秒。</p>
      <p>非当前标签收到响铃时，其标签和侧栏的状态点外会出现一圈提示，切换到该标签后清除。设置只保存在内存中，对已打开和新建的会话立即生效，刷新或重启后恢复默认。</p>
      <p id="bell-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" id="bell-preview">试听声音</button><button type="button" id="bell-cancel">取消</button><button type="submit" id="bell-apply" class="primary">应用</button></div>
    </form>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const style = get<HTMLSelectElement>("bell-style");
  const interval = get<HTMLInputElement>("bell-interval");
  const error = get("bell-error");

  const showNote = () => {
    get("bell-style-note").textContent = STYLE_NOTES[style.value as BellStyle] ?? "";
  };
  const close = () => {
    error.textContent = "";
    dialog.close();
  };
  style.addEventListener("change", showNote);
  get("bell-close").addEventListener("click", close);
  get("bell-cancel").addEventListener("click", close);
  // A click is a user gesture, so the preview can also start a suspended audio context.
  get("bell-preview").addEventListener("click", () => bell.preview());
  get<HTMLFormElement>("bell-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const next = parseBellSettings(style.value, interval.value);
    if (typeof next === "string") {
      error.textContent = next;
      interval.focus();
      return;
    }
    bell.configure(next);
    close();
  });
  return {
    open() {
      style.value = bell.settings.style;
      interval.value = String(bell.settings.intervalSeconds);
      error.textContent = "";
      showNote();
      dialog.showModal();
      style.focus();
    },
  };
}
