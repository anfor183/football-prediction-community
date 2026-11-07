/**
 * backtest_engine.js — Module 12: Walk-Forward Backtesting
 *
 * Evaluates recommendation engine performance using time-series validation only.
 * Never uses random train/test splits.
 *
 * Techniques:
 *   - Rolling window walk-forward
 *   - Time-series cross-validation
 *   - Monte Carlo simulation (bootstrap confidence intervals)
 *   - Per-season ROI tracking
 *   - Drawdown curve generation
 */

'use strict';

const Database = require('better-sqlite3');
const { predictFromRows } = require('./ml_predictor');
const {
    calculateEV,
    getMarketMetrics,
    getLeagueMetrics,
    getMarketPenalty,
    getOddsIntelligence,
    scoreCandidate,
    selectSafestPick,
    selectHighValuePick,
    selectHighRiskPick,
    enrichCandidate,
    extractLeagueName,
    calculateDisplayedConfidence,
    getMarketReliabilityScore
} = require('./recommendation_engine');
const { applyCalibration } = require('./calibration');

const ALL_MARKETS_LIST = [
    { key: 'homeWinProb',  label: 'Home Win' },
    { key: 'awayWinProb',  label: 'Away Win' },
    { key: 'drawProb',     label: 'Draw' },
    { key: 'over15Prob',   label: 'Over 1.5 Goals' },
    { key: 'over25Prob',   label: 'Over 2.5 Goals' },
    { key: 'over35Prob',   label: 'Over 3.5 Goals' },
    { key: 'under25Prob',  label: 'Under 2.5 Goals' },
    { key: 'ggProb',       label: 'Both Teams to Score (GG)' },
    { key: 'dnbHomeProb',  label: 'Home Draw No Bet' },
    { key: 'dnbAwayProb',  label: 'Away Draw No Bet' }
];

function checkBetResult(market, hs, as_) {
    if (hs === null || as_ === null) return 'void';
    const total = hs + as_;
    if (market === 'Home Win') return hs > as_ ? 'won' : 'lost';
    if (market === 'Away Win') return as_ > hs ? 'won' : 'lost';
    if (market === 'Draw') return hs === as_ ? 'won' : 'lost';
    if (market === 'Over 1.5 Goals') return total > 1.5 ? 'won' : 'lost';
    if (market === 'Over 2.5 Goals') return total > 2.5 ? 'won' : 'lost';
    if (market === 'Over 3.5 Goals') return total > 3.5 ? 'won' : 'lost';
    if (market === 'Under 2.5 Goals') return total < 2.5 ? 'won' : 'lost';
    if (market === 'Both Teams to Score (GG)') return hs > 0 && as_ > 0 ? 'won' : 'lost';
    if (market === 'Home Draw No Bet') {
        if (hs === as_) return 'void';
        return hs > as_ ? 'won' : 'lost';
    }
    if (market === 'Away Draw No Bet') {
        if (hs === as_) return 'void';
        return as_ > hs ? 'won' : 'lost';
    }
    return 'void';
}

/**
 * Run a walk-forward backtest of the recommendation engine.
 *
 * @param {string} dbPath - path to the SQLite database
 * @param {string} provider - 'bet9ja' | 'sportybet'
 * @param {object} options
 * @param {object} options.evThresholds - { safest: 2, highValue: 5, highRisk: 8 }
 * @param {number} options.decayRate - ML decay rate
 * @param {function} options.onProgress - optional progress callback(pct)
 * @returns {object} BacktestResult
 */
