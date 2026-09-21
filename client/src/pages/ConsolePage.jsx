import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../useSocket.js';
import { formatTime, liveRemaining } from '../time.js';

// 控制台：同一时刻全服务仅一个实例可持有控制权。
export default function ConsolePage() {
  const { snap, connState, control, send, acquire, release } = useSocket({ role: 'console' });
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [, force] = useState(0);

  // 100ms 重绘运行中的预览时间
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  // 首次收到快照时用服务端时长回填输入框
  const hydrated = useRef(false);
  if (!hydrated.current && snap) {
    hydrated.current = true;
    setMinutes(Math.floor(snap.durationMs / 60000));
    setSeconds(Math.round((snap.durationMs % 60000) / 1000));
  }

  const phase = snap?.phase ?? 'idle';
  const durationMs = Math.max(1000, (Number(minutes) || 0) * 60000 + (Number(seconds) || 0) * 1000);

  const applyDuration = () => send({ command: 'set_duration', durationMs });
  const cmd = (command, extra = {}) => send({ command, ...extra });

  const remaining = snap ? liveRemaining(snap) : 0;

  return (
    <div className="console">
      <header className="console-header">
        <h1>发言计时 · 控制台</h1>
        <div className="badges">
          <span className={`badge badge-${connState}`}>
            {connState === 'open' ? '● 已连接' : connState === 'reconnecting' ? '● 重连中' : '● 连接中'}
          </span>
          {control.granted ? (
            <span className="badge badge-held">🎙 持有控制权</span>
          ) : (
            <span className="badge badge-locked">🔒 未持有控制权</span>
          )}
        </div>
      </header>

      {!control.granted && (
        <section className="lock-panel">
          {control.locked ? (
            <>
              <p>已有其他控制台持有控制权，需等待其释放或失联（约 15 秒无心跳）后自动释放。</p>
              <button className="btn" onClick={acquire}>重新申请控制权</button>
              {control.reason === 'reconnect' && <p className="hint">网络重连后将自动重新申请。</p>}
            </>
          ) : (
            <>
              <p>当前无控制台持有控制权。</p>
              <button className="btn btn-primary" onClick={acquire}>申请控制权</button>
            </>
          )}
        </section>
      )}

      <section className={`preview ${snap?.finished ? 'preview-finished' : snap?.warning ? 'preview-warning' : ''}`}>
        <div className="preview-time">
          {snap ? formatTime(remaining, { tenths: snap.warning && phase === 'running' }) : '--:--'}
        </div>
        <div className="preview-state">{stateLabel(phase, snap?.warning, snap?.finished)}</div>
        <div className="preview-meta">
          设定时长 {snap ? formatTime(snap.durationMs) : '--:--'} · 版本 v{snap?.version ?? '-'}
        </div>
      </section>

      <fieldset className="panel" disabled={!control.granted}>
        <legend>设定时长</legend>
        <div className="duration-inputs">
          <label>
            分
            <input
              type="number"
              min="0"
              max="1440"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <label>
            秒
            <input
              type="number"
              min="0"
              max="59"
              step="5"
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <button
            className="btn"
            onClick={applyDuration}
            disabled={phase === 'running'}
            title={phase === 'running' ? '运行中请先暂停/重置' : '应用新时长（画面回到待开始）'}
          >
            应用时长
          </button>
        </div>
        <p className="hint">运行中不可修改时长；应用新时长会回到待开始状态。</p>
      </fieldset>

      <fieldset className="panel" disabled={!control.granted}>
        <legend>计时控制</legend>
        <div className="controls">
          <button
            className="btn btn-start"
            onClick={() => cmd('start')}
            disabled={phase === 'running'}
          >
            ▶ 开始
          </button>
          <button
            className="btn btn-pause"
            onClick={() => cmd('pause')}
            disabled={phase !== 'running'}
          >
            ⏸ 暂停
          </button>
          <button
            className="btn btn-resume"
            onClick={() => cmd('resume')}
            disabled={phase !== 'paused'}
          >
            ⏵ 继续
          </button>
          <button className="btn btn-reset" onClick={() => cmd('reset', { durationMs })}>
            ⟲ 重置
          </button>
        </div>
      </fieldset>

      {control.granted && (
        <div className="release-row">
          <button className="btn btn-ghost" onClick={release}>释放控制权（供其他控制台接管）</button>
        </div>
      )}

      <p className="foot-tip">投屏地址：<a href="/display" target="_blank" rel="noreferrer">/display</a>（可多屏打开）</p>
    </div>
  );
}

function stateLabel(phase, warning, finished) {
  if (finished) return '时间到';
  if (phase === 'idle') return '待开始';
  if (phase === 'paused') return '已暂停';
  return warning ? '剩余不足 1 分钟' : '发言进行中';
}
