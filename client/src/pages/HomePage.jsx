export default function HomePage() {
  return (
    <div className="home">
      <h1>会场发言计时</h1>
      <p className="subtitle">单控制台 · 多屏联播 · WebSocket 实时同步</p>
      <div className="home-cards">
        <a className="card card-console" href="/console">
          <span className="card-title">控制台</span>
          <span className="card-desc">设定时长、开始 / 暂停 / 继续 / 重置，持有唯一控制权</span>
        </a>
        <a className="card card-display" href="/display">
          <span className="card-title">投屏页</span>
          <span className="card-desc">大屏倒计时，60 秒警示、归零醒目提示，断线自动恢复</span>
        </a>
      </div>
      <p className="tip">投屏页建议浏览器按 F11 进入全屏；可在多块屏幕同时打开。</p>
    </div>
  );
}
