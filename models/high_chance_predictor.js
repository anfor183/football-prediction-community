/**
 * High Chance Pick XGBoost Engine — Inference Bridge
 * ===================================================
 * COMPLETELY SEPARATE from ai_best_predictor.js and safest_predictor.js.
 *
 * Two separate XGBoost models:
 *   1. high_chance_over25_model.json  — predicts P(Over 2.5 Goals)
 *   2. high_chance_gg_model.json      — predicts P(BTTS / GG)
 *
 * BATCH API: scoreRound() processes all matches in ONE Python call per model.
 * Validated holdout ROI: Over2.5 +85.5%, GG +93.9% (both at xgb>=0.70)
 * Target odds: 1.65–3.50
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const UTILS_DIR         = __dirname;
const OVER25_MODEL_PATH = path.join(UTILS_DIR, 'high_chance_over25_model.json');
const GG_MODEL_PATH     = path.join(UTILS_DIR, 'high_chance_gg_model.json');
const THRESH_PATH       = path.join(UTILS_DIR, 'high_chance_thresholds.json');
const REPORT_PATH       = path.join(UTILS_DIR, 'high_chance_report.json');

const MIN_ODD_HC = 1.65;
const MAX_ODD_HC = 3.50;

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(UTILS_DIR, '../browser-config.json');

function loadBlockedMarkets() {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return (cfg.ai && cfg.ai.blockedMarkets && cfg.ai.blockedMarkets.high_value) || [];
    } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadThresholds() {
    try { return JSON.parse(fs.readFileSync(THRESH_PATH, 'utf8')); }
    catch { return { over25: { min_prob: 0.70 }, gg: { min_prob: 0.70 } }; }
}

function isModelReady() {
    try { return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')).ready_for_deployment === true; }
    catch { return false; }
}

function getModelStatus() {
    try {
        const r = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
        const o = r.over25 || {}, g = r.gg || {};
        return {
            status:  r.ready_for_deployment ? 'xgboost' : 'not_ready',
            message: `High Chance XGBoost — Over2.5: ${o.profitable_folds||0}/5 folds +${o.avg_oos_roi||0}% | GG: ${g.profitable_folds||0}/5 folds +${g.avg_oos_roi||0}%`,
            ready:   r.ready_for_deployment,
        };
    } catch { return { status: 'not_trained', message: 'High Chance model not yet trained', ready: false }; }
}

/**
 * Build feature vector — must match high_chance_model.py exactly (19 features).
 */
function buildFV(rawProbs) {
    const n = k => ((rawProbs[k] || 0)) / 100;
    const hw=n('homeWinProb'), dr=n('drawProb'), aw=n('awayWinProb');
    const o15=n('over15Prob'), o25=n('over25Prob'), o35=n('over35Prob'), o45=n('over45Prob');
    const gg=n('ggProb'), hto25=n('htOver25Prob'), hto35=n('htOver35Prob');
    return [
        hw, dr, aw, o15, o25, o35, o45, gg, hto25, hto35,
        o25-(1-o25), gg-(1-gg), Math.abs(hw-aw), Math.max(hw,aw),
        1-dr, o25*gg,
        n('htScoring1stProb'), n('htScoring2ndProb'), n('htScoringEqualProb'),
    ];
}

/**
 * Batch inference for one model file.
 * @param {string}    modelPath
 * @param {number[][]} fvs
 * @returns {number[]} P(event) per row
 */
const VENV_PYTHON = path.join(UTILS_DIR, 'venv', 'bin', 'python3');
const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

