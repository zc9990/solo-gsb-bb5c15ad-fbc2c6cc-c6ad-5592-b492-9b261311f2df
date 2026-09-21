import React, { useEffect, useState } from 'react';
import { useTimerSocket, useRemainingMs, formatMs, STATUS_LABEL } from './useTimerSocket.js';

const PRESETS_MIN = [1, 3, 5, 10, 15, 20, 30, 45, 60];

/** 控制台：设定时长、开始/暂停/继续/重置；同一时刻仅一个控制台持有控制权。 */
export default function Console() {
  const { snapshot, control, connected, send, offsetRef } = useTimerSocket('console');
  const remaining = useRemainingMs(snapshot, offsetRef);
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);

  const status = snapshot ? snapshot.status : 'idle';
  const durationMs = snapshot ? snapshot.durationMs : 0;
  const warningMs = snapshot ? snapshot.warningMs : 60_000;
  const rem = remaining != null ? remaining : durationMs;

  // 快照时长变化时同步输入框，便于多端观察一致
  useEffect(() => {
    if (!snapshot) return;
    setMinutes(Math.floor(snapshot.durationMs / 60000));
    setSeconds(Math.round((snapshot.durationMs % 60000) / 1000));
  }, [snapshot && snapshot.durationMs]);

  const expired = status === 'expired';
  const warning = !expired && rem <= warningMs && (status === 'running' || status === 'paused');
  const phase = expired ? 'expired' : warning ? 'warning' : 'normal';

  const canOperate = connected && control.granted;
  const applyDuration = (ms) => send({ type: 'set_duration', ms });
  const applyCustom = () => {
    const ms = (Number(minutes) || 0) * 60_000 + (Number(seconds) || 0) * 1000;
    if (ms >= 1000) applyDuration(ms);
  };

  return (
    <div className="console">
      <header className="console-header">
        <h1>发言计时控制台</h1>
        <div className="badges">
          <span className={`badge ${connected ? 'ok' : 'bad'}`}>
            {connected ? '已连接' : '连接断开，重连中…'}
          </span>
          <span className={`badge ${control.granted ? 'ok' : 'warn'}`}>
            {control.granted
              ? '持有控制权'
              : control.holderConnected
                ? '只读（控制权在其他控制台）'
                : '等待控制权…'}
          </span>
        </div>
      </header>

      {!control.granted && control.holderConnected && (
        <div className="notice">另一控制台正在控制计时，本端为只读观察；对方断开后将自动移交控制权。</div>
      )}

      <section className={`preview phase-${phase}`}>
        <div className="preview-time">{formatMs(rem)}</div>
        <div className="preview-meta">
          <span>{STATUS_LABEL[status] || status}</span>
          <span>设定 {formatMs(durationMs)}</span>
        </div>
      </section>

      <section className="panel">
        <h2>设定时长</h2>
        <div className="presets">
          {PRESETS_MIN.map((m) => (
            <button
              key={m}
              className={durationMs === m * 60_000 ? 'chip active' : 'chip'}
              disabled={!canOperate || status === 'running'}
              onClick={() => applyDuration(m * 60_000)}
            >
              {m} 分钟
            </button>
          ))}
        </div>
        <div className="custom">
          <label>
            分
            <input
              type="number" min="0" max="720" value={minutes}
              disabled={!canOperate || status === 'running'}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <label>
            秒
            <input
              type="number" min="0" max="59" value={seconds}
              disabled={!canOperate || status === 'running'}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <button className="btn" disabled={!canOperate || status === 'running'} onClick={applyCustom}>
            应用时长
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>计时控制</h2>
        <div className="actions">
          <button className="btn primary" disabled={!canOperate || status === 'running'} onClick={() => send({ type: 'start' })}>
            开始
          </button>
          <button className="btn" disabled={!canOperate || status !== 'running'} onClick={() => send({ type: 'pause' })}>
            暂停
          </button>
          <button className="btn" disabled={!canOperate || status !== 'paused'} onClick={() => send({ type: 'resume' })}>
            继续
          </button>
          <button className="btn danger" disabled={!canOperate} onClick={() => send({ type: 'reset' })}>
            重置
          </button>
        </div>
        <p className="hint">进入最后 60 秒投屏转为琥珀色告警；归零后转为红色闪烁「时间到」。</p>
      </section>
    </div>
  );
}
