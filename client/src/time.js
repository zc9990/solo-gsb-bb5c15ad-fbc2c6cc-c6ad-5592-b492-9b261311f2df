// 时间工具：客户端在两份服务端快照之间用本地单调时钟插值，
// 渲染平滑（100ms 重绘），权威时间始终以服务端快照为准。

export function monoNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// 快照剩余时间（ms）。running 时按快照内的服务端单调时钟外推，
// 并夹取到 [0, durationMs]，避免越界。
export function liveRemaining(snap) {
  if (!snap) return 0;
  if (snap.phase !== 'running') return snap.remainingMs;
  const elapsed = monoNow() - snap.receivedAtMono;
  return Math.max(0, Math.min(snap.durationMs, snap.remainingMs - elapsed));
}

function pad2(n) {
  return String(Math.floor(n)).padStart(2, '0');
}

// MM:SS；60 秒内运行时附带一位十分之一秒，增强紧迫感
export function formatTime(ms, { tenths = false } = {}) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = `${pad2(minutes)}:${pad2(seconds)}`;
  if (tenths) {
    const t = Math.floor((clamped % 1000) / 100);
    return `${base}.${t}`;
  }
  return base;
}
