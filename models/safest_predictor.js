/**
 * Safest Pick XGBoost Engine — Inference Bridge
 * ==============================================
 * COMPLETELY SEPARATE from ai_best_predictor.js and high_chance_predictor.js.
 *
 * Model: Binary XGBoost — predicts P(1X2 pick wins) for short-odds markets.
 * Only recommends when model confidence × book_odd > 1 (positive EV).
 *
 * BATCH API: scoreRound() processes all matches in a single Python call.
 * Validated OOS: see safest_report.json (+27.5% ROI at xgb>=0.65)
 * Target markets: Home Win / Away Win / Draw (odds 1.30–1.85)
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const UTILS_DIR   = __dirname;
const MODEL_PATH  = path.join(UTILS_DIR, 'safest_model.json');
const THRESH_PATH = path.join(UTILS_DIR, 'safest_thresholds.json');
const REPORT_PATH = path.join(UTILS_DIR, 'safest_report.json');

const MIN_ODD = 1.30;
const MAX_ODD = 1.85;

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(UTILS_DIR, '../browser-config.json');

function loadBlockedMarkets() {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return (cfg.ai && cfg.ai.blockedMarkets && cfg.ai.blockedMarkets.safest) || [];
    } catch { return []; }
}

function loadThresholds() {
    try { return JSON.parse(fs.readFileSync(THRESH_PATH, 'utf8')); }
    catch { return { global_min_prob: 0.65 }; }
}

function isModelReady() {
    try { return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')).ready_for_deployment === true; }
    catch { return false; }
}

function getModelStatus() {
    try {
        const r = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
        return {
            status:  r.ready_for_deployment ? 'xgboost' : 'not_ready',
            message: `Safest XGBoost — ${r.profitable_folds}/5 folds profitable, avg OOS ROI: +${r.avg_oos_roi}%`,
            ready:   r.ready_for_deployment,
        };
    } catch { return { status: 'not_trained', message: 'Safest model not yet trained', ready: false }; }
}

/**
 * Build feature vector — must match safest_model.py exactly (16 features).
 */
function buildFV(rawProbs, market) {
    const n = k => ((rawProbs[k] || 0)) / 100;
    const hw = n('homeWinProb'), dr = n('drawProb'), aw = n('awayWinProb');
    const o15 = n('over15Prob'), o25 = n('over25Prob'), o35 = n('over35Prob'), gg = n('ggProb');
    const mp = market === 'home' ? hw : (market === 'away' ? aw : dr);
    return [
        hw, dr, aw, o15, o25, o35, gg, mp,
        Math.abs(hw - aw), Math.max(hw, aw, dr), 1.0 - mp,
        market === 'home' ? 1 : 0,
        market === 'away' ? 1 : 0,
        market === 'draw' ? 1 : 0,
        hw > 0.5 ? 1 : 0,
        aw > 0.5 ? 1 : 0,
    ];
}

/**
 * Batch inference — score ALL rows in one Python call.
 * @param {number[][]} featureVectors
 * @returns {number[]} P(win) for each row
 */
const VENV_PYTHON = path.join(UTILS_DIR, 'venv', 'bin', 'python3');
const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

function batchInfer(featureVectors) {
    const script = `
import json,sys,numpy as np,xgboost as xgb
m=xgb.XGBClassifier(); m.load_model('${MODEL_PATH.replace(/\\/g,'/')}')
X=np.array(json.loads(sys.stdin.read()),dtype=np.float32)
print(json.dumps(m.predict_proba(X)[:,1].tolist()))
`;
    const res = spawnSync(pythonBin, ['-c', script], {
        input: JSON.stringify(featureVectors), encoding: 'utf8', timeout: 20000
    });
    if (res.error || res.status !== 0) throw new Error(`Safest batch infer failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score an entire round of predictions in ONE Python call.
 * Returns the best bet across all matches, or null.
 *
 * @param {Array<{rawProbs, bookOdds, meta}>} matchList
 *   Each entry: { rawProbs: object (0-100 scale), bookOdds: object, meta: any }
 * @returns {object|null} { market, modelProb, bookOdd, ev, kellyFraction, source, meta }
 */
function scoreRound(matchList) {
    const thresh  = loadThresholds();
    const minProb = thresh.global_min_prob || 0.65;
    const ready   = isModelReady();

    // Build candidate list: each match × applicable markets
    const candidates = [];
    for (const { rawProbs, bookOdds, meta } of matchList) {
        for (const [mkt, label] of [['home','Home Win'],['away','Away Win'],['draw','Draw']]) {
            const odd = bookOdds[mkt];
            if (!odd || odd < MIN_ODD || odd > MAX_ODD) continue;
            const fallbackP = mkt === 'home' ? (rawProbs.homeWinProb||0)/100
                            : mkt === 'away' ? (rawProbs.awayWinProb||0)/100
                            :                  (rawProbs.drawProb||0)/100;
            candidates.push({ rawProbs, bookOdds, meta, mkt, label, odd, fallbackP });
        }
    }
    if (candidates.length === 0) return null;

    // Filter out globally blocked markets (loaded from browser-config.json)
    const blockedMarkets = loadBlockedMarkets();
    const filtered = blockedMarkets.length > 0
        ? candidates.filter(c => !blockedMarkets.includes(c.label))
        : candidates;
    if (filtered.length === 0) {
        console.log('[safest_predictor] All candidates blocked by market filter:', blockedMarkets.join(', '));
        return null;
    }

    // Batch XGBoost inference (filtered candidates only)
    let proba = null;
    if (ready && filtered.length > 0) {
        try {
            const fvs = filtered.map(c => buildFV(c.rawProbs, c.mkt));
            proba = batchInfer(fvs);
        } catch(e) {
            console.warn('[safest_predictor] batch infer failed, using Poisson fallback:', e.message);
        }
    }

    // Pick best EV across filtered candidates
    let bestBet = null;
    filtered.forEach((c, i) => {
        const modelP = proba ? proba[i] : c.fallbackP;
        const source = proba ? 'xgboost' : 'poisson_fallback';
        if (modelP < minProb) return;
        const ev = modelP * c.odd - 1.0;
        if (ev <= 0) return;
        if (!bestBet || ev > bestBet.ev) {
            const kelly = Math.max(0, Math.min(0.15, ((modelP * c.odd - 1) / (c.odd - 1)) * 0.5));
            bestBet = {
                market: c.label, modelProb: parseFloat((modelP*100).toFixed(1)),
                bookOdd: c.odd, ev: parseFloat((ev*100).toFixed(2)),
                kellyFraction: parseFloat(kelly.toFixed(4)), source, meta: c.meta
            };
        }
    });
    return bestBet;
}

/**
 * Single-match convenience wrapper (for backward compat).
 */
function recommendSafestBet(rawProbs, bookmakerOdds, meta) {
    return scoreRound([{ rawProbs, bookOdds: bookmakerOdds, meta }]);
}

module.exports = { scoreRound, recommendSafestBet, isModelReady, getModelStatus };
