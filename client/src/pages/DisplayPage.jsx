import { useEffect, useState } from 'react';
import { useSocket } from '../useSocket.js';
import { formatTime, liveRemaining } from '../time.js';

// 投屏页：纯展示，不可操作。状态由服务端权威快照驱动。
export default function DisplayPage() {
  const { snap, connState } = useSocket({ role: 'display' });
  const [, force] = useState(0);

  // 100ms 重绘：对 running 快照做本地插值，保证大屏数字平滑
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.title = snap
      ? `${formatTime(liveRemaining(snap))} · 发言计时`
      : '发言计时投屏';
  });

  if (!snap) {
    return (
      <div className="display display-idle">
        <div className="display-time">--:--</div>
        <div className="display-state">{connState === 'open' ? '等待控制台' : '连接服务中…'}</div>
      </div>
    );
  }

  const remaining = liveRemaining(snap);
  const cls = snap.finished
    ? 'display-finished'
    : snap.warning
      ? 'display-warning'
      : snap.phase === 'idle'
        ? 'display-idle'
        : 'display-running';

  return (
    <div className={`display ${cls}`}>
      {connState !== 'open' && (
        <div className="reconnect-banner">
          {connState === 'reconnecting' ? '网络中断，正在重连并同步时间…' : '连接中…'}
        </div>
      )}

      <div className="display-phase">
        {phaseText(snap.phase)}
      </div>

      <div className="display-time">
        {snap.finished ? '00:00' : formatTime(remaining, { tenths: snap.warning && snap.phase === 'running' })}
      </div>

      <div className="display-state">
        {snap.finished
          ? '时间到'
          : snap.phase === 'idle'
            ? '待开始'
            : snap.phase === 'paused'
              ? '已暂停'
              : snap.warning
                ? '剩余不足 1 分钟'
                : '发言进行中'}
      </div>

      <div className="display-duration">设定时长 {formatTime(snap.durationMs)}</div>
    </div>
  );
}

function phaseText(phase) {
  return { idle: 'READY', running: 'SPEAKING', paused: 'PAUSED', finished: 'TIME UP' }[phase] || '';
}
