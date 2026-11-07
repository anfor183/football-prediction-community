/**
 * calibration.js — Module 1: Probability Calibration
 *
 * Converts raw neural/Poisson model probabilities into true calibrated probabilities.
 * Never trust raw model confidence directly.
 *
 * Methods implemented:
 *   - Temperature Scaling
 *   - Platt Scaling
 *   - Isotonic Regression (histogram binning)
 *   - Brier Score
 *   - Expected Calibration Error (ECE)
 *   - Reliability Diagram data
 */

'use strict';

/**
 * Temperature Scaling
 * Divides the log-odds of the probability by temperature T.
 * T > 1 makes predictions more conservative (recommended for overconfident models).
 * T < 1 makes predictions sharper.
 *
 * @param {number} rawProb - Raw probability [0, 1]
 * @param {number} T - Temperature scalar (default 1.3)
 * @returns {number} calibrated probability [0, 1]
 */
function temperatureScale(rawProb, T = 1.3) {
    if (rawProb <= 0) return 0.001;
    if (rawProb >= 1) return 0.999;
    const logit = Math.log(rawProb / (1 - rawProb));
    const scaledLogit = logit / T;
    return 1 / (1 + Math.exp(-scaledLogit));
}

/**
 * Fit temperature scaling parameter T from historical data.
 * Minimizes negative log-likelihood (NLL) over a grid search.
 *
 * @param {Array<{prob: number, outcome: number}>} history - Array of {prob [0,1], outcome 0|1}
 * @returns {number} best T
 */
function fitTemperature(history) {
    if (!history || history.length < 10) return 1.3; // safe default

    let bestT = 1.0;
    let bestNLL = Infinity;

    // Grid search T in [0.5, 3.0]
    for (let T = 0.5; T <= 3.0; T += 0.05) {
        let nll = 0;
        for (const { prob, outcome } of history) {
            const p = Math.max(0.001, Math.min(0.999, temperatureScale(prob, T)));
            nll -= outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p);
        }
        if (nll < bestNLL) {
            bestNLL = nll;
            bestT = T;
        }
    }
    return parseFloat(bestT.toFixed(3));
}

/**
 * Platt Scaling — logistic regression post-calibration.
 * Fits sigmoid parameters A and B from historical picks.
 *
 * @param {Array<{prob: number, outcome: number}>} history
 * @returns {{ A: number, B: number }}
 */
function fitPlatt(history) {
    if (!history || history.length < 10) return { A: 1.0, B: 0.0 };

    // Simple gradient descent to fit P(y=1) = sigmoid(A * logit(p) + B)
    let A = 1.0;
    let B = 0.0;
    const lr = 0.01;
    const iterations = 500;

    for (let iter = 0; iter < iterations; iter++) {
        let dA = 0;
        let dB = 0;
        for (const { prob, outcome } of history) {
            const p = Math.max(0.001, Math.min(0.999, prob));
            const logit = Math.log(p / (1 - p));
            const pred = 1 / (1 + Math.exp(-(A * logit + B)));
            const err = pred - outcome;
            dA += err * logit;
            dB += err;
        }
        A -= lr * dA / history.length;
        B -= lr * dB / history.length;
    }
    return { A: parseFloat(A.toFixed(4)), B: parseFloat(B.toFixed(4)) };
}

/**
 * Apply Platt scaling to a raw probability.
 */
function plattScale(rawProb, A, B) {
    if (rawProb <= 0) return 0.001;
    if (rawProb >= 1) return 0.999;
    const p = Math.max(0.001, Math.min(0.999, rawProb));
    const logit = Math.log(p / (1 - p));
    return 1 / (1 + Math.exp(-(A * logit + B)));
}

/**
 * Isotonic Regression via histogram binning (10 bins).
 * Groups predictions by probability range, replaces each bin's probability
 * with the empirical frequency in that bin.
 *
 * @param {Array<{prob: number, outcome: number}>} history
 * @returns {Array<{binMin: number, binMax: number, calibratedProb: number, count: number}>}
 */
function fitIsotonicBins(history, nBins = 10) {
    if (!history || history.length < 10) return null;

    const bins = [];
    for (let i = 0; i < nBins; i++) {
        bins.push({ binMin: i / nBins, binMax: (i + 1) / nBins, wins: 0, count: 0 });
    }

    for (const { prob, outcome } of history) {
        const binIdx = Math.min(nBins - 1, Math.floor(prob * nBins));
        bins[binIdx].count++;
        bins[binIdx].wins += outcome;
    }

    return bins.map(b => ({
        ...b,
        calibratedProb: b.count > 0 ? b.wins / b.count : (b.binMin + b.binMax) / 2
    }));
}

/**
 * Apply isotonic regression calibration to a raw probability.
 */
function isotonicScale(rawProb, bins) {
    if (!bins) return rawProb;
    const bin = bins.find(b => rawProb >= b.binMin && rawProb < b.binMax);
    if (!bin) return bins[bins.length - 1].calibratedProb;
    return bin.calibratedProb;
}

