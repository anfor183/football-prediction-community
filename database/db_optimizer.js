/**
 * db_optimizer.js
 * ===============
 * Intelligent Database Optimizer for AI Model Training.
 *
 * Automatically inspects the SQLite database, checks for:
 *   1. Sportybet Virtual RNG Distribution Shifts (Draw % and Over 2.5 % drift)
 *   2. Optimal AI Model Training Window & Noise Accumulation (>25,000 matches)
 *   3. Season bloat across related tables (seasons, fixtures, standings, H2H)
 *
 * Computes the optimal retention target (e.g. 15,000 - 20,000 matches) and safely
 * trims stale historical records in the background without corrupting active models.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { pruneOldSeasons } = require('./db_cleaner');

const UTILS_DIR = __dirname;
const APP_DIR = path.resolve(UTILS_DIR, '..');
const STATE_FILE = path.join(APP_DIR, 'auto_trainer_state.json');

// Default target bounds for optimal training
const DEFAULT_OPTIMAL_WINDOW = 20000;
const REGIME_SHIFT_OPTIMAL_WINDOW = 15000;
const MAX_SEASONS_TO_RETAIN = 60;

/**
 * Calculates match distribution statistics from a list of rows
 */
function calculateDistribution(matches) {
    let home = 0, draw = 0, away = 0, o25 = 0, valid = 0;
    for (const m of matches) {
        if (!m.actual_score || !m.actual_score.includes(':')) continue;
        const [h, a] = m.actual_score.split(':').map(Number);
        if (isNaN(h) || isNaN(a)) continue;
        valid++;
        if (h > a) home++;
        else if (a > h) away++;
        else draw++;
        if ((h + a) > 2.5) o25++;
    }
    if (valid === 0) return null;
    return {
        drawPct: parseFloat((draw / valid * 100).toFixed(1)),
        o25Pct: parseFloat((o25 / valid * 100).toFixed(1)),
        homePct: parseFloat((home / valid * 100).toFixed(1)),
        awayPct: parseFloat((away / valid * 100).toFixed(1)),
        valid
    };
}

/**
 * Inspect the database and determine if optimization / trimming is required
 * and what the optimal retention count should be.
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {object} options - Optional settings (e.g. maxMatches, forceShiftThreshold)
 * @returns {object} Diagnostic analysis with optimal keep recommendation
 */
function analyzeOptimalDbTrim(dbPath, options = {}) {
    if (!dbPath || !fs.existsSync(dbPath)) {
        return {
            success: false,
            error: `Database file not found: ${dbPath || 'none'}`
        };
    }

    let db;
    try {
        db = new Database(dbPath, { readonly: true });
    } catch (e) {
        return { success: false, error: `Failed to open database: ${e.message}` };
    }

    try {
        // 1. Check table existence
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        const hasPredictions = tables.includes('historical_market_predictions');
        const hasSeasons = tables.includes('seasons');

        let totalMatches = 0;
        if (hasPredictions) {
            const countRow = db.prepare("SELECT COUNT(*) as c FROM historical_market_predictions").get();
            totalMatches = countRow ? countRow.c : 0;
        }

        let totalSeasons = 0;
        if (hasSeasons) {
            const seasonRow = db.prepare("SELECT COUNT(*) as c FROM seasons").get();
            totalSeasons = seasonRow ? seasonRow.c : 0;
        }

        // 2. Check for Virtual RNG Distribution Shift
        let shiftDetected = false;
        let shiftDetails = null;
        let recentDist = null;
        let olderDist = null;

        if (hasPredictions && totalMatches >= 6000) {
            try {
                const recent1k = db.prepare("SELECT actual_score FROM historical_market_predictions WHERE actual_score IS NOT NULL ORDER BY id DESC LIMIT 1000").all();
                const older5k = db.prepare("SELECT actual_score FROM historical_market_predictions WHERE actual_score IS NOT NULL ORDER BY id DESC LIMIT 5000 OFFSET 1000").all();

                recentDist = calculateDistribution(recent1k);
                olderDist = calculateDistribution(older5k);

                if (recentDist && olderDist) {
                    const drawDiff = Math.abs(recentDist.drawPct - olderDist.drawPct);
                    const o25Diff = Math.abs(recentDist.o25Pct - olderDist.o25Pct);

                    if (drawDiff > 6.0 || o25Diff > 8.0) {
                        shiftDetected = true;
                        shiftDetails = `Virtual RNG shift detected: Draw rate shifted ${olderDist.drawPct}% → ${recentDist.drawPct}%, Over 2.5 shifted ${olderDist.o25Pct}% → ${recentDist.o25Pct}%.`;
                    }
                }
            } catch (e) {
                // Ignore drift calculation failure if columns differ
            }
        }

        // 3. Determine Optimal Keep Count
        const customOptimal = options.optimalWindow || (options.maxMatches ? parseInt(options.maxMatches, 10) : null);
        let optimalKeepMatches = customOptimal || DEFAULT_OPTIMAL_WINDOW;
        let reason = '';
        let needsOptimization = false;

        if (shiftDetected) {
            optimalKeepMatches = customOptimal ? Math.min(customOptimal, REGIME_SHIFT_OPTIMAL_WINDOW) : REGIME_SHIFT_OPTIMAL_WINDOW;
            if (totalMatches > optimalKeepMatches) {
                needsOptimization = true;
                reason = `RNG engine shift detected (${shiftDetails}). Trimming data older than ${optimalKeepMatches.toLocaleString()} matches will remove obsolete game mechanics.`;
            }
        } else if (totalMatches > (customOptimal || 25000)) {
            optimalKeepMatches = customOptimal || DEFAULT_OPTIMAL_WINDOW;
            needsOptimization = true;
            reason = `Training set contains ${totalMatches.toLocaleString()} matches (> 25,000 threshold). Trimming to the newest ${optimalKeepMatches.toLocaleString()} matches removes stale noise and speeds up training.`;
        } else if (totalSeasons > MAX_SEASONS_TO_RETAIN) {
            needsOptimization = true;
            reason = `Database contains ${totalSeasons} seasons (> ${MAX_SEASONS_TO_RETAIN} threshold). Pruning excess seasons will optimize disk performance.`;
        }

        const recommendedTrimCount = Math.max(0, totalMatches - optimalKeepMatches);
        const excessSeasons = Math.max(0, totalSeasons - MAX_SEASONS_TO_RETAIN);

        db.close();

        return {
            success: true,
            dbPath,
            totalMatches,
            totalSeasons,
            shiftDetected,
            shiftDetails,
            recentDistribution: recentDist,
            olderDistribution: olderDist,
            needsOptimization,
            optimalKeepMatches,
            recommendedTrimCount,
            excessSeasons,
            reason: reason || 'Database is already within optimal operating parameters for AI model training.',
            recommendation: needsOptimization
                ? `Trim ${recommendedTrimCount.toLocaleString()} older matches to retain the newest ${optimalKeepMatches.toLocaleString()} matches for optimal AI accuracy.`
                : 'No database trimming required at this time.'
        };
    } catch (e) {
        if (db) {
            try { db.close(); } catch (_) {}
        }
        return { success: false, error: e.message };
    }
}

