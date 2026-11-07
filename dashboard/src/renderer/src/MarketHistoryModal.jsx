import React, { useState, useMemo } from 'react';
import { X, BarChart2, RefreshCw, Trash2, Bot, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle, XCircle, Minus, Search, Calendar, TrendingUp } from 'lucide-react';

// ─── Pure helpers ─────────────────────────────────────────────────────────────
const getActualOutcome = (h, a) => (h > a ? 'Home' : a > h ? 'Away' : 'Draw');
const marketWon = (mkt, h, a, h_ht, a_ht) => {
  if (h == null || a == null) return null;
  switch (mkt) {
    case 'home': return h > a; case 'draw': return h === a; case 'away': return a > h;
    case 'gg': return h > 0 && a > 0;
    case 'over15': return h + a > 1; case 'over25': return h + a > 2; case 'over35': return h + a > 3;
    case 'htft11': return (h_ht != null && a_ht != null) ? (h_ht > a_ht && h > a) : null;
    case 'htftXX': return (h_ht != null && a_ht != null) ? (h_ht === a_ht && h === a) : null;
    default: return null;
  }
};
const predicted1X2 = (pr) => {
  const h = pr?.homeWinProb || 0, d = pr?.drawProb || 0, a = pr?.awayWinProb || 0;
  return h >= d && h >= a ? 'Home' : a >= h && a >= d ? 'Away' : 'Draw';
};
const toDateKey = (ts) => {
  if (!ts) return null;
  const d = new Date(Number(ts));
  return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const calcConf = (hw, dr, aw) => Math.max(50, Math.min(98, Math.round(40 + (Math.max(hw,dr,aw)/100 - 0.33) * 85)));

// ─── Neon color by probability value ─────────────────────────────────────────
const probColor = (v) => v >= 65 ? '#22c55e' : v >= 45 ? '#f59e0b' : '#64748b';
const probGlow  = (v) => v >= 65 ? 'rgba(34,197,94,0.25)' : v >= 45 ? 'rgba(245,158,11,0.2)' : 'none';
const probBg    = (v) => v >= 65 ? 'rgba(34,197,94,0.1)' : v >= 45 ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.025)';

// ─── Win Rate Ring ─────────────────────────────────────────────────────────────
const Ring = ({ rate, size = 56 }) => {
  const valid = !isNaN(rate) && rate >= 0;
  const pct = valid ? Math.round(rate) : 0;
  const color = pct >= 60 ? '#22c55e' : pct >= 40 ? '#f59e0b' : pct > 0 ? '#ef4444' : '#334155';
  const r = size / 2 - 7;
  const circ = 2 * Math.PI * r;
  const dash = circ * (pct / 100);
  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5.5"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5.5"
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ - dash}
          style={{ transition:'stroke-dashoffset 0.7s cubic-bezier(.4,0,.2,1), stroke 0.3s', filter:`drop-shadow(0 0 5px ${color}66)` }}/>
      </svg>
      <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',
        fontSize:size*0.19, fontWeight:900, color: valid ? color : '#334155', letterSpacing:'-0.5px' }}>
        {valid ? `${pct}%` : '—'}
      </div>
    </div>
  );
};

