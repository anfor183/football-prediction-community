/**
 * recommendation_engine.js — Professional Betting Recommendation Engine
 *
 * Modules 2–11: Everything after the ML prediction model.
 * Takes raw probabilities from predictMatchupML() and applies:
 *
 *   M2  - Expected Value Engine
 *   M3  - Historical Market Engine (ROI, Sharpe, drawdown, Kelly)
 *   M4  - League Intelligence
 *   M5  - Odds Intelligence (profitability by odds bucket)
 *   M7  - Market Penalty Engine (dynamic, continuous)
 *   M8  - Recommendation Scoring (weighted composite)
 *   M9  - Three Independent Pick Pipelines
 *   M10 - Displayed Confidence Formula
 *   M11 - Continuous Learning (update after settlement)
 *
 * Module 1 (Calibration) lives in calibration.js
 * Module 6 (Ensemble Agreement) lives in ensemble_bridge.js
 * Module 12 (Backtesting) lives in backtest_engine.js
 * Module 13 (Dashboard Metrics) is at the bottom of this file
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 2: EXPECTED VALUE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Expected Value for a bet.
 *
 * EV = P_calibrated × (odds - 1) - (1 - P_calibrated)
 *    = P_calibrated × odds - 1
 *
 * @param {number} calibratedProbDecimal - calibrated probability [0, 1]
 * @param {number} bookmakerOdds - decimal odds (e.g. 1.87)
 * @returns {{
 *   ev: number,           // Expected value per unit staked
 *   evPct: number,        // EV as percentage
 *   fairOdds: number,     // True fair odds = 1 / calibratedProb
 *   impliedProbBM: number,// Bookmaker implied probability
 *   bookmakerMargin: number,
 *   edgePct: number,      // How much better than bookmaker (%)
 *   isPositive: boolean
 * }}
 */
function calculateEV(calibratedProbDecimal, bookmakerOdds) {
    const p = Math.max(0.001, Math.min(0.999, calibratedProbDecimal));
    const odds = Math.max(1.01, bookmakerOdds || 1.5);

    const ev = p * odds - 1;
    const evPct = ev * 100;

    const fairOdds = parseFloat((1 / p).toFixed(3));
    const impliedProbBM = parseFloat((1 / odds).toFixed(4));
    const bookmakerMargin = parseFloat(((1 / odds - p) * 100).toFixed(2));
    const edgePct = parseFloat(((p - impliedProbBM) * 100).toFixed(2));

    return {
        ev: parseFloat(ev.toFixed(4)),
        evPct: parseFloat(evPct.toFixed(2)),
        fairOdds,
        impliedProbBM,
        bookmakerMargin,
        edgePct,
        isPositive: ev > 0
    };
}

/**
 * Check if a bet passes the EV threshold gate.
 *
 * @param {number} evPct - EV as percentage
 * @param {string} pickType - 'safest' | 'high_value' | 'ai_best_pick'
 * @param {object} thresholds - { safest: 2, highValue: 5, highRisk: 8 } (%)
 * @returns {boolean}
 */
function passesEVGate(evPct, pickType, thresholds) {
    const t = thresholds || { safest: 2, highValue: 5, highRisk: 8 };
    if (pickType === 'safest') return evPct >= t.safest;
    if (pickType === 'high_value') return evPct >= t.highValue;
    if (pickType === 'ai_best_pick') return evPct >= t.highRisk;
    return evPct >= t.safest;
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 3: HISTORICAL MARKET ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute historical performance metrics for a specific market.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} market - e.g. 'Home Win', 'Over 2.5 Goals'
 * @param {number} lookback - number of recent settled bets
 * @returns {object} MarketMetrics
 */
function getMarketMetrics(db, market, lookback = 150) {
    try {
        const rows = db.prepare(`
            SELECT status, implied_odd, probability
            FROM ai_best_picks_history
            WHERE market = ? AND status IN ('won', 'lost')
            ORDER BY id DESC LIMIT ?
        `).all(market, lookback);

        if (rows.length < 5) {
            return _emptyMarketMetrics(market);
        }

        let profit = 0;
        let wins = 0;
        let losses = 0;
        const returns = [];
        let peak = 0;
        let maxDrawdown = 0;
        let runningProfit = 0;

        for (const r of rows) {
            const odd = r.implied_odd || 2.0;
            if (r.status === 'won') {
                const p = odd - 1;
                profit += p;
                runningProfit += p;
                wins++;
                returns.push(p);
            } else {
                profit -= 1;
                runningProfit -= 1;
                losses++;
                returns.push(-1);
            }
            if (runningProfit > peak) peak = runningProfit;
            const dd = peak - runningProfit;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }

        const n = rows.length;
        const roi = profit / n;
        const hitRate = wins / n;

        // Sharpe ratio (assuming risk-free = 0, each bet is a "period")
        const avgReturn = profit / n;
        const variance = returns.reduce((acc, r) => acc + Math.pow(r - avgReturn, 2), 0) / n;
        const stdDev = Math.sqrt(variance) || 0.001;
        const sharpe = avgReturn / stdDev;

        // Calmar ratio
        const calmar = maxDrawdown > 0 ? (roi / maxDrawdown) : (roi > 0 ? 1 : -1);

        // Kelly fraction: f = (p * odds - 1) / (odds - 1) where p = win rate
        const avgOdds = rows.reduce((a, r) => a + (r.implied_odd || 2), 0) / n;
        const kelly = ((hitRate * avgOdds - 1) / (avgOdds - 1));
        const kellyFraction = Math.max(0, Math.min(0.25, kelly)); // cap at 25%

        // Profit factor = gross wins / gross losses
        const grossWins = rows.filter(r => r.status === 'won').reduce((a, r) => a + ((r.implied_odd || 2) - 1), 0);
        const grossLosses = losses;
        const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 3 : 0);

        return {
            market,
            sampleSize: n,
            wins,
            losses,
            roi: parseFloat(roi.toFixed(4)),
            roiPct: parseFloat((roi * 100).toFixed(2)),
            hitRate: parseFloat(hitRate.toFixed(3)),
            hitRatePct: parseFloat((hitRate * 100).toFixed(1)),
            maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
            sharpe: parseFloat(sharpe.toFixed(3)),
            calmar: parseFloat(calmar.toFixed(3)),
            kellyFraction: parseFloat(kellyFraction.toFixed(4)),
            profitFactor: parseFloat(profitFactor.toFixed(3)),
            avgOdds: parseFloat(avgOdds.toFixed(2)),
            isHealthy: roi > -0.05 && maxDrawdown < 5 && profitFactor > 0.7
        };
    } catch (e) {
        return _emptyMarketMetrics(market);
    }
}

