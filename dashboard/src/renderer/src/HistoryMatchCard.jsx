import React from 'react';
import { Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

export const HistoryMatchCard = ({ match, theme, type, onClick }) => {
  const p = match;
  let pr = {};
  if (typeof p.predicted_probs === 'string') {
    try { pr = JSON.parse(p.predicted_probs); } catch(e) {}
  } else if (p.predicted_probs) {
    pr = p.predicted_probs;
  }
  
  const hw = pr.homeWinProb || 0;
  const dr = pr.drawProb || 0;
  const aw = pr.awayWinProb || 0;
  const gg = pr.ggProb || 0;
  const o25 = pr.over25Prob || 0;
  const o15 = pr.over15Prob || 0;
  const o35 = pr.over35Prob || 0;
  const htft11 = pr.htft11Prob || 0;
  const htftXX = pr.htftXXProb || 0;
  const htft22 = pr.htft22Prob || 0;
  
  const u15 = Math.max(0, 100 - o15);
  const u25 = Math.max(0, 100 - o25);
  const u35 = Math.max(0, 100 - o35);
  const noGg = Math.max(0, 100 - gg);
  
  let predictedLabel = '-';
  if (type === 'scored') {
    predictedLabel = p.predicted_result || '-';
  } else if (type === 'ai') {
    predictedLabel = p.market || '-';
  } else {
    predictedLabel = p.predicted_result || '-';
  }

  const isHome = predictedLabel.toLowerCase() === 'home';
  const isDraw = predictedLabel.toLowerCase() === 'draw';
  const isAway = predictedLabel.toLowerCase() === 'away';
  
  // ML-based confidence (from 1X2 probabilities)
  const maxProb = Math.max(hw, dr, aw) / 100;
  const mlConf = Math.max(50, Math.min(98, Math.round(40 + (maxProb - 0.33) * 85)));
  // For AI picks: use backend-computed confidence (which is ML-based). For others use ML directly.
  const matchConf = p.confidence || mlConf;
  // Market probability (for AI picks, this is the specific bet market's prob)
  const marketProb = p.probability || 0;

  // Use market prob to drive confidence color when 1X2 data isn't present
  const effectiveProb = hw || aw || marketProb;
  const confColor = theme === 'light'
    ? (effectiveProb >= 60 ? '#16a34a' : effectiveProb >= 50 ? '#d97706' : '#64748b')
    : (effectiveProb >= 60 ? '#4ade80' : effectiveProb >= 50 ? '#fbbf24' : '#94a3b8');

  // Actual Score processing
  const isFinished = p.status === 'won' || p.status === 'lost' || p.scored_status === 1;
  const [hScore, aScore] = (p.actual_score || '').split(':');
  let actualResult = null;
  if (hScore !== undefined && aScore !== undefined) {
    const hs = parseInt(hScore, 10);
    const as = parseInt(aScore, 10);
    if (hs > as) actualResult = 'home';
    else if (as > hs) actualResult = 'away';
    else actualResult = 'draw';
  }

  let isCorrect = undefined;
  if (isFinished) {
    if (type === 'ai') {
      isCorrect = p.status === 'won';
    } else {
      isCorrect = actualResult === predictedLabel.toLowerCase();
    }
  }

  const formatTime = (ts) => {
    if (!ts) return match.match_time || '';
    const d = new Date(typeof ts === 'string' ? parseInt(ts, 10) || ts : ts);
    if (isNaN(d.getTime())) return match.match_time || '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const timeLabel = formatTime(match.kickoff_timestamp);

  const options = [
    { label: `🏠 ${p.home_team} Win`, prob: hw, colorType: 'blue' },
    { label: `✈️ ${p.away_team} Win`, prob: aw, colorType: 'red' },
    { label: '🤝 Draw', prob: dr, colorType: 'yellow' },
    { label: '⚽ GG/BTTS', prob: gg, colorType: 'purple' },
    { label: '❌ No GG', prob: noGg, colorType: 'yellow' },
    { label: '🔥 Over 1.5', prob: o15, colorType: 'green' },
    { label: '📈 Over 2.5', prob: o25, colorType: 'green' },
    { label: '💥 Over 3.5', prob: o35, colorType: 'green' },
    { label: '🛡️ Under 1.5', prob: u15, colorType: 'blue' },
    { label: '🛡️ Under 2.5', prob: u25, colorType: 'blue' },
    { label: '🛡️ Under 3.5', prob: u35, colorType: 'blue' },
    { label: '⏱️ HT/FT 1/1', prob: htft11, colorType: 'purple' },
    { label: '⏱️ HT/FT X/X', prob: htftXX, colorType: 'yellow' },
    { label: '⏱️ HT/FT 2/2', prob: htft22, colorType: 'purple' }
  ];
  const bestBet = options.reduce((max, opt) => opt.prob > max.prob ? opt : max, options[0]);

  let badgeBg, badgeColor;
  if (bestBet.colorType === 'blue') {
    badgeBg = theme === 'light' ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.2)';
    badgeColor = theme === 'light' ? '#1d4ed8' : '#60a5fa';
  } else if (bestBet.colorType === 'red') {
    badgeBg = theme === 'light' ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.2)';
    badgeColor = theme === 'light' ? '#dc2626' : '#f87171';
  } else if (bestBet.colorType === 'yellow') {
    badgeBg = theme === 'light' ? 'rgba(245,158,11,0.12)' : 'rgba(251,191,36,0.2)';
    badgeColor = theme === 'light' ? '#b45309' : '#fbbf24';
  } else if (bestBet.colorType === 'green') {
    badgeBg = theme === 'light' ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.2)';
    badgeColor = theme === 'light' ? '#16a34a' : '#4ade80';
  } else { // purple
    badgeBg = theme === 'light' ? 'rgba(168,85,247,0.1)' : 'rgba(168,85,247,0.2)';
    badgeColor = theme === 'light' ? '#7c3aed' : '#a78bfa';
  }

  // Outcome Colors
  let outcomeBg = theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
  let outcomeBorder = 'transparent';
  if (isFinished) {
    if (isCorrect === true) {
      outcomeBg = theme === 'light' ? 'rgba(22,163,74,0.1)' : 'rgba(34,197,94,0.15)';
      outcomeBorder = theme === 'light' ? 'rgba(22,163,74,0.2)' : 'rgba(34,197,94,0.3)';
    } else if (isCorrect === false) {
      outcomeBg = theme === 'light' ? 'rgba(220,38,38,0.1)' : 'rgba(239,68,68,0.15)';
      outcomeBorder = theme === 'light' ? 'rgba(220,38,38,0.2)' : 'rgba(239,68,68,0.3)';
    }
  }

  return (
    <div style={{
      background: theme === 'light' 
        ? 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)' 
        : 'linear-gradient(135deg, rgba(0,20,10,0.9) 0%, rgba(0,40,20,0.8) 100%)',
      border: isFinished 
        ? (isCorrect === true ? (theme === 'light' ? '1px solid rgba(22,163,74,0.3)' : '1px solid rgba(34,197,94,0.4)') 
           : isCorrect === false ? (theme === 'light' ? '1px solid rgba(220,38,38,0.3)' : '1px solid rgba(239,68,68,0.4)')
           : (theme === 'light' ? '1px solid rgba(0,132,61,0.15)' : '1px solid rgba(0,132,61,0.3)'))
        : (theme === 'light' ? '1px solid rgba(0,132,61,0.15)' : '1px solid rgba(0,132,61,0.3)'),
      borderRadius: '14px',
      overflow: 'hidden',
      cursor: 'pointer',
      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
      boxShadow: isFinished && isCorrect === true
        ? (theme === 'light' ? '0 4px 20px rgba(22,163,74,0.15)' : '0 4px 20px rgba(34,197,94,0.2)')
        : (theme === 'light' ? '0 4px 20px rgba(0,0,0,0.05)' : '0 4px 20px rgba(0,0,0,0.3)')
    }}
    onClick={onClick}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 10px 30px rgba(0,132,61,0.25)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = theme === 'light' ? '0 4px 20px rgba(0,0,0,0.05)' : '0 4px 20px rgba(0,0,0,0.3)'; }}
    >
      {/* Card Header */}
      <div style={{
        background: theme === 'light' ? 'rgba(0,132,61,0.05)' : 'rgba(0,132,61,0.15)',
        padding: '0.75rem 1rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: theme === 'light' ? '1px solid rgba(0,132,61,0.08)' : '1px solid rgba(0,132,61,0.2)'
      }}>
        <div style={{ fontSize: '0.75rem', color: theme === 'light' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span>⏰ {timeLabel || '—'}</span>
          <span style={{ opacity: 0.5 }}>•</span>
          <span style={{ color: confColor, fontWeight: 700 }}>🎯 {type === 'ai' ? `Conf: ${matchConf}%` : `${matchConf}%`}</span>
          {type === 'ai' && marketProb > 0 && (
            <>
              <span style={{ opacity: 0.5 }}>•</span>
              <span style={{ color: theme === 'light' ? '#7c3aed' : '#a78bfa', fontWeight: 700 }}>Mkt: {marketProb}%</span>
            </>
          )}
          {p.round_number && (
            <>
              <span style={{ opacity: 0.5 }}>•</span>
              <span style={{ fontWeight: 600 }}>Wk {p.round_number}</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {type === 'ai' && (
            <div style={{
              background: badgeBg,
              color: badgeColor,
              borderRadius: '20px', padding: '0.2rem 0.75rem', fontSize: '0.75rem', fontWeight: 700
            }}>
              {predictedLabel} — {marketProb}%
            </div>
          )}
          {type !== 'ai' && (
            <div style={{
              background: badgeBg,
              color: badgeColor,
              borderRadius: '20px', padding: '0.2rem 0.75rem', fontSize: '0.75rem', fontWeight: 700
            }}>
              {bestBet.label} ({bestBet.prob}%)
            </div>
          )}
          
          {isFinished && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: outcomeBg, border: outcomeBorder, padding: '0.2rem 0.5rem', borderRadius: '20px', fontSize: '0.7rem', fontWeight: 800, color: isCorrect === true ? (theme === 'light' ? '#16a34a' : '#4ade80') : isCorrect === false ? (theme === 'light' ? '#dc2626' : '#f87171') : 'inherit' }}>
              {isCorrect === true ? <CheckCircle size={12} /> : isCorrect === false ? <XCircle size={12} /> : <AlertCircle size={12} />}
              {isCorrect === true ? 'WON' : isCorrect === false ? 'LOST' : 'PENDING'}
            </div>
          )}
        </div>
      </div>

      {/* Teams */}
      <div style={{ padding: '1rem', textAlign: 'center', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: (type !== 'ai' && isHome) 
                ? (theme === 'light' ? '#1d4ed8' : '#60a5fa') 
                : (theme === 'light' ? '#1e293b' : '#fff'),
              wordBreak: 'break-word'
            }}>{p.home_team}</div>
            <div style={{ fontSize: '0.75rem', color: confColor, fontWeight: 700 }}>{hw}%</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
            {isFinished ? (
              <div style={{
                fontSize: '1.25rem', fontWeight: 800, color: theme === 'light' ? '#0f172a' : '#fff',
                background: theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)', padding: '0.2rem 0.75rem', borderRadius: '8px'
              }}>
                {hScore} - {aScore}
              </div>
            ) : (
              <div style={{ color: theme === 'light' ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.3)', fontSize: '1.2rem', fontWeight: 300 }}>VS</div>
            )}
            {p.actual_ht_score && (
              <div style={{ fontSize: '0.7rem', color: theme === 'light' ? '#64748b' : '#94a3b8' }}>HT {p.actual_ht_score}</div>
            )}
          </div>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: (type !== 'ai' && isAway) 
                ? (theme === 'light' ? '#dc2626' : '#f87171') 
                : (theme === 'light' ? '#1e293b' : '#fff'),
              wordBreak: 'break-word'
            }}>{p.away_team}</div>
            <div style={{ fontSize: '0.75rem', color: confColor, fontWeight: 700 }}>{aw}%</div>
          </div>
        </div>

        {/* 1X2 Bars */}
        <div style={{ marginTop: '0.75rem', borderRadius: '8px', overflow: 'hidden', height: '8px', background: theme === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)', display: 'flex' }}>
          <div style={{ width: `${hw}%`, background: 'linear-gradient(90deg, #3b82f6, #60a5fa)', transition: 'width 0.4s' }} />
          <div style={{ width: `${dr}%`, background: 'linear-gradient(90deg, #fbbf24, #f59e0b)', transition: 'width 0.4s' }} />
          <div style={{ width: `${aw}%`, background: 'linear-gradient(90deg, #ef4444, #f87171)', transition: 'width 0.4s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', marginTop: '0.3rem', color: theme === 'light' ? '#475569' : 'rgba(255,255,255,0.6)' }}>
          <span>Home {hw}%</span><span>Draw {dr}%</span><span>Away {aw}%</span>
        </div>
      </div>

      {/* Market Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', padding: '0 1rem 1rem' }}>
        {[
          { label: 'GG/BTTS', value: gg, good: gg >= 60 },
          { label: 'Over 1.5', value: o15, good: o15 >= 65 },
          { label: 'Over 2.5', value: o25, good: o25 >= 55 },
          { label: 'Over 3.5', value: o35, good: o35 >= 45 },
          { label: 'HT/FT 1/1', value: htft11, good: htft11 >= 30 },
          { label: 'HT/FT X/X', value: htftXX, good: htftXX >= 20 },
        ].map(({ label, value, good }) => (
          <div key={label} style={{ background: theme === 'light' ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '0.5rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.65rem', color: theme === 'light' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)', marginBottom: '0.2rem' }}>{label}</div>
            <div style={{
              fontSize: '0.95rem',
              fontWeight: 700,
              color: good 
                ? (theme === 'light' ? '#16a34a' : '#4ade80') 
                : value >= 40 
                  ? (theme === 'light' ? '#d97706' : '#fbbf24') 
                  : (theme === 'light' ? '#64748b' : '#94a3b8')
            }}>{value}%</div>
            <div style={{ height: '3px', background: theme === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)', borderRadius: '2px', marginTop: '0.25rem', overflow: 'hidden' }}>
              <div style={{
                width: `${value}%`,
                height: '100%',
                background: good 
                  ? (theme === 'light' ? '#16a34a' : '#4ade80') 
                  : (theme === 'light' ? '#d97706' : '#fbbf24'),
                borderRadius: '2px'
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