// ─── Heat Calendar ────────────────────────────────────────────────────────────
const HeatCalendar = ({ dayStats, selectedDay, onSelect }) => {
  const [view, setView] = useState(() => { const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1); });
  const yr = view.getFullYear(), mo = view.getMonth();
  const label = view.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const firstDow = new Date(yr,mo,1).getDay();
  const dim = new Date(yr,mo+1,0).getDate();
  const offset = firstDow === 0 ? 6 : firstDow - 1;
  const cells = [];
  for (let i=0;i<offset;i++) cells.push(null);
  for (let d=1;d<=dim;d++) {
    const k=`${yr}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push({d,k});
  }
  while (cells.length%7) cells.push(null);

  const todayKey = toDateKey(Date.now());

  const dayColor = (k) => {
    const s = dayStats[k];
    if (!s||!s.total) return { bg:'rgba(255,255,255,0.03)', bdr:'rgba(255,255,255,0.06)', dot:null, rate:null };
    if (!s.finished) return { bg:'rgba(245,158,11,0.1)', bdr:'rgba(245,158,11,0.25)', dot:'#f59e0b', rate:null };
    const rate = s.won/s.finished;
    if (rate>=0.6) return { bg:'rgba(34,197,94,0.13)', bdr:'rgba(34,197,94,0.4)', dot:'#22c55e', glow:'rgba(34,197,94,0.3)', rate:Math.round(rate*100) };
    if (rate>=0.4) return { bg:'rgba(245,158,11,0.1)', bdr:'rgba(245,158,11,0.3)', dot:'#f59e0b', rate:Math.round(rate*100) };
    return { bg:'rgba(239,68,68,0.1)', bdr:'rgba(239,68,68,0.32)', dot:'#ef4444', rate:Math.round(rate*100) };
  };

  // Month summary
  const moKeys = Object.keys(dayStats).filter(k=>k.startsWith(`${yr}-${String(mo+1).padStart(2,'0')}`));
  const moTotal = moKeys.reduce((s,k)=>s+(dayStats[k]?.finished||0),0);
  const moWon = moKeys.reduce((s,k)=>s+(dayStats[k]?.won||0),0);
  const moRate = moTotal>0?Math.round((moWon/moTotal)*100):null;
  const profitDays = moKeys.filter(k=>{const s=dayStats[k];return s&&s.finished>0&&s.won/s.finished>=0.6;}).length;
  const losingDays = moKeys.filter(k=>{const s=dayStats[k];return s&&s.finished>0&&s.won/s.finished<0.4;}).length;

  return (
    <div style={{display:'flex',flexDirection:'column',gap:'0.7rem'}}>
      {/* Month nav */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <button onClick={()=>setView(new Date(yr,mo-1,1))} style={navBtn}>
          <ChevronLeft size={13}/>
        </button>
        <span style={{fontSize:'0.78rem',fontWeight:700,color:'#e2e8f0'}}>{label}</span>
        <button onClick={()=>setView(new Date(yr,mo+1,1))} style={navBtn}>
          <ChevronRight size={13}/>
        </button>
      </div>

      {/* Day headers */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:'2px'}}>
        {['M','T','W','T','F','S','S'].map((d,i)=>(
          <div key={i} style={{textAlign:'center',fontSize:'0.58rem',fontWeight:700,color:'#334155',padding:'0.1rem 0'}}>{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:'2px'}}>
        {cells.map((cell,i)=>{
          if (!cell) return <div key={i}/>;
          const {bg,bdr,dot,glow,rate}=dayColor(cell.k);
          const isSel=selectedDay===cell.k;
          const isToday=cell.k===todayKey;
          const hasData=!!dot;
          return (
            <div key={cell.k} onClick={()=>hasData&&onSelect(isSel?null:cell.k)}
              title={dayStats[cell.k]?`${dayStats[cell.k].total} matches · ${rate??'?'}% accuracy`:'No data'}
              style={{
                background: isSel ? (dot||'rgba(99,102,241,0.4)') : bg,
                border:`1.5px solid ${isSel?(dot||'#6366f1'):bdr}`,
                borderRadius:'8px', padding:'3px 1px 2px',
                cursor:hasData?'pointer':'default',
                textAlign:'center', transition:'all 0.15s ease',
                boxShadow: isSel ? `0 0 14px ${glow||'rgba(99,102,241,0.4)'}` : glow&&!isSel ? `0 0 6px ${glow}` : 'none',
                transform: isSel?'scale(1.12)':'scale(1)',
                position:'relative', zIndex:isSel?2:1
              }}>
              <div style={{fontSize:'0.63rem',fontWeight:isToday?900:600,
                color:isSel?'#fff':isToday?'#818cf8':hasData?'#e2e8f0':'#334155',lineHeight:1.1}}>
                {cell.d}
              </div>
              {dot&&<div style={{width:'4px',height:'4px',borderRadius:'50%',background:dot,margin:'1px auto 0',
                boxShadow:`0 0 5px ${dot}88`}}/>}
              {!dot&&<div style={{height:'5px'}}/>}
              {rate!==null&&<div style={{fontSize:'0.5rem',fontWeight:700,color:isSel?'rgba(255,255,255,0.85)':dot,lineHeight:1,marginTop:'1px'}}>{rate}%</div>}
              {!rate&&dot&&<div style={{height:'8px'}}/>}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{display:'flex',flexDirection:'column',gap:'0.3rem',marginTop:'0.1rem'}}>
        {[['#22c55e','≥60% Profitable'],['#f59e0b','40–60% Average'],['#ef4444','<40% Losing']].map(([c,l])=>(
          <div key={l} style={{display:'flex',alignItems:'center',gap:'0.4rem'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:c,boxShadow:`0 0 6px ${c}`,flexShrink:0}}/>
            <span style={{fontSize:'0.6rem',color:'#64748b',fontWeight:600}}>{l}</span>
          </div>
        ))}
      </div>

      {/* Monthly summary box */}
      {moTotal>0&&(
        <div style={{background:'linear-gradient(135deg,rgba(15,20,45,0.9),rgba(10,15,35,0.8))',
          border:'1px solid rgba(99,102,241,0.15)',borderRadius:'12px',padding:'0.7rem',marginTop:'0.1rem'}}>
          <div style={{fontSize:'0.6rem',color:'#475569',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.6px',marginBottom:'0.5rem'}}>
            📈 Month Summary
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.35rem'}}>
            {[
              {label:'Scored',val:moTotal,color:'#818cf8'},
              {label:'Won',val:moWon,color:'#22c55e'},
              {label:'Accuracy',val:moRate?`${moRate}%`:'—',color:moRate>=60?'#22c55e':moRate>=40?'#f59e0b':'#ef4444'},
              {label:'🟢 Days',val:profitDays,color:'#22c55e'},
            ].map(s=>(
              <div key={s.label} style={{textAlign:'center',background:'rgba(255,255,255,0.03)',borderRadius:'8px',padding:'0.4rem 0.2rem'}}>
                <div style={{fontSize:'1rem',fontWeight:900,color:s.color,lineHeight:1}}>{s.val}</div>
                <div style={{fontSize:'0.56rem',color:'#475569',textTransform:'uppercase',letterSpacing:'0.4px',fontWeight:600,marginTop:'0.1rem'}}>{s.label}</div>
              </div>
            ))}
          </div>
          {losingDays>0&&<div style={{fontSize:'0.62rem',color:'#ef4444',marginTop:'0.4rem',textAlign:'center',fontWeight:600}}>⚠️ {losingDays} losing day{losingDays!==1?'s':''} this month</div>}
        </div>
      )}
    </div>
  );
};

const navBtn = {
  background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'7px',
  color:'#64748b',cursor:'pointer',width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',transition:'all 0.15s'
};

// ─── Market Cell (used in cards) ────────────────────────────────────────────
const MktCell = ({ label, val, outcome }) => {
  const won  = outcome === true;
  const lost = outcome === false;
  const known = outcome !== null && outcome !== undefined;
  const numColor = won ? '#22c55e' : lost ? '#ef4444' : probColor(val);
  const bg  = won  ? 'rgba(34,197,94,0.13)' : lost ? 'rgba(239,68,68,0.11)' : probBg(val);
  const bdr = won  ? 'rgba(34,197,94,0.4)'  : lost ? 'rgba(239,68,68,0.35)' : `${probColor(val)}28`;
  const shadow = won ? '0 0 12px rgba(34,197,94,0.2)' : lost ? '0 0 10px rgba(239,68,68,0.15)' : 'none';
  return (
    <div style={{ background:bg, borderRadius:'10px', padding:'0.5rem 0.4rem',
      border:`1px solid ${bdr}`, boxShadow:shadow, textAlign:'center', transition:'all 0.2s' }}>
      <div style={{ fontSize:'0.56rem', color: known?(won?'#4ade80':'#f87171'):'#475569',
        fontWeight:600, marginBottom:'0.1rem', letterSpacing:'0.3px' }}>{label}</div>
      <div style={{ fontSize:'0.95rem', fontWeight:900, color:numColor,
        textShadow: won?'0 0 8px rgba(34,197,94,0.7)':lost?'0 0 8px rgba(239,68,68,0.5)':null }}>
        {val}%
      </div>
      {known ? (
        <div style={{ marginTop:'0.22rem', fontSize:'0.65rem', fontWeight:900, letterSpacing:'0.3px',
          color: won?'#22c55e':'#ef4444',
          textShadow: won?'0 0 8px #22c55e':'0 0 8px #ef4444' }}>
          {won ? '✓ WON' : '✗ LOST'}
        </div>
      ) : (
        <div style={{ height:'3px', background:'rgba(255,255,255,0.05)', borderRadius:'3px', marginTop:'0.28rem', overflow:'hidden' }}>
          <div style={{ width:`${val}%`, height:'100%', background:`linear-gradient(90deg,${numColor}88,${numColor})`, borderRadius:'3px' }}/>
        </div>
      )}
    </div>
  );
};


// ─── ML Match Card ────────────────────────────────────────────────────────────
const MLCard = ({ match: m, onClick }) => {
  const pr = m.probs || {};
  const hw=pr.homeWinProb||0, dr=pr.drawProb||0, aw=pr.awayWinProb||0;
  const gg=pr.ggProb||0,o15=pr.over15Prob||0,o25=pr.over25Prob||0,o35=pr.over35Prob||0;
  const conf = calcConf(hw,dr,aw);
  const { hScore, aScore, isFinished, predictedOutcome, actualOutcome, isCorrect1X2, timeLabel } = m;
  const ok = isCorrect1X2 === true, fail = isCorrect1X2 === false;

  // Glow ring color
  const glowCol = ok ? '#22c55e' : fail ? '#ef4444' : isFinished ? '#ef4444' : '#6366f1';
  const glowAmt = isFinished ? `0 0 0 1.5px ${glowCol}55, 0 0 30px ${glowCol}18` : '0 4px 20px rgba(0,0,0,0.4)';

  return (
    <div style={{
      borderRadius:'18px', overflow:'hidden',
      background:'linear-gradient(145deg,rgba(11,16,36,0.98) 0%,rgba(8,13,28,0.95) 100%)',
      border:`1.5px solid ${ok?'rgba(34,197,94,0.4)':fail?'rgba(239,68,68,0.3)':'rgba(99,102,241,0.15)'}`,
      boxShadow: glowAmt,
      transition:'transform 0.18s ease, box-shadow 0.18s ease'
    }}
    onClick={onClick}
    onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-3px)';e.currentTarget.style.boxShadow=`${glowAmt}, 0 12px 40px rgba(0,0,0,0.5)`;e.currentTarget.style.cursor='pointer';}}
    onMouseLeave={e=>{e.currentTarget.style.transform='translateY(0)';e.currentTarget.style.boxShadow=glowAmt;}}
    >
      {/* Top accent bar */}
      <div style={{height:'3px',background:ok?'linear-gradient(90deg,#16a34a,#22c55e,#16a34a)':fail?'linear-gradient(90deg,#dc2626,#ef4444,#dc2626)':'linear-gradient(90deg,#4338ca,#6366f1,#4338ca)'}}/>

      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'0.6rem 0.9rem',background:'rgba(255,255,255,0.025)'}}>
        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.72rem',color:'#64748b',fontWeight:600}}>
          <span style={{color:'#818cf8'}}>⏰ {timeLabel||m.match_time||'—'}</span>
          <span style={{opacity:0.4}}>·</span>
          <span style={{color:conf>=70?'#22c55e':conf>=55?'#f59e0b':'#94a3b8',fontWeight:800}}>🎯 {conf}%</span>
          <span style={{opacity:0.4}}>·</span>
          <span>Wk {m.round_number}</span>
        </div>
        {isFinished ? (
          <div style={{
            display:'flex',alignItems:'center',gap:'0.3rem',
            background:ok?'rgba(34,197,94,0.12)':'rgba(239,68,68,0.1)',
            border:`1px solid ${ok?'rgba(34,197,94,0.35)':'rgba(239,68,68,0.3)'}`,
            padding:'0.18rem 0.65rem',borderRadius:'20px',
            fontSize:'0.68rem',fontWeight:800,color:ok?'#22c55e':'#ef4444',
            boxShadow:ok?'0 0 10px rgba(34,197,94,0.2)':'none'
          }}>
            {ok?<CheckCircle size={11}/>:<XCircle size={11}/>}
            {ok?'CORRECT':'WRONG'}
          </div>
        ):(
          <div style={{fontSize:'0.68rem',fontWeight:700,color:'#f59e0b',background:'rgba(245,158,11,0.1)',
            padding:'0.18rem 0.6rem',borderRadius:'20px',border:'1px solid rgba(245,158,11,0.25)'}}>⏳ Pending</div>
        )}
      </div>

      {/* Teams + Score */}
      <div style={{padding:'0.85rem 0.9rem 0'}}>
        <div style={{display:'flex',alignItems:'center',gap:'0.6rem'}}>
          {/* Home */}
          <div style={{flex:1,textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:'0.9rem',color:'#f1f5f9',wordBreak:'break-word',lineHeight:1.25,letterSpacing:'-0.01em'}}>{m.home_team}</div>
            <div style={{fontSize:'0.68rem',fontWeight:700,marginTop:'0.2rem',
              color:hw>=60?'#22c55e':hw>=40?'#f59e0b':'#64748b',textShadow:hw>=60?'0 0 8px rgba(34,197,94,0.5)':null}}>{hw}%</div>
          </div>
          {/* Score/VS */}
          <div style={{flexShrink:0,textAlign:'center',minWidth:'72px'}}>
            {isFinished?(
              <div style={{
                background:'linear-gradient(135deg,rgba(255,255,255,0.09),rgba(255,255,255,0.05))',
                border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:'12px',padding:'0.3rem 0.6rem',
                fontSize:'1.45rem',fontWeight:900,color:'#f1f5f9',letterSpacing:'2px',
                boxShadow:'inset 0 1px 0 rgba(255,255,255,0.08)'
              }}>
                {hScore}–{aScore}
              </div>
            ):(
              <div style={{
                background:`linear-gradient(135deg,${predictedOutcome==='Home'?'rgba(59,130,246,0.2)':predictedOutcome==='Away'?'rgba(239,68,68,0.2)':'rgba(245,158,11,0.2)'},rgba(255,255,255,0.04))`,
                border:`1px solid ${predictedOutcome==='Home'?'rgba(59,130,246,0.4)':predictedOutcome==='Away'?'rgba(239,68,68,0.4)':'rgba(245,158,11,0.4)'}`,
                borderRadius:'10px',padding:'0.25rem 0.5rem',
                fontSize:'0.8rem',fontWeight:800,
                color:predictedOutcome==='Home'?'#60a5fa':predictedOutcome==='Away'?'#f87171':'#fbbf24'
              }}>{predictedOutcome||'VS'}</div>
            )}
            {isFinished&&(
              <div style={{fontSize:'0.58rem',color:'#475569',marginTop:'0.25rem'}}>
                {predictedOutcome} → {actualOutcome}
              </div>
            )}
          </div>
          {/* Away */}
          <div style={{flex:1,textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:'0.9rem',color:'#f1f5f9',wordBreak:'break-word',lineHeight:1.25,letterSpacing:'-0.01em'}}>{m.away_team}</div>
            <div style={{fontSize:'0.68rem',fontWeight:700,marginTop:'0.2rem',
              color:aw>=60?'#22c55e':aw>=40?'#f59e0b':'#64748b',textShadow:aw>=60?'0 0 8px rgba(34,197,94,0.5)':null}}>{aw}%</div>
          </div>
        </div>

        {/* 1X2 probability bar */}
        <div style={{marginTop:'0.75rem',height:'8px',borderRadius:'6px',overflow:'hidden',background:'rgba(255,255,255,0.04)',display:'flex',gap:'1px'}}>
          <div style={{width:`${hw}%`,background:'linear-gradient(90deg,#1d4ed8,#3b82f6)',transition:'width 0.6s ease'}}/>
          <div style={{width:`${dr}%`,background:'linear-gradient(90deg,#d97706,#f59e0b)',transition:'width 0.6s ease'}}/>
          <div style={{width:`${aw}%`,background:'linear-gradient(90deg,#dc2626,#ef4444)',transition:'width 0.6s ease'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.6rem',marginTop:'0.3rem',color:'#334155',fontWeight:700}}>
          <span style={{color:'#3b82f6'}}>H {hw}%</span><span style={{color:'#f59e0b'}}>D {dr}%</span><span style={{color:'#ef4444'}}>A {aw}%</span>
        </div>
      </div>

      {/* Market grid */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'0.45rem',padding:'0.85rem 0.9rem'}}>
        <MktCell label="GG / BTTS" val={gg}  outcome={isFinished?marketWon('gg',hScore,aScore):null}/>
        <MktCell label="Over 1.5"  val={o15} outcome={isFinished?marketWon('over15',hScore,aScore):null}/>
        <MktCell label="Over 2.5"  val={o25} outcome={isFinished?marketWon('over25',hScore,aScore):null}/>
        <MktCell label="Over 3.5"  val={o35} outcome={isFinished?marketWon('over35',hScore,aScore):null}/>
        <MktCell label="HT/FT 1/1" val={pr.htft11Prob||0} outcome={null}/>
        <MktCell label="HT/FT X/X" val={pr.htftXXProb||0} outcome={null}/>
      </div>
    </div>
  );
};

// ─── AI Pick Card ─────────────────────────────────────────────────────────────
const AICard = ({ pick, onClick }) => {
  // parseProbs handles: already-parsed object, JSON string, double-serialized string
  const pr = parseProbs(pick);
  const hw=pr.homeWinProb||0, dr=pr.drawProb||0, aw=pr.awayWinProb||0;
  const gg=pr.ggProb||0, o15=pr.over15Prob||0, o25=pr.over25Prob||0, o35=pr.over35Prob||0;
  const hasProbs = hw||dr||aw;
  // Use pre-computed confidence from backend if available, else calculate
  const conf = pick.confidence || (hasProbs ? calcConf(hw,dr,aw) : null);
  const isWon=pick.status==='won', isLost=pick.status==='lost', isFinished=isWon||isLost;
  const [hs,as_] = (pick.actual_score||'').split(':').map(Number);

  const isAIBest = pick.pick_type === 'ai_best_pick';
  const glowCol = isWon?'#10b981':isLost?'#ef4444':(isAIBest?'#fbbf24':'#f59e0b');
  const topBar = isWon
    ? 'linear-gradient(90deg,#047857,#10b981,#047857)'
    : isLost
      ? 'linear-gradient(90deg,#b91c1c,#ef4444,#b91c1c)'
      : isAIBest
        ? 'linear-gradient(90deg,#d97706,#fbbf24,#d97706)'
        : 'linear-gradient(90deg,#b45309,#f59e0b,#b45309)';

  return (
    <div style={{
      borderRadius:'18px', overflow:'hidden',
      background:'linear-gradient(145deg,rgba(10,8,22,0.99) 0%,rgba(5,5,15,0.97) 100%)',
      border: isWon
        ? '1.5px solid rgba(16,185,129,0.45)'
        : isLost
          ? '1.5px solid rgba(239,68,68,0.3)'
          : isAIBest
            ? '1.5px solid rgba(251,191,36,0.55)'
            : '1.5px solid rgba(245,158,11,0.35)',
      boxShadow: isWon
        ? '0 0 24px rgba(16,185,129,0.15), 0 8px 25px rgba(0,0,0,0.45)'
        : isLost
          ? '0 8px 25px rgba(0,0,0,0.45)'
          : isAIBest
            ? '0 0 26px rgba(251,191,36,0.22), 0 8px 25px rgba(0,0,0,0.55)'
            : '0 0 20px rgba(245,158,11,0.15), 0 8px 25px rgba(0,0,0,0.45)',
      transition:'transform 0.18s ease, box-shadow 0.18s ease'
    }}
    onClick={onClick}
    onMouseEnter={e=>{
      e.currentTarget.style.transform='translateY(-3.5px)';
      e.currentTarget.style.cursor='pointer';
      if (isAIBest && !isFinished) {
        e.currentTarget.style.boxShadow = '0 0 32px rgba(251,191,36,0.35), 0 12px 30px rgba(0,0,0,0.6)';
      }
    }}
    onMouseLeave={e=>{
      e.currentTarget.style.transform='translateY(0)';
      e.currentTarget.style.boxShadow = isWon
        ? '0 0 24px rgba(16,185,129,0.15), 0 8px 25px rgba(0,0,0,0.45)'
        : isLost
          ? '0 8px 25px rgba(0,0,0,0.45)'
          : isAIBest
            ? '0 0 26px rgba(251,191,36,0.22), 0 8px 25px rgba(0,0,0,0.55)'
            : '0 0 20px rgba(245,158,11,0.15), 0 8px 25px rgba(0,0,0,0.45)';
    }}
    >
      <div style={{height:'3.5px',background:topBar}}/>

      {/* Header */}
      <div style={{
        display:'flex',
        justifyContent:'space-between',
        alignItems:'center',
        padding:'0.65rem 0.9rem',
        background: isAIBest ? 'rgba(251,191,36,0.06)' : 'rgba(245,158,11,0.04)'
      }}>
        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap'}}>
          <div style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
            <Bot size={12} color={isAIBest ? '#fbbf24' : '#f59e0b'}/>
            <span style={{
              fontSize:'0.72rem',
              fontWeight:900,
              color: isAIBest ? '#fbbf24' : '#f59e0b',
              textShadow: isAIBest ? '0 0 6px rgba(251,191,36,0.3)' : 'none'
            }}>
              {isAIBest ? '🔥 High-Risk AI Pick' : pick.pick_type==='safest'?'🛡️ Safest':'⚡ High Value'}
            </span>
          </div>
          {conf&&<><span style={{opacity:0.3,color:'#fff'}}>·</span><span style={{fontSize:'0.72rem',color:'#818cf8',fontWeight:700}}>Conf {conf}%</span></>}
          {pick.probability>0&&<><span style={{opacity:0.3,color:'#fff'}}>·</span><span style={{fontSize:'0.72rem',color:'#a78bfa',fontWeight:700}}>Mkt {pick.probability}%</span></>}
        </div>
        <div style={{display:'flex',gap:'0.4rem',alignItems:'center',flexShrink:0}}>
          <div style={{
            background: isAIBest ? 'rgba(251,191,36,0.12)' : 'rgba(245,158,11,0.12)',
            color: isAIBest ? '#fbbf24' : '#fbbf24',
            borderRadius:'20px',
            padding:'0.2rem 0.65rem',
            fontSize:'0.7rem',
            fontWeight:700,
            border: isAIBest ? '1px solid rgba(251,191,36,0.3)' : '1px solid rgba(245,158,11,0.25)'
          }}>
            {pick.market} — {pick.probability}%
          </div>
          {isFinished&&(
            <div style={{display:'flex',alignItems:'center',gap:'0.25rem',
              background:isWon?'rgba(16,185,129,0.12)':'rgba(239,68,68,0.1)',
              border:`1px solid ${isWon?'rgba(16,185,129,0.35)':'rgba(239,68,68,0.3)'}`,
              padding:'0.2rem 0.55rem',borderRadius:'20px',fontSize:'0.68rem',fontWeight:900,
              color:isWon?'#10b981':'#ef4444',boxShadow:isWon?'0 0 10px rgba(16,185,129,0.2)':'none'}}>
              {isWon?<CheckCircle size={11}/>:<XCircle size={11}/>}
              {isWon?'WON':'LOST'}
            </div>
          )}
          {!isFinished&&<div style={{
            fontSize:'0.68rem',
            fontWeight:700,
            color: isAIBest ? '#fbbf24' : '#f59e0b',
            background: isAIBest ? 'rgba(251,191,36,0.08)' : 'rgba(245,158,11,0.08)',
            padding:'0.18rem 0.55rem',
            borderRadius:'20px',
            border: isAIBest ? '1px solid rgba(251,191,36,0.2)' : '1px solid rgba(245,158,11,0.18)'
          }}>⏳ Pending</div>}
        </div>
      </div>

      {/* Teams + Score */}
      <div style={{padding:'0.9rem 0.9rem 0'}}>
        <div style={{display:'flex',alignItems:'center',gap:'0.6rem'}}>
          <div style={{flex:1,textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:'0.9rem',color:'#f1f5f9',wordBreak:'break-word',lineHeight:1.25}}>{pick.home_team}</div>
            {hasProbs&&<div style={{fontSize:'0.68rem',fontWeight:700,color:hw>=60?'#22c55e':'#64748b',marginTop:'0.2rem'}}>{hw}%</div>}
          </div>
          <div style={{flexShrink:0,textAlign:'center',minWidth:'72px'}}>
            {isFinished&&!isNaN(hs)?(
              <div style={{background:'linear-gradient(135deg,rgba(255,255,255,0.09),rgba(255,255,255,0.05))',
                border:'1px solid rgba(255,255,255,0.12)',borderRadius:'12px',padding:'0.3rem 0.6rem',
                fontSize:'1.45rem',fontWeight:900,color:'#f1f5f9',letterSpacing:'2px'}}>
                {hs}–{as_}
              </div>
            ):(
              <div style={{color:'#475569',fontSize:'0.9rem',fontWeight:300}}>VS</div>
            )}
          </div>
          <div style={{flex:1,textAlign:'center'}}>
            <div style={{fontWeight:800,fontSize:'0.9rem',color:'#f1f5f9',wordBreak:'break-word',lineHeight:1.25}}>{pick.away_team}</div>
            {hasProbs&&<div style={{fontSize:'0.68rem',fontWeight:700,color:aw>=60?'#22c55e':'#64748b',marginTop:'0.2rem'}}>{aw}%</div>}
          </div>
        </div>

        {hasProbs&&(
          <>
            <div style={{marginTop:'0.75rem',height:'8px',borderRadius:'6px',overflow:'hidden',background:'rgba(255,255,255,0.04)',display:'flex',gap:'1px'}}>
              <div style={{width:`${hw}%`,background:'linear-gradient(90deg,#1d4ed8,#3b82f6)',transition:'width 0.6s'}}/>
              <div style={{width:`${dr}%`,background:'linear-gradient(90deg,#d97706,#f59e0b)',transition:'width 0.6s'}}/>
              <div style={{width:`${aw}%`,background:'linear-gradient(90deg,#dc2626,#ef4444)',transition:'width 0.6s'}}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.6rem',marginTop:'0.3rem',fontWeight:700}}>
              <span style={{color:'#3b82f6'}}>H {hw}%</span><span style={{color:'#f59e0b'}}>D {dr}%</span><span style={{color:'#ef4444'}}>A {aw}%</span>
            </div>
          </>
        )}
      </div>

      {hasProbs&&(
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'0.45rem',padding:'0.85rem 0.9rem'}}>
          <MktCell label="GG / BTTS" val={gg}/>
          <MktCell label="Over 1.5"  val={o15}/>
          <MktCell label="Over 2.5"  val={o25}/>
          <MktCell label="Over 3.5"  val={o35}/>
          <MktCell label="HT/FT 1/1" val={pr.htft11Prob||0}/>
          <MktCell label="HT/FT X/X" val={pr.htftXXProb||0}/>
        </div>
      )}
    </div>
  );
};

// ─── Week Row ─────────────────────────────────────────────────────────────────
const WeekRow = ({ weekNum, matches, winRate, type }) => {
  const [open, setOpen] = useState(false);
  const isML = type === 'ml';
  const won = matches.filter(m=>isML?m.isCorrect1X2===true:m.status==='won').length;
  const lost = matches.filter(m=>isML?m.isCorrect1X2===false:m.status==='lost').length;
  const pend = matches.filter(m=>isML?!m.isFinished:m.status==='pending').length;
  const rateOk = !isNaN(winRate);
  const rateColor = rateOk ? (winRate>=60?'#22c55e':winRate>=40?'#f59e0b':'#ef4444') : '#334155';
  const badgeBg = isML
    ? 'linear-gradient(135deg,#312e81,#4f46e5)'
    : 'linear-gradient(135deg,#78350f,#d97706)';
  const badgeGlow = isML ? 'rgba(99,102,241,0.5)' : 'rgba(217,119,6,0.5)';
  const rowBorder = isML ? 'rgba(99,102,241,0.18)' : 'rgba(245,158,11,0.2)';

  return (
    <div style={{borderRadius:'16px',
      background:'linear-gradient(145deg,rgba(10,14,32,0.97) 0%,rgba(8,12,26,0.95) 100%)',
      border:`1px solid ${rowBorder}`,
      boxShadow:'0 4px 20px rgba(0,0,0,0.35)',
      transition:'box-shadow 0.2s'
    }}>
      <button onClick={()=>setOpen(p=>!p)} style={{
        width:'100%',padding:'0.95rem 1.15rem',background:'transparent',border:'none',
        cursor:'pointer',display:'flex',alignItems:'center',gap:'0.85rem',color:'#f1f5f9',
        transition:'background 0.15s'
      }}
      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.025)'}
      onMouseLeave={e=>e.currentTarget.style.background='transparent'}
      >
        {/* Badge */}
        <div style={{background:badgeBg,borderRadius:'10px',padding:'0.38rem 0.9rem',
          fontWeight:900,fontSize:'0.82rem',color:'#fff',letterSpacing:'0.04em',flexShrink:0,
          boxShadow:`0 3px 12px ${badgeGlow},inset 0 1px 0 rgba(255,255,255,0.15)`,
          display:'flex',alignItems:'center',gap:'0.35rem'}}>
          {isML?'📊':'🤖'} WK {weekNum}
        </div>

        {/* Info */}
        <div style={{display:'flex',alignItems:'center',gap:'0.6rem',flex:1}}>
          <span style={{fontSize:'0.78rem',color:'#64748b',fontWeight:600}}>{matches.length} match{matches.length!==1?'es':''}</span>
          {won>0&&<span style={{fontSize:'0.8rem',color:'#22c55e',fontWeight:800,textShadow:'0 0 8px rgba(34,197,94,0.5)'}}>✓{won}</span>}
          {lost>0&&<span style={{fontSize:'0.8rem',color:'#ef4444',fontWeight:800}}>✗{lost}</span>}
          {pend>0&&<span style={{fontSize:'0.8rem',color:'#f59e0b',fontWeight:700}}>⏳{pend}</span>}
        </div>

        {/* Ring + toggle */}
        <Ring rate={rateOk?Math.round(winRate):NaN} size={54}/>
        <div style={{display:'flex',alignItems:'center',gap:'0.3rem',color:'#475569',fontSize:'0.72rem',fontWeight:600,flexShrink:0,minWidth:'70px',justifyContent:'flex-end'}}>
          {open?<ChevronUp size={14}/>:<ChevronDown size={14}/>}
          <span>{open?'Collapse':'Expand'}</span>
        </div>
      </button>

      {open&&(
        <div style={{padding:'0 1rem 1rem',
          display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(295px,1fr))',gap:'0.8rem'}}>
          {matches.map((m,i)=>
            type==='ai'
              ?<AICard key={m.id||i} pick={m} onClick={()=>m._onSelect&&m._onSelect(m)}/>
              :<MLCard key={m.id||i} match={m} onClick={()=>m._onSelect&&m._onSelect(m)}/>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Match Detail Drawer ─────────────────────────────────────────────────────
const parseProbs = (match) => {
  // For ML picks: match.probs is already parsed during enrichment
  if (match.probs && typeof match.probs === 'object' && Object.keys(match.probs).length > 0) {
    return match.probs;
  }
  // For AI picks: predicted_probs may be a JSON string or already an object
  const raw = match.predicted_probs;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    // Handle double-serialized case
    if (typeof parsed === 'string') return JSON.parse(parsed);
    return parsed;
  } catch(e) { return {}; }
};

const getMatchTime = (match) => {
  if (match.timeLabel && match.timeLabel !== '—') return match.timeLabel;
  if (match.match_time) return match.match_time;
  if (match.kickoff_timestamp) {
    const d = new Date(Number(match.kickoff_timestamp));
    if (!isNaN(d)) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return '—';
};

const MatchDetailDrawer = ({ match, type, onClose }) => {
  if (!match) return null;
  const isML = type === 'ml';
  const pr = parseProbs(match);
  const hw=pr.homeWinProb||0, dr=pr.drawProb||0, aw=pr.awayWinProb||0;
  const gg=pr.ggProb||0, o15=pr.over15Prob||0, o25=pr.over25Prob||0, o35=pr.over35Prob||0;
  const conf = (hw||dr||aw) ? calcConf(hw,dr,aw) : null;
  const isWon = isML ? match.isCorrect1X2===true : match.status==='won';
  const isLost = isML ? match.isCorrect1X2===false : match.status==='lost';
  const isFinished = isML ? match.isFinished : match.status==='won'||match.status==='lost';
  const [hs, as_] = isML ? [match.hScore, match.aScore] : (match.actual_score||'').split(':').map(Number);
  const [hHt, aHt] = isML ? [match.hHtScore, match.aHtScore] : (match.actual_ht_score||'').split(':').map(Number);
  const timeDisplay = getMatchTime(match);
  const statusColor = isWon ? '#22c55e' : isLost ? '#ef4444' : '#f59e0b';

  return (
    <div style={{ position:'fixed',inset:0,zIndex:10001,display:'flex',alignItems:'center',justifyContent:'center',
      background:'rgba(2,4,16,0.75)',backdropFilter:'blur(12px)', animation:'drawerIn 0.2s ease' }}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        width:'100%',maxWidth:'520px',background:'linear-gradient(145deg,#07101f,#0a1428)',
        borderRadius:'22px',border:`1.5px solid ${statusColor}40`,
        boxShadow:`0 0 0 1px ${statusColor}18, 0 30px 80px rgba(0,0,0,0.85)`,
        overflow:'hidden',maxHeight:'90vh',display:'flex',flexDirection:'column'
      }}>
        {/* Top accent */}
        <div style={{height:'4px',background:`linear-gradient(90deg,${statusColor}88,${statusColor},${statusColor}88)`}}/>
        {/* Header */}
        <div style={{padding:'0.85rem 1.2rem',borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
          {/* Top row: time + week + close */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.65rem'}}>
            <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
              <span style={{fontSize:'0.78rem',fontWeight:700,color:'#818cf8'}}>⏰ {timeDisplay}</span>
              <span style={{opacity:0.25,color:'#fff'}}>·</span>
              <span style={{fontSize:'0.78rem',fontWeight:700,color:'#475569'}}>Wk {match.round_number}</span>
              {!isML&&match.pick_type&&(
                <><span style={{opacity:0.25,color:'#fff'}}>·</span>
                <span style={{fontSize:'0.72rem',fontWeight:800,color:match.pick_type==='ai_best_pick'?'#fbbf24':'#f59e0b'}}>
                  {match.pick_type==='ai_best_pick'?'🔥 High-Risk AI Pick':match.pick_type==='safest'?'🛡️ Safest':'⚡ High Value'}
                </span></>
              )}
            </div>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:'8px',padding:'0.35rem',cursor:'pointer',color:'#64748b',display:'flex',transition:'all 0.15s'}}
              onMouseEnter={e=>{e.currentTarget.style.background='rgba(239,68,68,0.2)';e.currentTarget.style.color='#f87171';}}
              onMouseLeave={e=>{e.currentTarget.style.background='rgba(255,255,255,0.06)';e.currentTarget.style.color='#64748b';}}>
              <X size={16}/>
            </button>
          </div>
          {/* Score badges: Confidence + Probability */}
          <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
            {/* Confidence badge */}
            {conf&&(
              <div style={{
                display:'flex',alignItems:'center',gap:'0.35rem',
                background:conf>=75?'rgba(34,197,94,0.12)':conf>=60?'rgba(245,158,11,0.1)':'rgba(99,102,241,0.1)',
                border:`1px solid ${conf>=75?'rgba(34,197,94,0.35)':conf>=60?'rgba(245,158,11,0.3)':'rgba(99,102,241,0.25)'}`,
                borderRadius:'10px',padding:'0.35rem 0.7rem',
                boxShadow:conf>=75?'0 0 12px rgba(34,197,94,0.15)':'none'
              }}>
                <span style={{fontSize:'0.65rem',color:'#64748b',fontWeight:700}}>🎯 CONFIDENCE</span>
                <span style={{
                  fontSize:'1.15rem',fontWeight:900,letterSpacing:'-0.02em',
                  color:conf>=75?'#22c55e':conf>=60?'#f59e0b':'#a5b4fc',
                  textShadow:conf>=75?'0 0 8px rgba(34,197,94,0.5)':null
                }}>{conf}%</span>
              </div>
            )}
            {/* 1X2 max probability (ML) or market probability (AI) */}
            {(hw||dr||aw)&&(
              <div style={{
                display:'flex',alignItems:'center',gap:'0.35rem',
                background:'rgba(245,158,11,0.09)',
                border:'1px solid rgba(245,158,11,0.28)',
                borderRadius:'10px',padding:'0.35rem 0.7rem'
              }}>
                <span style={{fontSize:'0.65rem',color:'#64748b',fontWeight:700}}>
                  📊 {isML?'BEST PROB':'MKT PROB'}
                </span>
                <span style={{fontSize:'1.15rem',fontWeight:900,color:'#f59e0b',letterSpacing:'-0.02em'}}>
                  {isML?Math.max(hw,dr,aw):match.probability||Math.max(hw,dr,aw)}%
                </span>
              </div>
            )}
            {!isML&&match.probability>0&&!(hw||dr||aw)&&(
              <div style={{display:'flex',alignItems:'center',gap:'0.35rem',background:'rgba(245,158,11,0.09)',border:'1px solid rgba(245,158,11,0.28)',borderRadius:'10px',padding:'0.35rem 0.7rem'}}>
                <span style={{fontSize:'0.65rem',color:'#64748b',fontWeight:700}}>📊 MKT PROB</span>
                <span style={{fontSize:'1.15rem',fontWeight:900,color:'#f59e0b'}}>{match.probability}%</span>
              </div>
            )}
            {/* Status */}
            <div style={{
              display:'flex',alignItems:'center',gap:'0.3rem',marginLeft:'auto',
              background:isWon?'rgba(34,197,94,0.12)':isLost?'rgba(239,68,68,0.1)':'rgba(245,158,11,0.1)',
              border:`1px solid ${isWon?'rgba(34,197,94,0.35)':isLost?'rgba(239,68,68,0.3)':'rgba(245,158,11,0.25)'}`,
              borderRadius:'10px',padding:'0.35rem 0.75rem',
              fontSize:'0.78rem',fontWeight:900,
              color:isWon?'#22c55e':isLost?'#ef4444':'#f59e0b',
              boxShadow:isWon?'0 0 12px rgba(34,197,94,0.2)':null
            }}>
              {isWon?<CheckCircle size={13}/>:isLost?<XCircle size={13}/>:<Minus size={13}/>}
              {isWon?'CORRECT/WON':isLost?'WRONG/LOST':'PENDING'}
            </div>
          </div>
        </div>
        {/* Scrollable body */}
        <div style={{overflowY:'auto',padding:'1.2rem'}}>
          {/* Teams */}
          <div style={{display:'flex',alignItems:'center',gap:'1rem',marginBottom:'1.2rem'}}>
            <div style={{flex:1,textAlign:'center'}}>
              <div style={{fontWeight:900,fontSize:'1.05rem',color:'#f1f5f9',wordBreak:'break-word'}}>{match.home_team}</div>
              <div style={{fontSize:'0.72rem',fontWeight:700,color:hw>=60?'#22c55e':hw>=40?'#f59e0b':'#64748b',marginTop:'0.2rem'}}>{hw}%</div>
            </div>
            <div style={{flexShrink:0,textAlign:'center'}}>
              {isFinished&&!isNaN(hs) ? (
                <div style={{fontSize:'2rem',fontWeight:900,color:'#f1f5f9',background:'rgba(255,255,255,0.07)',padding:'0.25rem 1rem',borderRadius:'14px',border:`1px solid ${statusColor}40`,letterSpacing:'3px',boxShadow:`0 0 20px ${statusColor}20`}}>
                  {hs}–{as_}
                </div>
              ) : (
                <div style={{fontSize:'1rem',fontWeight:300,color:'#334155'}}>VS</div>
              )}
              {isML&&isFinished&&<div style={{fontSize:'0.62rem',color:'#475569',marginTop:'0.3rem'}}>{match.predictedOutcome} → {match.actualOutcome}</div>}
              <div style={{marginTop:'0.5rem',display:'flex',justifyContent:'center'}}>
                <div style={{display:'flex',alignItems:'center',gap:'0.3rem',background:isWon?'rgba(34,197,94,0.12)':isLost?'rgba(239,68,68,0.1)':'rgba(245,158,11,0.1)',border:`1px solid ${statusColor}40`,padding:'0.22rem 0.75rem',borderRadius:'20px',fontSize:'0.72rem',fontWeight:800,color:statusColor}}>
                  {isWon?<CheckCircle size={12}/>:isLost?<XCircle size={12}/>:<Minus size={12}/>}
                  {isWon?'CORRECT/WON':isLost?'WRONG/LOST':'PENDING'}
                </div>
              </div>
            </div>
            <div style={{flex:1,textAlign:'center'}}>
              <div style={{fontWeight:900,fontSize:'1.05rem',color:'#f1f5f9',wordBreak:'break-word'}}>{match.away_team}</div>
              <div style={{fontSize:'0.72rem',fontWeight:700,color:aw>=60?'#22c55e':aw>=40?'#f59e0b':'#64748b',marginTop:'0.2rem'}}>{aw}%</div>
            </div>
          </div>

          {/* 1X2 bar */}
          {(hw||dr||aw) ? (
            <div style={{marginBottom:'1.2rem'}}>
              <div style={{fontSize:'0.65rem',fontWeight:700,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px',marginBottom:'0.4rem'}}>1X2 Probability</div>
              <div style={{height:'10px',borderRadius:'8px',overflow:'hidden',background:'rgba(255,255,255,0.04)',display:'flex',gap:'1px'}}>
                <div style={{width:`${hw}%`,background:'linear-gradient(90deg,#1d4ed8,#3b82f6)'}}/>
                <div style={{width:`${dr}%`,background:'linear-gradient(90deg,#d97706,#f59e0b)'}}/>
                <div style={{width:`${aw}%`,background:'linear-gradient(90deg,#dc2626,#ef4444)'}}/>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.65rem',marginTop:'0.35rem',fontWeight:700}}>
                <span style={{color:'#3b82f6'}}>Home {hw}%</span>
                <span style={{color:'#f59e0b'}}>Draw {dr}%</span>
                <span style={{color:'#ef4444'}}>Away {aw}%</span>
              </div>
            </div>
          ) : null}

          {/* Market breakdown */}
          <div style={{fontSize:'0.65rem',fontWeight:800,color:'#475569',textTransform:'uppercase',
            letterSpacing:'0.6px',marginBottom:'0.6rem',display:'flex',alignItems:'center',gap:'0.4rem'}}>
            <span style={{width:18,height:1,background:'rgba(255,255,255,0.08)',display:'inline-block'}}/>
            Market Breakdown
            <span style={{width:18,height:1,background:'rgba(255,255,255,0.08)',display:'inline-block'}}/>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:'0.4rem',marginBottom:'1rem'}}>
            {[
              {label:'GG / BTTS', val:gg,  market:'gg'},
              {label:'Over 1.5',  val:o15, market:'over15'},
              {label:'Over 2.5',  val:o25, market:'over25'},
              {label:'Over 3.5',  val:o35, market:'over35'},
              {label:'HT/FT 1/1',val:pr.htft11Prob||0, market:'htft11'},
              {label:'HT/FT X/X',val:pr.htftXXProb||0, market:'htftXX'},
            ].map(({label,val,market})=>{
              const outcome = market&&isFinished&&!isNaN(hs) ? marketWon(market,hs,as_,hHt,aHt) : null;
              const won = outcome===true, lost = outcome===false, known = outcome!==null;
              const col = won?'#22c55e':lost?'#ef4444':probColor(val);
              const bg  = won?'rgba(34,197,94,0.1)':lost?'rgba(239,68,68,0.09)':'rgba(255,255,255,0.03)';
              const bdr = won?'rgba(34,197,94,0.35)':lost?'rgba(239,68,68,0.3)':'rgba(255,255,255,0.06)';
              return (
                <div key={label} style={{background:bg,border:`1px solid ${bdr}`,borderRadius:'12px',
                  padding:'0.6rem 0.85rem',display:'flex',alignItems:'center',gap:'0.75rem',
                  boxShadow:won?'0 0 14px rgba(34,197,94,0.12)':lost?'0 0 12px rgba(239,68,68,0.1)':'none'}}>
                  {/* Outcome icon */}
                  <div style={{
                    width:30,height:30,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
                    fontSize:'0.9rem',fontWeight:900,
                    background:known?(won?'rgba(34,197,94,0.2)':'rgba(239,68,68,0.16)'):'rgba(255,255,255,0.05)',
                    border:`1.5px solid ${known?(won?'rgba(34,197,94,0.5)':'rgba(239,68,68,0.45)'):'rgba(255,255,255,0.08)'}`,
                    color:known?(won?'#22c55e':'#ef4444'):'#334155',
                    boxShadow:known?(won?'0 0 10px rgba(34,197,94,0.25)':'0 0 10px rgba(239,68,68,0.2)'):'none'
                  }}>{known?(won?'✓':'✗'):'?'}</div>
                  {/* Label + bar */}
                  <div style={{flex:1}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:'0.25rem'}}>
                      <span style={{fontSize:'0.73rem',fontWeight:700,color:known?(won?'#4ade80':'#f87171'):'#94a3b8'}}>{label}</span>
                      <span style={{fontSize:'1rem',fontWeight:900,color:col,
                        textShadow:won?'0 0 8px rgba(34,197,94,0.6)':lost?'0 0 8px rgba(239,68,68,0.5)':null}}>{val}%</span>
                    </div>
                    <div style={{height:'5px',background:'rgba(255,255,255,0.06)',borderRadius:'4px',overflow:'hidden'}}>
                      <div style={{width:`${val}%`,height:'100%',
                        background:won?'linear-gradient(90deg,#16a34a,#22c55e)':lost?'linear-gradient(90deg,#dc2626,#ef4444)':
                          `linear-gradient(90deg,${col}88,${col})`,
                        borderRadius:'4px',
                        boxShadow:won?'0 0 6px rgba(34,197,94,0.5)':lost?'0 0 6px rgba(239,68,68,0.4)':'none'}}/>
                    </div>
                  </div>
                  {/* Badge */}
                  {known&&(
                    <div style={{flexShrink:0,
                      background:won?'rgba(34,197,94,0.15)':'rgba(239,68,68,0.12)',
                      border:`1px solid ${won?'rgba(34,197,94,0.4)':'rgba(239,68,68,0.35)'}`,
                      borderRadius:'8px',padding:'0.2rem 0.55rem',
                      fontSize:'0.68rem',fontWeight:900,
                      color:won?'#22c55e':'#ef4444',
                      letterSpacing:'0.3px',
                      textShadow:won?'0 0 6px #22c55e':'0 0 6px #ef4444'}}>
                      {won?'WON':'LOST'}
                    </div>
                  )}
                  {!known&&(
                    <div style={{flexShrink:0,background:'rgba(245,158,11,0.08)',border:'1px solid rgba(245,158,11,0.18)',
                      borderRadius:'8px',padding:'0.2rem 0.55rem',fontSize:'0.68rem',fontWeight:700,color:'#78716c'}}>
                      N/A
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* AI pick extra info */}
          {!isML&&match.market&&(
            <div style={{background:'rgba(245,158,11,0.08)',border:'1px solid rgba(245,158,11,0.2)',borderRadius:'12px',padding:'0.85rem',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontSize:'0.6rem',color:'#64748b',fontWeight:600,marginBottom:'0.2rem'}}>AI PICK MARKET</div>
                <div style={{fontSize:'1rem',fontWeight:800,color:'#fbbf24'}}>{match.market}</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:'0.6rem',color:'#64748b',fontWeight:600,marginBottom:'0.2rem'}}>MARKET PROB</div>
                <div style={{fontSize:'1.2rem',fontWeight:900,color:'#f59e0b'}}>{match.probability}%</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes drawerIn{from{opacity:0;transform:scale(0.95);}to{opacity:1;transform:scale(1);}}`}</style>
    </div>
  );
};

