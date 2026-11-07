/**
 * run_backtest.js — Walk-Forward Backtest: Old System vs New EV Engine (with Calibration)
 *
 * v2: Uses actual Platt/Temperature/Isotonic calibration per pick type
 *     before computing EV, matching the live engine's behaviour exactly.
 *
 * Usage: node run_backtest.js [db_path]
 * Default DB: sportybet_archive.db (resolved from settings or app root)
 */

'use strict';

const Database = require('better-sqlite3');
const {
    computeCalibrationParams, applyCalibration,
    brierScore, expectedCalibrationError
} = require('./utils/calibration');
const fs = require('fs');
const path = require('path');
const { resolveDatabasePath } = require('./utils/path_resolver');
const DB_PATH = resolveDatabasePath(process.argv[2], 'sportybet_archive.db');

// ─── Open DB ──────────────────────────────────────────────────────────────────
console.log(`\n📂  Opening: ${DB_PATH}`);
const db = new Database(DB_PATH);

console.log('🔧  Running schema migration…');
migrateDatabase(db);
console.log('    ✓ Engine columns ready');

// ─── Load all settled picks ───────────────────────────────────────────────────
const rawPicks = db.prepare(`
    SELECT id, pick_type, probability, implied_odd, status
    FROM ai_best_picks_history
    WHERE status IN ('won', 'lost')
    ORDER BY id ASC
`).all();
console.log(`\n📊  Loaded ${rawPicks.length} settled picks`);

// ─── Fit calibration params per pick type (uses full history) ─────────────────
console.log('🔬  Fitting calibration parameters per pick type…');
const calibParams = {};
for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
    calibParams[pt] = computeCalibrationParams(db, pt, 1000);
    const cp = calibParams[pt];
    console.log(`    ${pt}: T=${cp.T}  Platt(A=${cp.platt.A}, B=${cp.platt.B})  ECE=${(cp.ece*100).toFixed(1)}%  n=${cp.sampleSize}`);
}

// ─── Score helpers ────────────────────────────────────────────────────────────
function calcRawEV(probPct, odds) {
    const p = Math.max(0.001, Math.min(0.999, (probPct || 50) / 100));
    const o = Math.max(1.01, odds || 1.5);
    return (p * o - 1) * 100;
}

function calcCalibratedEV(probPct, odds, pickType) {
    const params = calibParams[pickType] || calibParams['ai_best_pick'];
    const { calibratedProb } = applyCalibration(probPct, params);
    const o = Math.max(1.01, odds || 1.5);
    return { ev: (calibratedProb * o - 1) * 100, calibratedProb };
}

// ─── Write calibrated EVs back to DB ─────────────────────────────────────────
console.log('⚡  Writing calibrated EV scores to DB…');
const updateStmt = db.prepare(`
    UPDATE ai_best_picks_history
    SET ev_score = ?, calibrated_prob = ?, bookmaker_implied_prob = ?
    WHERE id = ?
`);
let updated = 0;
db.transaction(() => {
    for (const p of rawPicks) {
        const { ev, calibratedProb } = calcCalibratedEV(p.probability, p.implied_odd, p.pick_type);
        const impliedProb = 1 / Math.max(1.01, p.implied_odd || 1.5);
        updateStmt.run(parseFloat(ev.toFixed(4)), parseFloat(calibratedProb.toFixed(4)), parseFloat(impliedProb.toFixed(4)), p.id);
        updated++;
    }
})();
console.log(`    ✓ Calibrated EVs written for ${updated} picks`);

// Reload with calibrated EVs
const picks = db.prepare(`
    SELECT id, pick_type, probability, implied_odd, ev_score, calibrated_prob, status
    FROM ai_best_picks_history
    WHERE status IN ('won', 'lost')
    ORDER BY id ASC
`).all();

