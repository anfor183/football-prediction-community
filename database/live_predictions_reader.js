const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { openSafeDatabase } = require('./db_safe');
const { analyseTimePatterns } = require('./time_pattern_analyzer');

let _timePatternCache = { dbPath: '', provider: '', timestamp: 0, lowGoalsHours: [16] };

function getLowGoalsHoursCached(dbPath, provider) {
    const now = Date.now();
    if (_timePatternCache.dbPath === dbPath && _timePatternCache.provider === provider && (now - _timePatternCache.timestamp) < 5 * 60 * 1000) {
        return _timePatternCache.lowGoalsHours;
    }
    try {
        const report = analyseTimePatterns(dbPath, provider === 'sportybet');
        if (report && report.success && report.anomalies) {
            const detectedLowHours = report.anomalies
                .filter(a => (a.marketKey === 'over25' || a.marketKey === 'avgGoals') && a.direction === 'LOW')
                .map(a => a.hour);
            if (detectedLowHours.length > 0) {
                _timePatternCache = { dbPath, provider, timestamp: now, lowGoalsHours: detectedLowHours };
                return detectedLowHours;
            }
        }
    } catch (e) {
        // Fallback silently
    }
    _timePatternCache = { dbPath, provider, timestamp: now, lowGoalsHours: [16] };
    return [16];
}

