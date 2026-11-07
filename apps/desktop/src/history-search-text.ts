import type { SearchOutcome } from "./history-search";
import { HISTORY_REGEX_BATCH_TIMEOUT_MS, HISTORY_SEARCH_MAX_MATCHES } from "./history-budget";

/**
 * Status line of the history view's search (history-view.ts), announced politely. `count` is the
 * number of matches so far, `current` the index of the selected one (newest first, -1 for none),
 * `outcome` undefined while the search runs. Only numbers are added to fixed text: neither the
 * query nor the engine's error message is shown.
 */
export function searchStatusText(count: number, current: number, outcome: SearchOutcome | undefined): string {
  const at = current >= 0 ? `第 ${(count - current).toLocaleString()} 处，` : "";
  const found = `${at}已找到 ${count.toLocaleString()} 处`;
  if (!outcome) return `正在搜索… ${found}`;
  if (outcome.cancelled) return `已停止：${found}（未搜索完）`;
  switch (outcome.failure) {
    case "invalid": return "正则表达式无效，请检查括号、量词与转义";
    case "unavailable": return "正则搜索不可用：后台线程未能启动";
    case "timeout": {
      const seconds = (HISTORY_REGEX_BATCH_TIMEOUT_MS / 1000).toLocaleString();
      return `匹配超时，已停止：${found}（未搜索完，一批行超过 ${seconds} 秒）`;
    }
    case "failed": return `正则匹配出错，已停止：${found}（未搜索完）`;
    default: break;
  }
  if (!count) return "没有找到";
  const total = `${at}共 ${count.toLocaleString()} 处`;
  if (outcome.limited) return `${total}（已达上限，只列出最新的 ${HISTORY_SEARCH_MAX_MATCHES.toLocaleString()} 处）`;
  return total;
}
