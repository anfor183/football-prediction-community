/**
 * pattern_analyzer.js
 * Deep pattern mining for virtual/simulated football databases.
 * Detects: goal constants, home bias, team strengths, streaks,
 * H2H fixedness, scoreline frequencies, best bets, and model mismatch.
 */

const Database = require('better-sqlite3');
const fs = require('fs');

// ──────────────────────────────────────────────────────────────────────────────
// Poisson helper (reused from ml_predictor)
// ──────────────────────────────────────────────────────────────────────────────
function factorial(n) {
    if (n <= 1) return 1;
    let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}
const poisson = (lam, k) => (Math.pow(lam, k) * Math.exp(-lam)) / factorial(k);

function poissonOver(lam1, lam2, threshold) {
    const max = 8;
    let over = 0;
    for (let h = 0; h <= max; h++) {
        for (let a = 0; a <= max; a++) {
            if (h + a > threshold) over += poisson(lam1, h) * poisson(lam2, a);
        }
    }
    return over;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data loader (supports both fixtures and betting_analytics tables)
// ──────────────────────────────────────────────────────────────────────────────
function loadMatches(db, provider = 'bet9ja') {
    let rows = [];
    const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';
    const tableName = (provider === 'sportybet') ? 'sporty_fixtures' : 'fixtures';

    // Try betting_analytics/sporty_betting_analytics first (richer schema)
    try {
        rows = db.prepare(
            `SELECT home_team, away_team,
                    CAST(home_score AS INTEGER) AS home_score,
                    CAST(away_score AS INTEGER) AS away_score,
                    match_result, gg_ng, total_goals, match_time, season_name, id
             FROM ${viewName}
             WHERE home_score IS NOT NULL AND away_score IS NOT NULL
             ORDER BY id ASC`
        ).all();
    } catch (_) { /* fall through */ }

    // Fallback: fixtures/sporty_fixtures table
    if (rows.length === 0) {
        try {
            rows = db.prepare(
                `SELECT home_team, away_team,
                        CAST(home_score AS INTEGER) AS home_score,
                        CAST(away_score AS INTEGER) AS away_score,
                        NULL AS match_result, NULL AS gg_ng, NULL AS total_goals,
                        match_time, NULL AS season_name,
                        id
                 FROM ${tableName}
                 WHERE home_score IS NOT NULL AND away_score IS NOT NULL
                 ORDER BY id ASC`
            ).all();
        } catch (e) {
            return [];
        }
    }

    // Normalise
    return rows.map(r => {
        const hs = parseInt(r.home_score, 10);
        const as_ = parseInt(r.away_score, 10);
        if (isNaN(hs) || isNaN(as_) || hs < 0 || as_ < 0) return null;
        const total = hs + as_;
        let result = r.match_result;
        if (!result) result = hs > as_ ? 'Home' : hs < as_ ? 'Away' : 'Draw';
        return {
            id: r.id,
            home_team: r.home_team,
            away_team: r.away_team,
            home_score: hs,
            away_score: as_,
            total_goals: total,
            result,
            gg: hs > 0 && as_ > 0,
            match_time: r.match_time || null,
            season_name: r.season_name || null
        };
    }).filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. LEAGUE DNA
// ──────────────────────────────────────────────────────────────────────────────
function analyseLeagueDNA(matches) {
    const n = matches.length;
    if (n === 0) return null;

    let totalGoals = 0, homeGoals = 0, awayGoals = 0;
    let homeWins = 0, draws = 0, awayWins = 0, ggCount = 0;
    const goalDist = {}; // total_goals -> count

    for (const m of matches) {
        totalGoals += m.total_goals;
        homeGoals  += m.home_score;
        awayGoals  += m.away_score;
        if (m.result === 'Home') homeWins++;
        else if (m.result === 'Draw') draws++;
        else awayWins++;
        if (m.gg) ggCount++;
        goalDist[m.total_goals] = (goalDist[m.total_goals] || 0) + 1;
    }

    const avgGoals     = totalGoals / n;
    const avgHomeGoals = homeGoals  / n;
    const avgAwayGoals = awayGoals  / n;
    const homeAdvantage = avgHomeGoals / (avgAwayGoals || 1);

    // Over/Under actuals
    const ov = (threshold) => matches.filter(m => m.total_goals > threshold).length / n;
    const un = (threshold) => matches.filter(m => m.total_goals < threshold).length / n;

    // Poisson-predicted Over/Under (using league averages)
    const poissonOv = (threshold) => poissonOver(avgHomeGoals, avgAwayGoals, threshold);

    const overMarkets = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map(t => ({
        threshold: t,
        actual: ov(t),
        poisson: poissonOv(t),
        mismatch: ov(t) - poissonOv(t)   // positive = simulation scores more than Poisson predicts
    }));

    const underMarkets = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map(t => ({
        threshold: t,
        actual: un(t),
        poisson: 1 - poissonOv(t),
        mismatch: un(t) - (1 - poissonOv(t))
    }));

    // Goal distribution (sorted)
    const maxGoal = Math.max(...Object.keys(goalDist).map(Number));
    const distribution = [];
    for (let g = 0; g <= Math.min(maxGoal, 15); g++) {
        distribution.push({
            goals: g,
            count: goalDist[g] || 0,
            frequency: (goalDist[g] || 0) / n
        });
    }

    return {
        totalMatches: n,
        avgGoals, avgHomeGoals, avgAwayGoals,
        homeAdvantageFactor: homeAdvantage,
        homeWinPct: homeWins / n,
        drawPct: draws / n,
        awayWinPct: awayWins / n,
        ggPct: ggCount / n,
        overMarkets,
        underMarkets,
        goalDistribution: distribution
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. TEAM POWER RANKINGS
// ──────────────────────────────────────────────────────────────────────────────
function analyseTeamStrengths(matches) {
    const stats = {};
    const init = () => ({
        hGS: 0, hGC: 0, hPlayed: 0,
        aGS: 0, aGC: 0, aPlayed: 0,
        wins: 0, draws: 0, losses: 0, played: 0
    });

    let totHomeGoals = 0, totAwayGoals = 0, cnt = 0;
    for (const m of matches) { totHomeGoals += m.home_score; totAwayGoals += m.away_score; cnt++; }
    const avgHG = totHomeGoals / (cnt || 1);
    const avgAG = totAwayGoals / (cnt || 1);

    for (const m of matches) {
        if (!stats[m.home_team]) stats[m.home_team] = init();
        if (!stats[m.away_team]) stats[m.away_team] = init();

        const ht = stats[m.home_team];
        const at = stats[m.away_team];

        ht.hGS += m.home_score; ht.hGC += m.away_score; ht.hPlayed++;
        at.aGS += m.away_score; at.aGC += m.home_score; at.aPlayed++;
        ht.played++; at.played++;

        if (m.result === 'Home') { ht.wins++; at.losses++; }
        else if (m.result === 'Draw') { ht.draws++; at.draws++; }
        else { ht.losses++; at.wins++; }
    }

    return Object.entries(stats).map(([team, s]) => {
        const hM = s.hPlayed || 1, aM = s.aPlayed || 1;
        const attackStr  = ((s.hGS / hM) / (avgHG || 1) + (s.aGS / aM) / (avgAG || 1)) / 2;
        const defenseStr = ((s.hGC / hM) / (avgAG || 1) + (s.aGC / aM) / (avgHG || 1)) / 2;
        const winRate    = s.wins / (s.played || 1);
        const avgScored  = (s.hGS + s.aGS) / (s.played || 1);
        const avgConceded = (s.hGC + s.aGC) / (s.played || 1);
        const powerScore = attackStr - defenseStr;

        return {
            team, played: s.played,
            wins: s.wins, draws: s.draws, losses: s.losses,
            winRate, avgScored, avgConceded,
            attackStrength: attackStr,
            defenseStrength: defenseStr,
            powerScore   // positive = strong team (scores more, concedes less relative to average)
        };
    }).sort((a, b) => b.powerScore - a.powerScore);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. STREAK ANALYSIS (momentum detection)
// ──────────────────────────────────────────────────────────────────────────────
function analyseStreaks(matches) {
    // Build per-team match sequences in chronological order
    const teamHistory = {};
    for (const m of matches) {
        if (!teamHistory[m.home_team]) teamHistory[m.home_team] = [];
        if (!teamHistory[m.away_team]) teamHistory[m.away_team] = [];
        teamHistory[m.home_team].push({ result: m.result === 'Home' ? 'W' : m.result === 'Draw' ? 'D' : 'L', scored: m.home_score, conceded: m.away_score });
        teamHistory[m.away_team].push({ result: m.result === 'Away' ? 'W' : m.result === 'Draw' ? 'D' : 'L', scored: m.away_score, conceded: m.home_score });
    }

    // Compute conditional probabilities
    let winAfterWin = 0, winAfterWinTotal = 0;
    let winAfterLoss = 0, winAfterLossTotal = 0;
    let scoreAfterScore = 0, scoreAfterScoreTotal = 0;
    let concAfterConc = 0, concAfterConcTotal = 0;

    for (const seq of Object.values(teamHistory)) {
        for (let i = 1; i < seq.length; i++) {
            const prev = seq[i - 1], curr = seq[i];

            if (prev.result === 'W') {
                winAfterWinTotal++;
                if (curr.result === 'W') winAfterWin++;
            }
            if (prev.result === 'L') {
                winAfterLossTotal++;
                if (curr.result === 'W') winAfterLoss++;
            }
            if (prev.scored > 0) {
                scoreAfterScoreTotal++;
                if (curr.scored > 0) scoreAfterScore++;
            }
            if (prev.conceded > 0) {
                concAfterConcTotal++;
                if (curr.conceded > 0) concAfterConc++;
            }
        }
    }

    const baseWinRate = matches.filter(m => m.result !== 'Draw').length / (matches.length * 2) * 0.5; // approx

    return {
        winAfterWin:      winAfterWinTotal  > 0 ? winAfterWin  / winAfterWinTotal  : 0,
        winAfterLoss:     winAfterLossTotal > 0 ? winAfterLoss / winAfterLossTotal : 0,
        scoreAfterScore:  scoreAfterScoreTotal > 0 ? scoreAfterScore / scoreAfterScoreTotal : 0,
        concAfterConc:    concAfterConcTotal   > 0 ? concAfterConc   / concAfterConcTotal   : 0,
        sampleWinAfterWin:  winAfterWinTotal,
        sampleWinAfterLoss: winAfterLossTotal,
        sampleScoreAfterScore: scoreAfterScoreTotal,
        sampleConcAfterConc:   concAfterConcTotal,
        // Is there significant momentum? (>5% above baseline)
        momentumDetected: (winAfterWin / (winAfterWinTotal || 1)) - (winAfterLoss / (winAfterLossTotal || 1)) > 0.05
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. HEAD-TO-HEAD FIXEDNESS (do the same matchups repeat?)
// ──────────────────────────────────────────────────────────────────────────────
function analyseH2HFixedness(matches) {
    const h2h = {};
    for (const m of matches) {
        const key = [m.home_team, m.away_team].sort().join(' vs ');
        if (!h2h[key]) h2h[key] = { goals: [], results: [], home: m.home_team, away: m.away_team, count: 0 };
        h2h[key].goals.push(m.total_goals);
        h2h[key].results.push(m.result);
        h2h[key].count++;
    }

    const pairs = Object.values(h2h).filter(p => p.count >= 4);

    const analysed = pairs.map(p => {
        const avgG = p.goals.reduce((a, b) => a + b, 0) / p.count;
        const variance = p.goals.reduce((a, b) => a + Math.pow(b - avgG, 2), 0) / p.count;
        const stdDev = Math.sqrt(variance);

        // Result consistency: how often does the same team win?
        const resultCounts = {};
        p.results.forEach(r => { resultCounts[r] = (resultCounts[r] || 0) + 1; });
        const maxResult = Object.entries(resultCounts).sort((a, b) => b[1] - a[1])[0];
        const resultConsistency = maxResult ? maxResult[1] / p.count : 0;

        return {
            matchup: p.home.split(' ')[0] + ' vs ' + p.away.split(' ')[0],
            fullMatchup: `${p.home} vs ${p.away}`,
            count: p.count,
            avgGoals: avgG,
            stdDev,
            resultConsistency,
            dominantResult: maxResult ? maxResult[0] : 'Unknown',
            isFixed: stdDev < 1.5 && resultConsistency > 0.6  // low variance + consistent winner
        };
    });

    const fixed = analysed.filter(a => a.isFixed).sort((a, b) => b.resultConsistency - a.resultConsistency);
    const highScoring = analysed.sort((a, b) => b.avgGoals - a.avgGoals).slice(0, 5);
    const lowScoring  = [...analysed].sort((a, b) => a.avgGoals - b.avgGoals).slice(0, 5);

    return {
        pairsAnalysed: analysed.length,
        fixedMatchups: fixed.slice(0, 10),
        highScoringMatchups: highScoring,
        lowScoringMatchups: lowScoring
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. SCORELINE FREQUENCY (what the simulation actually produces)
// ──────────────────────────────────────────────────────────────────────────────
function analyseScorelineFrequency(matches, leagueDna) {
    const n = matches.length;
    const freq = {};
    for (const m of matches) {
        const key = `${m.home_score}-${m.away_score}`;
        freq[key] = (freq[key] || 0) + 1;
    }

    const λH = leagueDna.avgHomeGoals;
    const λA = leagueDna.avgAwayGoals;

    const scorelines = Object.entries(freq).map(([score, count]) => {
        const [h, a] = score.split('-').map(Number);
        const actual = count / n;
        const frequency = count / n;
        const expected = poisson(λH, h) * poisson(λA, a);
        const ratio = expected > 0 ? actual / expected : 0;
        return { score, h, a, count, actual, frequency, expected, ratio,
                 overRepresented: ratio > 1.3,
                 underRepresented: ratio < 0.7 };
    }).sort((a, b) => b.count - a.count);

    return {
        top15: scorelines.slice(0, 15),
        overRepresented: scorelines.filter(s => s.overRepresented).sort((a, b) => b.ratio - a.ratio).slice(0, 8),
        underRepresented: scorelines.filter(s => s.underRepresented && s.expected > 0.01).sort((a, b) => a.ratio - b.ratio).slice(0, 5)
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. BEST BET SUGGESTIONS (exploit discovered patterns)
// ──────────────────────────────────────────────────────────────────────────────
function generateBestBets(leagueDna, streaks) {
    const suggestions = [];

    // Over/Under suggestions based on actual accuracy vs Poisson mismatch
    for (const market of leagueDna.overMarkets) {
        const actualPct = market.actual * 100;
        const label = `Over ${market.threshold} Goals`;

        if (actualPct >= 80) {
            suggestions.push({
                market: label,
                recommendation: 'ALWAYS BET OVER',
                confidence: actualPct,
                reason: `${actualPct.toFixed(1)}% of matches go Over ${market.threshold}. This is a near-guaranteed bet in this league.`,
                color: '#10b981'
            });
        } else if (actualPct >= 65) {
            suggestions.push({
                market: label,
                recommendation: 'FAVOUR OVER',
                confidence: actualPct,
                reason: `${actualPct.toFixed(1)}% of matches go Over ${market.threshold}. Strong edge — bet Over when no strong defensive matchup.`,
                color: '#3b82f6'
            });
        } else if (actualPct <= 20) {
            suggestions.push({
                market: label,
                recommendation: 'ALWAYS BET UNDER',
                confidence: 100 - actualPct,
                reason: `Only ${actualPct.toFixed(1)}% go Over ${market.threshold}. Favour Under in this league.`,
                color: '#f59e0b'
            });
        }

        // Flag if Poisson model consistently underestimates
        if (market.mismatch > 0.08) {
            suggestions.push({
                market: `${label} — Model Calibration`,
                recommendation: 'INCREASE XG ESTIMATE',
                confidence: 75,
                reason: `Model underestimates Over ${market.threshold} by ${(market.mismatch * 100).toFixed(1)}%. Sim generates more goals than Poisson predicts.`,
                color: '#f97316'
            });
        }
    }

    // Home advantage suggestion
    const homeAdv = leagueDna.homeWinPct * 100;
    if (homeAdv > 50) {
        suggestions.push({
            market: 'Home Win (1X2)',
            recommendation: 'FAVOUR HOME',
            confidence: homeAdv,
            reason: `Home teams win ${homeAdv.toFixed(1)}% of matches. Home advantage factor: ${leagueDna.homeAdvantageFactor.toFixed(2)}×.`,
            color: '#8b5cf6'
        });
    }

    // Streak suggestion
    if (streaks.momentumDetected) {
        suggestions.push({
            market: 'Recent Form',
            recommendation: 'USE STREAK FILTER',
            confidence: streaks.winAfterWin * 100,
            reason: `Win-after-win rate: ${(streaks.winAfterWin * 100).toFixed(1)}% vs win-after-loss: ${(streaks.winAfterLoss * 100).toFixed(1)}%. Momentum is significant — weight recent matches more.`,
            color: '#ec4899'
        });
    }

    // GG suggestion
    const ggPct = leagueDna.ggPct * 100;
    if (ggPct > 60) {
        suggestions.push({
            market: 'Both Teams Score (GG)',
            recommendation: 'FAVOUR GG',
            confidence: ggPct,
            reason: `${ggPct.toFixed(1)}% of matches have both teams scoring. Bet GG unless one team has very low attack strength.`,
            color: '#14b8a6'
        });
    } else if (ggPct < 40) {
        suggestions.push({
            market: 'Both Teams Score (GG)',
            recommendation: 'FAVOUR NO GOAL (NG)',
            confidence: (100 - ggPct),
            reason: `Only ${ggPct.toFixed(1)}% of matches are GG. Favour NG unless both teams have high attack strength.`,
            color: '#f59e0b'
        });
    }

    // Sort by confidence descending
    return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. MODEL MISMATCH TABLE (where does Poisson get it wrong?)
// ──────────────────────────────────────────────────────────────────────────────
function analyseMismatch(leagueDna) {
    const over = leagueDna.overMarkets.map(m => ({
        market: `Over ${m.threshold}`,
        actual: m.actual,
        poissonPredicted: m.poisson,
        mismatch: m.mismatch,
        direction: m.mismatch > 0 ? 'Poisson UNDERESTIMATES' : 'Poisson OVERESTIMATES',
        severity: Math.abs(m.mismatch) > 0.10 ? 'High' : Math.abs(m.mismatch) > 0.04 ? 'Medium' : 'Low'
    }));

    const under = leagueDna.underMarkets.map(m => ({
        market: `Under ${m.threshold}`,
        actual: m.actual,
        poissonPredicted: m.poisson,
        mismatch: m.mismatch,
        direction: m.mismatch > 0 ? 'Poisson UNDERESTIMATES' : 'Poisson OVERESTIMATES',
        severity: Math.abs(m.mismatch) > 0.10 ? 'High' : Math.abs(m.mismatch) > 0.04 ? 'Medium' : 'Low'
    }));

    return [...over, ...under];
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ──────────────────────────────────────────────────────────────────────────────
function analysePatterns(dbPath, provider = 'bet9ja') {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    let db;
    try {
        db = new Database(dbPath);
    } catch (e) {
        return { success: false, error: 'Could not open database: ' + e.message };
    }

    const matches = loadMatches(db, provider);
    db.close();

    if (matches.length < 20) {
        return { success: false, error: `Insufficient data: ${matches.length} matches found. Need at least 20.` };
    }

    const leagueDNA      = analyseLeagueDNA(matches);
    const teamStrengths  = analyseTeamStrengths(matches);
    const streaks        = analyseStreaks(matches);
    const h2hFixedness   = analyseH2HFixedness(matches);
    const scorelines     = analyseScorelineFrequency(matches, leagueDNA);
    const bestBets       = generateBestBets(leagueDNA, streaks);
    const mismatch       = analyseMismatch(leagueDNA);

    return {
        success: true,
        matchesAnalysed: matches.length,
        generatedAt: new Date().toISOString(),
        leagueDNA,
        teamStrengths,
        streaks,
        h2hFixedness,
        scorelines,
        bestBets,
        mismatch
    };
}

module.exports = { analysePatterns };
