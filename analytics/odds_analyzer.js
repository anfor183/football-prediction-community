const Database = require('better-sqlite3');
const fs = require('fs');

/**
 * Odds Analyzer - Tracks market performance and predicts odds likelihood
 * Learns which markets are likely to get 3.0+ odds based on historical patterns
 */

/**
 * Initialize odds tracking table
 */
function initOddsTable(db) {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS market_odds_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                season_name TEXT,
                round_number INTEGER,
                home_team TEXT,
                away_team TEXT,
                market TEXT,
                probability REAL,
                actual_odd REAL,
                is_3_3_plus INTEGER DEFAULT 0,
                pick_status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(season_name, round_number, home_team, away_team, market) ON CONFLICT IGNORE
            );
        `);
    } catch (e) {
        console.error("Error initializing odds table:", e.message);
    }
}

/**
 * Track a prediction with market and probability
 * Called when AI Best Pick is made
 */
function recordMarketPick(db, season, round, homeTeam, awayTeam, market, probability) {
    try {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO market_odds_history 
            (season_name, round_number, home_team, away_team, market, probability, pick_status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `);
        stmt.run(season, round, homeTeam, awayTeam, market, probability);
    } catch (e) {
        console.error("Error recording market pick:", e.message);
    }
}

/**
 * Helper to dynamically load the high risk min odds from configuration
 */
function getHighRiskMinOdds() {
    let highRiskMinOdds = 3.3; // Default fallback
    try {
        const path = require('path');
        const configPath = path.resolve(__dirname, '../browser-config.json');
        if (fs.existsSync(configPath)) {
            const browserConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (browserConfig && browserConfig.ai && typeof browserConfig.ai.highRiskMinOdds === 'number') {
                highRiskMinOdds = browserConfig.ai.highRiskMinOdds;
            }
        }
    } catch (e) {
        // ignore
    }
    return highRiskMinOdds;
}

/**
 * Update pick result when match is scored
 */
function updatePickResult(db, season, round, homeTeam, awayTeam, market, actualOdd, resultStatus) {
    try {
        const stmt = db.prepare(`
            UPDATE market_odds_history 
            SET actual_odd = ?, is_3_3_plus = ?, pick_status = ?
            WHERE season_name = ? AND round_number = ? AND home_team = ? AND away_team = ? AND market = ?
        `);
        const limitOdds = getHighRiskMinOdds();
        const is3_3Plus = actualOdd >= limitOdds ? 1 : 0;
        stmt.run(actualOdd, is3_3Plus, resultStatus, season, round, homeTeam, awayTeam, market);
    } catch (e) {
        console.error("Error updating pick result:", e.message);
    }
}

/**
 * Analyze market performance - returns odds likelihood per market
 * Returns object like:
 * {
 *   "homeWin": { total: 45, odds_3_3_plus: 28, percentage: 62.2 },
 *   "over25": { total: 30, odds_3_3_plus: 18, percentage: 60.0 },
 *   ...
 * }
 */
function analyzeMarketPerformance(db, lookbackRounds = 50) {
    try {
        const highRiskMinOdds = getHighRiskMinOdds();
        const historyRows = db.prepare(`
            SELECT
                market,
                COUNT(*) as total,
                SUM(CASE WHEN actual_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
            FROM market_odds_history
            WHERE actual_odd IS NOT NULL
            GROUP BY market
        `).all(highRiskMinOdds);

        const rows = historyRows.length > 0 ? historyRows : db.prepare(`
            SELECT
                market,
                COUNT(*) as total,
                SUM(CASE WHEN implied_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
            FROM ai_best_picks_history
            GROUP BY market
            ORDER BY total DESC
        `).all(highRiskMinOdds);

        const analysis = {};

        for (const row of rows) {
            const percentage = row.total > 0 ? ((row.odds_3_3_plus / row.total) * 100).toFixed(1) : 0;
            analysis[row.market] = {
                total: row.total,
                odds_3_3_plus: row.odds_3_3_plus,
                percentage: parseFloat(percentage),
                confidence: Math.min(100, (row.total / 30) * 100)
            };
        }

        return analysis;
    } catch (e) {
        console.error("Error analyzing market performance:", e.message);
        return {};
    }
}

