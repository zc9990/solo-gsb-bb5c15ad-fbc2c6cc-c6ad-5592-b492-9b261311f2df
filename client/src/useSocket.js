import { useCallback, useEffect, useRef, useState } from 'react';
import { monoNow } from './time.js';
import { judgeSnapshot, INITIAL_BASELINE } from './guard.js';

// 单一 WebSocket 连接管理：
//  - 自动重连（指数退避，上限 5s）；
//  - 快照版本守卫：低版本 / 旧纪元（服务端重启前）消息一律丢弃，画面不回滚；
//  - 控制台心跳续租，断线自动重新申请控制权。
const HEARTBEAT_MS = 5000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5000;

export function useSocket({ role }) {
  const [snap, setSnap] = useState(null);
  const [connState, setConnState] = useState('connecting'); // connecting | open | reconnecting
  const [control, setControl] = useState({ granted: false });
  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const wantControlRef = useRef(role === 'console'); // 控制台始终希望持有控制权
  const myIdRef = useRef(null);
  const baselineRef = useRef({ ...INITIAL_BASELINE });

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const acquire = useCallback(() => {
    wantControlRef.current = true;
    send({ command: 'acquire' });
  }, [send]);

  const release = useCallback(() => {
    wantControlRef.current = false;
    send({ command: 'release' });
    setControl({ granted: false });
  }, [send]);

  useEffect(() => {
    let disposed = false;
    let heartbeatTimer = null;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        retryRef.current = 0;
        setConnState('open');
        // 重连后旧租约已被服务端释放，若之前持有/需要控制权则重新申请
        if (wantControlRef.current) ws.send(JSON.stringify({ command: 'acquire' }));
        heartbeatTimer = setInterval(() => {
          ws.send(JSON.stringify({ command: 'heartbeat' }));
        }, HEARTBEAT_MS);
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.type === 'hello') {
          myIdRef.current = msg.clientId;
          // 连接/重连首包显式建立纪元基线；服务端重启后 epoch 变化，重置版本号
          baselineRef.current = { currentEpoch: msg.epoch, currentVersion: 0 };
          return;
        }

        if (msg.type === 'snapshot') {
          // 版本守卫：过期/重复/旧纪元消息一律丢弃，画面不得回滚
          const verdict = judgeSnapshot(baselineRef.current, msg);
          if (!verdict.accept) return;
          baselineRef.current = { currentEpoch: verdict.epoch, currentVersion: verdict.version };
          setSnap({ ...msg, receivedAtMono: monoNow() });

          // 控制权归属对账（可能被其他控制台顶掉/超时释放）
          const mine = msg.holderId != null && msg.holderId === myIdRef.current;
          setControl((prev) => {
            if (prev.granted === mine && prev.holderId === msg.holderId) return prev;
            return mine
              ? { granted: true, holderId: msg.holderId }
              : { granted: false, holderId: msg.holderId, locked: msg.locked };
          });
          return;
        }

        if (msg.type === 'control') {
          // 控制权消息为单播；targetId 存在时仅当事连接处理
          if (msg.targetId && msg.targetId !== myIdRef.current) return;
          if (msg.granted) {
            setControl({ granted: true, holderId: myIdRef.current });
          } else {
            // 被拒绝 / 释放 / 断线 / 超时，本端失去控制权
            setControl({
              granted: false,
              reason: msg.reason,
              holderId: msg.holderId ?? null,
              locked: msg.reason === 'locked',
            });
          }
        }
      });

      ws.addEventListener('close', () => {
        clearInterval(heartbeatTimer);
        if (disposed) return;
        setConnState('reconnecting');
        setControl((prev) => (prev.granted ? { ...prev, granted: false, reason: 'reconnect' } : prev));
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryRef.current);
        retryRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        ws.close();
      });
    };

    connect();

    return () => {
      disposed = true;
      clearInterval(heartbeatTimer);
      clearTimeout(reconnectTimerRef.current);
      const ws = wsRef.current;
      if (ws) {
        // 正常卸载：通知服务端释放租约
        if (wantControlRef.current && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ command: 'release' }));
        }
        ws.close();
      }
    };
  }, []);

  return {
    snap,
    connState,
    control,
    send,
    acquire,
    release,
  };
}