// ─── Modal ────────────────────────────────────────────────────────────────────
const MarketHistoryModal = ({ isOpen, onClose, data=[], aiPicks=[], theme, onRefresh, onClearHistory }) => {
  const [tab, setTab]           = useState('ml');
  const [search, setSearch]     = useState('');
  const [filter, setFilter]     = useState('all');
  const [selDay, setSelDay]     = useState(null);
  const [selMatch, setSelMatch] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [minConf, setMinConf]   = useState(0);   // minimum confidence %
  const [minProb, setMinProb]   = useState(0);   // minimum market/1X2 probability %

  // Enrich ML
  const enriched = useMemo(()=>{
    if (!Array.isArray(data)) return [];
    return data.map(row=>{
      let probs={};
      try{probs=JSON.parse(row.predicted_probs||'{}');}catch(e){}
      const sc = row.actual_score?.includes(':')?row.actual_score.split(':'):null;
      const hScore=sc?parseInt(sc[0],10):null, aScore=sc?parseInt(sc[1],10):null;
      const scHt = row.actual_ht_score?.includes(':')?row.actual_ht_score.split(':'):null;
      const hHtScore = scHt?parseInt(scHt[0],10):null, aHtScore = scHt?parseInt(scHt[1],10):null;
      const isFinished=sc!==null&&!isNaN(hScore)&&!isNaN(aScore);
      const predictedOutcome=predicted1X2(probs);
      const actualOutcome=isFinished?getActualOutcome(hScore,aScore):null;
      const isCorrect1X2=isFinished?predictedOutcome===actualOutcome:null;
      const dateKey=toDateKey(row.kickoff_timestamp);
      const hw=probs.homeWinProb||0, dr=probs.drawProb||0, aw=probs.awayWinProb||0;
      const conf = calcConf(hw, dr, aw);
      const maxProb = Math.max(hw, dr, aw);
      return {...row,probs,hScore,aScore,hHtScore,aHtScore,isFinished,predictedOutcome,actualOutcome,isCorrect1X2,dateKey,timeLabel:row.match_time||'',conf,maxProb};
    });
  },[data]);

  const baseRows = useMemo(()=>{
    const isML=tab==='ml';
    return (isML?enriched:aiPicks.map(p=>(
      {...p,
        isFinished:p.status==='won'||p.status==='lost',
        isCorrect1X2:p.status==='won'?true:p.status==='lost'?false:null,
        dateKey:toDateKey(p.kickoff_timestamp),
        conf: p.confidence || calcConf(
          (typeof p.predicted_probs==='object'?p.predicted_probs?.homeWinProb:0)||0,
          (typeof p.predicted_probs==='object'?p.predicted_probs?.drawProb:0)||0,
          (typeof p.predicted_probs==='object'?p.predicted_probs?.awayWinProb:0)||0
        ),
        maxProb: p.probability || 0,
      }
    )));
  },[tab,enriched,aiPicks]);

  // Day stats for calendar (same filters as the visible rows, but without the day selection)
  const dayStats = useMemo(()=>{
    const m={};
    const add=(dk,fin,ok)=>{
      if (!dk) return;
      if (!m[dk]) m[dk]={total:0,finished:0,won:0};
      m[dk].total++;
      if(fin){m[dk].finished++;if(ok)m[dk].won++;}
    };

    const filteredForCalendar = baseRows.filter(r=>{
      if(search){const q=search.toLowerCase(); if(!(r.home_team?.toLowerCase().includes(q)||r.away_team?.toLowerCase().includes(q))) return false;}
      if(filter==='won')     return tab==='ml'?r.isCorrect1X2===true:r.status==='won';
      if(filter==='lost')    return tab==='ml'?r.isCorrect1X2===false:r.status==='lost';
      if(filter==='pending') return tab==='ml'?!r.isFinished:r.status==='pending';
      if(minConf>0)  return (r.conf||0)>=minConf;
      if(minProb>0)  return tab==='ml'?(r.maxProb||0)>=minProb:(r.probability||0)>=minProb;
      return true;
    });

    filteredForCalendar.forEach(r=>add(r.dateKey, tab==='ml'?r.isFinished:r.status==='won'||r.status==='lost', tab==='ml'?r.isCorrect1X2===true:r.status==='won'));
    return m;
  },[baseRows,tab,search,filter,minConf,minProb]);

  const mlStats = useMemo(()=>{
    const fin=enriched.filter(r=>r.isFinished), won=fin.filter(r=>r.isCorrect1X2).length;
    return{total:enriched.length,finished:fin.length,won,rate:fin.length?Math.round((won/fin.length)*100):0,pending:enriched.length-fin.length};
  },[enriched]);
  const aiStats = useMemo(()=>{
    const fin=aiPicks.filter(p=>p.status==='won'||p.status==='lost'), won=fin.filter(p=>p.status==='won').length;
    return{total:aiPicks.length,finished:fin.length,won,rate:fin.length?Math.round((won/fin.length)*100):0,pending:aiPicks.filter(p=>p.status==='pending').length};
  },[aiPicks]);

  const filteredRows = useMemo(()=>{
    let rows=baseRows;
    if(selDay)      rows=rows.filter(r=>r.dateKey===selDay);
    if(search){const q=search.toLowerCase();rows=rows.filter(r=>r.home_team?.toLowerCase().includes(q)||r.away_team?.toLowerCase().includes(q));}
    if(filter==='won')     rows=rows.filter(r=>tab==='ml'?r.isCorrect1X2===true:r.status==='won');
    if(filter==='lost')    rows=rows.filter(r=>tab==='ml'?r.isCorrect1X2===false:r.status==='lost');
    if(filter==='pending') rows=rows.filter(r=>tab==='ml'?!r.isFinished:r.status==='pending');
    if(minConf>0)  rows=rows.filter(r=>(r.conf||0)>=minConf);
    if(minProb>0)  rows=rows.filter(r=>tab==='ml'?(r.maxProb||0)>=minProb:(r.probability||0)>=minProb);
    return rows.map(r=>({
      ...r,
      _onSelect: () => setSelMatch({...r, _type: tab}),
    }));
  },[baseRows,tab,selDay,search,filter,minConf,minProb]);

  const weeks = useMemo(()=>{
    const map=new Map();
    filteredRows.forEach(r=>{
      const w=r.round_number||0;
      if(!map.has(w)) map.set(w,[]);
      map.get(w).push(r);
    });
    return Array.from(map.entries()).sort((a,b)=>b[0]-a[0]).map(([w,ms])=>{
      const fin=ms.filter(m=>tab==='ml'?m.isFinished:m.status==='won'||m.status==='lost');
      const won2=fin.filter(m=>tab==='ml'?m.isCorrect1X2:m.status==='won').length;
      return{week:w,matches:ms,winRate:fin.length?(won2/fin.length)*100:NaN};
    });
  },[filteredRows,tab]);

  const visibleStats = useMemo(()=>{
    if(tab==='ml'){
      const fin=filteredRows.filter(r=>r.isFinished);
      const won=fin.filter(r=>r.isCorrect1X2===true).length;
      return{
        total: filteredRows.length,
        finished: fin.length,
        won,
        rate: fin.length?Math.round((won/fin.length)*100):0,
        pending: filteredRows.length-fin.length,
      };
    }
    const fin=filteredRows.filter(p=>p.status==='won'||p.status==='lost');
    const won=fin.filter(p=>p.status==='won').length;
    return{
      total: filteredRows.length,
      finished: fin.length,
      won,
      rate: fin.length?Math.round((won/fin.length)*100):0,
      pending: filteredRows.filter(p=>p.status==='pending').length,
    };
  },[filteredRows,tab]);

  const st = visibleStats;
  if (!isOpen) return null;

  const tabBtn=(v,lbl)=>(
    <button key={v} onClick={()=>setTab(v)} style={{
      padding:'0.48rem 1rem',borderRadius:'9px',border:'none',cursor:'pointer',
      fontWeight:700,fontSize:'0.8rem',transition:'all 0.2s',
      background:tab===v?'rgba(99,102,241,0.22)':'transparent',
      color:tab===v?'#a5b4fc':'#64748b',
      outline:tab===v?'1px solid rgba(99,102,241,0.35)':'none'
    }}>{lbl}</button>
  );
  const fBtn=(v,lbl)=>(
    <button key={v} onClick={()=>setFilter(v)} style={{
      padding:'0.35rem 0.75rem',borderRadius:'7px',border:'none',cursor:'pointer',
      fontSize:'0.73rem',fontWeight:600,transition:'all 0.15s',
      background:filter===v?'rgba(99,102,241,0.18)':'rgba(255,255,255,0.04)',
      color:filter===v?'#a5b4fc':'#64748b',
      outline:filter===v?'1px solid rgba(99,102,241,0.28)':'none'
    }}>{lbl}</button>
  );

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(2,4,16,0.93)',backdropFilter:'blur(28px)',
      zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:'1rem',
      animation:'mhIn 0.22s cubic-bezier(0.4,0,0.2,1)'}}>
      <div style={{
        width:'100%',maxWidth:'1300px',height:'94vh',
        background:'linear-gradient(160deg,#060c1c 0%,#08102a 50%,#050c1a 100%)',
        borderRadius:'22px',
        border:'1px solid rgba(99,102,241,0.2)',
        boxShadow:'0 50px 120px -20px rgba(0,0,0,0.95),0 0 0 1px rgba(99,102,241,0.05),inset 0 1px 0 rgba(255,255,255,0.04)',
        display:'flex',flexDirection:'column',overflow:'hidden'
      }}>

        {/* ── HEADER ─────────────────────────────────────── */}
        <div style={{padding:'1rem 1.5rem',
          background:'linear-gradient(135deg,rgba(8,10,28,0.98) 0%,rgba(14,8,40,0.95) 100%)',
          borderBottom:'1px solid rgba(99,102,241,0.13)',
          display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',gap:'0.85rem'}}>
            <div style={{padding:'0.55rem',background:'linear-gradient(135deg,rgba(99,102,241,0.35),rgba(139,92,246,0.25))',
              borderRadius:'12px',display:'flex',boxShadow:'0 4px 16px rgba(99,102,241,0.35)'}}>
              <BarChart2 size={20} color='#a5b4fc'/>
            </div>
            <div>
              <h2 style={{margin:0,fontSize:'1.2rem',fontWeight:900,color:'#f1f5f9',letterSpacing:'-0.03em'}}>Market History</h2>
              <div style={{fontSize:'0.65rem',color:'#64748b',fontWeight:600,marginTop:'0.2rem'}}>
                {mlStats.total} System Predictions · grouped by week
              </div>
            </div>
          </div>

          {/* Stat pills */}
          <div style={{display:'flex',gap:'0.5rem',alignItems:'center'}}>
            {[
              {l:'Total',v:st.total,c:'#818cf8'},
              {l:'Won',v:st.won,c:'#22c55e'},
              {l:'Win Rate',v:`${st.rate}%`,c:st.rate>=60?'#22c55e':st.rate>=40?'#f59e0b':'#ef4444'}
            ].map(s=>(
              <div key={s.l} style={{display:'flex',alignItems:'baseline',gap:'0.3rem',
                background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',
                borderRadius:'10px',padding:'0.3rem 0.75rem'}}>
                <span style={{fontSize:'1.1rem',fontWeight:900,color:s.c}}>{s.v}</span>
                <span style={{fontSize:'0.58rem',color:'#334155',textTransform:'uppercase',letterSpacing:'0.5px',fontWeight:700}}>{s.l}</span>
              </div>
            ))}
          </div>

          {/* Buttons */}
          <div style={{display:'flex',gap:'0.45rem',alignItems:'center'}}>
            <button onClick={onRefresh} style={{display:'flex',alignItems:'center',gap:'0.35rem',padding:'0.48rem 0.85rem',
              borderRadius:'9px',border:'none',background:'rgba(99,102,241,0.14)',color:'#a5b4fc',
              cursor:'pointer',fontWeight:700,fontSize:'0.76rem',outline:'1px solid rgba(99,102,241,0.25)',transition:'all 0.2s'}}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(99,102,241,0.25)'}
              onMouseLeave={e=>e.currentTarget.style.background='rgba(99,102,241,0.14)'}>
              <RefreshCw size={12}/> Refresh
            </button>
            <button onClick={async()=>{setClearing(true);try{await onClearHistory?.();}finally{setClearing(false);}}}
              disabled={clearing} style={{display:'flex',alignItems:'center',gap:'0.35rem',padding:'0.48rem 0.85rem',
              borderRadius:'9px',border:'none',background:'rgba(239,68,68,0.12)',color:'#f87171',
              cursor:clearing?'not-allowed':'pointer',fontWeight:700,fontSize:'0.76rem',outline:'1px solid rgba(239,68,68,0.22)',transition:'all 0.2s',opacity:clearing?0.6:1}}
              onMouseEnter={e=>!clearing&&(e.currentTarget.style.background='rgba(239,68,68,0.22)')}
              onMouseLeave={e=>!clearing&&(e.currentTarget.style.background='rgba(239,68,68,0.12)')}>
              <Trash2 size={12}/>{clearing?'Clearing…':'Clear All'}
            </button>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',
              cursor:'pointer',color:'#64748b',padding:'0.48rem',borderRadius:'9px',display:'flex',alignItems:'center',transition:'all 0.2s'}}
              onMouseEnter={e=>{e.currentTarget.style.background='rgba(239,68,68,0.18)';e.currentTarget.style.color='#f87171';}}
              onMouseLeave={e=>{e.currentTarget.style.background='rgba(255,255,255,0.05)';e.currentTarget.style.color='#64748b';}}>
              <X size={17}/>
            </button>
          </div>
        </div>

        {/* ── BODY ───────────────────────────────────────── */}
        <div style={{display:'flex',flex:1,overflow:'hidden'}}>

          {/* Sidebar calendar */}
          <div style={{width:'220px',flexShrink:0,padding:'1rem',borderRight:'1px solid rgba(255,255,255,0.04)',
            background:'rgba(255,255,255,0.012)',overflowY:'auto',display:'flex',flexDirection:'column',gap:'0.65rem'}}>
            <div style={{display:'flex',alignItems:'center',gap:'0.4rem',paddingBottom:'0.35rem',
              borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
              <Calendar size={13} color='#818cf8'/>
              <span style={{fontSize:'0.65rem',fontWeight:800,color:'#475569',textTransform:'uppercase',letterSpacing:'0.7px'}}>Performance Calendar</span>
            </div>
            <HeatCalendar dayStats={dayStats} selectedDay={selDay} onSelect={setSelDay}/>
            {selDay&&(
              <button onClick={()=>setSelDay(null)} style={{background:'rgba(99,102,241,0.12)',border:'1px solid rgba(99,102,241,0.25)',
                borderRadius:'8px',padding:'0.4rem',cursor:'pointer',color:'#a5b4fc',
                fontSize:'0.72rem',fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:'0.3rem',transition:'all 0.15s'}}>
                <X size={11}/> Clear day filter
              </button>
            )}
          </div>

          {/* Main area */}
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            {/* Toolbar */}
            <div style={{padding:'0.75rem 1.15rem',borderBottom:'1px solid rgba(255,255,255,0.04)',
              display:'flex',gap:'0.6rem',flexWrap:'wrap',alignItems:'center',
              background:'rgba(8,12,28,0.5)',flexShrink:0}}>

              <div style={{display:'flex',alignItems:'center',gap:'0.4rem',background:'rgba(8,12,28,0.9)',
                borderRadius:'9px',padding:'0 0.6rem',flex:1,minWidth:'130px',border:'1px solid rgba(255,255,255,0.07)'}}>
                <Search size={13} color='#334155'/>
                <input type="text" placeholder="Search teams…" value={search} onChange={e=>setSearch(e.target.value)}
                  style={{background:'transparent',border:'none',padding:'0.48rem 0.2rem',color:'#e2e8f0',outline:'none',fontSize:'0.82rem',width:'100%'}}/>
              </div>
              <div style={{display:'flex',gap:'0.3rem',flexWrap:'wrap'}}>
                {fBtn('all','All')}{fBtn('won','✓ Won')}{fBtn('lost','✗ Lost')}{fBtn('pending','⏳ Pending')}
              </div>
              {/* Confidence filter */}
              <div style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
                <span style={{fontSize:'0.68rem',fontWeight:700,color:'#475569',whiteSpace:'nowrap'}}>🎯 Conf ≥</span>
                <select value={minConf} onChange={e=>setMinConf(Number(e.target.value))}
                  style={{background:'rgba(99,102,241,0.12)',border:'1px solid rgba(99,102,241,0.25)',
                    borderRadius:'8px',padding:'0.32rem 0.5rem',color:'#a5b4fc',fontSize:'0.73rem',
                    fontWeight:700,cursor:'pointer',outline:'none'}}>
                  <option value={0}>All</option>
                  <option value={55}>55%</option>
                  <option value={60}>60%</option>
                  <option value={65}>65%</option>
                  <option value={70}>70%</option>
                  <option value={75}>75%</option>
                  <option value={80}>80%</option>
                  <option value={85}>85%+</option>
                </select>
              </div>
              {/* Probability filter */}
              <div style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
                <span style={{fontSize:'0.68rem',fontWeight:700,color:'#475569',whiteSpace:'nowrap'}}>📊 Prob ≥</span>
                <select value={minProb} onChange={e=>setMinProb(Number(e.target.value))}
                  style={{background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.22)',
                    borderRadius:'8px',padding:'0.32rem 0.5rem',color:'#fbbf24',fontSize:'0.73rem',
                    fontWeight:700,cursor:'pointer',outline:'none'}}>
                  <option value={0}>All</option>
                  <option value={50}>50%</option>
                  <option value={55}>55%</option>
                  <option value={60}>60%</option>
                  <option value={65}>65%</option>
                  <option value={70}>70%</option>
                  <option value={75}>75%</option>
                  <option value={80}>80%+</option>
                </select>
              </div>
              {selDay&&(
                <div style={{display:'flex',alignItems:'center',gap:'0.35rem',background:'rgba(99,102,241,0.15)',
                  border:'1px solid rgba(99,102,241,0.3)',borderRadius:'8px',padding:'0.32rem 0.7rem',
                  fontSize:'0.73rem',color:'#a5b4fc',fontWeight:700}}>
                  📅 {selDay}
                  <button onClick={()=>setSelDay(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#a5b4fc',display:'flex',padding:0}}><X size={11}/></button>
                </div>
              )}
            </div>

            {/* Week list */}
            <div style={{flex:1,overflowY:'auto',padding:'1rem 1.15rem',display:'flex',flexDirection:'column',gap:'0.7rem'}}>
              {weeks.length===0?(
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%',gap:'1rem',color:'#334155'}}>
                  <div style={{padding:'1.5rem',background:'rgba(99,102,241,0.07)',borderRadius:'50%',boxShadow:'0 0 30px rgba(99,102,241,0.1)'}}>
                    <BarChart2 size={36} color='#818cf8' style={{opacity:0.3}}/>
                  </div>
                  <p style={{margin:0,fontSize:'0.95rem',fontWeight:700,color:'#475569'}}>{selDay?`No data for ${selDay}`:'No predictions found'}</p>
                  <p style={{margin:0,fontSize:'0.8rem'}}>{selDay?'Pick a different day on the calendar.':'Try adjusting your filters or refresh.'}</p>
                </div>
              ):weeks.map(({week,matches,winRate})=>(
                <WeekRow key={week} weekNum={week} matches={matches} winRate={winRate} type={tab}/>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selMatch&&<MatchDetailDrawer match={selMatch} type={selMatch._type} onClose={()=>setSelMatch(null)}/>}
      <style>{`
        @keyframes mhIn{from{opacity:0;transform:scale(0.97) translateY(8px);}to{opacity:1;transform:scale(1) translateY(0);}}
        ::-webkit-scrollbar{width:4px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:rgba(99,102,241,0.2);border-radius:99px;}
        ::-webkit-scrollbar-thumb:hover{background:rgba(99,102,241,0.38);}
      `}</style>
    </div>
  );
};
export default MarketHistoryModal;