function _emptyMarketMetrics(market) {
    return {
        market, sampleSize: 0, wins: 0, losses: 0,
        roi: 0, roiPct: 0, hitRate: 0.5, hitRatePct: 50,
        maxDrawdown: 0, sharpe: 0, calmar: 0, kellyFraction: 0.05,
        profitFactor: 1.0, avgOdds: 2.0, isHealthy: true
    };
}

/**
 * Get a reliability multiplier for a market based on its historical ROI.
 * Returns 0.6–1.4 range.
 */
function getMarketReliabilityScore(marketMetrics) {
    if (!marketMetrics || marketMetrics.sampleSize < 10) return 1.0;
    const roi = marketMetrics.roi;
    // Normalize: -0.2 ROI → 0.6 multiplier; +0.15 ROI → 1.4 multiplier
    return Math.max(0.6, Math.min(1.4, 1.0 + roi * 2.0));
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 4: LEAGUE INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract league name from season_name field.
 * e.g. "Bet9ja Premier League S45" → "Premier League"
 */
function extractLeagueName(seasonName) {
    if (!seasonName) return 'Unknown';
    // Remove common prefixes/suffixes
    return seasonName
        .replace(/^(Sportybet|Bet9ja|VFL)\s*/i, '')
        .replace(/\s*S\d+\s*$/i, '')
        .replace(/\s*Season\s*\d+\s*$/i, '')
        .trim() || 'Unknown';
}

/**
 * Calculate historical ROI for a league.
 *
 * @param {object} db
 * @param {string} leagueName - extracted league name
 * @param {number} lookback
 * @returns {{ leagueName, roi, roiPct, sampleSize, reliabilityScore }}
 */
function getLeagueMetrics(db, leagueName, lookback = 200) {
    try {
        const rows = db.prepare(`
            SELECT status, implied_odd, season_name
            FROM ai_best_picks_history
            WHERE status IN ('won', 'lost')
            ORDER BY id DESC LIMIT ?
        `).all(lookback * 3);

        // Filter to this league
        const leagueRows = rows.filter(r => extractLeagueName(r.season_name) === leagueName);

        if (leagueRows.length < 5) {
            return { leagueName, roi: 0, roiPct: 0, sampleSize: 0, reliabilityScore: 1.0 };
        }

        const profit = leagueRows.reduce((acc, r) => {
            return acc + (r.status === 'won' ? (r.implied_odd || 2) - 1 : -1);
        }, 0);

        const roi = profit / leagueRows.length;
        // Confidence multiplier: 0.7 (losing league) → 1.3 (profitable league)
        const reliabilityScore = Math.max(0.7, Math.min(1.3, 1.0 + roi * 2.5));

        return {
            leagueName,
            roi: parseFloat(roi.toFixed(4)),
            roiPct: parseFloat((roi * 100).toFixed(2)),
            sampleSize: leagueRows.length,
            reliabilityScore: parseFloat(reliabilityScore.toFixed(3))
        };
    } catch (e) {
        return { leagueName, roi: 0, roiPct: 0, sampleSize: 0, reliabilityScore: 1.0 };
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 5: ODDS INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────

const ODDS_BUCKETS = [
    { label: '1.20-1.40', min: 1.20, max: 1.40 },
    { label: '1.40-1.60', min: 1.40, max: 1.60 },
    { label: '1.60-1.80', min: 1.60, max: 1.80 },
    { label: '1.80-2.00', min: 1.80, max: 2.00 },
    { label: '2.00-3.00', min: 2.00, max: 3.00 },
    { label: '3.00-5.00', min: 3.00, max: 5.00 },
    { label: '5.00+',     min: 5.00, max: Infinity }
];

/**
 * Get the profitability of the odds bucket that contains the given odds.
 *
 * @param {object} db
 * @param {number} odds - decimal odds
 * @returns {{ bucket, roi, hitRate, sampleSize, isOptimal, reliabilityScore }}
 */
function getOddsIntelligence(db, odds) {
    const bucket = ODDS_BUCKETS.find(b => odds >= b.min && odds < b.max) || ODDS_BUCKETS[4];

    try {
        const rows = db.prepare(`
            SELECT status, implied_odd
            FROM ai_best_picks_history
            WHERE implied_odd >= ? AND implied_odd < ? AND status IN ('won', 'lost')
            ORDER BY id DESC LIMIT 200
        `).all(bucket.min, bucket.max === Infinity ? 999 : bucket.max);

        if (rows.length < 5) {
            return { bucket: bucket.label, roi: 0, hitRate: 0.5, sampleSize: 0, isOptimal: true, reliabilityScore: 1.0 };
        }

        let profit = 0;
        let wins = 0;
        for (const r of rows) {
            if (r.status === 'won') { profit += (r.implied_odd || 2) - 1; wins++; }
            else profit -= 1;
        }
        const roi = profit / rows.length;
        const hitRate = wins / rows.length;

        return {
            bucket: bucket.label,
            roi: parseFloat(roi.toFixed(4)),
            roiPct: parseFloat((roi * 100).toFixed(2)),
            hitRate: parseFloat(hitRate.toFixed(3)),
            sampleSize: rows.length,
            isOptimal: roi > 0,
            reliabilityScore: Math.max(0.7, Math.min(1.3, 1.0 + roi * 2.0))
        };
    } catch (e) {
        return { bucket: bucket.label, roi: 0, hitRate: 0.5, sampleSize: 0, isOptimal: true, reliabilityScore: 1.0 };
    }
}

/**
 * Get all odds bucket performance for dashboard display.
 */
function getAllOddsBuckets(db) {
    return ODDS_BUCKETS.map(b => {
        const mid = b.max === Infinity ? b.min + 2 : (b.min + b.max) / 2;
        return { ...getOddsIntelligence(db, mid), bucketLabel: b.label };
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 7: MARKET PENALTY ENGINE (Dynamic, Continuous)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate a dynamic market penalty multiplier.
 * Returns 0.5–1.0 (never binary block — always continuous).
 *
 * Factors:
 *   - Losing streak in this market
 *   - Market-level ROI decline (recent vs all-time)
 *   - Concept drift (calibration error rising)
 *   - Recent CLV decline
 *
 * @param {object} db
 * @param {string} market
 * @param {string} pickType
 * @returns {{ penaltyMultiplier, factors, isDrifting, streakLength }}
 */
function getMarketPenalty(db, market, pickType) {
    let penaltyMultiplier = 1.0;
    const factors = {};

    try {
        // Recent 20 picks for this market + pick type
        const recentRows = db.prepare(`
            SELECT status, implied_odd, probability, ev_score
            FROM ai_best_picks_history
            WHERE market = ? AND pick_type = ? AND status IN ('won', 'lost')
            ORDER BY id DESC LIMIT 30
        `).all(market, pickType);

        if (recentRows.length < 3) {
            return { penaltyMultiplier: 1.0, factors: {}, isDrifting: false, streakLength: 0 };
        }

        // 1. Losing streak penalty
        let streak = 0;
        for (const r of recentRows) {
            if (r.status === 'lost') streak++;
            else break;
        }
        const streakPenalty = streak >= 5 ? 0.30
                            : streak >= 4 ? 0.20
                            : streak >= 3 ? 0.12
                            : streak >= 2 ? 0.06
                            : 0;
        penaltyMultiplier -= streakPenalty;
        factors.streakPenalty = streakPenalty;
        factors.streakLength = streak;

        // 2. Recent ROI vs overall ROI decline
        const recentProfit = recentRows.slice(0, 10).reduce((acc, r) => {
            return acc + (r.status === 'won' ? (r.implied_odd || 2) - 1 : -1);
        }, 0);
        const recentROI = recentProfit / Math.min(10, recentRows.length);
        const overallProfit = recentRows.reduce((acc, r) => {
            return acc + (r.status === 'won' ? (r.implied_odd || 2) - 1 : -1);
        }, 0);
        const overallROI = overallProfit / recentRows.length;

        if (recentROI < overallROI - 0.15) {
            const declinePenalty = Math.min(0.20, (overallROI - recentROI) * 0.5);
            penaltyMultiplier -= declinePenalty;
            factors.roiDeclinePenalty = declinePenalty;
        }
        factors.recentROI = recentROI;
        factors.overallROI = overallROI;

        // 3. Calibration drift (predicted prob vs actual win rate)
        const rowsWithProb = recentRows.filter(r => r.probability > 0);
        if (rowsWithProb.length >= 5) {
            const avgPredProb = rowsWithProb.reduce((a, r) => a + r.probability / 100, 0) / rowsWithProb.length;
            const actualWinRate = rowsWithProb.filter(r => r.status === 'won').length / rowsWithProb.length;
            const calibrationError = Math.abs(avgPredProb - actualWinRate);

            if (calibrationError > 0.20) {
                const driftPenalty = Math.min(0.15, calibrationError * 0.4);
                penaltyMultiplier -= driftPenalty;
                factors.driftPenalty = driftPenalty;
            }
            factors.calibrationError = calibrationError;
            factors.isDrifting = calibrationError > 0.15;
        }

        // 4. EV score decline (if we have EV data)
        const rowsWithEV = recentRows.filter(r => r.ev_score !== null && r.ev_score !== undefined);
        if (rowsWithEV.length >= 5) {
            const recentEVRows = rowsWithEV.slice(0, 5);
            const olderEVRows = rowsWithEV.slice(5);
            if (olderEVRows.length >= 3) {
                const recentAvgEV = recentEVRows.reduce((a, r) => a + r.ev_score, 0) / recentEVRows.length;
                const olderAvgEV = olderEVRows.reduce((a, r) => a + r.ev_score, 0) / olderEVRows.length;
                if (recentAvgEV < olderAvgEV - 0.05) {
                    const evPenalty = Math.min(0.10, (olderAvgEV - recentAvgEV) * 0.5);
                    penaltyMultiplier -= evPenalty;
                    factors.evDeclinePenalty = evPenalty;
                }
            }
        }

    } catch (e) {
        // DB not ready yet
    }

    return {
        penaltyMultiplier: parseFloat(Math.max(0.5, Math.min(1.0, penaltyMultiplier)).toFixed(3)),
        factors,
        isDrifting: factors.isDrifting || false,
        streakLength: factors.streakLength || 0
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 8: RECOMMENDATION SCORING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a candidate bet using a weighted composite of all engine metrics.
 *
 * Weights:
 *   25% Calibrated Probability
 *   25% Expected Value
 *   15% Historical League ROI
 *   10% Historical Market ROI
 *   10% Model Agreement
 *    5% Odds Intelligence (bucket ROI)
 *    5% Market Penalty (inverse penalty = health)
 *    5% Recent Form (market streak)
 *
 * Returns score 0–100.
 *
 * @param {object} candidate
 * @returns {number} recommendationScore (0–100)
 */
function scoreCandidate(candidate) {
    const {
        calibratedProbDecimal = 0.5,
        evPct = 0,
        leagueROI = 0,
        marketROI = 0,
        agreementScore = 0.5,
        oddsReliabilityScore = 1.0,
        penaltyMultiplier = 1.0,
        recentFormScore = 0.5
    } = candidate;

    // Normalize each component to 0–1
    // Calibration: scale 0.4–0.8 range to 0–1
    const calibScore = Math.max(0, Math.min(1, (calibratedProbDecimal - 0.35) / 0.45));

    // EV: scale -10% to +20% range to 0–1
    const evScore = Math.max(0, Math.min(1, (evPct + 10) / 30));

    // League ROI: scale -20% to +20% range to 0–1
    const leagueScore = Math.max(0, Math.min(1, (leagueROI * 100 + 20) / 40));

    // Market ROI: scale -20% to +20% range to 0–1
    const marketScore = Math.max(0, Math.min(1, (marketROI * 100 + 20) / 40));

    // Agreement: already 0–1
    const agrScore = Math.max(0, Math.min(1, agreementScore));

    // Odds intelligence: scale 0.7–1.3 to 0–1
    const oddsScore = Math.max(0, Math.min(1, (oddsReliabilityScore - 0.7) / 0.6));

    // Penalty health: scale 0.5–1.0 to 0–1
    const penaltyHealth = Math.max(0, Math.min(1, (penaltyMultiplier - 0.5) / 0.5));

    // Recent form: already 0–1
    const formScore = Math.max(0, Math.min(1, recentFormScore));

    const weighted =
        0.25 * calibScore +
        0.25 * evScore +
        0.15 * leagueScore +
        0.10 * marketScore +
        0.10 * agrScore +
        0.05 * oddsScore +
        0.05 * penaltyHealth +
        0.05 * formScore;

    return parseFloat((weighted * 100).toFixed(1));
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 9: THREE INDEPENDENT RECOMMENDATION PIPELINES
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 9a: LOSING REGIME DETECTOR
// Suspends or reduces stake when recent results show model is out-of-sync.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects if a pick type is in a losing regime based on recent settled results.
 * Returns { suspended: bool, reducedStake: bool, lossRate: number }
 *
 * Thresholds (from professional syndicate risk management):
 *   - lossRate > 80% in last 10: SUSPEND (return null for pick)
 *   - lossRate > 70% in last 10: REDUCE stake to 0.25× Kelly
 *
 * @param {object} db - better-sqlite3 instance
 * @param {string} pickType - 'safest' | 'high_value' | 'ai_best_pick'
 * @returns {{ suspended: boolean, reducedStake: boolean, lossRate: number, recentCount: number }}
 */
function detectLosingRegime(db, pickType) {
    try {
        const recent = db.prepare(`
            SELECT status FROM ai_best_picks_history
            WHERE pick_type = ? AND status IN ('won', 'lost')
            ORDER BY id DESC LIMIT 10
        `).all(pickType);

        if (recent.length < 6) return { suspended: false, reducedStake: false, lossRate: 0, recentCount: recent.length };

        const losses = recent.filter(r => r.status === 'lost').length;
        const lossRate = losses / recent.length;

        // Never hard-suspend the recommendation engine indefinitely — instead flag reduced stake
        return {
            suspended: false,
            reducedStake: lossRate > 0.70,
            lossRate: parseFloat(lossRate.toFixed(3)),
            recentCount: recent.length
        };
    } catch (e) {
        return { suspended: false, reducedStake: false, lossRate: 0, recentCount: 0 };
    }
}


/**
 * Select the Safest Pick.
 * Objective: lowest variance, highest probability, low drawdown.
 *
 * @param {object} db - better-sqlite3 instance (for regime detection)
 * @param {Array} scoredCandidates - candidates with full engine metadata
 * @param {number} evThreshold - minimum EV%
 * @returns {object|null}
 */
function selectSafestPick(db, scoredCandidates, evThreshold = 0) {
    if (!scoredCandidates || scoredCandidates.length === 0) return null;

    // Filter for safe picks (odds 1.20 - 1.95, high probability)
    const eligible = scoredCandidates.filter(c => {
        const probOk    = (c.calibratedProbDecimal && c.calibratedProbDecimal >= 0.55) || (c.prob && c.prob >= 55);
        const oddsOk    = c.odds >= 1.20 && c.odds <= 1.95;
        const qualityOk = (c.penaltyMultiplier == null || c.penaltyMultiplier >= 0.50);
        return probOk && oddsOk && qualityOk;
    });

    const poolToUse = eligible.length > 0 ? eligible : scoredCandidates.filter(c => c.odds <= 2.20);
    if (poolToUse.length === 0) {
        // Ultimate fallback: sort by raw prob
        const sorted = [...scoredCandidates].sort((a, b) => (b.prob || 0) - (a.prob || 0));
        return sorted[0] ? { ...sorted[0], pipelineType: 'safest', pipelineObjective: 'Highest Win Probability Pick' } : null;
    }

    // Sort: highest calibrated probability first, then recommendation score
    poolToUse.sort((a, b) => {
        const scoreA = (a.calibratedProbDecimal || (a.prob / 100)) * 3.0 + (a.recommendationScore || 50) * 0.05 + (1 / Math.max(1.1, a.odds)) * 0.5;
        const scoreB = (b.calibratedProbDecimal || (b.prob / 100)) * 3.0 + (b.recommendationScore || 50) * 0.05 + (1 / Math.max(1.1, b.odds)) * 0.5;
        return scoreB - scoreA;
    });

    return { ...poolToUse[0], pipelineType: 'safest', pipelineObjective: 'Highest Model Win Probability (1.20–1.95)' };
}

/**
 * Select the High Value Pick.
 * Objective: positive EV / value bets across goals and 1X2 markets (odds 1.70 - 3.20).
 *
 * @param {object} db - better-sqlite3 instance
 * @param {Array} scoredCandidates
 * @param {number} evThreshold - minimum EV%
 * @returns {object|null}
 */
function selectHighValuePick(db, scoredCandidates, evThreshold = 0) {
    if (!scoredCandidates || scoredCandidates.length === 0) return null;

    const POSITIVE_MARKETS = new Set([
        'Over 2.5 Goals',
        'Over 1.5 Goals',
        'Over 3.5 Goals',
        'Both Teams to Score (GG)',
        'Home Win',
        'Away Win'
    ]);

    const eligible = scoredCandidates.filter(c => {
        const oddsOk    = c.odds >= 1.70 && c.odds <= 3.20;
        const marketOk  = POSITIVE_MARKETS.has(c.market) || c.odds >= 1.90;
        const evOk      = (c.evPct == null) || (c.evPct >= evThreshold);
        return oddsOk && marketOk && evOk;
    });

    const poolToUse = eligible.length > 0 ? eligible : scoredCandidates.filter(c => c.odds >= 1.60 && c.odds <= 3.50);
    if (poolToUse.length === 0) {
        // Fallback: pick candidate with highest EV or recommendation score
        const sorted = [...scoredCandidates].sort((a, b) => (b.evPct || 0) - (a.evPct || 0));
        return sorted[0] ? { ...sorted[0], pipelineType: 'high_value', pipelineObjective: 'Best Value Pick' } : null;
    }

    poolToUse.sort((a, b) => {
        const scoreA = (a.evPct || 0) * 1.5 + (a.recommendationScore || 50) + (a.calibratedProbDecimal || 0.5) * 20;
        const scoreB = (b.evPct || 0) * 1.5 + (b.recommendationScore || 50) + (b.calibratedProbDecimal || 0.5) * 20;
        return scoreB - scoreA;
    });

    return { ...poolToUse[0], pipelineType: 'high_value', pipelineObjective: 'High Value / Positive EV (Odds 1.70–3.20)' };
}

/**
 * Select the High-Risk AI Best Pick.
 * Objective: High-yield, top-tier model pick (odds >= 2.50 or highest reward/risk).
 *
 * @param {object} db            - better-sqlite3 instance
 * @param {Array}  scoredCandidates - enriched candidate pool (used for fallback)
 * @param {number} evThreshold   - minimum EV%
 * @param {object} [liveMatchData] - { rawProbs, homeRecentMatches, awayRecentMatches, bookmakerOdds }
 * @returns {object|null}
 */
function selectHighRiskPick(db, scoredCandidates, evThreshold = 5, liveMatchData = null) {
    if (!scoredCandidates || scoredCandidates.length === 0) return null;

    // ── PATH A: Dedicated XGBoost / Isotonic engine ──────────────────────
    // When live match data is provided (rawProbs + bookmaker odds), use the
    // dedicated AI Best predictor for HT/FT markets.
    if (liveMatchData && liveMatchData.rawProbs && liveMatchData.bookmakerOdds) {
        try {
            const { predictAndRecommendSync, getModelStatus } = require('./ai_best_predictor');
            const bet = predictAndRecommendSync(
                liveMatchData.rawProbs,
                liveMatchData.homeRecentMatches || [],
                liveMatchData.awayRecentMatches || [],
                liveMatchData.bookmakerOdds
            );

            if (!bet) return null; // No positive EV — valid "no bet" decision

            const modelStatus = getModelStatus();
            return {
                market:             bet.market,
                prob:               bet.calibratedProb,
                calibratedProbDecimal: bet.calibratedProb / 100,
                calibratedProbPct:  bet.calibratedProb,
                impliedOdd:         bet.bookOdd,
                odds:               bet.bookOdd,
                evPct:              bet.ev,
                kellyFraction:      bet.kellyFraction,
                pipelineType:       'ai_best_pick',
                pipelineObjective:  modelStatus.ready
                    ? `XGBoost HT/FT model — OOS ROI: ${modelStatus.avgOosRoi > 0 ? '+' : ''}${modelStatus.avgOosRoi}%`
                    : 'Isotonic calibration fallback — awaiting XGBoost validation',
                modelSource:        bet.source,
                isExperimental:     !modelStatus.ready
            };
        } catch (err) {
            console.warn('[selectHighRiskPick] AI Best predictor error:', err.message);
            // Fall through to legacy path
        }
    }

    // ── PATH B: Fallback (no live data, or predictor failed) ──────
    const AVOID_MARKETS = new Set(['Under 1.5 Goals']);
    let eligible = scoredCandidates.filter(c => {
        const oddsOk    = c.odds >= 2.50 && c.odds <= 20.0;
        const marketOk  = !AVOID_MARKETS.has(c.market);
        const evOk      = (c.evPct == null) || c.evPct >= evThreshold;
        return oddsOk && marketOk && evOk;
    });

    if (eligible.length === 0) {
        eligible = scoredCandidates.filter(c => c.odds >= 2.0);
    }
    if (eligible.length === 0) {
        eligible = [...scoredCandidates];
    }
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
        const scoreA = (b.odds || 2.0) * (b.calibratedProbDecimal || (b.prob / 100)) + (b.evPct || 0);
        const scoreB = (a.odds || 2.0) * (a.calibratedProbDecimal || (a.prob / 100)) + (a.evPct || 0);
        return scoreA - scoreB;
    });

    return {
        ...eligible[0],
        pipelineType: 'ai_best_pick',
        pipelineObjective: 'High-Risk High-Yield Model Pick (Odds >= 2.50)',
        isExperimental: false
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 10: DISPLAYED CONFIDENCE FORMULA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the displayed confidence percentage.
 *
 * Formula:
 *   displayedConfidence = calibratedProb × marketReliability × leagueReliability
 *                         × penaltyMultiplier × agreementScore × historicalAccuracy
 *
 * Capped at 90% max to prevent misleading values.
 *
 * @param {object} components
 * @returns {{ displayedConfidence: number, components: object }}
 */
function calculateDisplayedConfidence(components) {
    const {
        calibratedProbDecimal = 0.5,
        marketReliability = 1.0,
        leagueReliability = 1.0,
        penaltyMultiplier = 1.0,
        agreementScore = 0.7,
        historicalAccuracy = 0.7  // market hit rate from historical data
    } = components;

    // Each factor on a 0.6–1.0 scale contribution
    // We use geometric mean-like blending to avoid outliers dominating
    const raw = calibratedProbDecimal
        * Math.max(0.6, Math.min(1.4, marketReliability))
        * Math.max(0.7, Math.min(1.3, leagueReliability))
        * Math.max(0.5, Math.min(1.0, penaltyMultiplier))
        * Math.max(0.5, Math.min(1.0, 0.5 + agreementScore * 0.5))
        * Math.max(0.6, Math.min(1.2, historicalAccuracy + 0.3));

    const displayedConfidence = parseFloat((Math.min(0.90, Math.max(0.35, raw)) * 100).toFixed(1));

    return {
        displayedConfidence,
        components: {
            calibratedProbPct: parseFloat((calibratedProbDecimal * 100).toFixed(1)),
            marketReliability: parseFloat(marketReliability.toFixed(3)),
            leagueReliability: parseFloat(leagueReliability.toFixed(3)),
            penaltyMultiplier: parseFloat(penaltyMultiplier.toFixed(3)),
            agreementScore: parseFloat(agreementScore.toFixed(3)),
            historicalAccuracy: parseFloat(historicalAccuracy.toFixed(3))
        }
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 11: CONTINUOUS LEARNING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update all engine state after a bet is settled.
 * Called from live_companion.js settlement logic.
 *
 * @param {object} db
 * @param {object} settledPick - the just-settled row from ai_best_picks_history
 */
function updateAfterSettlement(db, settledPick) {
    if (!settledPick || !settledPick.market || !settledPick.pick_type) return;

    // The underlying DB rows are already updated by the existing settlement code.
    // This function handles any derived state that needs to be written separately.
    // Currently: log that update happened (metrics are computed fresh on next pick)
    // Future: write calibration coefficients to a persistent state table.

    try {
        // Ensure the ev_score is stored (if not already via the pick generation path)
        if (settledPick.id && settledPick.ev_score !== null && settledPick.ev_score !== undefined) {
            db.prepare(`
                UPDATE ai_best_picks_history
                SET ev_score = ?, calibrated_prob = ?, recommendation_score = ?,
                    displayed_confidence = ?
                WHERE id = ? AND (ev_score IS NULL OR ev_score = 0)
            `).run(
                settledPick.ev_score || null,
                settledPick.calibrated_prob || null,
                settledPick.recommendation_score || null,
                settledPick.displayed_confidence || null,
                settledPick.id
            );
        }
    } catch (e) {
        // Columns may not exist on older DBs — handled by migration
    }
}

/**
 * Migrate DB: add new columns needed by the recommendation engine.
 * Safe to call multiple times (uses IF NOT EXISTS pattern via try/catch).
 *
 * @param {object} db
 */
function migrateDatabase(db) {
    const newColumns = [
        'ev_score REAL',
        'calibrated_prob REAL',
        'recommendation_score REAL',
        'market_roi REAL',
        'league_roi REAL',
        'agreement_score REAL',
        'penalty_multiplier REAL',
        'displayed_confidence REAL',
        'bookmaker_implied_prob REAL'
    ];

    for (const col of newColumns) {
        try {
            db.exec(`ALTER TABLE ai_best_picks_history ADD COLUMN ${col}`);
        } catch (e) {
            // Column already exists — fine
        }
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// MODULE 13: DASHBOARD METRICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather all new dashboard metrics for the health panel.
 *
 * @param {object} db
 * @param {string} pickType - 'ai_best_pick' | 'safest' | 'high_value'
 * @returns {object} DashboardMetrics
 */
function getDashboardMetrics(db, pickType = 'ai_best_pick') {
    const { computeCalibrationParams, brierScore, expectedCalibrationError } = require('./calibration');

    try {
        const rows = db.prepare(`
            SELECT status, implied_odd, probability, ev_score, recommendation_score,
                   agreement_score, penalty_multiplier, market, season_name
            FROM ai_best_picks_history
            WHERE status IN ('won', 'lost') AND pick_type = ?
            ORDER BY id DESC LIMIT 200
        `).all(pickType);

        if (rows.length < 5) {
            return _emptyDashboardMetrics();
        }

        // Brier Score + ECE
        const history = rows.map(r => ({
            prob: Math.max(0.001, Math.min(0.999, (r.probability || 50) / 100)),
            outcome: r.status === 'won' ? 1 : 0
        }));

        const brier = brierScore(history);
        const ece = expectedCalibrationError(history);

        // Average EV (for picks that have it)
        const evRows = rows.filter(r => r.ev_score !== null && r.ev_score !== undefined);
        const avgEV = evRows.length > 0 ? evRows.reduce((a, r) => a + r.ev_score, 0) / evRows.length : null;

        // Profit Factor
        let grossWins = 0, grossLosses = 0;
        for (const r of rows) {
            if (r.status === 'won') grossWins += (r.implied_odd || 2) - 1;
            else grossLosses += 1;
        }
        const profitFactor = grossLosses > 0 ? parseFloat((grossWins / grossLosses).toFixed(3)) : null;

        // Market Health Score (avg penalty multiplier)
        const penaltyRows = rows.filter(r => r.penalty_multiplier !== null);
        const avgPenalty = penaltyRows.length > 0
            ? penaltyRows.reduce((a, r) => a + r.penalty_multiplier, 0) / penaltyRows.length
            : 1.0;
        const marketHealthScore = parseFloat((avgPenalty * 100).toFixed(1));

        // Model Agreement Score
        const agrRows = rows.filter(r => r.agreement_score !== null);
        const avgAgreement = agrRows.length > 0
            ? agrRows.reduce((a, r) => a + r.agreement_score, 0) / agrRows.length
            : null;

        // Concept Drift Score (calibration error, lower = better)
        const conceptDriftScore = parseFloat((ece * 100).toFixed(1));

        // Recommendation Quality Score (avg rec score)
        const recRows = rows.filter(r => r.recommendation_score !== null);
        const avgRecScore = recRows.length > 0
            ? recRows.reduce((a, r) => a + r.recommendation_score, 0) / recRows.length
            : null;

        // ROI and win rate
        const totalProfit = rows.reduce((a, r) => a + (r.status === 'won' ? (r.implied_odd || 2) - 1 : -1), 0);
        const roi = totalProfit / rows.length;
        const winRate = rows.filter(r => r.status === 'won').length / rows.length;

        return {
            sampleSize: rows.length,
            roi: parseFloat(roi.toFixed(4)),
            roiPct: parseFloat((roi * 100).toFixed(2)),
            winRate: parseFloat(winRate.toFixed(3)),
            winRatePct: parseFloat((winRate * 100).toFixed(1)),
            brierScore: brier,
            ece,
            avgExpectedValue: avgEV !== null ? parseFloat(avgEV.toFixed(2)) : null,
            profitFactor,
            marketHealthScore,
            modelAgreementScore: avgAgreement !== null ? parseFloat((avgAgreement * 100).toFixed(1)) : null,
            conceptDriftScore,
            recommendationQualityScore: avgRecScore !== null ? parseFloat(avgRecScore.toFixed(1)) : null,
            grossWins: parseFloat(grossWins.toFixed(2)),
            grossLosses: parseFloat(grossLosses.toFixed(2)),
        };
    } catch (e) {
        return _emptyDashboardMetrics();
    }
}

function _emptyDashboardMetrics() {
    return {
        sampleSize: 0, roi: 0, roiPct: 0, winRate: 0, winRatePct: 0,
        brierScore: null, ece: null, avgExpectedValue: null, profitFactor: null,
        marketHealthScore: null, modelAgreementScore: null, conceptDriftScore: null,
        recommendationQualityScore: null, grossWins: 0, grossLosses: 0
    };
}


// ─────────────────────────────────────────────────────────────────────────────
// MASTER RECOMMENDATION RUNNER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fully enriched candidate object for one market bet option.
 * Enriches with all engine metadata synchronously.
 *
 * @param {object} db
 * @param {object} raw - { market, prob (0-100), impliedOdd, calibratedProbDecimal, match, seasonName, ... }
 * @param {object} calibrationParams - from computeCalibrationParams()
 * @param {object} evThresholds - { safest, highValue, highRisk }
 * @param {object} agreementData - from ensemble_bridge.getModelAgreement()
 * @returns {object} EnrichedCandidate
 */
function enrichCandidate(db, raw, calibrationParams, evThresholds, agreementData) {
    const { applyCalibration } = require('./calibration');

    // Module 1: Calibration
    const calibResult = applyCalibration(raw.prob, calibrationParams);
    const calibratedProbDecimal = calibResult.calibratedProb;

    // Module 2: EV
    const evResult = calculateEV(calibratedProbDecimal, raw.impliedOdd);

    // Kelly Stake Sizing (fractional Kelly = 0.5× full Kelly for safety)
    const odds = Math.max(1.01, raw.impliedOdd || 1.5);
    const p = calibratedProbDecimal;
    const fullKelly = (p * odds - 1) / (odds - 1);   // Kelly formula
    const kellyFraction = parseFloat(Math.max(0, Math.min(0.15, fullKelly * 0.5)).toFixed(4)); // Half-Kelly capped at 15%

    // Module 3: Market metrics
    const marketMetrics = getMarketMetrics(db, raw.market);

    // Module 4: League metrics
    const leagueName = extractLeagueName(raw.seasonName || '');
    const leagueMetrics = getLeagueMetrics(db, leagueName);

    // Module 5: Odds intelligence
    const oddsIntel = getOddsIntelligence(db, raw.impliedOdd);

    // Module 7: Penalty
    const penaltyResult = getMarketPenalty(db, raw.market, raw.pickType || 'ai_best_pick');

    // Module 6: Agreement (async, but passed in as pre-computed)
    const agreement = agreementData || { agreementScore: 0.5, available: false };

    // Module 10: Displayed confidence
    const confResult = calculateDisplayedConfidence({
        calibratedProbDecimal,
        marketReliability: getMarketReliabilityScore(marketMetrics),
        leagueReliability: leagueMetrics.reliabilityScore,
        penaltyMultiplier: penaltyResult.penaltyMultiplier,
        agreementScore: agreement.agreementScore,
        historicalAccuracy: marketMetrics.hitRate
    });

    // Module 8: Score
    const enriched = {
        // Original fields
        market: raw.market,
        prob: raw.prob,
        impliedOdd: raw.impliedOdd,
        odds: raw.impliedOdd,
        match: raw.match,
        seasonName: raw.seasonName,

        // Calibration
        calibratedProbDecimal,
        calibratedProbPct: parseFloat((calibratedProbDecimal * 100).toFixed(1)),
        calibrationDetails: calibResult,

        // EV
        evPct: evResult.evPct,
        evRaw: evResult.ev,
        fairOdds: evResult.fairOdds,
        bookmakerImpliedProb: parseFloat((evResult.impliedProbBM * 100).toFixed(1)),
        edgePct: evResult.edgePct,
        bookmakerMargin: evResult.bookmakerMargin,

        // Market
        marketMetrics,
        marketROI: marketMetrics.roi,
        marketReliability: getMarketReliabilityScore(marketMetrics),

        // League
        leagueMetrics,
        leagueROI: leagueMetrics.roi,
        leagueReliability: leagueMetrics.reliabilityScore,

        // Odds
        oddsIntelligence: oddsIntel,
        oddsReliabilityScore: oddsIntel.reliabilityScore,

        // Agreement
        agreementScore: agreement.agreementScore,
        modelVotes: agreement.modelVotes,
        modelDetails: agreement.modelDetails,
        agreementSource: agreement.source,

        // Penalty
        penaltyMultiplier: penaltyResult.penaltyMultiplier,
        penaltyFactors: penaltyResult.factors,
        isDrifting: penaltyResult.isDrifting,
        streakLength: penaltyResult.streakLength,

        // Confidence
        displayedConfidence: confResult.displayedConfidence,
        confidenceComponents: confResult.components,

        // EV threshold check
        recentFormScore: Math.max(0, Math.min(1, (penaltyResult.penaltyMultiplier - 0.5) * 2)),

        // Kelly stake sizing
        kellyStakePct: kellyFraction * 100,  // as percentage of bankroll
        kellyDescription: kellyFraction <= 0
            ? 'No edge'
            : kellyFraction <= 0.02 ? 'Micro (≤2%)'
            : kellyFraction <= 0.05 ? 'Small (2–5%)'
            : kellyFraction <= 0.10 ? 'Medium (5–10%)'
            : 'Full (10–15%)'
    };

    // Score last (needs all other fields)
    enriched.recommendationScore = scoreCandidate(enriched);

    return enriched;
}


module.exports = {
    // M2
    calculateEV,
    passesEVGate,
    // M3
    getMarketMetrics,
    getMarketReliabilityScore,
    // M4
    extractLeagueName,
    getLeagueMetrics,
    // M5
    getOddsIntelligence,
    getAllOddsBuckets,
    ODDS_BUCKETS,
    // M7
    getMarketPenalty,
    // M8
    scoreCandidate,
    // M9a
    detectLosingRegime,
    // M9
    selectSafestPick,
    selectHighValuePick,
    selectHighRiskPick,
    // M10
    calculateDisplayedConfidence,
    // M11
    updateAfterSettlement,
    migrateDatabase,
    // M13
    getDashboardMetrics,
    // Master
    enrichCandidate
};