/**
 * Get odds probability for a specific market
  * Returns likelihood (0-100) that this market will have 3.0+ odds
 */
function getOddsProbability(db, market, allMarkets) {
    try {
        const analysis = analyzeMarketPerformance(db);
        
        if (analysis[market]) {
            return {
                market,
                odds_probability: analysis[market].percentage,
                sample_size: analysis[market].total,
                confidence: analysis[market].confidence
            };
        }
        
        // If no specific data, return default based on market type
        const defaultOddsProbability = {
            'homeWin': 55,
            'draw': 48,
            'awayWin': 52,
            'over15': 60,
            'under15': 45,
            'over25': 65,
            'under25': 40,
            'over35': 70,
            'under35': 35,
            'gg': 58,
            'ng': 42,
            'dnbHome': 50,
            'dnbAway': 50
        };
        
        return {
            market,
            odds_probability: defaultOddsProbability[market] || 50,
            sample_size: 0,
            confidence: 30 // low confidence without data
        };
    } catch (e) {
        console.error("Error getting odds probability:", e.message);
        return { market, odds_probability: 50, sample_size: 0, confidence: 30 };
    }
}

/**
 * Calculate Odds Score for ranking picks
 * Combines: (Probability × Odds Likelihood) - weighting both equally
 * Higher score = more likely to get 3.0+ odds
 * 
 * Score = (Prob% × 0.5) + (OddsLikelihood% × 0.5)
 */
function calculateOddsScore(probability, oddsLikelihood) {
    // probability is 0-100 (our prediction)
    // oddsLikelihood is 0-100 (historical odds chance)
    const probScore = (probability / 100) * 50; // 0-50 points
    const oddsScore = (oddsLikelihood / 100) * 50; // 0-50 points
    return Math.round(probScore + oddsScore);
}

/**
 * Rank potential picks by odds score
 * Returns sorted array of picks with odds metrics
 */
function rankPicksByOdds(db, pickCandidates) {
    // pickCandidates = [ { market, prob, impliedOdd }, ... ]
    const analysis = analyzeMarketPerformance(db);
    
    const ranked = pickCandidates.map(pick => {
        const marketAnalysis = analysis[pick.market] || { 
            percentage: 50, 
            confidence: 30,
            total: 0 
        };
        
        const oddsScore = calculateOddsScore(pick.prob, marketAnalysis.percentage);
        
        return {
            ...pick,
            oddsScore,
            oddsProbability: marketAnalysis.percentage,
            oddsConfidence: marketAnalysis.confidence,
            marketSampleSize: marketAnalysis.total,
            // Composite score: higher prob picks with good odds history win
            compositeScore: (pick.prob * 0.6) + (marketAnalysis.percentage * 0.4)
        };
    });
    
    // Sort by composite score (higher = better)
    return ranked.sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Get detailed market report for UI
 */
function getMarketReport(db) {
    try {
        const analysis = analyzeMarketPerformance(db);
        const report = {
            generatedAt: new Date().toISOString(),
            markets: analysis,
            recommendations: []
        };
        
        // Find markets with highest odds success rates
        const sorted = Object.entries(analysis)
            .sort((a, b) => b[1].percentage - a[1].percentage);
        
        for (const [market, stats] of sorted) {
            if (stats.total >= 3) { // Only recommend if we have sample data
                report.recommendations.push({
                    market,
                    priority: stats.percentage >= 65 ? 'HIGH' : stats.percentage >= 50 ? 'MEDIUM' : 'LOW',
                    odds_3_3_likelihood: stats.percentage,
                    picks_made: stats.total,
                    successful_picks: stats.odds_3_3_plus,
                    confidence: stats.confidence
                });
            }
        }
        
        return report;
    } catch (e) {
        console.error("Error generating market report:", e.message);
        return { error: e.message, markets: {} };
    }
}

/**
 * Export functions for use in live_companion.js
 */
module.exports = {
    initOddsTable,
    recordMarketPick,
    updatePickResult,
    analyzeMarketPerformance,
    getOddsProbability,
    calculateOddsScore,
    rankPicksByOdds,
    getMarketReport
};
