// 设备级互斥锁。
//
// 背景：Scheduler.tick() 用 `mode:platform` 作为 workerKey 做互斥，所以京东、美团、淘宝的
// 待办任务会被同时取出并各自调用 collector.collect()，在调度层面是真并发。
// 但物理上只有一台设备（一个 ADB serial、一块屏幕、一套输入焦点），三个采集器同时操作必然
// 互相抢前台、抢输入框焦点，结果就是 A 点的按钮实际落在 B 的页面上——这类错误在日志里表现为
// 「坐标越界」「点完页面不对」，极难和定位问题区分开。
//
// 因此三平台并行的正确形态是：**任务并行创建、设备串行执行**。
// 所有采集器在进入设备操作前都必须经过这把锁，取不到就排队等待。
//
// 注意：这把锁只解决单设备串行。将来上第二台设备时，应改为按设备分锁（key 用 serial），
// 那时三平台才能真正并行，届时需要重新配置通道（见 agent.md 5.3 节「同通道串行」）。

let tail: Promise<void> = Promise.resolve();
let current: string | null = null;
let waiting = 0;

/** 当前占用设备的平台，空闲时为 null。用于健康检查与诊断输出。 */
export function deviceHolder(): string | null {
  return current;
}

/** 排队等待设备的平台数量。 */
export function deviceQueueLength(): number {
  return waiting;
}

/**
 * 在设备锁保护下执行。同一时刻只允许一个平台占用设备。
 * @param platform 平台标识，仅用于日志与诊断
 * @param fn 实际采集逻辑
 */
export async function withDeviceLock<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  waiting += 1;
  const queuedAt = Date.now();
  try {
    await previous;
    waiting -= 1;
    current = platform;
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > 500) console.log(`[device-lock] ${platform} 取得设备（排队 ${Math.round(waitedMs / 1000)}s）`);
    return await fn();
  } finally {
    if (current === platform) current = null;
    release();
  }
}