// ─── Backtest functions ───────────────────────────────────────────────────────
function runBacktest(picks, evThresholds) {
    const results = {};
    for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
        const sub = picks.filter(p => p.pick_type === pt);
        let bets = 0, won = 0, profit = 0;
        for (const p of sub) {
            if (evThresholds !== null) {
                const ev = p.ev_score || 0;
                const thr = pt === 'safest' ? evThresholds.safest
                    : pt === 'high_value' ? evThresholds.highValue
                    : evThresholds.highRisk;
                if (ev < thr) continue;
            }
            bets++;
            if (p.status === 'won') { won++; profit += p.implied_odd - 1; }
            else profit -= 1;
        }
        results[pt] = bets > 0
            ? { bets, won, winRate: +(won / bets * 100).toFixed(1), roi: +(profit / bets * 100).toFixed(2), profit: +profit.toFixed(2) }
            : { bets: 0, won: 0, winRate: 0, roi: 0, profit: 0 };
    }
    return results;
}

function walkForwardOptimize(picks, pickType) {
    const sub = picks.filter(p => p.pick_type === pickType);
    const split = Math.floor(sub.length * 0.6);
    const train = sub.slice(0, split);
    const test  = sub.slice(split);
    if (train.length < 10 || test.length < 5) return { bestThreshold: 0, testBets: 0, testROI: null, baseROI: null, roiLift: null };

    let best = { threshold: 0, roi: -Infinity };
    for (let t = -10; t <= 30; t += 0.5) {
        let bets = 0, profit = 0;
        for (const p of train) {
            if ((p.ev_score || -999) >= t) { bets++; profit += p.status === 'won' ? p.implied_odd - 1 : -1; }
        }
        if (bets >= 5 && profit / bets > best.roi) best = { threshold: t, roi: profit / bets };
    }

    let testBets = 0, testProfit = 0, testWon = 0;
    for (const p of test) {
        if ((p.ev_score || -999) >= best.threshold) {
            testBets++;
            if (p.status === 'won') { testWon++; testProfit += p.implied_odd - 1; }
            else testProfit -= 1;
        }
    }
    let baseProfit = 0, baseWon = 0;
    for (const p of test) {
        if (p.status === 'won') { baseWon++; baseProfit += p.implied_odd - 1; }
        else baseProfit -= 1;
    }
    const baseROI = +(baseProfit / test.length * 100).toFixed(2);
    const testROI = testBets > 0 ? +(testProfit / testBets * 100).toFixed(2) : null;
    return {
        bestThreshold: best.threshold,
        trainBets: train.length,
        testBets, testWon,
        baseBets: test.length, baseWon, baseROI, testROI,
        roiLift: testROI != null ? +((testROI - baseROI)).toFixed(2) : null
    };
}

function calcCalibQuality(picks, pt, useCalibrated = false) {
    const sub = picks.filter(p => p.pick_type === pt);
    if (sub.length < 5) return null;
    const hist = sub.map(p => ({
        prob: useCalibrated
            ? Math.max(0.001, Math.min(0.999, p.calibrated_prob || (p.probability || 50) / 100))
            : Math.max(0.001, Math.min(0.999, (p.probability || 50) / 100)),
        outcome: p.status === 'won' ? 1 : 0
    }));
    const bs = brierScore(hist);
    const ece = expectedCalibrationError(hist);
    return { brierScore: bs.toFixed(4), ece: (ece * 100).toFixed(2), n: sub.length };
}

// ─── Run Backtests ────────────────────────────────────────────────────────────
const LINE = '═'.repeat(68);
const line = '─'.repeat(68);
console.log(`\n${LINE}`);
console.log('  WALK-FORWARD BACKTEST (v2 — with Calibrated EV)');
console.log(LINE);

const oldResults  = runBacktest(picks, null);                                           // no EV filter
const newResults  = runBacktest(picks, { safest: 2, highValue: 5, highRisk: 8 });       // default thresholds
const optResults  = runBacktest(picks, { safest: 8, highValue: 0, highRisk: 10 });      // recommended from analysis
const aggResults  = runBacktest(picks, { safest: 5, highValue: 0, highRisk: 5 });       // moderate

const wf = {};
const calRaw = {};
const calCal = {};
for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
    wf[pt]     = walkForwardOptimize(picks, pt);
    calRaw[pt] = calcCalibQuality(picks, pt, false);   // raw probability
    calCal[pt] = calcCalibQuality(picks, pt, true);    // calibrated probability
}

