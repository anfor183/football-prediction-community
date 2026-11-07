import './web_bridge_client'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/main.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    const errObj = {
      msg: error ? error.message : 'React Render Error',
      url: 'ReactErrorBoundary',
      line: 0,
      col: 0,
      stack: error ? error.stack : ''
    };
    if (window.api && window.api.logRendererError) {
      window.api.logRendererError(errObj).catch(err => {
        console.error('Failed to log renderer error:', err);
      });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = async () => {
    if (window.confirm("Are you sure you want to clear your local cache, settings, and reload? This can resolve crashes due to corrupted state.")) {
      try {
        localStorage.clear();
        sessionStorage.clear();
        if (window.api && window.api.smartClearData) {
          await window.api.smartClearData();
        }
      } catch (e) {
        console.error('Failed to clear state:', e);
      }
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          background: '#040815',
          fontFamily: "'Outfit', 'Inter', sans-serif",
          color: '#f8fafc',
          padding: '2rem',
          boxSizing: 'border-box'
        }}>
          <div style={{
            background: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '24px',
            padding: '2.5rem',
            maxWidth: '680px',
            width: '100%',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            position: 'relative',
            overflow: 'hidden'
          }}>
            {/* Background glowing gradient */}
            <div style={{
              position: 'absolute',
              top: '-150px',
              right: '-150px',
              width: '300px',
              height: '300px',
              background: 'radial-gradient(circle, rgba(16, 185, 129, 0.15) 0%, rgba(16, 185, 129, 0) 70%)',
              pointerEvents: 'none'
            }} />
            <div style={{
              position: 'absolute',
              bottom: '-150px',
              left: '-150px',
              width: '300px',
              height: '300px',
              background: 'radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, rgba(59, 130, 246, 0) 70%)',
              pointerEvents: 'none'
            }} />

            {/* Error header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
              <div style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '12px',
                width: '48px',
                height: '48px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.5rem'
              }}>
                ⚠️
              </div>
              <div>
                <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.02em' }}>
                  Dashboard Recovery Console
                </h1>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                  An unexpected React render exception has been intercepted.
                </div>
              </div>
            </div>

            <p style={{ fontSize: '0.9rem', color: '#cbd5e1', lineHeight: '1.6', marginBottom: '1.5rem' }}>
              This error has been logged automatically to <code style={{ background: 'rgba(255,255,255,0.06)', padding: '0.2rem 0.4rem', borderRadius: '6px', color: '#60a5fa', fontSize: '0.85rem' }}>logs/renderer-process.log</code>. 
              Please review the stack trace below for details.
            </p>

            {/* Code Box */}
            <div style={{
              background: 'rgba(2, 6, 23, 0.8)',
              border: '1px solid rgba(255,255,255,0.05)',
              borderRadius: '14px',
              padding: '1.25rem',
              marginBottom: '2rem',
              maxHeight: '220px',
              overflowY: 'auto',
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: '0.8rem',
              color: '#f87171',
              whiteSpace: 'pre-wrap',
              boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.6)'
            }}>
              <strong style={{ color: '#ef4444', display: 'block', marginBottom: '0.5rem' }}>
                {this.state.error && this.state.error.toString()}
              </strong>
              {this.state.error && this.state.error.stack}
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                onClick={this.handleReload}
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '12px',
                  padding: '0.75rem 1.5rem',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
                  transition: 'all 0.25s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
                onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(16, 185, 129, 0.35)'; }}
                onMouseOut={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.25)'; }}
              >
                🔄 Reload Dashboard
              </button>

              <button
                onClick={this.handleReset}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: '#e2e8f0',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '12px',
                  padding: '0.75rem 1.5rem',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.25s ease'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'; }}
              >
                🗑️ Clear Cache & Restart
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

console.log('Renderer process started')
ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
