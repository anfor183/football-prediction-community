'use strict';

/**
 * ai_best_predictor.js
 *
 * Node.js inference bridge for the dedicated AI Best XGBoost HT/FT model.
 *
 * At inference time:
 *   1. Load trained model (ai_best_htft_model.json) via Python subprocess
 *   2. Build feature vector from live match data
 *   3. Return 9 calibrated HT/FT probabilities + top-pick recommendation
 *
 * Falls back gracefully to isotonic calibration if model unavailable.
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const { buildLiveFeatureVector, HTFT_LABELS } = require('./ai_best_feature_builder');
const { calibrateHtftProbs, getBestHtftBet }  = require('./htft_calibration_tables');

const MODEL_PATH      = path.join(__dirname, 'ai_best_htft_model.json');
const THRESHOLDS_PATH = path.join(__dirname, 'ai_best_htft_thresholds.json');
const REPORT_PATH     = path.join(__dirname, 'ai_best_htft_report.json');

// Book overround measured empirically from sportybet_archive.db: 13.9%
const BOOK_MARGIN = 0.139;

// Minimum EV threshold (model_prob * book_odd - 1 must exceed this)
const MIN_EV = 0.0;    // any positive EV allowed — markets self-select by odds ratio

// Only these 2 markets have shown positive OOS ROI with REAL book odds:
// htftXX at p≥20%: +28.5% ROI  |  htft22 at p≥20%: +70.7% ROI
// htft11 excluded — bookmaker prices it fairly (short odds eliminate edge)
const PROFITABLE_MARKETS = new Set(['htftXXProb', 'htft22Prob']);

// Minimum model confidence — below this, skip regardless of EV
const MIN_PROB = 0.20; // 20% — validated threshold for positive OOS ROI

// Typical Sportybet HT/FT book odds (empirically measured from sportybet_archive.db)
// Used when real match-specific odds not available in bookmakerOdds
const TYPICAL_BOOK_ODDS = {
    htft11Prob: 4.1,  htft1XProb: 22.0, htft12Prob: 80.0,
    htftX1Prob: 7.0,  htftXXProb: 6.5,  htftX2Prob: 9.0,
    htft21Prob: 75.0, htft2XProb: 24.0, htft22Prob: 5.8
};


/**
 * Check if the trained XGBoost model is available and validated.
 */
function isModelReady() {
    if (!fs.existsSync(MODEL_PATH))      return false;
    if (!fs.existsSync(THRESHOLDS_PATH)) return false;
    if (!fs.existsSync(REPORT_PATH))     return false;
    try {
        const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
        return report.ready_for_deployment === true;
    } catch { return false; }
}

/**
 * Run XGBoost inference via Python subprocess.
 * @param {number[][]} featureVectors - array of feature vectors
 * @returns {number[][]} proba - array of 9-class probability vectors
 */
function runXGBoostInference(featureVectors) {
    const script = `
import json, sys, numpy as np
import xgboost as xgb

model = xgb.XGBClassifier()
model.load_model('${MODEL_PATH.replace(/\\/g, '/')}')
X = np.array(json.loads(sys.stdin.read()), dtype=np.float32)
proba = model.predict_proba(X)
print(json.dumps(proba.tolist()))
`;
    const result = spawnSync('python3', ['-c', script], {
        input: JSON.stringify(featureVectors),
        encoding: 'utf8',
        timeout: 10000
    });

    if (result.error || result.status !== 0) {
        throw new Error(`XGBoost inference failed: ${result.stderr || result.error}`);
    }

    return JSON.parse(result.stdout.trim());
}

/**
 * Load per-market confidence thresholds from training.
 */
