import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 计时 WebSocket Hook。
 *
 * - 自动重连（退避），重连后服务端会推送递增版本的最新快照，画面恢复同一剩余时间；
 * - 仅接受 version 严格递增的快照，过期/乱序消息直接丢弃，画面不会回滚；
 * - 运行态下用服务端单调时钟（serverNow/endAt）与本地单调时钟的偏移做平滑插值。
 */
export function useTimerSocket(role) {
  const [snapshot, setSnapshot] = useState(null);
  const [control, setControl] = useState({ granted: false, holderConnected: false });
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const lastVersionRef = useRef(-1);
  const offsetRef = useRef(0); // serverNow - performance.now()

  useEffect(() => {
    let ws = null;
    let closed = false;
    let retry = 0;
    let timer = null;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws?role=${role}`);
      wsRef.current = ws;

      ws.onopen = () => { retry = 0; setConnected(true); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'snapshot') {
          if (msg.version <= lastVersionRef.current) return; // 过期快照：丢弃，不回滚
          lastVersionRef.current = msg.version;
          offsetRef.current = msg.serverNow - performance.now();
          setSnapshot(msg);
        } else if (msg.type === 'control') {
          setControl({ granted: !!msg.granted, holderConnected: !!msg.holderConnected });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        setControl((c) => ({ ...c, granted: false }));
        if (!closed) {
          retry += 1;
          timer = setTimeout(connect, Math.min(5000, 400 * retry));
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) try { ws.close(); } catch { /* ignore */ }
    };
  }, [role]);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  return { snapshot, control, connected, send, offsetRef };
}

/** 以 100ms 节奏计算当前剩余毫秒数（运行态用单调时钟插值，其余直接取快照值）。 */
export function useRemainingMs(snapshot, offsetRef) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 100);
    return () => clearInterval(t);
  }, []);
  if (!snapshot) return null;
  if (snapshot.status === 'running' && snapshot.endAt != null) {
    return Math.max(0, snapshot.endAt - (performance.now() + offsetRef.current));
  }
  return snapshot.remainingMs;
}

export function formatMs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const STATUS_LABEL = {
  idle: '待 机',
  running: '进行中',
  paused: '已暂停',
  expired: '时间到',
};
