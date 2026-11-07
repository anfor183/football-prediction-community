const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { predictFromRows } = require('./ml_predictor.js');
const { getBookmakerOdd } = require('./live_companion.js');

// Resolve the project root path
const projectRoot = path.join(__dirname, '../');

function resolveAppPath(relativePath) {
    return path.join(projectRoot, relativePath);
}

async function callAI({ provider, apiKey, model, systemPrompt, userPrompt, temperature = 0.5 }) {
    if (!apiKey) {
        throw new Error(`API key is missing for provider "${provider}".`);
    }

    const prov = provider.toLowerCase();

    if (prov === 'deepseek' || prov === 'openai' || prov === 'gemini') {
        let url = 'https://api.deepseek.com/v1/chat/completions';
        let defaultModel = 'deepseek-chat';

        if (prov === 'openai') {
            url = 'https://api.openai.com/v1/chat/completions';
            defaultModel = 'gpt-4o-mini';
        } else if (prov === 'gemini') {
            url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
            defaultModel = 'gemini-2.5-flash';
        }

        const selectedModel = model || defaultModel;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`AI API Error (${prov}): ${response.statusText}. ${errText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }

    if (prov === 'anthropic') {
        const selectedModel = model || 'claude-haiku-4-5';
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: selectedModel,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`AI API Error (Anthropic): ${response.statusText}. ${errText}`);
        }

        const data = await response.json();
        if (data.content && data.content[0] && data.content[0].text) {
            return data.content[0].text.trim();
        }
        throw new Error('Invalid response structure from Anthropic API');
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
}

// Helper: Settler function for backtest validation
function checkBetResult(marketLabel, homeScore, awayScore) {
    const totalGoals = homeScore + awayScore;
    let won = false;

    if (marketLabel === 'Home Win') won = homeScore > awayScore;
    else if (marketLabel === 'Away Win') won = awayScore > homeScore;
    else if (marketLabel === 'Draw') won = homeScore === awayScore;
    else if (marketLabel === 'Over 1.5 Goals') won = totalGoals > 1.5;
    else if (marketLabel === 'Under 1.5 Goals') won = totalGoals < 1.5;
    else if (marketLabel === 'Over 2.5 Goals') won = totalGoals > 2.5;
    else if (marketLabel === 'Under 2.5 Goals') won = totalGoals < 2.5;
    else if (marketLabel === 'Over 3.5 Goals') won = totalGoals > 3.5;
    else if (marketLabel === 'Under 3.5 Goals') won = totalGoals < 3.5;
    else if (marketLabel === 'Both Teams to Score (GG)') won = homeScore > 0 && awayScore > 0;
    else if (marketLabel === 'Both Teams NOT to Score (No GG)') won = !(homeScore > 0 && awayScore > 0);
    else if (marketLabel === 'Home Draw No Bet') {
        if (homeScore === awayScore) return 'void';
        won = homeScore > awayScore;
    } else if (marketLabel === 'Away Draw No Bet') {
        if (homeScore === awayScore) return 'void';
        won = awayScore > homeScore;
    } else {
        return 'void';
    }

    return won ? 'won' : 'lost';
}

// Helper: Apply Edge Boost for backtest validation
function applyEdgeBoost(probability, marketLabel, activeEdge, boostStrength = 10) {
    if (!activeEdge) return probability;
    if (marketLabel === activeEdge.market) {
        return probability + boostStrength;
    }
    return probability;
}

// Helper: Continuous Learning status builder for backtest validation
function getLearningStatus(db, type) {
    const status = {
        volatileHours: [],
        marketPenalties: {}
    };

    try {
        const recentPicks = db.prepare(`
            SELECT market, status, match_time 
            FROM ai_best_picks_history
            WHERE status IN ('won', 'lost') AND pick_type = ?
            ORDER BY id DESC LIMIT 250
        `).all(type);

        if (recentPicks.length > 30) {
            const hourStats = {};
            const marketStats = {};

            recentPicks.forEach(p => {
                if (!marketStats[p.market]) marketStats[p.market] = { won: 0, total: 0 };
                marketStats[p.market].total++;
                if (p.status === 'won') marketStats[p.market].won++;

                if (p.match_time && p.match_time.includes(':')) {
                    const h = parseInt(p.match_time.split(':')[0], 10);
                    if (!hourStats[h]) hourStats[h] = { won: 0, total: 0 };
                    hourStats[h].total++;
                    if (p.status === 'won') hourStats[h].won++;
                }
            });

            const learningHourThreshold = 0.28;
            const learningMarketSevereThreshold = 0.28;
            const learningMarketModerateThreshold = 0.38;

            Object.keys(hourStats).forEach(h => {
                const s = hourStats[h];
                if (s.total >= 4) {
                    const wr = s.won / s.total;
                    if (wr < learningHourThreshold) status.volatileHours.push(parseInt(h, 10));
                }
            });

            Object.keys(marketStats).forEach(m => {
                const s = marketStats[m];
                if (s.total >= 5) {
                    const wr = s.won / s.total;
                    if (wr < learningMarketSevereThreshold) status.marketPenalties[m] = 12;
                    else if (wr < learningMarketModerateThreshold) status.marketPenalties[m] = 6;
                }
            });
        }
    } catch (e) {}

    return status;
}

// Helper: Dynamic Edge Discovery for backtest validation
function getEdgeDiscovery(db, seasonName, type) {
    try {
        const rows = db.prepare(`
            SELECT market, status, probability, implied_odd
            FROM ai_best_picks_history
            WHERE status IN ('won','lost','void') AND pick_type = ?
            ORDER BY id DESC LIMIT 100
        `).all(type);

        if (!rows || rows.length < 10) {
            return null;
        }

        const marketStats = {};
        for (const row of rows) {
            const market = row.market || 'Unknown';
            const probability = Number(row.probability || (row.implied_odd ? 100 / row.implied_odd : 0));
            const impliedOdd = Number(row.implied_odd) || (probability > 0 ? parseFloat((100 / probability).toFixed(2)) : 0);

            if (probability < 55 || impliedOdd <= 0) continue;
            if (impliedOdd < 4 || impliedOdd > 50) continue;

            if (!marketStats[market]) {
                marketStats[market] = {
                    market, sampleSize: 0, wins: 0, losses: 0, voids: 0, totalProfit: 0, totalProbability: 0, totalImpliedOdd: 0, pickCount: 0
                };
            }

            const stat = marketStats[market];
            stat.pickCount += 1;
            stat.totalProbability += probability;
            stat.totalImpliedOdd += impliedOdd;

            if (row.status === 'won') {
                stat.wins += 1;
                stat.totalProfit += impliedOdd - 1;
                stat.sampleSize += 1;
            } else if (row.status === 'lost') {
                stat.losses += 1;
                stat.totalProfit -= 1;
                stat.sampleSize += 1;
            } else if (row.status === 'void') {
                stat.voids += 1;
            }
        }

        const candidates = Object.values(marketStats).map(stat => {
            const winRate = stat.sampleSize > 0 ? stat.wins / stat.sampleSize : 0;
            const avgProbability = stat.pickCount > 0 ? stat.totalProbability / stat.pickCount : 0;
            const avgImpliedOdd = stat.pickCount > 0 ? stat.totalImpliedOdd / stat.pickCount : 0;
            const roi = stat.sampleSize > 0 ? stat.totalProfit / stat.sampleSize : 0;
            return {
                market: stat.market,
                sampleSize: stat.sampleSize,
                wins: stat.wins,
                losses: stat.losses,
                voids: stat.voids,
                winRate,
                roi,
                avgProbability,
                avgImpliedOdd,
                totalProfit: stat.totalProfit
            };
        });

        const eligible = candidates.filter(c => c.sampleSize >= 10 && c.winRate >= 0.56 && c.roi >= 0.05);
        eligible.sort((a, b) => {
            const scoreA = a.winRate * 100 + a.roi * 60 + Math.log10(a.sampleSize + 1) * 3 + a.avgProbability * 0.2;
            const scoreB = b.winRate * 100 + b.roi * 60 + Math.log10(b.sampleSize + 1) * 3 + b.avgProbability * 0.2;
            return scoreB - scoreA;
        });

        return eligible.length > 0 ? eligible[0] : null;
    } catch (e) {
        return null;
    }
}

// Helper: Calculate composite pick score for backtest validation
function rankPicks(db, candidates, type) {
    if (candidates.length === 0) return [];
    
    const analysis = {};
    try {
        const stats = db.prepare(`
            SELECT market, COUNT(*) as total, SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won
            FROM ai_best_picks_history
            WHERE status IN ('won', 'lost') AND pick_type = ?
            GROUP BY market
        `).all(type);
        
        stats.forEach(s => {
            analysis[s.market] = {
                percentage: s.total > 0 ? (s.won / s.total) * 100 : 50,
                total: s.total
            };
        });
    } catch (e) {}

    const ranked = candidates.map(pick => {
        const marketAnalysis = analysis[pick.market] || { percentage: 50, total: 0 };
        return {
            ...pick,
            compositeScore: (pick.prob * 0.6) + (marketAnalysis.percentage * 0.4)
        };
    });

    return ranked.sort((a, b) => b.compositeScore - a.compositeScore);
}

// Main verification helper: runs ELO-Poisson simulation over the last 5 seasons
function verifySettingsProfitability(dbPath, isSportybet, newSettings) {
    const { decayRate, poissonWeight, poissonWeightDraw, poissonWeightWin, highRiskThreshold, highRiskMinOdds } = newSettings;
    const db = new Database(dbPath, { readonly: true });
    
    const tableName = isSportybet ? 'sporty_fixtures' : 'fixtures';
    let allMatches = [];
    try {
        allMatches = db.prepare(`SELECT * FROM ${tableName} ORDER BY id ASC`).all();
    } catch (e) {
        db.close();
        return { success: false, error: e.message };
    }
    db.close();

    const seasonsMap = {};
    allMatches.forEach(m => {
        if (!m.season_name) return;
        if (!seasonsMap[m.season_name]) seasonsMap[m.season_name] = [];
        seasonsMap[m.season_name].push(m);
    });

    const seasonNamesSorted = Object.keys(seasonsMap).sort((a, b) => {
        const numA = parseInt(a.replace(/[^\d]/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/[^\d]/g, ''), 10) || 0;
        return numA - numB;
    });

    // Backtest the last 5 seasons for speed (takes only 2-3 seconds)
    const backtestSeasons = seasonNamesSorted.slice(-5);
    if (backtestSeasons.length === 0) {
        return { success: true, profit: 0, roi: 0, totalBets: 0 };
    }

    const predictionsCache = {};
    backtestSeasons.forEach(seasonName => {
        const seasonMatches = seasonsMap[seasonName];
        seasonMatches.forEach(m => {
            const firstMatchIdInRound = seasonMatches.filter(x => x.match_time === m.match_time).reduce((min, x) => x.id < min ? x.id : min, m.id);
            const key = `${m.season_name}_${m.match_time}_${m.home_team}_${m.away_team}`;
            if (!predictionsCache[key]) {
                const trainingRows = allMatches.filter(row => row.id < firstMatchIdInRound).slice(-10000);
                if (trainingRows.length >= 5) {
                    predictionsCache[key] = predictFromRows(trainingRows, m.home_team, m.away_team, decayRate, {
                        poissonWeight, poissonWeightDraw, poissonWeightWin
                    });
                }
            }
        });
    });

    const simDb = new Database(':memory:');
    simDb.exec(`
        CREATE TABLE ai_best_picks_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            pick_type TEXT,
            home_team TEXT,
            away_team TEXT,
            market TEXT,
            probability REAL,
            implied_odd REAL,
            status TEXT,
            actual_score TEXT,
            match_time TEXT
        );
    `);

    let totalBets = 0;
    let profit = 0;
    const confidenceFloor = isSportybet ? (highRiskThreshold - 3) : (highRiskThreshold - 5);
    const highOddsMarkets = ['Home Win', 'Away Win', 'Both Teams to Score (GG)', 'Over 2.5 Goals', 'Over 3.5 Goals'];
    const allMarketsList = [
        { key: 'homeWinProb', label: 'Home Win' },
        { key: 'awayWinProb', label: 'Away Win' },
        { key: 'drawProb', label: 'Draw' },
        { key: 'over15Prob', label: 'Over 1.5 Goals' },
        { key: 'over25Prob', label: 'Over 2.5 Goals' },
        { key: 'over35Prob', label: 'Over 3.5 Goals' },
        { key: 'under15Prob', label: 'Under 1.5 Goals' },
        { key: 'under25Prob', label: 'Under 2.5 Goals' },
        { key: 'under35Prob', label: 'Under 3.5 Goals' },
        { key: 'ggProb', label: 'Both Teams to Score (GG)' },
        { key: 'noGgProb', label: 'Both Teams NOT to Score (No GG)' },
        { key: 'dnbHomeProb', label: 'Home Draw No Bet' },
        { key: 'dnbAwayProb', label: 'Away Draw No Bet' }
    ];

    for (const seasonName of backtestSeasons) {
        const seasonMatches = seasonsMap[seasonName];
        const roundTimes = Array.from(new Set(seasonMatches.map(m => m.match_time))).sort((a,b) => {
            const minIdA = seasonMatches.filter(x => x.match_time === a).reduce((min, x) => x.id < min ? x.id : min, Infinity);
            const minIdB = seasonMatches.filter(x => x.match_time === b).reduce((min, x) => x.id < min ? x.id : min, Infinity);
            return minIdA - minIdB;
        });

        for (let rIdx = 0; rIdx < roundTimes.length; rIdx++) {
            const time = roundTimes[rIdx];
            const roundMatches = seasonMatches.filter(m => m.match_time === time);
            const roundNumber = rIdx + 1;
            
            const learningStatusAiBest = getLearningStatus(simDb, 'ai_best_pick');
            const activeEdgeAiBest = getEdgeDiscovery(simDb, seasonName, 'ai_best_pick');
            
            const learningStatusHV = getLearningStatus(simDb, 'high_value_high_odds');
            const activeEdgeHV = getEdgeDiscovery(simDb, seasonName, 'high_value_high_odds');

            const candidateAiBest = [];
            const candidateHV = [];

            for (const match of roundMatches) {
                const key = `${match.season_name}_${match.match_time}_${match.home_team}_${match.away_team}`;
                const pred = predictionsCache[key];
                if (!pred) continue;

                const maxProb = Math.max(pred.homeWinProb, pred.drawProb, pred.awayWinProb);
                let confidence = Math.round(40 + (maxProb - 0.33) * 85);
                confidence = Math.max(50, Math.min(98, confidence));

                const probs = {
                    homeWinProb: Math.round(pred.homeWinProb * 100),
                    drawProb: Math.round(pred.drawProb * 100),
                    awayWinProb: Math.round(pred.awayWinProb * 100),
                    over15Prob: Math.round(pred.over15 * 100),
                    over25Prob: Math.round(pred.over25 * 100),
                    over35Prob: Math.round(pred.over35 * 100),
                    under15Prob: Math.round((1 - pred.over15) * 100),
                    under25Prob: Math.round((1 - pred.over25) * 100),
                    under35Prob: Math.round((1 - pred.over35) * 100),
                    ggProb: Math.round(pred.gg * 100),
                    noGgProb: Math.round((1 - pred.gg) * 100),
                    dnbHomeProb: Math.round((pred.homeWinProb / (pred.homeWinProb + pred.awayWinProb || 1)) * 100),
                    dnbAwayProb: Math.round((pred.awayWinProb / (pred.homeWinProb + pred.awayWinProb || 1)) * 100)
                };

                let hour = null;
                if (match.match_time && match.match_time.includes(':')) {
                    let tStr = match.match_time;
                    if (tStr.includes('T')) tStr = tStr.split('T')[1];
                    hour = parseInt(tStr.split(':')[0], 10);
                }

                if (hour === null || !learningStatusAiBest.volatileHours.includes(hour)) {
                    allMarketsList.forEach(market => {
                        if (isSportybet && market.key.includes('dnb')) return;
                        const prob = probs[market.key] || 0;
                        if (prob <= 0) return;
                        if (learningStatusAiBest.marketPenalties[market.label]) return;
                        
                        const adjustedProb = applyEdgeBoost(prob, market.label, activeEdgeAiBest);
                        let impliedOdd = parseFloat((100 / prob).toFixed(2));
                        if (match.bookmaker_odds) {
                            const bOdd = getBookmakerOdd(match.bookmaker_odds, market.label);
                            if (bOdd && bOdd > 1.0) impliedOdd = parseFloat(Number(bOdd).toFixed(2));
                        }
                        
                        if (impliedOdd >= highRiskMinOdds && confidence >= highRiskThreshold && prob >= 25) {
                            candidateAiBest.push({
                                match, market: market.label, prob, impliedOdd, adjustedProb, confidence
                            });
                        }
                    });
                }

                if (hour === null || (hour >= 8 || hour === 0)) {
                    highOddsMarkets.forEach(marketLabel => {
                        const mktKey = allMarketsList.find(m => m.label === marketLabel).key;
                        const prob = probs[mktKey] || 0;
                        if (prob <= 0) return;
                        if (learningStatusHV.marketPenalties[marketLabel]) return;

                        const adjustedProb = applyEdgeBoost(prob, marketLabel, activeEdgeHV);
                        let impliedOdd = parseFloat((100 / prob).toFixed(2));
                        if (match.bookmaker_odds) {
                            const bOdd = getBookmakerOdd(match.bookmaker_odds, marketLabel);
                            if (bOdd && bOdd > 1.0) impliedOdd = parseFloat(Number(bOdd).toFixed(2));
                        }

                        if (prob >= (isSportybet ? 50 : 60) && confidence >= confidenceFloor) {
                            candidateHV.push({
                                match, market: marketLabel, prob, impliedOdd, adjustedProb, confidence
                            });
                        }
                    });
                }
            }

            if (candidateAiBest.length > 0) {
                const ranked = rankPicks(simDb, candidateAiBest, 'ai_best_pick');
                const pick = ranked[0];
                const outcome = checkBetResult(pick.market, pick.match.home_score, pick.match.away_score);
                
                const odd = pick.impliedOdd;
                let pickProfit = 0;
                if (outcome === 'won') {
                    pickProfit = odd - 1;
                } else if (outcome === 'lost') {
                    pickProfit = -1;
                }
                
                profit += pickProfit;
                totalBets++;

                simDb.prepare(`
                    INSERT INTO ai_best_picks_history 
                    (season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd, status, actual_score, match_time)
                    VALUES (?, ?, 'ai_best_pick', ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(seasonName, roundNumber, pick.match.home_team, pick.match.away_team, pick.market, pick.prob, pick.impliedOdd, outcome, `${pick.match.home_score}:${pick.match.away_score}`, pick.match.match_time);
            }

            if (candidateHV.length > 0) {
                const ranked = rankPicks(simDb, candidateHV, 'high_value_high_odds');
                const pick = ranked[0];
                const outcome = checkBetResult(pick.market, pick.match.home_score, pick.match.away_score);

                const odd = pick.impliedOdd;
                let pickProfit = 0;
                if (outcome === 'won') {
                    pickProfit = odd - 1;
                } else if (outcome === 'lost') {
                    pickProfit = -1;
                }

                profit += pickProfit;
                totalBets++;

                simDb.prepare(`
                    INSERT INTO ai_best_picks_history 
                    (season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd, status, actual_score, match_time)
                    VALUES (?, ?, 'high_value_high_odds', ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(seasonName, roundNumber, pick.match.home_team, pick.match.away_team, pick.market, pick.prob, pick.impliedOdd, outcome, `${pick.match.home_score}:${pick.match.away_score}`, pick.match.match_time);
            }
        }
    }

    simDb.close();
    const roi = totalBets > 0 ? (profit / totalBets) * 100 : 0;
    return { success: true, profit, roi, totalBets };
}

async function runAIMetaOptimizer(dbPath, provider = 'bet9ja') {
    console.log(`[AI Meta-Optimizer] Starting optimization run for ${provider} database: ${dbPath}`);

    const configPath = resolveAppPath('browser-config.json');
    if (!fs.existsSync(configPath)) {
        console.warn(`[AI Meta-Optimizer] Config file browser-config.json not found at: ${configPath}`);
        return { success: false, error: 'Config file not found' };
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error(`[AI Meta-Optimizer] Failed to parse config file:`, e.message);
        return { success: false, error: 'Config parse failure' };
    }

    const aiConfig = config.ai || {};
    if (!aiConfig.aiOptimizerEnabled) {
        console.log(`[AI Meta-Optimizer] Feature is disabled in settings. Skipping optimization.`);
        return { success: true, optimized: false, message: 'Feature disabled' };
    }

    const aiProvider = aiConfig.provider || 'deepseek';
    let apiKey = '';
    if (aiProvider === 'deepseek') apiKey = aiConfig.deepseekApiKey;
    else if (aiProvider === 'openai') apiKey = aiConfig.openaiApiKey;
    else if (aiProvider === 'anthropic') apiKey = aiConfig.anthropicApiKey;
    else if (aiProvider === 'gemini') apiKey = aiConfig.geminiApiKey;

    if (!apiKey) {
        console.warn(`[AI Meta-Optimizer] Warning: AI Optimizer is enabled, but API key for "${aiProvider}" is missing.`);
        return { success: false, error: 'Missing API key' };
    }

    const aiModel = aiConfig.model || '';

    if (!fs.existsSync(dbPath)) {
        console.error(`[AI Meta-Optimizer] Database not found: ${dbPath}`);
        return { success: false, error: 'Database not found' };
    }

    let db;
    let recentPicks = [];
    try {
        db = new Database(dbPath);

        // Fetch recent 250 settled picks (excluding safest picks)
        recentPicks = db.prepare(`
            SELECT a.market, a.status, a.home_team, a.away_team, a.probability, a.implied_odd, a.actual_score, l.match_time 
            FROM ai_best_picks_history a
            LEFT JOIN live_predictions l ON a.season_name = l.season_name AND a.home_team = l.home_team AND a.away_team = l.away_team
            WHERE a.status IN ('won', 'lost') AND a.pick_type != 'safest'
            ORDER BY a.id DESC LIMIT 250
        `).all();

    } catch (dbErr) {
        console.error(`[AI Meta-Optimizer] Database error during stats collection:`, dbErr.message);
        if (db) db.close();
        return { success: false, error: dbErr.message };
    } finally {
        if (db) db.close();
    }

    if (recentPicks.length < 20) {
        console.log(`[AI Meta-Optimizer] Insufficient settled picks (${recentPicks.length}/20 required). Skipping optimization.`);
        return { success: true, optimized: false, message: 'Insufficient data' };
    }

    // Compile statistics
    let totalWon = 0;
    const marketStats = {};
    const hourStats = {};

    recentPicks.forEach(p => {
        const won = p.status === 'won';
        if (won) totalWon++;

        const odd = p.implied_odd || 1.0;
        const profit = won ? (odd - 1.0) : -1.0;

        // Market Stats
        if (!marketStats[p.market]) marketStats[p.market] = { won: 0, total: 0, profit: 0 };
        marketStats[p.market].total++;
        marketStats[p.market].profit += profit;
        if (won) marketStats[p.market].won++;

        // Hourly Stats
        if (p.match_time && p.match_time.includes(':')) {
            const h = parseInt(p.match_time.split(':')[0], 10);
            if (!isNaN(h)) {
                if (!hourStats[h]) hourStats[h] = { won: 0, total: 0, profit: 0 };
                hourStats[h].total++;
                hourStats[h].profit += profit;
                if (won) hourStats[h].won++;
            }
        }
    });

    const overallWinRate = parseFloat(((totalWon / recentPicks.length) * 100).toFixed(1));

    const marketReports = Object.keys(marketStats).map(m => {
        const stats = marketStats[m];
        const wr = parseFloat(((stats.won / stats.total) * 100).toFixed(1));
        const roi = parseFloat(((stats.profit / stats.total) * 100).toFixed(1));
        return { market: m, total: stats.total, won: stats.won, winRate: wr, netProfitUnits: parseFloat(stats.profit.toFixed(2)), roiPercent: roi };
    });

    const hourlyReports = Object.keys(hourStats).map(h => {
        const stats = hourStats[h];
        const wr = parseFloat(((stats.won / stats.total) * 100).toFixed(1));
        const roi = parseFloat(((stats.profit / stats.total) * 100).toFixed(1));
        return { hour: parseInt(h, 10), total: stats.total, won: stats.won, winRate: wr, netProfitUnits: parseFloat(stats.profit.toFixed(2)), roiPercent: roi };
    });

    // Compile detailed losses for AI learning
    const recentLosses = recentPicks
        .filter(p => p.status === 'lost')
        .slice(0, 20)
        .map(p => ({
            market: p.market,
            homeTeam: p.home_team,
            awayTeam: p.away_team,
            matchTime: p.match_time || 'Unknown',
            predictedProbability: p.probability,
            impliedOdd: p.implied_odd,
            actualScore: p.actual_score || 'Unknown'
        }));

    // Compile detailed wins for AI learning and focusing on what works
    const recentWins = recentPicks
        .filter(p => p.status === 'won')
        .slice(0, 20)
        .map(p => ({
            market: p.market,
            homeTeam: p.home_team,
            awayTeam: p.away_team,
            matchTime: p.match_time || 'Unknown',
            predictedProbability: p.probability,
            impliedOdd: p.implied_odd,
            actualScore: p.actual_score || 'Unknown'
        }));

    // Load current weights
    let currentDecayRate = 0.015;
    let currentPoissonWeight = 0.6;
    let currentPoissonWeightDraw = 0.6;
    let currentPoissonWeightWin = 0.6;
    let peakPerformance = null;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const wData = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof wData.decayRate === 'number') currentDecayRate = wData.decayRate;
            if (typeof wData.poissonWeight === 'number') {
                currentPoissonWeight = wData.poissonWeight;
                currentPoissonWeightDraw = typeof wData.poissonWeightDraw === 'number' ? wData.poissonWeightDraw : currentPoissonWeight;
                currentPoissonWeightWin = typeof wData.poissonWeightWin === 'number' ? wData.poissonWeightWin : currentPoissonWeight;
            }
            if (wData.peakPerformance) {
                peakPerformance = wData.peakPerformance;
            }
        } catch (e) {
            // ignore
        }
    }

    let currentLearningHourThreshold = aiConfig.learningHourThreshold || 0.45;
    let currentLearningMarketSevereThreshold = aiConfig.learningMarketSevereThreshold || 0.45;
    let currentLearningMarketModerateThreshold = aiConfig.learningMarketModerateThreshold || 0.52;

    console.log(`[AI Meta-Optimizer] Current settings - decayRate: ${currentDecayRate}, poissonWeight: ${currentPoissonWeight}, Win weight: ${currentPoissonWeightWin}, Draw weight: ${currentPoissonWeightDraw}`);
    console.log(`[AI Meta-Optimizer] Recent Win Rate: ${overallWinRate}% (${totalWon}/${recentPicks.length})`);

    const systemPrompt = 
        "You are an expert AI Data Scientist specializing in Virtual Football (simulated sports) forecasting systems.\n" +
        "The system uses a mathematical Poisson model blended with ELO strengths. The parameters you can optimize are:\n" +
        "1. decayRate (typical range: 0.005 to 0.05) - determines how quickly older match results lose importance. A higher value prioritizes recent matches.\n" +
        "2. poissonWeight (typical range: 0.1 to 1.0) - general weights the Poisson prediction vs the ELO ratings. A higher value leans more on Poisson expected goals, while a lower value leans on ELO.\n" +
        "3. poissonWeightDraw (typical range: 0.1 to 1.0) - Poisson weight specifically for Draw markets. A higher value leans on Poisson goal distribution which is excellent for predicting draws, while lower leans on ELO.\n" +
        "4. poissonWeightWin (typical range: 0.1 to 1.0) - Poisson weight specifically for Home/Away Win markets. Lower value leans on team ELO strengths which is great for win outcomes.\n" +
        "5. highRiskThreshold (typical range: 40 to 80) - the confidence threshold percentage for making an AI pick. Increase this to select only high-probability matches.\n" +
        "6. highRiskMinOdds (typical range: 1.5 to 3.5) - the minimum odds threshold for AI picks.\n" +
        "7. learningHourThreshold (typical range: 0.15 to 0.45) - the hourly win rate threshold below which an hour is blacklisted in continuous learning. Since high-risk picks win ~30% of the time, this should be lower (e.g. 0.22 - 0.28) so we don't blacklist every hour.\n" +
        "8. learningMarketSevereThreshold (typical range: 0.15 to 0.45) - win rate threshold below which a market is severely penalized.\n" +
        "9. learningMarketModerateThreshold (typical range: 0.20 to 0.52) - win rate threshold below which a market is moderately penalized.\n\n" +
        "Your task is to analyze the recent performance breakdown, the list of recent losses, and the list of recent wins of High Value and AI Best picks. Learn from both; identify what markets, hours, or patterns are producing the highest net profit and ROI (yield) versus what is causing net unit losses. Do not chase a high win rate for its own sake—instead, optimize all parameters (including thresholds and weights) to maximize net simulated profit and long-term yield. Prioritize value-based high odds picks that have positive expected value (+EV).\n" +
        "You must return ONLY a JSON object in this exact format (no markdown, no backticks, no explanations):\n" +
        "{\n" +
        "  \"decayRate\": 0.018,\n" +
        "  \"poissonWeight\": 0.55,\n" +
        "  \"poissonWeightDraw\": 0.75,\n" +
        "  \"poissonWeightWin\": 0.35,\n" +
        "  \"highRiskThreshold\": 60,\n" +
        "  \"highRiskMinOdds\": 3.3,\n" +
        "  \"learningHourThreshold\": 0.25,\n" +
        "  \"learningMarketSevereThreshold\": 0.25,\n" +
        "  \"learningMarketModerateThreshold\": 0.30,\n" +
        "  \"reasoning\": \"Optimized Poisson weights for Draw (0.75) and Wins (0.35) and set safe learning thresholds to avoid over-blacklisting hours and markets for high risk picks.\"\n" +
        "}";

    const userPrompt = JSON.stringify({
        provider,
        currentSettings: {
            decayRate: currentDecayRate,
            poissonWeight: currentPoissonWeight,
            poissonWeightDraw: currentPoissonWeightDraw,
            poissonWeightWin: currentPoissonWeightWin,
            highRiskThreshold: aiConfig.highRiskThreshold || 65,
            highRiskMinOdds: aiConfig.highRiskMinOdds || 3.3,
            learningHourThreshold: currentLearningHourThreshold,
            learningMarketSevereThreshold: currentLearningMarketSevereThreshold,
            learningMarketModerateThreshold: currentLearningMarketModerateThreshold
        },
        performanceSummary: {
            totalPicks: recentPicks.length,
            overallWinRatePercent: overallWinRate,
            marketBreakdown: marketReports,
            hourlyBreakdown: hourlyReports
        },
        recentLossesAnalysis: recentLosses,
        recentWinsAnalysis: recentWins
    }, null, 2);

    try {
        const responseText = await callAI({
            provider: aiProvider,
            apiKey,
            model: aiModel,
            systemPrompt,
            userPrompt,
            temperature: 0.2
        });

        const cleanJson = responseText.replace(/```json|```/g, '').trim();
        const output = JSON.parse(cleanJson);

        if (typeof output.decayRate !== 'number' || typeof output.poissonWeight !== 'number') {
            throw new Error('AI returned invalid non-numeric weights.');
        }

        // Clamp parameters to reasonable boundaries
        const decayRate = Math.max(0.001, Math.min(0.1, output.decayRate));
        const poissonWeight = Math.max(0.0, Math.min(1.0, output.poissonWeight));
        
        let poissonWeightDraw = currentPoissonWeightDraw;
        if (typeof output.poissonWeightDraw === 'number') {
            poissonWeightDraw = Math.max(0.0, Math.min(1.0, output.poissonWeightDraw));
        } else {
            poissonWeightDraw = poissonWeight;
        }

        let poissonWeightWin = currentPoissonWeightWin;
        if (typeof output.poissonWeightWin === 'number') {
            poissonWeightWin = Math.max(0.0, Math.min(1.0, output.poissonWeightWin));
        } else {
            poissonWeightWin = poissonWeight;
        }

        let highRiskThreshold = aiConfig.highRiskThreshold || 65;
        if (typeof output.highRiskThreshold === 'number') {
            highRiskThreshold = Math.max(20, Math.min(95, Math.round(output.highRiskThreshold)));
        }
        
        let highRiskMinOdds = aiConfig.highRiskMinOdds || 3.3;
        if (typeof output.highRiskMinOdds === 'number') {
            highRiskMinOdds = Math.max(3.3, Math.min(5.0, parseFloat(output.highRiskMinOdds.toFixed(2))));
        }

        let learningHourThreshold = currentLearningHourThreshold;
        if (typeof output.learningHourThreshold === 'number') {
            learningHourThreshold = Math.max(0.05, Math.min(0.8, output.learningHourThreshold));
        }

        let learningMarketSevereThreshold = currentLearningMarketSevereThreshold;
        if (typeof output.learningMarketSevereThreshold === 'number') {
            learningMarketSevereThreshold = Math.max(0.05, Math.min(0.8, output.learningMarketSevereThreshold));
        }

        let learningMarketModerateThreshold = currentLearningMarketModerateThreshold;
        if (typeof output.learningMarketModerateThreshold === 'number') {
            learningMarketModerateThreshold = Math.max(0.05, Math.min(0.8, output.learningMarketModerateThreshold));
        }

        const reasoning = output.reasoning || 'Optimized parameters dynamically based on recent statistics.';

        // Perform local walk-forward backtest validation over the last 5 seasons
        console.log(`[AI Meta-Optimizer] Running long-term profitability backtest verification...`);
        const isSporty = provider === 'sportybet';
        
        // 1. Run backtest on current settings for comparison
        const currentSettings = {
            decayRate: currentDecayRate,
            poissonWeight: currentPoissonWeight,
            poissonWeightDraw: currentPoissonWeightDraw,
            poissonWeightWin: currentPoissonWeightWin,
            highRiskThreshold: aiConfig.highRiskThreshold || 65,
            highRiskMinOdds: aiConfig.highRiskMinOdds || 3.3
        };
        const validationCurrent = verifySettingsProfitability(dbPath, isSporty, currentSettings);
        if (validationCurrent.success) {
            console.log(`[AI Meta-Optimizer] Current configuration backtest: Net Profit: ${validationCurrent.profit.toFixed(2)}u (ROI: ${validationCurrent.roi.toFixed(2)}%) on ${validationCurrent.totalBets} bets.`);
        }

        // 2. Run backtest on proposed settings
        const proposedSettings = {
            decayRate,
            poissonWeight,
            poissonWeightDraw,
            poissonWeightWin,
            highRiskThreshold,
            highRiskMinOdds
        };
        const validation = verifySettingsProfitability(dbPath, isSporty, proposedSettings);
        if (validation.success) {
            console.log(`[AI Meta-Optimizer] Proposed configuration backtest: Net Profit: ${validation.profit.toFixed(2)}u (ROI: ${validation.roi.toFixed(2)}%) on ${validation.totalBets} bets.`);
            
            let shouldReject = false;
            let rejectReason = '';

            let peakProfit = 0;
            if (peakPerformance && typeof peakPerformance.profit === 'number') {
                peakProfit = peakPerformance.profit;
            }

            if (validation.profit <= 0 && validation.totalBets > 0) {
                shouldReject = true;
                rejectReason = `negative backtest profit: ${validation.profit.toFixed(2)}u (ROI: ${validation.roi.toFixed(2)}%)`;
            } else if (validationCurrent.success && validationCurrent.totalBets > 0 && validation.profit < validationCurrent.profit) {
                shouldReject = true;
                rejectReason = `degraded performance: ${validation.profit.toFixed(2)}u (ROI: ${validation.roi.toFixed(2)}%) vs Current: ${validationCurrent.profit.toFixed(2)}u (ROI: ${validationCurrent.roi.toFixed(2)}%)`;
            } else if (peakProfit > 0 && validation.profit < peakProfit) {
                shouldReject = true;
                rejectReason = `below peak performance: ${validation.profit.toFixed(2)}u (ROI: ${validation.roi.toFixed(2)}%) vs Peak: ${peakProfit.toFixed(2)}u (ROI: ${peakPerformance.roi.toFixed(2)}%)`;
            }

            if (shouldReject) {
                console.warn(`[AI Meta-Optimizer] ⚠️ Proposed settings REJECTED due to ${rejectReason}.`);
                
                // Log the rejection
                const logPath = `${dbPath}.ai_optimizer.log`;
                const logEntry = `[${new Date().toISOString()}] Optimizer: REJECTED proposed settings (${rejectReason} over last 5 seasons).\n` +
                    `  - Current:  decayRate = ${currentSettings.decayRate}, poissonWeight = ${currentSettings.poissonWeight}, poissonWeightDraw = ${currentSettings.poissonWeightDraw}, poissonWeightWin = ${currentSettings.poissonWeightWin}, threshold = ${currentSettings.highRiskThreshold}, minOdds = ${currentSettings.highRiskMinOdds}\n` +
                    `  - Proposed: decayRate = ${decayRate}, poissonWeight = ${poissonWeight}, poissonWeightDraw = ${poissonWeightDraw}, poissonWeightWin = ${poissonWeightWin}, threshold = ${highRiskThreshold}, minOdds = ${highRiskMinOdds}\n` +
                    `  - Reason:   Settings failed safety backtest (did not beat or match current configuration or peak performance).\n\n`;
                fs.appendFileSync(logPath, logEntry, 'utf8');

                return { success: true, optimized: false, message: `Settings rejected: ${rejectReason}` };
            }
        } else {
            console.warn(`[AI Meta-Optimizer] ⚠️ Could not complete backtest verification: ${validation.error}. Skipping safety check.`);
        }

        // Determine if we need to update the peak performance
        let newPeakPerformance = peakPerformance;
        const proposedProfit = validation.success ? validation.profit : 0;
        const currentPeakProfit = (peakPerformance && typeof peakPerformance.profit === 'number') ? peakPerformance.profit : 0;
        
        if (!newPeakPerformance || proposedProfit > currentPeakProfit) {
            newPeakPerformance = {
                profit: proposedProfit,
                roi: validation.success ? validation.roi : 0,
                totalBets: validation.success ? validation.totalBets : 0,
                decayRate,
                poissonWeight,
                poissonWeightDraw,
                poissonWeightWin,
                highRiskThreshold,
                highRiskMinOdds,
                recordedAt: new Date().toISOString()
            };
            console.log(`[AI Meta-Optimizer] 🏆 New peak profit performance recorded: ${proposedProfit.toFixed(2)}u!`);
        }

        // Save back to weights file
        const newWeights = {
            decayRate,
            poissonWeight,
            poissonWeightDraw,
            poissonWeightWin,
            lastOptimizedByAI: new Date().toISOString(),
            previousSettings: {
                decayRate: currentDecayRate,
                poissonWeight: currentPoissonWeight,
                poissonWeightDraw: currentPoissonWeightDraw,
                poissonWeightWin: currentPoissonWeightWin
            },
            performanceSnapshot: {
                picksCount: recentPicks.length,
                winRate: overallWinRate
            },
            peakPerformance: newPeakPerformance
        };

        fs.writeFileSync(weightsPath, JSON.stringify(newWeights, null, 4), 'utf8');

        // Update browser-config.json with optimized thresholds
        config.ai = {
            ...config.ai,
            highRiskThreshold,
            highRiskMinOdds,
            learningHourThreshold,
            learningMarketSevereThreshold,
            learningMarketModerateThreshold
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');

        // Write log entry
        const logPath = `${dbPath}.ai_optimizer.log`;
        const logEntry = `[${new Date().toISOString()}] Optimizer: ${aiProvider} (${aiModel || 'default'})\n` +
            `  - Previous: decayRate = ${currentDecayRate}, poissonWeight = ${currentPoissonWeight}, poissonWeightDraw = ${currentPoissonWeightDraw}, poissonWeightWin = ${currentPoissonWeightWin}, hourThreshold = ${currentLearningHourThreshold}, marketSevere = ${currentLearningMarketSevereThreshold}, marketMod = ${currentLearningMarketModerateThreshold}\n` +
            `  - New:      decayRate = ${decayRate}, poissonWeight = ${poissonWeight}, poissonWeightDraw = ${poissonWeightDraw}, poissonWeightWin = ${poissonWeightWin}, hourThreshold = ${learningHourThreshold}, marketSevere = ${learningMarketSevereThreshold}, marketMod = ${learningMarketModerateThreshold}, threshold = ${highRiskThreshold}, minOdds = ${highRiskMinOdds}\n` +
            `  - Accuracy: ${overallWinRate}% on last ${recentPicks.length} picks\n` +
            `  - Reason:   ${reasoning}\n\n`;

        fs.appendFileSync(logPath, logEntry, 'utf8');

        console.log(`[AI Meta-Optimizer] ✅ Optimization Successful!`);
        console.log(`  ➔ decayRate: ${currentDecayRate} ➔ ${decayRate}`);
        console.log(`  ➔ poissonWeight: ${currentPoissonWeight} ➔ ${poissonWeight}`);
        console.log(`  ➔ poissonWeightDraw: ${currentPoissonWeightDraw} ➔ ${poissonWeightDraw}`);
        console.log(`  ➔ poissonWeightWin: ${currentPoissonWeightWin} ➔ ${poissonWeightWin}`);
        console.log(`  ➔ highRiskThreshold: ${aiConfig.highRiskThreshold || 65} ➔ ${highRiskThreshold}%`);
        console.log(`  ➔ highRiskMinOdds: ${aiConfig.highRiskMinOdds || 3.3} ➔ ${highRiskMinOdds}`);
        console.log(`  ➔ learningHourThreshold: ${currentLearningHourThreshold} ➔ ${learningHourThreshold}`);
        console.log(`  ➔ learningMarketSevereThreshold: ${currentLearningMarketSevereThreshold} ➔ ${learningMarketSevereThreshold}`);
        console.log(`  ➔ learningMarketModerateThreshold: ${currentLearningMarketModerateThreshold} ➔ ${learningMarketModerateThreshold}`);
        console.log(`  ➔ Reason: ${reasoning}`);

        return { success: true, optimized: true, decayRate, poissonWeight, highRiskThreshold, highRiskMinOdds };

    } catch (e) {
        console.error(`[AI Meta-Optimizer] Optimization failed:`, e.message);
        return { success: false, error: e.message };
    }
}

// Support running directly as a standalone CLI script
if (require.main === module) {
    const args = process.argv.slice(2);
    const dbPath = args[0];
    const provider = args[1] || 'bet9ja';
    
    if (!dbPath) {
        console.error('Usage: node ai_meta_optimizer.js <dbPath> [provider]');
        process.exit(1);
    }
    
    runAIMetaOptimizer(dbPath, provider)
        .then(res => {
            // Set exit code and exit cleanly after a short timeout to let async handles flush
            process.exitCode = res.success ? 0 : 1;
            setTimeout(() => {
                process.exit(process.exitCode);
            }, 500);
        })
        .catch(err => {
            console.error('Fatal execution error:', err);
            process.exitCode = 1;
            setTimeout(() => {
                process.exit(1);
            }, 500);
        });
}

module.exports = { runAIMetaOptimizer, callAI, verifySettingsProfitability };
