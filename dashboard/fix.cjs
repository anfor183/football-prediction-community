const fs = require('fs');
let code = fs.readFileSync('dashboard/src/renderer/src/App.jsx', 'utf8');

const searchStr = `{/* Row Inspector Modal */}
        {selectedRowData && (
          <div style={{`;

const renderFuncs = `  const renderPipeTable = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0 || typeof arr[0] !== 'string' || !arr[0].includes('|')) return null;
    const headers = arr[0].split('|').map(s => s.trim());
    const rows = arr.slice(1).map(row => (typeof row === 'string' ? row.split('|').map(s => s.trim()) : []));
    
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', marginBottom: '1rem', background: '#0f172a', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.05)' }}>
            {headers.map((h, i) => (
              <th key={i} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.8rem', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.1)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.8rem', color: '#e2e8f0' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderJsonValue = (obj) => {
    if (obj && typeof obj === 'object') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {Object.entries(obj).map(([k, v]) => {
            if (k === 'tables' && Array.isArray(v)) {
              return (
                <div key={k}>
                  <h4 style={{ margin: '0 0 0.5rem 0', color: '#fbbf24' }}>League Tables</h4>
                  {renderPipeTable(v)}
                </div>
              )
            }
            if (k === 'matches' && Array.isArray(v)) {
               return (
                <div key={k}>
                  <h4 style={{ margin: '0 0 0.5rem 0', color: '#fbbf24' }}>Matches</h4>
                  <ul style={{ margin: 0, paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {v.map((match, i) => <li key={i} style={{ color: '#e2e8f0', fontSize: '0.85rem' }}>{match}</li>)}
                  </ul>
                </div>
               )
            }
            if (typeof v === 'object' && v !== null) {
              return (
                <div key={k} style={{ padding: '0.5rem', background: 'rgba(0,0,0,0.1)', borderRadius: '6px' }}>
                  <div style={{ fontWeight: 600, color: '#94a3b8', marginBottom: '0.5rem' }}>{k}</div>
                  {renderJsonValue(v)}
                </div>
              )
            }
            return (
              <div key={k} style={{ display: 'flex', gap: '0.5rem' }}>
                <span style={{ color: '#94a3b8' }}>{k}:</span>
                <span style={{ color: '#e2e8f0', wordBreak: 'break-word' }}>{String(v)}</span>
              </div>
            )
          })}
        </div>
      )
    }
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem' }}>{JSON.stringify(obj, null, 2)}</pre>
  };

        {/* Row Inspector Modal */}
        {selectedRowData && (
          <div style={{`;

code = code.replace(searchStr, renderFuncs);

// We also need to remove the inline renderJsonValue that got injected
code = code.replace(/const renderJsonValue = \(val\) => <pre style=\{\{ margin: 0, fontSize: '0\.85rem' \}\}>\{JSON\.stringify\(val, null, 2\)\}<\/pre>;/g, '');

fs.writeFileSync('dashboard/src/renderer/src/App.jsx', code);
console.log('Successfully injected renderFuncs');