const fmtROI = v => v == null ? '  —     ' : `${v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`;
const typeLabels = { safest: '🛡  Safest', high_value: '⚡  High Value', ai_best_pick: '🎯  AI Best Pick' };

for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
    const o = oldResults[pt], n = newResults[pt], op = optResults[pt], a = aggResults[pt];
    const w = wf[pt];
    const cr = calRaw[pt], cc = calCal[pt];
    const total = picks.filter(p => p.pick_type === pt).length;

    console.log(`\n${typeLabels[pt]}  (${total} settled picks)`);
    console.log(line);
    console.log(`  ${''.padEnd(22)} ${'No EV filter'.padEnd(14)} ${'EV≥def'.padEnd(12)} ${'EV≥opt'.padEnd(12)} ${'EV≥mod'.padEnd(10)}`);
    console.log(`  ${'Bets Placed'.padEnd(22)} ${String(o.bets).padEnd(14)} ${String(n.bets).padEnd(12)} ${String(op.bets).padEnd(12)} ${String(a.bets).padEnd(10)}`);
    console.log(`  ${'Won'.padEnd(22)} ${String(o.won).padEnd(14)} ${String(n.won).padEnd(12)} ${String(op.won).padEnd(12)} ${String(a.won).padEnd(10)}`);
    console.log(`  ${'Win Rate'.padEnd(22)} ${(o.winRate+'%').padEnd(14)} ${(n.winRate+'%').padEnd(12)} ${(op.winRate+'%').padEnd(12)} ${(a.winRate+'%').padEnd(10)}`);
    console.log(`  ${'Net Profit (units)'.padEnd(22)} ${String(o.profit).padEnd(14)} ${String(n.profit).padEnd(12)} ${String(op.profit).padEnd(12)} ${String(a.profit).padEnd(10)}`);
    console.log(`  ${'ROI per bet'.padEnd(22)} ${fmtROI(o.roi).padEnd(14)} ${fmtROI(n.roi).padEnd(12)} ${fmtROI(op.roi).padEnd(12)} ${fmtROI(a.roi).padEnd(10)}`);

    console.log('');
    console.log('  Walk-Forward Optimization (calibrated EV):');
    console.log(`    Optimal EV threshold (train):  ${w.bestThreshold >= 0 ? '+' : ''}${w.bestThreshold}%`);
    if (w.baseBets) {
        console.log(`    Test — ALL bets: ${w.baseBets} | WR: ${(w.baseWon/w.baseBets*100).toFixed(1)}% | ROI: ${fmtROI(w.baseROI)}`);
        console.log(`    Test — EV≥${String(w.bestThreshold).padEnd(5)}: ${w.testBets} | WR: ${w.testBets>0?(w.testWon/w.testBets*100).toFixed(1)+'%':'—'} | ROI: ${fmtROI(w.testROI)}`);
        console.log(`    ROI lift from EV filter: ${w.roiLift!=null?(w.roiLift>=0?'+':'')+w.roiLift+'%':'—'}`);
    }

    console.log('');
    console.log('  Calibration Quality:');
    if (cr && cc) {
        const ratingR = parseFloat(cr.brierScore) <= 0.22 ? '🟡 Good' : parseFloat(cr.brierScore) <= 0.28 ? '🟠 Fair' : '🔴 Poor';
        const ratingC = parseFloat(cc.brierScore) <= 0.22 ? '🟡 Good' : parseFloat(cc.brierScore) <= 0.18 ? '🟢 Excellent' : parseFloat(cc.brierScore) <= 0.28 ? '🟠 Fair' : '🔴 Poor';
        console.log(`    Raw probabilities  — Brier: ${cr.brierScore} ${ratingR}  ECE: ${cr.ece}%`);
        console.log(`    Calibrated probs   — Brier: ${cc.brierScore} ${ratingC}  ECE: ${cc.ece}%`);
        const brierImprovement = (parseFloat(cr.brierScore) - parseFloat(cc.brierScore)).toFixed(4);
        const eceImprovement   = (parseFloat(cr.ece) - parseFloat(cc.ece)).toFixed(2);
        console.log(`    Calibration improvement: Brier ${brierImprovement >= 0 ? '↓' : '↑'}${Math.abs(brierImprovement)}  ECE ${eceImprovement >= 0 ? '↓' : '↑'}${Math.abs(eceImprovement)}%`);
    }
}

