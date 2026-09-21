/**
 * SIP 原文：把 REGISTER / INVITE 这类报文抓进 SIP 日志面板。
 *
 * 背景：SDK 没有公开「读 SIP 报文」的接口（官方只有 client.getDiagnostics() 的生命周期日志），
 * 唯一能拿到原文的办法是打开 JsSIP 自带的 debug 命名空间，它会把报文打到 console，
 * 我们再拦截 console、把命中关键字的行转进面板。
 *
 * 有两个必须注意的点：
 *   1. JsSIP 是首次 connect() 时才懒加载的，加载时读一次 localStorage.debug，
 *      所以必须在签入之前调用（页面在 onMounted 里就调用）。
 *   2. 这是 SDK 未公开的调试能力，仅用于演示与排障，不要当成稳定接口。
 */

import { SIP_LOG_RE, cleanJsSipText } from "./logs";
import type { LogLevel } from "./logs";

/** 把一条 SIP 原文交给页面（由 usePhone 注入，写进 SIP 面板） */
export type SipLineFn = (level: LogLevel, text: string) => void;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * 打开 SIP 原文并把结果接到 onLine；返回一个「取消」函数（页面卸载时调用）。
 */
export function enableJsSipDebug(onLine: SipLineFn): () => void {
  try {
    localStorage.setItem("debug", "JsSIP:*");
  } catch {
    /* 隐私模式下写不了 localStorage：SIP 原文就没有了，其他功能不受影响 */
  }

  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const method of CONSOLE_METHODS) {
    const original = console[method].bind(console);
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      try {
        const text = cleanJsSipText(args);
        if (text && SIP_LOG_RE.test(text)) {
          onLine(method === "error" ? "error" : method === "warn" ? "warn" : "info", text);
        }
      } catch {
        /* 记日志本身不能影响业务 */
      }
      original(...args);
    };
  }

  return () => {
    for (const [method, original] of originals) {
      (console as unknown as Record<string, unknown>)[method] = original;
    }
    originals.clear();
  };
}