function loadThresholds() {
    try {
        return JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * Convert XGBoost probability vector to named probs object (for compatibility
 * with getBestHtftBet).
 * @param {number[]} probaVec - 9-element probability vector
 * @returns {object} e.g. { htft11Prob: 28.3, htft22Prob: 19.1, ... }
 */
function probaVecToProbs(probaVec) {
    const out = {};
    HTFT_LABELS.forEach((label, i) => {
        out[label + 'Prob'] = probaVec[i] * 100;  // convert to 0-100 scale
    });
    return out;
}

/**
 * Core recommendation: given a match's predicted probs + form data + book odds,
 * return the best HT/FT bet or null (no bet).
 *
 * @param {object} rawProbs         - parsed predicted_probs from live_predictions
 * @param {Array}  homeRecentMatches - form history for home team
 * @param {Array}  awayRecentMatches - form history for away team
 * @param {object} bookmakerOdds    - { halftimeFulltime: { htft11: 4.2, ... } }
 * @returns {object|null} { market, calibratedProb, bookOdd, ev, kellyFraction } or null
 */
async function predictAndRecommend(rawProbs, homeRecentMatches, awayRecentMatches, bookmakerOdds) {
    // DB stores HT/FT odds under 'htft' key with keys like 'htft11', 'htft22'
    // Legacy format used 'halftimeFulltime' — support both
    const htftOdds = (bookmakerOdds && (bookmakerOdds.htft || bookmakerOdds.halftimeFulltime)) || {};
    let xgbProbs = null;

    // ── Attempt XGBoost inference ─────────────────────────────────────────
    if (isModelReady()) {
        try {
            const fv = buildLiveFeatureVector(rawProbs, homeRecentMatches, awayRecentMatches);
            const probaMatrix = runXGBoostInference([fv]);
            xgbProbs = probaVecToProbs(probaMatrix[0]);
        } catch (err) {
            console.warn('[ai_best_predictor] XGBoost inference failed, falling back to isotonic calibration:', err.message);
            xgbProbs = null;
        }
    }

    // ── Fallback: isotonic calibration ───────────────────────────────────
    const probs = xgbProbs || calibrateHtftProbs(rawProbs);

    // ── Apply per-market thresholds ───────────────────────────────────────
    const thresholds = loadThresholds();
    const source = xgbProbs ? 'xgboost' : 'isotonic_fallback';

    // ── Find best EV market ───────────────────────────────────────────────
    const bookKeyMap = {
        htft11Prob: 'htft11', htft1XProb: 'htft1X', htft12Prob: 'htft12',
        htftX1Prob: 'htftX1', htftXXProb: 'htftXX', htftX2Prob: 'htftX2',
        htft21Prob: 'htft21', htft2XProb: 'htft2X', htft22Prob: 'htft22'
    };
    const labelMap = {
        htft11Prob: 'HT/FT 1/1', htft1XProb: 'HT/FT 1/X', htft12Prob: 'HT/FT 1/2',
        htftX1Prob: 'HT/FT X/1', htftXXProb: 'HT/FT X/X', htftX2Prob: 'HT/FT X/2',
        htft21Prob: 'HT/FT 2/1', htft2XProb: 'HT/FT 2/X', htft22Prob: 'HT/FT 2/2'
    };

    let bestBet = null;

    for (const [probKey, bookKey] of Object.entries(bookKeyMap)) {
        // Only bet markets with proven positive OOS ROI
        if (!PROFITABLE_MARKETS.has(probKey)) continue;

        const calibP = (probs[probKey] || 0) / 100;
        if (calibP < MIN_PROB) continue;


        // Use real bookmaker odd; fall back to typical if unavailable
        const bookOdd = htftOdds[bookKey] || TYPICAL_BOOK_ODDS[probKey];
        if (!bookOdd || bookOdd < 2.0) continue; // skip if no odds available

        // EV = model_prob × book_odd - 1 (positive means model sees edge)
        const ev = calibP * bookOdd - 1.0;
        if (ev <= MIN_EV) continue;

        // Half-Kelly fraction for bet sizing (capped at 15% of bankroll)
        const fullKelly = (calibP * bookOdd - 1) / (bookOdd - 1);
        const kellyFraction = Math.max(0, Math.min(0.15, fullKelly * 0.5));

        if (!bestBet || ev > bestBet.ev) {
            bestBet = {
                market:          labelMap[probKey],
                calibratedProb:  parseFloat((calibP * 100).toFixed(1)),
                bookOdd:         bookOdd,
                ev:              parseFloat((ev * 100).toFixed(2)),   // in %
                kellyFraction:   parseFloat(kellyFraction.toFixed(4)),
                source
            };
        }
    }

    return bestBet; // null = no bet this round (valid decision)
}


/**
 * Synchronous version for use in pick pipelines that aren't async-compatible.
 */
function predictAndRecommendSync(rawProbs, homeRecentMatches, awayRecentMatches, bookmakerOdds) {
    // DB stores HT/FT odds under 'htft' key; fall back to 'halftimeFulltime' for compat
    const htftOdds = (bookmakerOdds && (bookmakerOdds.htft || bookmakerOdds.halftimeFulltime)) || {};

    let xgbProbs = null;
    const source = isModelReady() ? 'xgboost' : 'isotonic_fallback';

    if (isModelReady()) {
        try {
            const fv = buildLiveFeatureVector(rawProbs, homeRecentMatches, awayRecentMatches);
            const probaMatrix = runXGBoostInference([fv]);
            xgbProbs = probaVecToProbs(probaMatrix[0]);
        } catch { xgbProbs = null; }
    }

    const probs      = xgbProbs || calibrateHtftProbs(rawProbs);
    const thresholds = loadThresholds();

    // Map from probKey → bookKey (htft11Prob → htft11)
    const bookKeyMap = {
        htft11Prob: 'htft11', htft1XProb: 'htft1X', htft12Prob: 'htft12',
        htftX1Prob: 'htftX1', htftXXProb: 'htftXX', htftX2Prob: 'htftX2',
        htft21Prob: 'htft21', htft2XProb: 'htft2X', htft22Prob: 'htft22'
    };
    const labelMap = {
        htft11Prob: 'HT/FT 1/1', htft1XProb: 'HT/FT 1/X', htft12Prob: 'HT/FT 1/2',
        htftX1Prob: 'HT/FT X/1', htftXXProb: 'HT/FT X/X', htftX2Prob: 'HT/FT X/2',
        htft21Prob: 'HT/FT 2/1', htft2XProb: 'HT/FT 2/X', htft22Prob: 'HT/FT 2/2'
    };

    let bestBet = null;

    for (const [probKey, bookKey] of Object.entries(bookKeyMap)) {
        // Only bet markets with proven positive OOS ROI
        if (!PROFITABLE_MARKETS.has(probKey)) continue;

        const calibP = (probs[probKey] || 0) / 100;
        if (calibP < MIN_PROB) continue;

        // Use real bookmaker odd; fall back to typical if unavailable
        const bookOdd = htftOdds[bookKey] || TYPICAL_BOOK_ODDS[probKey];
        if (!bookOdd || bookOdd < 2.0) continue;

        // EV = model_prob × book_odd - 1
        const ev = calibP * bookOdd - 1.0;
        if (ev <= MIN_EV) continue;

        const fullKelly    = (calibP * bookOdd - 1) / (bookOdd - 1);
        const kellyFraction = Math.max(0, Math.min(0.15, fullKelly * 0.5));

        if (!bestBet || ev > bestBet.ev) {
            bestBet = {
                market:          labelMap[probKey],
                calibratedProb:  parseFloat((calibP * 100).toFixed(1)),
                bookOdd,
                ev:              parseFloat((ev * 100).toFixed(2)),
                kellyFraction:   parseFloat(kellyFraction.toFixed(4)),
                source
            };
        }
    }

    return bestBet; // null = no bet this round
}


/**
 * Load team form history from the database for live inference.
 * Returns arrays compatible with buildLiveFeatureVector().
 */
function loadTeamForm(db, teamName, isHome = true, limit = 15) {
    const col  = isHome ? 'home_team' : 'away_team';
    const rows = db.prepare(`
        SELECT actual_ht_score, actual_score
        FROM historical_market_predictions
        WHERE ${col} = ?
          AND actual_ht_score IS NOT NULL AND actual_ht_score != ''
          AND actual_score IS NOT NULL AND actual_score LIKE '%:%'
        ORDER BY id ASC
    `).all(teamName);

    const { computeTeamForm, HTFT_LABELS: labels } = require('./ai_best_feature_builder');

    // Convert to the form expected by computeTeamForm
    const formRows = rows.slice(-limit).map(r => {
        const [hH, hA] = r.actual_ht_score.split(':').map(Number);
        const [fH, fA] = r.actual_score.split(':').map(Number);
        const htFor     = isHome ? hH : hA;
        const htAgainst = isHome ? hA : hH;
        const ftFor     = isHome ? fH : fA;
        const ftAgainst = isHome ? fA : fH;
        const htResult = htFor > htAgainst ? 'W' : htFor < htAgainst ? 'L' : 'D';
        const ftResult = ftFor > ftAgainst ? 'W' : ftFor < ftAgainst ? 'L' : 'D';
        const ht = hH > hA ? '1' : hH < hA ? '2' : 'X';
        const ft = fH > fA ? '1' : fH < fA ? '2' : 'X';
        const htftKey = 'htft' + (isHome ? ht : (ht==='1'?'2':ht==='2'?'1':ht)) +
                                 (isHome ? ft : (ft==='1'?'2':ft==='2'?'1':ft));
        return { teamHtGoalsFor: htFor, teamHtGoalsAgainst: htAgainst,
                 teamFtGoalsFor: ftFor, teamFtGoalsAgainst: ftAgainst,
                 htResult, ftResult,
                 htftKey: labels.includes(htftKey) ? htftKey : 'htft11' };
    });

    return formRows;
}

/**
 * Get model status for dashboard display.
 */
function getModelStatus() {
    if (!isModelReady()) {
        return { status: 'fallback', message: 'Using isotonic calibration (XGBoost model not ready)', ready: false };
    }
    try {
        const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
        return {
            status: 'xgboost',
            message: `XGBoost model active — ${report.profitable_folds}/5 folds profitable, avg OOS ROI: ${report.avg_oos_roi > 0 ? '+' : ''}${report.avg_oos_roi}%`,
            trainedOn: report.trained_on,
            avgOosRoi: report.avg_oos_roi,
            profitableFolds: report.profitable_folds,
            ready: true
        };
    } catch {
        return { status: 'fallback', message: 'Model file corrupt, using isotonic fallback', ready: false };
    }
}

module.exports = {
    predictAndRecommend,
    predictAndRecommendSync,
    loadTeamForm,
    getModelStatus,
    isModelReady,
    BOOK_MARGIN,
    MIN_EV,
    MIN_PROB
};
