/**
 * 首通保护：平台在每次注册完成后的第一个外呼会回 480（Q.850 cause=16），这里自动重拨一次兜底。
 * 默认行为对齐老 ccbar（`_shouldRetryCall` / `_retryLastCall`）：**一个签入周期只重拨一次、800ms 后**。
 *
 * 这个文件只回答「什么时候该拨」：不含文案、不碰 SDK（真正拨号由调用方注入），
 * 所以可以直接用 node --test 覆盖（tests/call-retry.test.ts）。
 *
 * 三条约束，少一条就会变成「无限重拨」—— 老实现（写在 usePhone 里那版）正好三条都踩了：
 *   1. 额度按「每次签入」记账：一轮最多拨 delays.length 次，用完就停到下次 reset()。
 *      老实现每次失败都重置 attempt，于是永远停在第一个时间点那一档，也永远不会收手。
 *   2. 已经有链条在跑时，链自己失败的回调不会武装新链（running 挡住）。
 *      否则每次重拨失败都把进度清零，次数也回到 0。
 *   3. 时间点从「第一次失败」起算，startedAt / index 只在本模块里改；
 *      调用方的 dial() 碰不到它们，不会算出 0 延迟后连环重拨。
 */

/**
 * 重拨的时间点（毫秒）：从第一次失败起算，不是从上次重拨起算。
 *
 * 默认**只重拨一次**（800ms 后），对齐老 ccbar 的
 * 「首通 480 Temporarily Unavailable，自动重拨一次」（`_retryLastCall` 的 800ms + `!this._callRetried`）。
 * 需要多档时间点（例如 1.5s / 3s / 6s 连试三次）时，用 options.delays 显式传。
 */
export const CALL_RETRY_DELAYS: readonly number[] = [800];

/** 交给调用方翻译成日志/提示 */
export type CallRetryEvent =
  | { type: "armed"; target: string; delays: readonly number[] }
  | { type: "attempt"; target: string; attempt: number }
  | { type: "skipped"; target: string; attempt: number }
  | { type: "exhausted"; target: string };

/** 定时器与时钟（测试里注入假实现，页面里用默认的） */
export type CallRetryTimers = {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
  now(): number;
};

export type CallRetryOptions = {
  /** 真正发起一次重拨；抛错只会中断这一次，不会打断整个链条 */
  attempt: (target: string) => void;
  /** 已经有一路真的在响/在通话 → 跳过这个时间点，别插进去抢 */
  hasLiveCall?: () => boolean;
  onEvent?: (event: CallRetryEvent) => void;
  delays?: readonly number[];
  /** 仅供测试注入 */
  timers?: CallRetryTimers;
};

export type CallRetry = {
  /** 签入成功（收到 connection.registered）：清空记账，本次签入重新允许兜底 */
  reset: () => void;
  /** 呼叫失败时调用；已在重拨中、或本次签入额度用完，都不会重开一条链 */
  arm: (target: string) => void;
  /** 停止当前链条（挂断、接通、退签、页面卸载），本次签入仍可再次 arm */
  cancel: () => void;
  /** 停止并放弃本次签入的剩余额度（已经有一路真正接通过，平台侧是好的） */
  finish: () => void;
  /** 是否有一条链条正在等待/推进 */
  readonly running: boolean;
  /** 本次签入已经自动拨出去几次 */
  readonly used: number;
};

const DEFAULT_TIMERS: CallRetryTimers = {
  // 浏览器里 setTimeout 返回 number；node 下返回对象，所以统一按 number 存（本模块只在页面里用默认实现）
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (handle) => clearTimeout(handle as unknown as number),
  now: () => Date.now(),
};

export function createCallRetry(options: CallRetryOptions): CallRetry {
  const delays = options.delays ?? CALL_RETRY_DELAYS;
  const timers = options.timers ?? DEFAULT_TIMERS;

  let allowed = false; // 本次签入是否还允许兜底
  let running = false; // 是否有链条在跑
  let used = 0; // 本次签入已经自动拨出去几次
  let index = 0; // 当前链条走到第几个时间点
  let timing: number | undefined; // 下一次 tick 的句柄
  let target = "";
  let startedAt = 0;
  let gaveUp = false; // 「额度用完」只提示一次

  function emit(event: CallRetryEvent): void {
    options.onEvent?.(event);
  }

  function clearTimer(): void {
    if (timing !== undefined) timers.clear(timing);
    timing = undefined;
  }

  function stopChain(): void {
    clearTimer();
    running = false;
    index = 0;
  }

  function plan(): void {
    const offset = delays[index];
    if (offset == null) {
      // 走完最后一个时间点：链条自然结束（额度也刚好用完）
      running = false;
      return;
    }
    timing = timers.set(tick, Math.max(0, startedAt + offset - timers.now()));
  }

  function giveUp(): void {
    if (gaveUp) return;
    gaveUp = true;
    emit({ type: "exhausted", target });
  }

  function tick(): void {
    timing = undefined;
    if (!running || !allowed) return;
    const attempt = index + 1;
    // 中途被取消后重新武装的链条，也不能让总额度超支
    if (used >= delays.length) {
      stopChain();
      giveUp();
      return;
    }
    if (options.hasLiveCall?.()) {
      index += 1;
      emit({ type: "skipped", target, attempt });
      plan();
      return;
    }
    index += 1;
    used += 1;
    emit({ type: "attempt", target, attempt });
    try {
      options.attempt(target);
    } catch {
      /* 这一次拨号没成功也没关系，剩下的时间点继续走 */
    }
    if (index >= delays.length) {
      running = false;
      return;
    }
    plan();
  }

  return {
    reset(): void {
      stopChain();
      allowed = true;
      used = 0;
      target = "";
      startedAt = 0;
      gaveUp = false;
    },
    arm(nextTarget: string): void {
      if (!allowed || !nextTarget) return;
      if (running) return; // 链条自己失败的回调：忽略，别把进度清零
      if (used >= delays.length) {
        giveUp();
        return;
      }
      target = nextTarget;
      startedAt = timers.now();
      index = 0;
      running = true;
      emit({ type: "armed", target, delays });
      plan();
    },
    cancel(): void {
      stopChain();
    },
    finish(): void {
      stopChain();
      allowed = false;
    },
    get running(): boolean {
      return running;
    },
    get used(): number {
      return used;
    },
  };
}