// ─── EV Distribution ─────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log('  EV DISTRIBUTION (calibrated EV): Positive vs Negative');
console.log(LINE);
for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
    const sub = picks.filter(p => p.pick_type === pt);
    const pos = sub.filter(p => (p.ev_score || 0) > 0);
    const neg = sub.filter(p => (p.ev_score || 0) <= 0);
    const pWon = pos.filter(p => p.status === 'won').length;
    const nWon = neg.filter(p => p.status === 'won').length;
    const pProfit = pos.reduce((a,p) => a + (p.status==='won' ? p.implied_odd-1 : -1), 0);
    const nProfit = neg.reduce((a,p) => a + (p.status==='won' ? p.implied_odd-1 : -1), 0);
    console.log(`\n  ${typeLabels[pt]}`);
    console.log(`    Positive EV: ${pos.length} bets | WR: ${pos.length?((pWon/pos.length*100).toFixed(1)+'%'):'—'} | ROI: ${pos.length?fmtROI(pProfit/pos.length*100):'—'}`);
    console.log(`    Negative EV: ${neg.length} bets | WR: ${neg.length?((nWon/neg.length*100).toFixed(1)+'%'):'—'} | ROI: ${neg.length?fmtROI(nProfit/neg.length*100):'—'}`);
    // Avg EV in each bucket
    const avgPosEV = pos.length ? (pos.reduce((a,p)=>a+(p.ev_score||0),0)/pos.length).toFixed(2) : null;
    const avgNegEV = neg.length ? (neg.reduce((a,p)=>a+(p.ev_score||0),0)/neg.length).toFixed(2) : null;
    console.log(`    Avg EV:  Positive: +${avgPosEV}%   Negative: ${avgNegEV}%`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log('  VERDICT: Old System vs New (calibrated EV, recommended thresholds)');
console.log(LINE + '\n');
let totalLift = 0, cnt = 0;
for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
    const o = oldResults[pt], nr = optResults[pt];
    if (o.bets > 0) {
        const lift = (nr.roi || 0) - (o.roi || 0);
        const icon = lift > 1 ? '📈' : lift < -1 ? '📉' : '➡️';
        console.log(`  ${typeLabels[pt].padEnd(22)} Old: ${fmtROI(o.roi).padEnd(10)} → Opt: ${fmtROI(nr.roi).padEnd(10)} ${icon}  ${lift>=0?'+':''}${lift.toFixed(2)}%`);
        if (nr.bets > 0) { totalLift += lift; cnt++; }
    }
}
if (cnt > 0) {
    const avg = totalLift / cnt;
    console.log(`\n  Average ROI lift across pick types: ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`);
    console.log(`  Verdict: ${avg > 3 ? '✅ New engine is SIGNIFICANTLY better' : avg > 0 ? '✅ New engine is better' : avg > -1 ? '➡️  Similar — check threshold tuning' : '⚠️  Threshold tuning needed'}`);
}

console.log(`\n${LINE}`);
console.log('  RECOMMENDED EV THRESHOLDS (from walk-forward analysis)');
console.log(LINE);
console.log(`  Safest:     EV ≥ ${wf.safest?.bestThreshold >= 0 ? '+' : ''}${wf.safest?.bestThreshold ?? 2}%`);
console.log(`  High Value: EV ≥ ${wf.high_value?.bestThreshold >= 0 ? '+' : ''}${wf.high_value?.bestThreshold ?? 5}%`);
console.log(`  AI Best:    EV ≥ ${wf.ai_best_pick?.bestThreshold >= 0 ? '+' : ''}${wf.ai_best_pick?.bestThreshold ?? 8}%`);
console.log('\n  Apply via: Settings → EV Threshold Engine → ML mode → ▶ Run Now\n');

db.close();
