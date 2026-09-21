import React from 'react';
import { useTimerSocket, useRemainingMs, formatMs, STATUS_LABEL } from './useTimerSocket.js';

/** 投屏页：全屏大字倒计时，进入 60 秒转琥珀色告警，归零转红色闪烁“时间到”。 */
export default function Display() {
  const { snapshot, connected, offsetRef } = useTimerSocket('display');
  const remaining = useRemainingMs(snapshot, offsetRef);

  const status = snapshot ? snapshot.status : 'idle';
  const durationMs = snapshot ? snapshot.durationMs : 1;
  const warningMs = snapshot ? snapshot.warningMs : 60_000;
  const rem = remaining != null ? remaining : durationMs;

  const expired = status === 'expired' || (status === 'running' && rem <= 0);
  const warning = !expired && rem <= warningMs && (status === 'running' || status === 'paused');
  const phase = expired ? 'expired' : warning ? 'warning' : 'normal';
  const progress = Math.max(0, Math.min(1, durationMs > 0 ? rem / durationMs : 0));

  return (
    <div className={`display phase-${phase}`}>
      <div className="status-label">{STATUS_LABEL[status] || status}</div>
      <div className="big-time">{formatMs(rem)}</div>
      {expired && <div className="time-up">TIME&nbsp;UP</div>}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>
      {!connected && <div className="offline-badge">连接断开，重连中…（画面保持最后状态）</div>}
    </div>
  );
}
