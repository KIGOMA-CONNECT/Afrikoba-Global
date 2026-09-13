import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'system-ui' }}>
          <h2 style={{ color: '#c0392b', marginBottom: 8 }}>Kuna tatizo limetokea</h2>
          <p style={{ color: '#6b7a70', fontSize: 14, marginBottom: 8 }}>
            Bonyeza kitufe hapa chini. Ikiwa tatizo linaendelea, tumia "Ripoti".
          </p>
          <p style={{ color: '#8a3b3b', fontSize: 12, margin: '0 auto 14px', maxWidth: 520, wordBreak: 'break-word' }}>
            {String(this.state.error?.message || this.state.error)}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{ padding: '8px 20px', background: '#0b5d1e', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 14 }}
          >
            Jaribu Tena
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}