function runWalkForwardBacktest(dbPath, provider = 'bet9ja', options = {}) {
    const {
        evThresholds = { safest: 2, highValue: 5, highRisk: 8 },
        decayRate = 0.015,
        onProgress = null
    } = options;

    if (!require('fs').existsSync(dbPath)) {
        return { success: false, error: 'Database not found' };
    }

    const db = new Database(dbPath, { readonly: true });
    const tableName = provider === 'sportybet' ? 'sporty_fixtures' : 'fixtures';

    let allMatches = [];
    try {
        allMatches = db.prepare(`SELECT * FROM ${tableName} ORDER BY id ASC`).all();
    } catch (e) {
        db.close();
        return { success: false, error: e.message };
    }
    db.close();

    // Build season map
    const seasonsMap = {};
    for (const m of allMatches) {
        if (!m.season_name) continue;
        if (!seasonsMap[m.season_name]) seasonsMap[m.season_name] = [];
        seasonsMap[m.season_name].push(m);
    }

    const seasonNames = Object.keys(seasonsMap).sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return na - nb;
    });

    // Use last 8 seasons for backtest (or all if fewer)
    const backtestSeasons = seasonNames.slice(-8);

    const simDb = new Database(':memory:');
    simDb.exec(`
        CREATE TABLE ai_best_picks_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            pick_type TEXT,
            home_team TEXT, away_team TEXT,
            market TEXT,
            probability REAL, implied_odd REAL,
            status TEXT,
            ev_score REAL, calibrated_prob REAL,
            recommendation_score REAL, penalty_multiplier REAL,
            agreement_score REAL, league_roi REAL, market_roi REAL,
            displayed_confidence REAL
        );
    `);

    const results = {
        safest: { bets: 0, profit: 0, wins: 0, curve: [] },
        high_value: { bets: 0, profit: 0, wins: 0, curve: [] },
        ai_best_pick: { bets: 0, profit: 0, wins: 0, curve: [] },
        overall: { bets: 0, profit: 0, wins: 0, curve: [] }
    };

    const seasonResults = [];
    const totalSeasons = backtestSeasons.length;

    // Minimal calibration params (will use defaults until enough data)
    const calibParams = { T: 1.3, platt: { A: 1.0, B: 0.0 }, isotonic: null };

    for (let sIdx = 0; sIdx < backtestSeasons.length; sIdx++) {
        const seasonName = backtestSeasons[sIdx];
        const seasonMatches = seasonsMap[seasonName];
        if (onProgress) onProgress(Math.round((sIdx / totalSeasons) * 100));

        // Get unique rounds sorted by first match ID
        const roundTimes = [...new Set(seasonMatches.map(m => m.match_time))].sort((a, b) => {
            const minA = seasonMatches.filter(m => m.match_time === a).reduce((min, m) => m.id < min ? m.id : min, Infinity);
            const minB = seasonMatches.filter(m => m.match_time === b).reduce((min, m) => m.id < min ? m.id : min, Infinity);
            return minA - minB;
        });

        const seasonStats = { seasonName, bets: 0, profit: 0, wins: 0 };

        for (let rIdx = 0; rIdx < roundTimes.length; rIdx++) {
            const time = roundTimes[rIdx];
            const roundMatches = seasonMatches.filter(m => m.match_time === time);
            const roundNumber = rIdx + 1;

            // Build training data (all matches before this round)
            const firstId = roundMatches.reduce((min, m) => m.id < min ? m.id : min, Infinity);
            const trainingRows = allMatches.filter(m => m.id < firstId).slice(-10000);
            if (trainingRows.length < 5) continue;

            // Collect candidates across all match + market combinations
            const allCandidates = { safest: [], high_value: [], ai_best_pick: [] };

            for (const match of roundMatches) {
                const pred = predictFromRows(trainingRows, match.home_team, match.away_team, decayRate);
                if (!pred) continue;

                const probs = {
                    homeWinProb: Math.round(pred.homeWinProb * 100),
                    awayWinProb: Math.round(pred.awayWinProb * 100),
                    drawProb: Math.round(pred.drawProb * 100),
                    over15Prob: Math.round(pred.over15 * 100),
                    over25Prob: Math.round(pred.over25 * 100),
                    over35Prob: Math.round(pred.over35 * 100),
                    under25Prob: Math.round((1 - pred.over25) * 100),
                    ggProb: Math.round(pred.gg * 100),
                    dnbHomeProb: Math.round((pred.homeWinProb / Math.max(0.001, pred.homeWinProb + pred.awayWinProb)) * 100),
                    dnbAwayProb: Math.round((pred.awayWinProb / Math.max(0.001, pred.homeWinProb + pred.awayWinProb)) * 100)
                };

                for (const mkt of ALL_MARKETS_LIST) {
                    const prob = probs[mkt.key] || 0;
                    if (prob < 5) continue;

                    const impliedOdd = parseFloat((100 / prob).toFixed(2));
                    const calibResult = applyCalibration(prob, calibParams);
                    const calibratedProbDecimal = calibResult.calibratedProb;
                    const evResult = calculateEV(calibratedProbDecimal, impliedOdd);

                    // Get penalty from simulated DB
                    const penaltyResult = getMarketPenalty(simDb, mkt.label, 'ai_best_pick');

                    const candidate = {
                        market: mkt.label,
                        prob,
                        impliedOdd,
                        odds: impliedOdd,
                        calibratedProbDecimal,
                        evPct: evResult.evPct,
                        fairOdds: evResult.fairOdds,
                        marketROI: 0,
                        leagueROI: 0,
                        agreementScore: 0.5,
                        oddsReliabilityScore: 1.0,
                        penaltyMultiplier: penaltyResult.penaltyMultiplier,
                        isDrifting: penaltyResult.isDrifting,
                        streakLength: penaltyResult.streakLength,
                        recentFormScore: 0.5,
                        match,
                        seasonName
                    };
                    candidate.recommendationScore = scoreCandidate(candidate);

                    allCandidates.safest.push(candidate);
                    allCandidates.high_value.push(candidate);
                    allCandidates.ai_best_pick.push(candidate);
                }
            }

            // Select picks via three independent pipelines
            const picks = [
                ['safest', selectSafestPick(allCandidates.safest, evThresholds.safest)],
                ['high_value', selectHighValuePick(allCandidates.high_value, evThresholds.highValue)],
                ['ai_best_pick', selectHighRiskPick(allCandidates.ai_best_pick, evThresholds.highRisk)]
            ];

            for (const [pickType, pick] of picks) {
                if (!pick) continue;

                const outcome = checkBetResult(
                    pick.market,
                    pick.match.home_score,
                    pick.match.away_score
                );
                if (outcome === 'void') continue;

                const won = outcome === 'won';
                const odd = pick.impliedOdd;
                const pickProfit = won ? (odd * 0.85 - 1) : -1; // apply 15% juice like existing code

                results[pickType].bets++;
                results[pickType].profit += pickProfit;
                if (won) results[pickType].wins++;
                results[pickType].curve.push({ round: `${seasonName}:${roundNumber}`, profit: results[pickType].profit, won });

                results.overall.bets++;
                results.overall.profit += pickProfit;
                if (won) results.overall.wins++;
                results.overall.curve.push({ round: `${seasonName}:${roundNumber}`, profit: results.overall.profit, won });

                seasonStats.bets++;
                seasonStats.profit += pickProfit;
                if (won) seasonStats.wins++;

                // Record in simulated DB for future rounds' learning
                simDb.prepare(`
                    INSERT OR IGNORE INTO ai_best_picks_history
                    (season_name, round_number, pick_type, home_team, away_team, market,
                     probability, implied_odd, status, ev_score, calibrated_prob, recommendation_score, penalty_multiplier)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    seasonName, roundNumber, pickType,
                    pick.match.home_team, pick.match.away_team,
                    pick.market, pick.prob, pick.impliedOdd, outcome,
                    pick.evPct, pick.calibratedProbDecimal * 100,
                    pick.recommendationScore, pick.penaltyMultiplier
                );
            }
        }

        seasonStats.roi = seasonStats.bets > 0 ? parseFloat(((seasonStats.profit / seasonStats.bets) * 100).toFixed(2)) : 0;
        seasonStats.winRate = seasonStats.bets > 0 ? parseFloat(((seasonStats.wins / seasonStats.bets) * 100).toFixed(1)) : 0;
        seasonResults.push(seasonStats);
    }

    simDb.close();

    // Compute summary stats
    const summary = {};
    for (const [pt, r] of Object.entries(results)) {
        const roi = r.bets > 0 ? (r.profit / r.bets) * 100 : 0;
        const winRate = r.bets > 0 ? (r.wins / r.bets) * 100 : 0;

        // Max drawdown from curve
        let peak = 0, maxDD = 0, running = 0;
        for (const pt of r.curve) {
            running = pt.profit;
            if (running > peak) peak = running;
            const dd = peak - running;
            if (dd > maxDD) maxDD = dd;
        }

        summary[pt] = {
            bets: r.bets,
            profit: parseFloat(r.profit.toFixed(2)),
            roi: parseFloat(roi.toFixed(2)),
            winRate: parseFloat(winRate.toFixed(1)),
            maxDrawdown: parseFloat(maxDD.toFixed(2))
        };
    }

    // Monte Carlo bootstrap CI (1000 resamples of overall picks)
    const ci = monteCarloCI(results.overall.curve, 1000);

    return {
        success: true,
        provider,
        evThresholds,
        seasonsBacktested: backtestSeasons.length,
        seasonResults,
        summary,
        monteCarloCI: ci,
        overall: summary.overall
    };
}

/**
 * Bootstrap Monte Carlo confidence intervals for ROI.
 */
function monteCarloCI(curve, nResamples = 1000) {
    if (!curve || curve.length < 5) return { p5: null, p50: null, p95: null };

    const returns = curve.map(c => c.won ? 1 : -1);
    const n = returns.length;
    const simROIs = [];

    for (let i = 0; i < nResamples; i++) {
        let profit = 0;
        for (let j = 0; j < n; j++) {
            profit += returns[Math.floor(Math.random() * n)];
        }
        simROIs.push((profit / n) * 100);
    }

    simROIs.sort((a, b) => a - b);
    return {
        p5: parseFloat(simROIs[Math.floor(nResamples * 0.05)].toFixed(2)),
        p50: parseFloat(simROIs[Math.floor(nResamples * 0.5)].toFixed(2)),
        p95: parseFloat(simROIs[Math.floor(nResamples * 0.95)].toFixed(2)),
        mean: parseFloat((simROIs.reduce((a, b) => a + b) / nResamples).toFixed(2))
    };
}

module.exports = {
    runWalkForwardBacktest,
    monteCarloCI,
    checkBetResult
};
