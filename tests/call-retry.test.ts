import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_RETRY_DELAYS, createCallRetry } from "../src/lib/callRetry.ts";

/** 多档时间点不是默认行为（默认只有一档，对齐老 ccbar），用例里显式传 */
const MULTI_DELAYS = [1500, 3000, 6000] as const;

type FakeTimer = { id: number; at: number; fn: () => void };

/** 假时钟 + 假定时器：模块只用到 set / clear / now，所以能整段跑在虚拟时间里 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  let queue: FakeTimer[] = [];
  const timers = {
    set(fn: () => void, ms: number) {
      const id = ++seq;
      queue.push({ id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clear(handle: number) {
      queue = queue.filter((item) => item.id !== handle);
    },
    now: () => now,
  };
  return {
    timers,
    /** 按时间顺序触发定时器；步数超限说明链条停不下来（老实现就是这个样子） */
    fire(limitMs = 60_000, maxSteps = 200) {
      const start = now;
      let steps = 0;
      while (queue.length) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next) break;
        if (next.at - start > limitMs) break;
        if (++steps > maxSteps) throw new Error(`定时器停不下来（${maxSteps} 步还没走完）`);
        queue.shift();
        now = next.at;
        next.fn();
      }
    },
    /** 模拟浏览器挂起：时间往前跳，但不触发定时器 */
    jump(ms: number) {
      now += ms;
    },
    get pending() {
      return queue.length;
    },
  };
}

test("默认只重拨一次（对齐老 ccbar：800ms 后一次，一个签入周期就这一次）", () => {
  const clock = fakeClock();
  const dialed: number[] = [];
  const events: string[] = [];
  const retry = createCallRetry({
    attempt: () => dialed.push(clock.timers.now()),
    onEvent: (event) => events.push(event.type),
    timers: clock.timers,
  });

  assert.deepEqual(CALL_RETRY_DELAYS, [800], "默认时间点就一档");

  retry.reset();
  retry.arm("A");
  clock.fire();
  assert.deepEqual(dialed, [800], "只重拨一次，且是 800ms 后");
  assert.deepEqual(events, ["armed", "attempt"]);
  assert.equal(retry.used, 1);

  // 重拨又失败：额度已用完，不再拨（下一次签入才重新记账）
  retry.arm("A");
  clock.fire();
  assert.equal(dialed.length, 1);
  assert.equal(events.filter((type) => type === "exhausted").length, 1);
});

test("配了多档时间点（可选）时：按 1.5s / 3s / 6s 各重拨一次，然后收手", () => {
  const clock = fakeClock();
  const dialed: number[] = [];
  const events: string[] = [];
  const retry = createCallRetry({
    attempt: () => dialed.push(clock.timers.now()),
    onEvent: (event) => events.push(event.type),
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.arm("17371432374");
  assert.deepEqual(dialed, [], "武装时不该立刻拨号");
  assert.equal(retry.running, true);

  clock.fire();
  assert.deepEqual(dialed, [1500, 3000, 6000]);
  assert.deepEqual(events, ["armed", "attempt", "attempt", "attempt"]);
  assert.equal(retry.running, false);
  assert.equal(retry.used, 3);
  assert.equal(clock.pending, 0);
});

test("重拨自己又失败：不会把进度清零（老实现会无限重拨）", () => {
  const clock = fakeClock();
  const events: string[] = [];
  let dials = 0;
  const retry = createCallRetry({
    // 平台一直回 480：每次重拨都再失败一次
    attempt: () => {
      dials += 1;
      retry.arm("17371432374");
    },
    onEvent: (event) => events.push(event.type),
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.arm("17371432374");
  clock.fire();
  assert.equal(dials, 3, "一分钟内最多 3 次，不能一直拨下去");

  // 链条走完后再来的失败：只提示一次，不再拨
  retry.arm("17371432374");
  retry.arm("17371432374");
  clock.fire();
  assert.equal(dials, 3);
  assert.equal(events.filter((type) => type === "exhausted").length, 1);

  // 下一次签入重新记账
  retry.reset();
  retry.arm("17371432374");
  clock.fire();
  assert.equal(dials, 6);
});

test("额度按「每次签入」记账：中途取消再武装也不会超支", () => {
  const clock = fakeClock();
  const dialed: number[] = [];
  const retry = createCallRetry({
    attempt: () => dialed.push(clock.timers.now()),
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.arm("A");
  clock.fire(2000);
  assert.deepEqual(dialed, [1500]);

  retry.cancel();
  assert.equal(clock.pending, 0, "取消后不该留下定时器");
  assert.equal(retry.running, false);

  retry.arm("B"); // 用户手动改拨别的号码，又失败了一次
  clock.fire();
  assert.equal(dialed.length, 3, "总额度仍是本次签入的 3 次");
});

test("已有呼叫在响：跳过该时间点，但不占额度", () => {
  const clock = fakeClock();
  const dialed: number[] = [];
  const skipped: number[] = [];
  let liveTicks = 1; // 只有第一个时间点刚好有呼叫在响
  const retry = createCallRetry({
    attempt: () => dialed.push(clock.timers.now()),
    hasLiveCall: () => liveTicks-- > 0,
    onEvent: (event) => {
      if (event.type === "skipped") skipped.push(event.attempt);
    },
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.arm("A");
  clock.fire();
  assert.deepEqual(skipped, [1]);
  assert.deepEqual(dialed, [3000, 6000], "后面的时间点照走");
});

test("接通后收手：finish() 之后不再兜底，reset() 重新记账", () => {
  const clock = fakeClock();
  let dials = 0;
  const retry = createCallRetry({
    attempt: () => {
      dials += 1;
    },
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.finish(); // 已经有一路接通过，平台侧是好的
  retry.arm("A");
  assert.equal(clock.pending, 0);
  clock.fire();
  assert.equal(dials, 0);

  retry.reset(); // 下一次签入
  retry.arm("A");
  clock.fire();
  assert.equal(dials, 3);
});

test("浏览器挂起后再回来：只把剩下的时间点走完，不会连环重拨", () => {
  const clock = fakeClock();
  const dialed: number[] = [];
  const retry = createCallRetry({
    attempt: () => dialed.push(clock.timers.now()),
    delays: MULTI_DELAYS,
    timers: clock.timers,
  });

  retry.reset();
  retry.arm("A");
  clock.jump(60_000); // 定时器还没跑，时间已经过去了
  clock.fire();
  assert.ok(dialed.length <= 3, `最多 3 次，实际 ${dialed.length}`);
  assert.equal(clock.pending, 0, "时间点走完后不该留下定时器");
});
