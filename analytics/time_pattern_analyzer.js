/**
 * time_pattern_analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects time-of-day patterns in virtual football databases.
 *
 * For each hour of the day (0–23) and for four named session blocks,
 * it computes per-market win rates (Over/Under 1.5–3.5, GG, Draw,
 * Home Win, Away Win, Odd/Even Goals) and flags statistically anomalous
 * slots using a Z-score test (|z| >= 1.5).
 *
 * Exports:
 *   analyseTimePatterns(dbPath)        → full report object
 *   getTimeAdjustmentFactor(dbPath, hour) → { goalsFactor, description }
 */

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Named session blocks
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_BLOCKS = [
    { name: 'Morning',    label: '🌅 Morning',    start: 0,  end: 8  },
    { name: 'Daytime',    label: '☀️ Daytime',    start: 9,  end: 15 },
    { name: 'Evening',    label: '🌆 Evening',    start: 16, end: 20 },
    { name: 'Late Night', label: '🌙 Late Night', start: 21, end: 23 },
];

function getSession(hour) {
    for (const s of SESSION_BLOCKS) {
        if (hour >= s.start && hour <= s.end) return s.name;
    }
    return 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// DB loader — mirrors pattern_analyzer.js loadMatches
// ─────────────────────────────────────────────────────────────────────────────
function loadMatches(db, isSportybet = false) {
    let rows = [];
    let isSporty = isSportybet;
    if (!isSporty) {
        try {
            const sportyTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sporty_fixtures'").get();
            const standardTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixtures'").get();
            if (sportyTableExists && !standardTableExists) {
                isSporty = true;
            }
        } catch (e) {}
    }
    const condition = isSporty ? "league_name LIKE 'Sportybet%'" : "league_name NOT LIKE 'Sportybet%'";
    const viewName = isSporty ? 'sporty_betting_analytics' : 'betting_analytics';
    const fixturesName = isSporty ? 'sporty_fixtures' : 'fixtures';

    // Prefer betting_analytics (richer schema) - Limit to 10000 most recent rows to adapt to pattern changes
    try {
        rows = db.prepare(`
            SELECT home_team, away_team,
                   CAST(home_score AS INTEGER) AS home_score,
                   CAST(away_score AS INTEGER) AS away_score,
                   CAST(ht_home_score AS INTEGER) AS ht_home_score,
                   CAST(ht_away_score AS INTEGER) AS ht_away_score,
                   match_time, id
            FROM ${viewName}
            WHERE home_score IS NOT NULL AND away_score IS NOT NULL AND ${condition}
            ORDER BY id DESC LIMIT 10000
        `).all();
        rows.reverse();
    } catch (_) { /* fall through */ }

    // Fallback: fixtures table
    if (rows.length === 0) {
        try {
            rows = db.prepare(`
                SELECT home_team, away_team,
                       CAST(home_score AS INTEGER) AS home_score,
                       CAST(away_score AS INTEGER) AS away_score,
                       CAST(ht_home_score AS INTEGER) AS ht_home_score,
                       CAST(ht_away_score AS INTEGER) AS ht_away_score,
                       match_time, id
                FROM ${fixturesName}
                WHERE home_score IS NOT NULL AND away_score IS NOT NULL AND ${condition}
                ORDER BY id DESC LIMIT 10000
            `).all();
            rows.reverse();
        } catch (_) { return []; }
    }

    const result = [];
    for (const r of rows) {
        const hs = parseInt(r.home_score, 10);
        const as_ = parseInt(r.away_score, 10);
        if (isNaN(hs) || isNaN(as_) || hs < 0 || as_ < 0) continue;

        // Extract hour from match_time (handles "14:30" and ISO "2026-05-28T07:31:00Z")
        let hour = null;
        if (r.match_time && typeof r.match_time === 'string' && r.match_time.includes(':')) {
            let timeStr = r.match_time;
            if (timeStr.includes('T')) {
                timeStr = timeStr.split('T')[1];
            }
            const parsed = parseInt(timeStr.split(':')[0], 10);
            if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) {
                hour = parsed;
            }
        }

        const total = hs + as_;
        const htH = (r.ht_home_score !== null && r.ht_home_score !== undefined) ? parseInt(r.ht_home_score, 10) : null;
        const htA = (r.ht_away_score !== null && r.ht_away_score !== undefined) ? parseInt(r.ht_away_score, 10) : null;

        result.push({
            id: r.id,
            home_score: hs,
            away_score: as_,
            ht_home_score: (!isNaN(htH) && htH >= 0) ? htH : null,
            ht_away_score: (!isNaN(htA) && htA >= 0) ? htA : null,
            total,
            hour,
            session: hour !== null ? getSession(hour) : null,
            result: hs > as_ ? 'Home' : hs < as_ ? 'Away' : 'Draw',
            gg: hs > 0 && as_ > 0,
        });
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute market rates for a slice of matches
// ─────────────────────────────────────────────────────────────────────────────
function computeRates(matches) {
    const n = matches.length;
    if (n === 0) {
        return {
            matchCount: 0,
            avgGoals: 0,
            homeWinRate: 0, drawRate: 0, awayWinRate: 0,
            over05: 0, over15: 0, over25: 0, over35: 0, over45: 0,
            under15: 0, under25: 0, under35: 0, under45: 0,
            ggRate: 0, ngRate: 0,
            oddRate: 0, evenRate: 0,
        };
    }

    let totalGoals = 0;
    let homeWins = 0, draws = 0, awayWins = 0;
    let ov05 = 0, ov15 = 0, ov25 = 0, ov35 = 0, ov45 = 0;
    let gg = 0, odd = 0;

    for (const m of matches) {
        totalGoals += m.total;
        if (m.result === 'Home') homeWins++;
        else if (m.result === 'Draw') draws++;
        else awayWins++;
        if (m.total > 0) ov05++;
        if (m.total > 1) ov15++;
        if (m.total > 2) ov25++;
        if (m.total > 3) ov35++;
        if (m.total > 4) ov45++;
        if (m.gg) gg++;
        if (m.total % 2 === 1) odd++;
    }

    return {
        matchCount: n,
        avgGoals: totalGoals / n,
        homeWinRate: homeWins / n,
        drawRate: draws / n,
        awayWinRate: awayWins / n,
        over05: ov05 / n,
        over15: ov15 / n,
        over25: ov25 / n,
        over35: ov35 / n,
        over45: ov45 / n,
        under15: 1 - (ov15 / n),
        under25: 1 - (ov25 / n),
        under35: 1 - (ov35 / n),
        under45: 1 - (ov45 / n),
        ggRate: gg / n,
        ngRate: 1 - (gg / n),
        oddRate: odd / n,
        evenRate: 1 - (odd / n),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Z-score helper
// ─────────────────────────────────────────────────────────────────────────────
function zScore(value, mean, stdDev) {
    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
}

function stdDev(values) {
    const n = values.length;
    if (n === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
    return Math.sqrt(variance);
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect anomalies across all hourly buckets for a given market key
// ─────────────────────────────────────────────────────────────────────────────
const MARKET_KEYS = [
    { key: 'over15',    label: 'Over 1.5 Goals' },
    { key: 'over25',    label: 'Over 2.5 Goals' },
    { key: 'over35',    label: 'Over 3.5 Goals' },
    { key: 'under25',   label: 'Under 2.5 Goals' },
    { key: 'ggRate',    label: 'Both Teams Score (GG)' },
    { key: 'drawRate',  label: 'Draw' },
    { key: 'homeWinRate', label: 'Home Win' },
    { key: 'awayWinRate', label: 'Away Win' },
    { key: 'oddRate',   label: 'Odd Total Goals' },
    { key: 'avgGoals',  label: 'Avg Goals/Match' },
];

const Z_THRESHOLD = 1.5; // Flag if |z| >= this
const MIN_SAMPLE  = 20;  // Minimum matches for a slot to be flagged

function detectAnomalies(hourlyStats, leagueRates) {
    const alerts = [];

    for (const market of MARKET_KEYS) {
        const { key, label } = market;

        // Collect per-hour rates (only hours with enough data)
        const hourRates = hourlyStats
            .filter(h => h.matchCount >= MIN_SAMPLE)
            .map(h => h.rates[key]);

        if (hourRates.length < 4) continue; // Need at least 4 data-sufficient hours

        const sd = stdDev(hourRates);
        const leagueAvg = leagueRates[key];

        for (const slot of hourlyStats) {
            if (slot.matchCount < MIN_SAMPLE) continue;
            const rate = slot.rates[key];
            const z = zScore(rate, leagueAvg, sd || 0.01);

            if (Math.abs(z) >= Z_THRESHOLD) {
                const direction = z > 0 ? 'HIGH' : 'LOW';
                const isGoalMarket = ['over15', 'over25', 'over35', 'avgGoals'].includes(key);
                const isGGMarket = key === 'ggRate';
                const isDrawMarket = key === 'drawRate';
                const isHomeWin = key === 'homeWinRate';
                const isAwayWin = key === 'awayWinRate';

                let recommendation = '';
                if (direction === 'HIGH') {
                    if (isGoalMarket) recommendation = `Favour ${label.includes('Avg') ? 'Over 2.5 Goals' : label}`;
                    else if (isGGMarket) recommendation = 'Favour Both Teams to Score (GG)';
                    else if (isDrawMarket) recommendation = 'Favour Draw';
                    else if (isHomeWin) recommendation = 'Favour Home Win';
                    else if (isAwayWin) recommendation = 'Favour Away Win';
                    else recommendation = `${label} is unusually HIGH`;
                } else {
                    if (isGoalMarket) recommendation = `Favour Under ${label.replace('Over ', '')}`;
                    else if (isGGMarket) recommendation = 'Favour No Goal (NG)';
                    else if (isDrawMarket) recommendation = 'Avoid Draw — decisive outcomes more likely';
                    else if (isHomeWin) recommendation = 'Away Win or Draw more likely than usual';
                    else if (isAwayWin) recommendation = 'Home Win or Draw more likely than usual';
                    else recommendation = `${label} is unusually LOW`;
                }

                alerts.push({
                    hour: slot.hour,
                    session: slot.session,
                    market: label,
                    marketKey: key,
                    direction,
                    zScore: Math.round(z * 100) / 100,
                    rate: Math.round(rate * 1000) / 10,           // as %
                    leagueAvg: Math.round(leagueAvg * 1000) / 10,
                    deviation: Math.round((rate - leagueAvg) * 1000) / 10,
                    matchCount: slot.matchCount,
                    recommendation,
                    strength: Math.abs(z) >= 2.5 ? 'Strong' : Math.abs(z) >= 2.0 ? 'Moderate' : 'Mild',
                });
            }
        }
    }

    // Sort by absolute Z-score descending
    return alerts.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}

// ─────────────────────────────────────────────────────────────────────────────
// Session block summary
// ─────────────────────────────────────────────────────────────────────────────
function computeSessionStats(matches, leagueRates) {
    return SESSION_BLOCKS.map(block => {
        const slotMatches = matches.filter(m => m.session === block.name);
        const rates = computeRates(slotMatches);

        const deviations = {};
        for (const mk of MARKET_KEYS) {
            const diff = rates[mk.key] - leagueRates[mk.key];
            deviations[mk.key] = Math.round(diff * 1000) / 10; // percentage point diff
        }

        return {
            session: block.name,
            label: block.label,
            hourRange: `${String(block.start).padStart(2, '0')}:00 – ${String(block.end).padStart(2, '0')}:59`,
            matchCount: slotMatches.length,
            rates,
            deviations,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — analyseTimePatterns
// ─────────────────────────────────────────────────────────────────────────────
function analyseTimePatterns(dbPath, isSportybet = false) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    let db;
    try {
        db = new Database(dbPath, { readonly: true, timeout: 10000 });
        try {
            db.pragma('busy_timeout = 10000');
        } catch (e) {}
    } catch (e) {
        return { success: false, error: 'Could not open database: ' + e.message };
    }

    const allMatches = loadMatches(db, isSportybet);
    db.close();

    if (allMatches.length < 20) {
        return { success: false, error: `Insufficient data: ${allMatches.length} matches found. Need at least 20.` };
    }

    // Overall league rates (benchmark)
    const leagueRates = computeRates(allMatches);

    // Matches WITH a known kickoff hour
    const timedMatches = allMatches.filter(m => m.hour !== null);
    const timedPct = allMatches.length > 0
        ? Math.round((timedMatches.length / allMatches.length) * 100)
        : 0;

    // Build hourly buckets (0–23)
    const hourlyStats = [];
    for (let h = 0; h <= 23; h++) {
        const slotMatches = timedMatches.filter(m => m.hour === h);
        const rates = computeRates(slotMatches);
        hourlyStats.push({
            hour: h,
            label: `${String(h).padStart(2, '0')}:00`,
            session: getSession(h),
            matchCount: slotMatches.length,
            rates,
        });
    }

    // Session summaries
    const sessionStats = computeSessionStats(timedMatches, leagueRates);

    // Detect anomalies
    const anomalies = detectAnomalies(hourlyStats, leagueRates);

    // Coverage warning
    const hasTimedData = timedMatches.length >= 20;

    return {
        success: true,
        generatedAt: new Date().toISOString(),
        totalMatches: allMatches.length,
        timedMatches: timedMatches.length,
        timedCoverage: timedPct,
        hasTimedData,
        leagueRates,
        hourlyStats,
        sessionStats,
        anomalies,
        markets: MARKET_KEYS,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECONDARY EXPORT — getTimeAdjustmentFactor
// Returns a goals scaling factor based on the current hour's deviation from
// the league avg goals rate. Used by ml_predictor.js to nudge XG.
// ─────────────────────────────────────────────────────────────────────────────
function getTimeAdjustmentFactor(dbPath, currentHour, isSportybet = false) {
    if (currentHour === null || currentHour === undefined) {
        return { factor: 1.0, description: 'No time data', isSignificant: false };
    }

    try {
        const report = analyseTimePatterns(dbPath, isSportybet);
        if (!report.success || !report.hasTimedData) {
            return { factor: 1.0, description: 'Insufficient time data', isSignificant: false };
        }

        const slot = report.hourlyStats.find(h => h.hour === currentHour);
        if (!slot || slot.matchCount < MIN_SAMPLE) {
            return { factor: 1.0, description: 'Not enough data for this hour', isSignificant: false };
        }

        const leagueAvg = report.leagueRates.avgGoals;
        const slotAvg   = slot.rates.avgGoals;

        if (leagueAvg === 0) {
            return { factor: 1.0, description: 'League avg is zero', isSignificant: false };
        }

        const rawFactor = slotAvg / leagueAvg;
        // Clamp to ±25% so we don't over-correct
        const factor = Math.max(0.75, Math.min(1.25, rawFactor));
        const pctChange = Math.round((factor - 1) * 100);
        const sign = pctChange >= 0 ? '+' : '';

        // Only flag as significant if over25 anomaly exists for this hour
        const over25Anomaly = report.anomalies.find(
            a => a.hour === currentHour && a.marketKey === 'over25'
        );
        const isSignificant = !!over25Anomaly || Math.abs(factor - 1) >= 0.08;

        return {
            factor,
            description: `${sign}${pctChange}% goals vs league avg at ${String(currentHour).padStart(2, '0')}:00`,
            isSignificant,
            matchCount: slot.matchCount,
            slotAvgGoals: Math.round(slotAvg * 100) / 100,
            leagueAvgGoals: Math.round(leagueAvg * 100) / 100,
        };
    } catch (e) {
        return { factor: 1.0, description: 'Error: ' + e.message, isSignificant: false };
    }
}

module.exports = { analyseTimePatterns, getTimeAdjustmentFactor };