/**
 * Brier Score — measures accuracy of probability predictions.
 * Lower is better. Perfect: 0. Worst: 1.
 *
 * @param {Array<{prob: number, outcome: number}>} history
 * @returns {number}
 */
function brierScore(history) {
    if (!history || history.length === 0) return 1.0;
    const sum = history.reduce((acc, { prob, outcome }) => {
        return acc + Math.pow(prob - outcome, 2);
    }, 0);
    return parseFloat((sum / history.length).toFixed(4));
}

/**
 * Expected Calibration Error (ECE) — average absolute deviation between
 * predicted probability and empirical frequency across bins.
 *
 * @param {Array<{prob: number, outcome: number}>} history
 * @param {number} nBins
 * @returns {number}
 */
function expectedCalibrationError(history, nBins = 10) {
    if (!history || history.length === 0) return 1.0;

    const bins = [];
    for (let i = 0; i < nBins; i++) {
        bins.push({ probSum: 0, outcomes: 0, count: 0 });
    }

    for (const { prob, outcome } of history) {
        const binIdx = Math.min(nBins - 1, Math.floor(prob * nBins));
        bins[binIdx].probSum += prob;
        bins[binIdx].outcomes += outcome;
        bins[binIdx].count++;
    }

    let ece = 0;
    for (const bin of bins) {
        if (bin.count === 0) continue;
        const avgProb = bin.probSum / bin.count;
        const empiricalFreq = bin.outcomes / bin.count;
        ece += (bin.count / history.length) * Math.abs(avgProb - empiricalFreq);
    }
    return parseFloat(ece.toFixed(4));
}

/**
 * Generate reliability diagram data for visualization.
 *
 * @param {Array<{prob: number, outcome: number}>} history
 * @param {number} nBins
 * @returns {Array<{binCenter: number, empiricalFreq: number, count: number}>}
 */
function reliabilityDiagram(history, nBins = 10) {
    if (!history || history.length === 0) return [];
    const bins = fitIsotonicBins(history, nBins);
    if (!bins) return [];
    return bins
        .filter(b => b.count > 0)
        .map(b => ({
            binCenter: parseFloat(((b.binMin + b.binMax) / 2).toFixed(2)),
            empiricalFreq: parseFloat(b.calibratedProb.toFixed(3)),
            count: b.count
        }));
}

/**
 * Master calibration function.
 * Reads historical settled picks from DB and computes calibration parameters.
 *
 * @param {object} db - better-sqlite3 DB instance
 * @param {string} pickType - 'ai_best_pick' | 'safest' | 'high_value'
 * @param {number} lookback - how many settled bets to use
 * @returns {object} CalibrationParams
 */
function computeCalibrationParams(db, pickType = 'ai_best_pick', lookback = 300) {
    let history = [];
    try {
        const rows = db.prepare(`
            SELECT probability, status
            FROM ai_best_picks_history
            WHERE status IN ('won', 'lost') AND pick_type = ?
            ORDER BY id DESC LIMIT ?
        `).all(pickType, lookback);

        history = rows.map(r => ({
            prob: Math.max(0.001, Math.min(0.999, (r.probability || 50) / 100),),
            outcome: r.status === 'won' ? 1 : 0
        }));
    } catch (e) {
        // DB may not have enough data yet
    }

    const T = fitTemperature(history);
    const platt = fitPlatt(history);
    const isotonic = fitIsotonicBins(history);
    const brier = brierScore(history);
    const ece = expectedCalibrationError(history);
    const diagram = reliabilityDiagram(history);

    return {
        T,
        platt,
        isotonic,
        brier,
        ece,
        diagram,
        sampleSize: history.length
    };
}

/**
 * Apply all three calibration methods and return a blended calibrated probability.
 * Blend: 40% Temperature, 30% Platt, 30% Isotonic.
 *
 * @param {number} rawProbPercent - raw probability as percentage (0–100)
 * @param {object} params - CalibrationParams from computeCalibrationParams()
 * @returns {{ calibratedProb: number, temperatureProb: number, plattProb: number, isotonicProb: number }}
 */
function applyCalibration(rawProbPercent, params) {
    const rawProb = Math.max(0.001, Math.min(0.999, rawProbPercent / 100));

    const tempProb = temperatureScale(rawProb, params.T || 1.3);
    const plattProb = plattScale(rawProb, (params.platt || {}).A || 1.0, (params.platt || {}).B || 0.0);
    const isoProb = params.isotonic ? isotonicScale(rawProb, params.isotonic) : rawProb;

    // Blended output
    const calibratedProb = 0.4 * tempProb + 0.3 * plattProb + 0.3 * isoProb;

    return {
        calibratedProb: Math.max(0.001, Math.min(0.999, calibratedProb)),
        temperatureProb: tempProb,
        plattProb,
        isotonicProb: isoProb
    };
}

module.exports = {
    temperatureScale,
    fitTemperature,
    fitPlatt,
    plattScale,
    fitIsotonicBins,
    isotonicScale,
    brierScore,
    expectedCalibrationError,
    reliabilityDiagram,
    computeCalibrationParams,
    applyCalibration
};
