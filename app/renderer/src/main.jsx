import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// 渲染期一旦抛异常，整窗口就是一片黑，什么线索都没有 —— 至少把错误写到页面上
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[render] 崩了', err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 40, color: '#f0ede7', fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}>
        {'界面崩了：'}{String(this.state.err?.stack || this.state.err)}
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