function getLivePredictions(dbPath, provider = 'bet9ja', limit = 300) {
    if (!dbPath || !fs.existsSync(dbPath)) {
        const defaultPath = provider === 'sportybet'
            ? path.join(__dirname, '../databases/sportybet_archive.db')
            : path.join(__dirname, '../databases/bet9ja_archive.db');
        if (fs.existsSync(defaultPath)) {
            dbPath = defaultPath;
        } else {
            return { success: false, error: 'Database not found' };
        }
    }

    let db;
    try {
        db = openSafeDatabase(dbPath, { readonly: false, timeout: 5000 });
    } catch (_) {
        try {
            db = openSafeDatabase(dbPath, { readonly: true, timeout: 5000 });
        } catch (openErr) {
            return { success: false, error: openErr.message };
        }
    }
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
    } catch (e) {}

    try {
        // Automatically settle any pending picks whose matches have completed (fast SQLite query, <5ms)
        try {
            const { settlePendingAIPicks } = require('./live_companion.js');
            if (typeof settlePendingAIPicks === 'function') {
                settlePendingAIPicks(db);
            }
        } catch (_) {}

        // Fetch the most recently ACTIVE season for the specific provider (fast index scan via ORDER BY id DESC)
        let latestSeasonRow;
        if (provider === 'sportybet') {
            latestSeasonRow = db.prepare(
                "SELECT season_name FROM live_predictions WHERE season_name LIKE 'Sportybet%' ORDER BY id DESC LIMIT 1"
            ).get();
        } else {
            latestSeasonRow = db.prepare(
                "SELECT season_name FROM live_predictions WHERE season_name NOT LIKE 'Sportybet%' ORDER BY id DESC LIMIT 1"
            ).get();
        }

        if (!latestSeasonRow) {
            // Fallback to any season in the active database
            latestSeasonRow = db.prepare(
                "SELECT season_name, MAX(id) as max_id FROM live_predictions GROUP BY season_name ORDER BY max_id DESC LIMIT 1"
            ).get();
        }

        if (!latestSeasonRow) {
            db.close();
            return { success: true, seasonName: null, predictions: [], aiPicksHistory: [], lowGoalsHours: [16] };
        }

        const seasonName = latestSeasonRow.season_name;

        let limitNum = parseInt(limit, 10);
        if (isNaN(limitNum) || limitNum <= 0) limitNum = 300;
        // Cap live predictions to a safe maximum of 500 to prevent loading tens of thousands of rows
        const safeLimit = Math.min(Math.max(limitNum, 50), 500);
        const limitClause = `LIMIT ${safeLimit}`;

        let hasOddsCol = false;
        try {
            const tableInfo = db.pragma('table_info(live_predictions)');
            hasOddsCol = tableInfo.some(c => c.name === 'bookmaker_odds');
        } catch (_) {}

        const predCols = `id, season_name, round_number, match_time, home_team, away_team, predicted_result, predicted_probs, actual_score, actual_ht_score, scored_status, kickoff_timestamp, scored_with_prediction, anomaly_detected, league_id${hasOddsCol ? ', bookmaker_odds' : ''}`;
        // Allow upcoming matches and active pending matches within recent grace period (2 hours)
        const activePendingCutoff = Date.now() - 2 * 3600 * 1000;
        let predictions;
        if (provider === 'sportybet' || seasonName.startsWith('Sportybet')) {
            const pending = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name LIKE 'Sportybet%' 
                  AND scored_status = 0
                  AND (kickoff_timestamp IS NULL OR kickoff_timestamp >= ?)
                ORDER BY round_number ASC, id ASC
            `).all(activePendingCutoff);

            const scored = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE scored_status = 1
                ORDER BY id DESC
                ${limitClause}
            `).all();

            predictions = [...scored.reverse(), ...pending];
        } else {
            const pending = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name = ? 
                  AND scored_status = 0
                  AND (kickoff_timestamp IS NULL OR kickoff_timestamp >= ?)
                ORDER BY round_number ASC, id ASC
            `).all(seasonName, activePendingCutoff);

            const scored = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name = ? 
                  AND scored_status = 1
                ORDER BY round_number ASC, id ASC
                ${limitClause}
            `).all(seasonName);

            predictions = [...scored, ...pending];
        }

        // Fetch AI picks history
        let aiPicksHistory = [];
        try {
            const cols = `a.id, a.season_name, a.round_number, a.pick_type, a.home_team, a.away_team, a.market, a.probability, a.implied_odd, a.actual_score, a.status, a.predicted_probs, a.kickoff_timestamp, a.match_time${hasOddsCol ? ', lp.bookmaker_odds' : ''}`;
            if (provider === 'sportybet') {
                aiPicksHistory = db.prepare(`
                    SELECT ${cols} 
                    FROM ai_best_picks_history a
                    ${hasOddsCol ? `LEFT JOIN live_predictions lp 
                      ON lp.season_name = a.season_name 
                     AND lp.home_team = a.home_team 
                     AND lp.away_team = a.away_team 
                     AND lp.round_number = a.round_number` : ''}
                    WHERE a.season_name LIKE 'Sportybet%' 
                    ORDER BY a.id DESC ${limitClause}
                `).all();
            } else {
                aiPicksHistory = db.prepare(`
                    SELECT ${cols} 
                    FROM ai_best_picks_history a
                    ${hasOddsCol ? `LEFT JOIN live_predictions lp 
                      ON lp.season_name = a.season_name 
                     AND lp.home_team = a.home_team 
                     AND lp.away_team = a.away_team 
                     AND lp.round_number = a.round_number` : ''}
                    WHERE a.season_name NOT LIKE 'Sportybet%' 
                    ORDER BY a.id DESC ${limitClause}
                `).all();
            }
        } catch (he) {
            console.error("Error reading ai_best_picks_history:", he.message);
        }

        let lowGoalsHours = getLowGoalsHoursCached(dbPath, provider);

        let learningStatus = null;
        try {
            const statusPath = dbPath + '.learning.json';
            if (fs.existsSync(statusPath)) {
                learningStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            }
        } catch (e) {
            // Ignore
        }

        db.close();

        return {
            success: true,
            seasonName,
            learningStatus,
            predictions: predictions.map(p => {
                let probs = {};
                try {
                    probs = JSON.parse(p.predicted_probs) || {};
                    if (probs.dnbHomeProb === undefined || probs.dnbAwayProb === undefined) {
                        const h = probs.homeWinProb || 0;
                        const a = probs.awayWinProb || 0;
                        const total = h + a || 1;
                        probs.dnbHomeProb = Math.round((h / total) * 100);
                        probs.dnbAwayProb = Math.round((a / total) * 100);
                    }
                } catch (pe) {
                    probs = {};
                }
                return {
                    ...p,
                    predicted_probs: probs
                };
            }),
            aiPicksHistory: aiPicksHistory.map(pick => {
                let probs = {};
                try {
                    probs = JSON.parse(pick.predicted_probs) || {};
                    if (probs.dnbHomeProb === undefined || probs.dnbAwayProb === undefined) {
                        const h = probs.homeWinProb || 0;
                        const a = probs.awayWinProb || 0;
                        const total = h + a || 1;
                        probs.dnbHomeProb = Math.round((h / total) * 100);
                        probs.dnbAwayProb = Math.round((a / total) * 100);
                    }
                } catch (pe) {
                    probs = {};
                }
                const hw = probs.homeWinProb || 0;
                const dr = probs.drawProb || 0;
                const aw = probs.awayWinProb || 0;
                const maxProb = Math.max(hw, dr, aw) / 100;
                let confidence = Math.round(40 + (maxProb - 0.33) * 85);
                confidence = Math.max(50, Math.min(98, confidence));
                return {
                    ...pick,
                    predicted_probs: probs,
                    confidence
                };
            }),
            lowGoalsHours
        };
    } catch (e) {
        try { db.close(); } catch (_) {}
        return { success: false, error: e.message };
    }
}

module.exports = {
    getLivePredictions
};