/**
 * Automatically execute optimal database trimming and maintenance
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {object} options - Options: force (boolean), targetKeep (number), pruneSeasons (boolean)
 * @returns {object} Result of the optimization operation
 */
function autoOptimizeDatabase(dbPath, options = {}) {
    const analysis = analyzeOptimalDbTrim(dbPath, options);
    if (!analysis.success) {
        return { success: false, error: analysis.error };
    }

    const { totalMatches, optimalKeepMatches, shiftDetected, reason } = analysis;
    const targetKeep = options.targetKeep ? parseInt(options.targetKeep, 10) : optimalKeepMatches;

    // Check if trimming is needed
    if (!options.force && !analysis.needsOptimization && totalMatches <= targetKeep) {
        return {
            success: true,
            optimized: false,
            totalMatches,
            trimmedCount: 0,
            remainingCount: totalMatches,
            message: `Database already at optimal size (${totalMatches.toLocaleString()} matches). No trimming needed.`,
            analysis
        };
    }

    let db;
    try {
        db = new Database(dbPath);
    } catch (e) {
        return { success: false, error: `Failed to open database for writing: ${e.message}` };
    }

    const startTime = Date.now();
    let trimmedCount = 0;
    let prunedSeasonsCount = 0;

    try {
        // 1. Trim historical_market_predictions if exceeds targetKeep
        if (totalMatches > targetKeep) {
            const cutoffRow = db.prepare("SELECT id FROM historical_market_predictions ORDER BY id DESC LIMIT 1 OFFSET ?").get(targetKeep - 1);
            if (cutoffRow && cutoffRow.id) {
                const info = db.prepare("DELETE FROM historical_market_predictions WHERE id < ?").run(cutoffRow.id);
                trimmedCount = info.changes;
            }
        }

        // 2. Prune excess seasons across related tables
        if (options.pruneSeasons !== false) {
            try {
                const seasonsCountBefore = db.prepare("SELECT COUNT(*) as c FROM seasons").get().c;
                if (seasonsCountBefore > MAX_SEASONS_TO_RETAIN) {
                    pruneOldSeasons(db, MAX_SEASONS_TO_RETAIN);
                    const seasonsCountAfter = db.prepare("SELECT COUNT(*) as c FROM seasons").get().c;
                    prunedSeasonsCount = Math.max(0, seasonsCountBefore - seasonsCountAfter);
                }
            } catch (_) {
                // Table might not exist in standalone archive db
            }
        }

        // 3. Run SQLite optimize maintenance
        try {
            db.pragma('optimize');
            db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (_) {}

        db.close();

        const durationMs = Date.now() - startTime;
        const remainingCount = totalMatches - trimmedCount;

        // Record in state file
        try {
            let state = {};
            if (fs.existsSync(STATE_FILE)) {
                state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            }
            state.lastOptimizedAt = new Date().toISOString();
            state.lastOptimizedTrimmed = trimmedCount;
            state.lastOptimizedRemaining = remainingCount;
            state.lastOptimizedDurationMs = durationMs;
            state.lastOptimizedReason = reason;
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        } catch (_) {}

        return {
            success: true,
            optimized: true,
            trimmedCount,
            remainingCount,
            prunedSeasonsCount,
            shiftDetected,
            durationMs,
            message: `✨ Auto-optimized database: Trimmed ${trimmedCount.toLocaleString()} stale matches (retained newest ${remainingCount.toLocaleString()}) and pruned ${prunedSeasonsCount} old seasons in ${(durationMs / 1000).toFixed(1)}s.`,
            analysis
        };
    } catch (e) {
        if (db) {
            try { db.close(); } catch (_) {}
        }
        return { success: false, error: `Database optimization failed: ${e.message}` };
    }
}

module.exports = {
    analyzeOptimalDbTrim,
    autoOptimizeDatabase,
    DEFAULT_OPTIMAL_WINDOW,
    REGIME_SHIFT_OPTIMAL_WINDOW,
    MAX_SEASONS_TO_RETAIN
};