function batchInfer(modelPath, fvs) {
    const script = `
import json,sys,numpy as np,xgboost as xgb
m=xgb.XGBClassifier(); m.load_model('${modelPath.replace(/\\/g,'/')}')
X=np.array(json.loads(sys.stdin.read()),dtype=np.float32)
print(json.dumps(m.predict_proba(X)[:,1].tolist()))
`;
    const res = spawnSync(pythonBin, ['-c', script], {
        input: JSON.stringify(fvs), encoding: 'utf8', timeout: 20000
    });
    if (res.error || res.status !== 0) throw new Error(`HC batch infer failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim());
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Score an entire round in ONE Python call per model (two calls total).
 * Returns the single best bet across all matches and both markets, or null.
 *
 * @param {Array<{rawProbs, bookOdds, meta}>} matchList
 * @returns {object|null}
 */
function scoreRound(matchList) {
    const thresh = loadThresholds();
    const ready  = isModelReady();
    const tO25   = (thresh.over25 || {}).min_prob || 0.70;
    const tGG    = (thresh.gg     || {}).min_prob || 0.70;

    // Candidates for each market — skip any blocked market entirely
    const blockedMarkets = loadBlockedMarkets();
    const o25Blocked = blockedMarkets.some(m => m.toLowerCase().includes('over 2.5') || m.toLowerCase().includes('over2.5'));
    const ggBlocked  = blockedMarkets.some(m => m.toLowerCase().includes('both teams') || m.toLowerCase().includes('gg') || m.toLowerCase().includes('btts'));

    const o25Candidates = [], ggCandidates = [];
    for (const entry of matchList) {
        const { rawProbs, bookOdds, meta } = entry;
        const o25Odd = bookOdds.over25;
        const ggOdd  = bookOdds.gg;
        if (!o25Blocked && o25Odd && o25Odd >= MIN_ODD_HC && o25Odd <= MAX_ODD_HC)
            o25Candidates.push({ ...entry, odd: o25Odd, label: 'Over 2.5 Goals',        fallbackP: (rawProbs.over25Prob||0)/100 });
        if (!ggBlocked  && ggOdd  && ggOdd  >= MIN_ODD_HC && ggOdd  <= MAX_ODD_HC)
            ggCandidates.push({  ...entry, odd: ggOdd,  label: 'Both Teams to Score',   fallbackP: (rawProbs.ggProb||0)/100 });
    }
    if (ggBlocked)  console.log('[high_chance] GG/BTTS market blocked by config');
    if (o25Blocked) console.log('[high_chance] Over 2.5 Goals market blocked by config');

    // Batch infer both models in parallel (spawnSync blocks, but each is one call)
    let o25Proba = null, ggProba = null;
    if (ready) {
        if (o25Candidates.length > 0) {
            try { o25Proba = batchInfer(OVER25_MODEL_PATH, o25Candidates.map(c => buildFV(c.rawProbs))); }
            catch(e) { console.warn('[high_chance] over25 batch infer failed:', e.message); }
        }
        if (ggCandidates.length > 0) {
            try { ggProba = batchInfer(GG_MODEL_PATH, ggCandidates.map(c => buildFV(c.rawProbs))); }
            catch(e) { console.warn('[high_chance] gg batch infer failed:', e.message); }
        }
    }

    // Find best EV bet across both markets
    let bestBet = null;

    const evalCandidates = (list, proba, thresh, source) => {
        list.forEach((c, i) => {
            const modelP = proba ? proba[i] : c.fallbackP;
            const src    = proba ? source : 'poisson_fallback';
            if (modelP < thresh) return;
            const ev = modelP * c.odd - 1.0;
            if (ev <= 0) return;
            if (!bestBet || ev > bestBet.ev) {
                const kelly = Math.max(0, Math.min(0.15, ((modelP * c.odd - 1) / (c.odd - 1)) * 0.5));
                bestBet = {
                    market: c.label, modelProb: parseFloat((modelP*100).toFixed(1)),
                    bookOdd: c.odd,  ev: parseFloat((ev*100).toFixed(2)),
                    kellyFraction: parseFloat(kelly.toFixed(4)), source: src, meta: c.meta
                };
            }
        });
    };

    evalCandidates(o25Candidates, o25Proba, tO25, 'xgboost_over25');
    evalCandidates(ggCandidates,  ggProba,  tGG,  'xgboost_gg');
    return bestBet;
}

/**
 * Single-match convenience wrapper (for backward compat).
 */
function recommendHighChanceBet(rawProbs, bookmakerOdds, meta) {
    return scoreRound([{ rawProbs, bookOdds: bookmakerOdds, meta }]);
}

module.exports = { scoreRound, recommendHighChanceBet, isModelReady, getModelStatus };
