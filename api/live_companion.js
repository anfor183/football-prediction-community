// Force desktop device argument before loading configuration
if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}

const fs = require('fs');
const path = require('path');
const { Bet9jaGismoDirect } = require('./bet9ja_gismo_direct');
const Database = require('better-sqlite3');
const { openSafeDatabase } = require('./db_safe.js');
const config = require('../config');
const mlPredictor = require('./ml_predictor');
const { predictFromRows } = mlPredictor;
const { getTimeAdjustmentFactor, analyseTimePatterns } = require('./time_pattern_analyzer');
const oddsAnalyzer = require('./odds_analyzer');
const recEngine = require('./recommendation_engine');
const edgeGate = require('./edge_gate');
const { computeCalibrationParams, applyCalibration } = require('./calibration');
const { calibrateHtftProbs, getBestHtftBet } = require('./htft_calibration_tables');
const ensembleBridge = require('./ensemble_bridge');
const { settlementLogger, scraperLogger } = require('./robust_logger');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function getTimestampFromTimeStr(timeStr, offsetMinutes = 60) {
    if (!timeStr || !timeStr.includes(':')) return Date.now();
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    // Construct UTC timestamp representing h:m on current UTC date
    let utcTimestamp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0);
    // Bet9ja match time is in WAT (UTC+1 = +60 minutes). Subtract offset to get true UTC
    utcTimestamp -= offsetMinutes * 60 * 1000;
    // Handle day wrap around
    if (utcTimestamp < now.getTime() - 12 * 60 * 60 * 1000) {
        utcTimestamp += 24 * 60 * 60 * 1000;
    } else if (utcTimestamp > now.getTime() + 18 * 60 * 60 * 1000) {
        utcTimestamp -= 24 * 60 * 60 * 1000;
    }
    return utcTimestamp;
}

function cleanMatchTeamName(name) {
    if (!name) return '';
    let text = name.trim();
    const len = text.length;
    if (len > 0 && len % 2 === 0) {
        const half = text.substring(0, len / 2);
        if (half.length > 3 && /[a-zA-Z]/.test(half) && half + half === text) {
            text = half;
        }
    }
    if (text.length > 3) {
        const suffix = text.substring(text.length - 3);
        if (/^[A-Z0-9]{3}$/.test(suffix)) {
            text = text.substring(0, text.length - 3).trim();
        }
    }
    return text;
}

function extractScore(scoreStr) {
    if (!scoreStr) return null;
    let clean = scoreStr.replace(/\s+/g, '');
    const halfLen = clean.length / 2;
    if (clean.length % 2 === 0 && clean.substring(0, halfLen) === clean.substring(halfLen)) {
        clean = clean.substring(0, halfLen);
    }
    const match = clean.match(/^(\d+):(\d+)$/);
    if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
    const m = clean.match(/(\d+):(\d+)/);
    if (m) {
        return [parseInt(m[1], 10), parseInt(m[2], 10)];
    }
    return null;
}

function initLiveTables(db) {
    // Initialize odds tracking table
    oddsAnalyzer.initOddsTable(db);
    // Migrate DB for new recommendation engine columns
    recEngine.migrateDatabase(db);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS live_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            predicted_result TEXT,
            predicted_probs TEXT,
            actual_score TEXT,
            actual_ht_score TEXT,
            scored_status INTEGER DEFAULT 0,
            kickoff_timestamp INTEGER,
            UNIQUE(season_name, home_team, away_team) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS ai_best_picks_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            season_name TEXT,
            round_number INTEGER,
            pick_type TEXT,
            home_team TEXT,
            away_team TEXT,
            market TEXT,
            probability INTEGER,
            implied_odd REAL,
            predicted_probs TEXT,
            actual_score TEXT,
            status TEXT DEFAULT 'pending',
            UNIQUE(season_name, round_number, pick_type) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS historical_market_predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT,
            season_name TEXT,
            round_number INTEGER,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            predicted_probs TEXT,
            actual_score TEXT,
            actual_ht_score TEXT,
            kickoff_timestamp INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(provider, season_name, round_number, home_team, away_team) ON CONFLICT IGNORE
        );

        CREATE TABLE IF NOT EXISTS telegram_sent_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_key TEXT NOT NULL UNIQUE,
            msg_type TEXT NOT NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN round_number INTEGER");
    } catch (e) {
        // column already exists, ignore
    }

    try {
        db.exec("ALTER TABLE ai_best_picks_history ADD COLUMN predicted_probs TEXT");
    } catch (e) {
        // column already exists, ignore
    }

    // Migration: add scored_with_prediction column to track if a played match had a prior prediction
    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN scored_with_prediction INTEGER DEFAULT 1");
    } catch (e) {
        // column already exists, ignore
    }

    try {
        db.exec("ALTER TABLE fixtures ADD COLUMN bookmaker_odds TEXT");
    } catch (e) {
        // ignore
    }

    try {
        db.exec("ALTER TABLE ai_best_picks_history ADD COLUMN kickoff_timestamp INTEGER");
    } catch (e) {
        // column already exists, ignore
    }

    try {
        db.exec("ALTER TABLE ai_best_picks_history ADD COLUMN match_time TEXT");
    } catch (e) {
        // column already exists, ignore
    }

    // Migration: add kickoff_timestamp column if not exists
    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN kickoff_timestamp INTEGER");
    } catch (e) {
        // column already exists, ignore
    }

    try {
        db.exec("ALTER TABLE live_predictions ADD COLUMN bookmaker_odds TEXT");
    } catch (e) {
        // column already exists, ignore
    }

    // Backfill logic for null timestamps in live_predictions
    try {
        const nullRows = db.prepare("SELECT id, match_time FROM live_predictions WHERE kickoff_timestamp IS NULL").all();
        if (nullRows.length > 0) {
            const updateStmt = db.prepare("UPDATE live_predictions SET kickoff_timestamp = ? WHERE id = ?");
            db.transaction((rows) => {
                for (const r of rows) {
                    updateStmt.run(getTimestampFromTimeStr(r.match_time), r.id);
                }
            })(nullRows);
            console.log(`[Migration] Backfilled kickoff_timestamp for ${nullRows.length} matches in live_predictions.`);
        }
    } catch (e) {
        console.error("[Migration] Failed to backfill kickoff_timestamp in live_predictions:", e.message);
    }

    // Backfill logic for null timestamps in ai_best_picks_history from live_predictions
    try {
        const nullAiRows = db.prepare("SELECT id, season_name, round_number, home_team, away_team FROM ai_best_picks_history WHERE kickoff_timestamp IS NULL OR match_time IS NULL").all();
        if (nullAiRows.length > 0) {
            const updateAiStmt = db.prepare("UPDATE ai_best_picks_history SET kickoff_timestamp = COALESCE(kickoff_timestamp, ?), match_time = COALESCE(match_time, ?) WHERE id = ?");
            const findMatchStmt = db.prepare("SELECT match_time, kickoff_timestamp FROM live_predictions WHERE home_team = ? AND away_team = ? AND (season_name = ? OR round_number = ?) ORDER BY id DESC LIMIT 1");
            db.transaction((rows) => {
                for (const r of rows) {
                    const matched = findMatchStmt.get(r.home_team, r.away_team, r.season_name, r.round_number);
                    if (matched && (matched.kickoff_timestamp || matched.match_time)) {
                        updateAiStmt.run(matched.kickoff_timestamp || null, matched.match_time || null, r.id);
                    }
                }
            })(nullAiRows);
        }
    } catch (e) {
        // ignore
    }
}

async function scrapeAndPredictLiveSeason(dbPath, isHeadless = true, isContinuous = false) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: `Database file not found: ${dbPath}` };
    }

    const db = new Database(dbPath);
    initLiveTables(db);

    // Trigger AI Meta-Optimizer automatically on startup if enabled in settings
    try {
        const weightsPath = `${dbPath}.weights.json`;
        let runNeeded = false;
        if (!fs.existsSync(weightsPath)) {
            runNeeded = true;
        } else {
            const stats = fs.statSync(weightsPath);
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs > 12 * 60 * 60 * 1000) { // Older than 12 hours
                runNeeded = true;
            }
        }
        if (runNeeded) {
            console.log("[AI Meta-Optimizer] Running automatic startup calibration...");
            const { runAIMetaOptimizer } = require('./ai_meta_optimizer');
            runAIMetaOptimizer(dbPath, 'bet9ja')
                .then(res => {
                    if (res && res.success && res.optimized) {
                        console.log(`[AI Meta-Optimizer] Startup calibration applied successfully.`);
                    }
                })
                .catch(err => console.error('[AI Meta-Optimizer] Startup calibration failed:', err.message));
        }
    } catch (optErr) {
        console.error('[AI Meta-Optimizer] Failed to run startup calibration:', optErr.message);
    }

    let page, browser;
    let gismoDirect = null;
    let gismoFixtures = [];
    let gismoResults  = [];
    let offsetMinutes = -(new Date().getTimezoneOffset());
    try {
        console.log('🚀 Launching stealth browser for live companion...');
        const result = await config.connect({ headless: isHeadless, provider: 'bet9ja' });
        page = result;
        if (page && page.timezoneOffsetMinutes !== undefined) {
            offsetMinutes = page.timezoneOffsetMinutes;
            console.log(`[Timezone] Using browser-emulated timezone offset: ${offsetMinutes} minutes`);
        }

        if (page.browser) browser = page.browser();

        // ── FAST-PATH: attach CDP + Gismo capture BEFORE navigating ──────────
        try {
            const mainSession = await page.target().createCDPSession();
            await mainSession.send('Network.enable');
            await mainSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

            gismoDirect = new Bet9jaGismoDirect({
                tournamentName: 'bundesliga',
                onFixtures: (fixtures) => { gismoFixtures.push(...fixtures); },
                onResults:  (results)  => { gismoResults.push(...results); }
            });
            gismoDirect.attachCDP(mainSession);

            // Also hook child sessions (iframes may make their own API calls)
            mainSession.on('Target.attachedToTarget', async ({ sessionId }) => {
                const child = mainSession.connection().session(sessionId);
                if (!child) return;
                try {
                    await child.send('Network.enable');
                    if (gismoDirect) gismoDirect.attachCDP(child);
                } catch(e) {}
            });
            console.log('[Bet9ja Direct] ✅ CDP capture armed. Waiting for first Gismo API call...');
        } catch(e) {
            console.warn('[Bet9ja Direct] ⚠️ Could not set up CDP capture:', e.message);
        }
        // ── END FAST-PATH setup ───────────────────────────────────────────────

        console.log('🌐 Navigating to Bet9ja Virtuals live lobby...');
        await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(5000);

        // Click Virtual Football -> Bundesliga
        console.log("🔍 Finding Virtual Football menu...");
        const vfHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, button'));
            return els.find(e => e.textContent.trim().includes('Virtual Football') && e.offsetParent !== null && e.textContent.trim().length < 30);
        });
        if (vfHandle && vfHandle.asElement()) {
            await vfHandle.asElement().click();
            await delay(2000);
        }

        console.log("🔍 Selecting Virtual Football Bundesliga...");
        const bndHandle = await page.evaluateHandle(() => {
            const els = Array.from(document.querySelectorAll('a, div, span, li, button'));
            return els.find(e => e.textContent.trim().includes('Virtual Football Bundesliga') && e.offsetParent !== null && e.textContent.trim().length < 50);
        });
        if (bndHandle && bndHandle.asElement()) {
            await bndHandle.asElement().click();
            await delay(4000);
        }

        // Load Prior Matches as Training set
        const allPriorMatches = db.prepare(
            "SELECT id, home_team, away_team, home_score, away_score, ht_home_score, ht_away_score FROM betting_analytics ORDER BY id ASC"
        ).all();

        let decayRate = 0.015;
        let poissonWeight = 0.6;
        let poissonWeightDraw = 0.6;
        let poissonWeightWin = 0.6;
        const weightsPath = `${dbPath}.weights.json`;
        if (fs.existsSync(weightsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
                if (typeof data.decayRate === 'number') decayRate = data.decayRate;
                if (typeof data.poissonWeight === 'number') {
                    poissonWeight = data.poissonWeight;
                    poissonWeightDraw = typeof data.poissonWeightDraw === 'number' ? data.poissonWeightDraw : poissonWeight;
                    poissonWeightWin = typeof data.poissonWeightWin === 'number' ? data.poissonWeightWin : poissonWeight;
                }
            } catch (e) {}
        }

        const insertPred = db.prepare(`
            INSERT OR IGNORE INTO live_predictions (
                season_name, round_number, match_time, home_team, away_team, predicted_result, predicted_probs, scored_status, kickoff_timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);

        const updateScore = db.prepare(`
            UPDATE live_predictions
            SET actual_score = ?, actual_ht_score = ?, scored_status = 1
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND scored_status = 0
        `);

        let predictionsCreated = 0;
        let predictionsScored = 0;
        let activeSeasonName = "Virtual Football Bundesliga Live";

        console.log("🔄 Starting continuous live companion scraping loop...");
        while (true) {
            try {
                if (page.isClosed() || (browser && !browser.isConnected())) {
                    console.log("🔌 Browser or page closed. Exiting live companion loop...");
                    break;
                }

                // Reload weights dynamically in case they were updated by the AI Optimizer or manual changes
                try {
                    if (fs.existsSync(weightsPath)) {
                        const wData = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
                        if (typeof wData.decayRate === 'number') decayRate = wData.decayRate;
                        if (typeof wData.poissonWeight === 'number') {
                            poissonWeight = wData.poissonWeight;
                            poissonWeightDraw = typeof wData.poissonWeightDraw === 'number' ? wData.poissonWeightDraw : poissonWeight;
                            poissonWeightWin = typeof wData.poissonWeightWin === 'number' ? wData.poissonWeightWin : poissonWeight;
                        }
                    }
                } catch (wErr) {
                    // Ignore read errors
                }

                // Get Active Season Name from UI
                // ── FAST-PATH: when Gismo direct is alive, skip all DOM clicks ─────────
                if (gismoDirect && gismoDirect.isAlive()) {
                    console.log('[Bet9ja Direct] ⚡ Direct API mode active — skipping DOM scraping.');

                    // Drain queued fixtures from the Gismo client
                    const newFixtures = gismoFixtures.splice(0);
                    const newResults  = gismoResults.splice(0);

                    // Process fixtures → create predictions
                    for (const fix of newFixtures) {
                        const { homeTeam, awayTeam, matchDay, kickoffMs, matchTime } = fix;
                        if (!homeTeam || !awayTeam) continue;
                        const pred = predictFromRows(allPriorMatches, homeTeam, awayTeam, decayRate, { poissonWeight, poissonWeightDraw, poissonWeightWin });
                        if (!pred || !pred.predictedResult) continue;
                        try {
                            insertPred.run(activeSeasonName, matchDay || null, matchTime || '', homeTeam, awayTeam,
                                pred.predictedResult, JSON.stringify(pred), 0, kickoffMs || null);
                        } catch(e) { /* IGNORE – duplicate */ }
                    }

                    // Process results → score existing predictions
                    for (const res of newResults) {
                        const { homeTeam, awayTeam, homeScore, awayScore, htHome, htAway } = res;
                        if (!homeTeam || !awayTeam || homeScore == null) continue;
                        const ftScore = `${homeScore}:${awayScore}`;
                        const htScore = `${htHome}:${htAway}`;
                        updateScore.run(ftScore, htScore, activeSeasonName, homeTeam, awayTeam);
                    }

                    // Request next refresh (the client auto-polls every 25s, this is an extra nudge)
                    gismoDirect.requestRefresh();

                    await delay(5000);
                    continue; // ← skip all DOM-click logic below
                }
                // ── END FAST-PATH ─────────────────────────────────────────────────────

                const detectedSeasonName = await page.evaluate(() => {
                    // Locate current active season element
                    const els = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4, th, td'));
                    const seasonEl = els.find(e => e.textContent.includes('Virtual Football') && /\d+/.test(e.textContent) && e.offsetParent !== null && e.textContent.trim().length < 50);
                    return seasonEl ? seasonEl.textContent.trim() : null;
                });
                if (detectedSeasonName) {
                    activeSeasonName = detectedSeasonName;
                }

                console.log(`📡 Current Active Season Name: ${activeSeasonName}`);

                // Open Fixtures Tab
                console.log("📂 Opening Fixtures tab...");
                const fixturesTabHandle = await page.evaluateHandle(() => {
                    const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'fixtures' && e.offsetParent !== null && e.textContent.trim().length < 20);
                });
                if (fixturesTabHandle && fixturesTabHandle.asElement()) {
                    await fixturesTabHandle.asElement().click();
                    await delay(3000);
                }

                // Extract reference round and kickoff time from the default tab before clicking "Full listing"
                console.log("📍 Extracting reference round and kickoff time from default Rounds view...");
                const refRoundInfo = await page.evaluate(() => {
                    const els = Array.from(document.querySelectorAll('*'));
                    let roundNum = null;
                    let timeStr = null;
                    
                    // 1. Search tr rows for Round / Matchday
                    const rows = Array.from(document.querySelectorAll('tr'));
                    for (const row of rows) {
                        const text = row.textContent.trim().replace(/\s+/g, ' ');
                        const roundMatch = text.match(/(?:Round|Week|Matchday)\s+(\d+)/i);
                        if (roundMatch && !roundNum) {
                            roundNum = parseInt(roundMatch[1], 10);
                        }
                        if (text.includes('|')) {
                            const parts = text.split('|').map(p => p.trim());
                            if (parts.length >= 2 && /^\d{1,2}:\d{2}$/.test(parts[0])) {
                                if (!timeStr) {
                                    timeStr = parts[0];
                                }
                            }
                        }
                        if (roundNum && timeStr) break;
                    }
                    
                    // 2. Fallback: Search all leaf text nodes for "Round X" or "Week X"
                    if (!roundNum) {
                        for (const el of els) {
                            if (el.children.length === 0 && el.textContent) {
                                const text = el.textContent.trim();
                                const m = text.match(/^(?:Round|Week|Matchday)\s+(\d+)$/i) || text.match(/\b(?:Round|Week|Matchday)\s+(\d+)\b/i);
                                if (m) {
                                    roundNum = parseInt(m[1], 10);
                                    break;
                                }
                            }
                        }
                    }
                    
                    // 3. Fallback: Search for elements with round-active style classes
                    if (!roundNum) {
                        const roundActive = document.querySelector('.round-active, .week-active, .active-round, .active-week');
                        if (roundActive) {
                            const m = roundActive.textContent.match(/(\d+)/);
                            if (m) roundNum = parseInt(m[1], 10);
                        }
                    }
                    
                    return { roundNum, timeStr };
                });
                console.log(`📍 Found reference round info: Round ${refRoundInfo.roundNum} starts at ${refRoundInfo.timeStr}`);

                // Click "Full listing" sub-tab
                console.log("📂 Clicking 'Full listing' sub-tab...");
                const fullListingSubTabHandle = await page.evaluateHandle(() => {
                    const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'full listing' && e.offsetParent !== null && e.textContent.trim().length < 20);
                });
                if (fullListingSubTabHandle && fullListingSubTabHandle.asElement()) {
                    await fullListingSubTabHandle.asElement().click();
                    await delay(3000);
                }

                // Expand all fixtures
                console.log("🔽 Expanding all fixtures...");
                let canShowMore = true;
                let showMoreCount = 0;
                while (canShowMore && showMoreCount < 40) {
                    const buttonHandle = await page.evaluateHandle(() => {
                        const btns = Array.from(document.querySelectorAll('a, div, span, button'));
                        return btns.find(e => {
                            const text = e.textContent.trim().toLowerCase();
                            return (text === 'show more' || text === 'see more') && e.offsetParent !== null && e.textContent.trim().length < 30;
                        });
                    });
                    if (buttonHandle && buttonHandle.asElement()) {
                        try {
                            await buttonHandle.asElement().click();
                            showMoreCount++;
                            await delay(2000);
                        } catch (err) {
                            try {
                                await page.evaluate(el => el.click(), buttonHandle);
                                showMoreCount++;
                                await delay(2000);
                            } catch (jsErr) {
                                canShowMore = false;
                            }
                        }
                    } else {
                        canShowMore = false;
                    }
                }
                console.log(`🔽 Expanded fixtures list cleanly.`);

                // Scrape the DOM rows
                const scraped = await page.evaluate(() => {
                    const lines = [];
                    const rows = Array.from(document.querySelectorAll('tr'));
                    rows.forEach(row => {
                        const cells = Array.from(row.querySelectorAll('th, td')).map(td => td.textContent.trim().replace(/\s+/g, ' '));
                        if (cells.length > 0) lines.push(cells.join(' | '));
                    });
                    return lines;
                });

                console.log(`📝 Scraped ${scraped.length} raw rows from live view.`);

                // Build list of unique kickoff times from scraped rows to chronologically map round numbers
                const uniqueTimes = [];
                for (const line of scraped) {
                    if (!line.includes('|')) continue;
                    const parts = line.split('|').map(p => p.trim());
                    if (parts.length < 4) continue;
                    const timeStr = parts[0];
                    if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
                        if (!uniqueTimes.includes(timeStr)) {
                            uniqueTimes.push(timeStr);
                        }
                    }
                }

                const refIdx = (refRoundInfo && refRoundInfo.timeStr) ? uniqueTimes.indexOf(refRoundInfo.timeStr) : -1;

                let playedCount = 0;
                let unplayedCount = 0;

                for (const line of scraped) {
                    if (!line.includes('|')) continue;
                    const parts = line.split('|').map(p => p.trim());
                    if (parts.length < 4) continue;

                    const timeStr = parts[0];
                    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) continue;

                    // Determine round number chronologically using our reference round
                    let currentRound = null;
                    const matchTimeIdx = uniqueTimes.indexOf(timeStr);
                    if (refIdx !== -1 && refRoundInfo.roundNum !== null) {
                        if (matchTimeIdx !== -1) {
                            currentRound = refRoundInfo.roundNum + (matchTimeIdx - refIdx);
                            // Wrap around if necessary
                            const maxRounds = activeSeasonName.toLowerCase().includes('bundesliga') ? 30 : 38;
                            while (currentRound < 1) currentRound += maxRounds;
                            while (currentRound > maxRounds) currentRound -= maxRounds;
                        }
                    } else if (matchTimeIdx !== -1) {
                        // Robust Fallback
                        const maxRounds = activeSeasonName.toLowerCase().includes('bundesliga') ? 30 : 38;
                        currentRound = matchTimeIdx + 1;
                        if (currentRound > maxRounds) currentRound = maxRounds;
                    }

                    let homeTeam = '';
                    let awayTeam = '';
                    let htHomeScore = null;
                    let htAwayScore = null;
                    let homeScore = null;
                    let awayScore = null;

                    if (parts.length >= 6 && parts[2] === '-') {
                        homeTeam = cleanMatchTeamName(parts[1]);
                        awayTeam = cleanMatchTeamName(parts[3]);
                        const ht = extractScore(parts[4]);
                        if (ht) { htHomeScore = ht[0]; htAwayScore = ht[1]; }
                        const ft = extractScore(parts[5]);
                        if (ft) { homeScore = ft[0]; awayScore = ft[1]; }
                    } else if (parts[1].includes('-')) {
                        const teamParts = parts[1].split('-');
                        if (teamParts.length >= 2) {
                            homeTeam = cleanMatchTeamName(teamParts[0]);
                            awayTeam = cleanMatchTeamName(teamParts[1]);
                            const ht = extractScore(parts[2]);
                            if (ht) { htHomeScore = ht[0]; htAwayScore = ht[1]; }
                            const ft = extractScore(parts[3]);
                            if (ft) { homeScore = ft[0]; awayScore = ft[1]; }
                        }
                    }

                    if (!homeTeam || !awayTeam || homeTeam === awayTeam) continue;

                    const isPlayed = homeScore !== null && awayScore !== null;
                    if (isPlayed) playedCount++;
                    else unplayedCount++;

                    // Check if prediction already exists in DB
                    const existing = db.prepare(`
                        SELECT * FROM live_predictions 
                        WHERE season_name = ? AND home_team = ? AND away_team = ?
                    `).get(activeSeasonName, homeTeam, awayTeam);

                    // Calculate kickoff hour and time-of-day goal factor
                    let kickoffHour = null;
                    if (timeStr && timeStr.includes(':')) {
                        const parsed = parseInt(timeStr.split(':')[0], 10);
                        if (!isNaN(parsed) && parsed >= 0 && parsed <= 23) kickoffHour = parsed;
                    }

                    let timeGoalsFactor = 1.0;
                    if (kickoffHour !== null) {
                        try {
                            const timeAdj = getTimeAdjustmentFactor(dbPath, kickoffHour);
                            if (timeAdj && timeAdj.factor) {
                                timeGoalsFactor = timeAdj.factor;
                            }
                        } catch (e) {
                            // ignore
                        }
                    }

                    if (!existing && !isPlayed) {
                        // Generate and save ML prediction for unplayed match
                        const pred = predictFromRows(allPriorMatches, homeTeam, awayTeam, decayRate, { poissonWeight, poissonWeightDraw, poissonWeightWin }, timeGoalsFactor);
                        if (pred) {
                            let predicted = 'Draw';
                            if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb) predicted = 'Home';
                            else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb) predicted = 'Away';

                            const probs = {
                                homeWinProb:  Math.round(pred.homeWinProb * 100),
                                drawProb:     Math.round(pred.drawProb    * 100),
                                awayWinProb:  Math.round(pred.awayWinProb * 100),
                                dnbHomeProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.home : 0.5) * 100),
                                dnbAwayProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.away : 0.5) * 100),
                                ggProb:       Math.round(pred.gg          * 100),
                                over15Prob:   Math.round(pred.over15      * 100),
                                over25Prob:   Math.round(pred.over25      * 100),
                                over35Prob:   Math.round(pred.over35      * 100),
                                over45Prob:   Math.round(pred.over45      * 100),
                                over55Prob:   Math.round(pred.over55      * 100),
                                htOver25Prob: Math.round(pred.htOver25    * 100),
                                htOver35Prob: Math.round(pred.htOver35    * 100),
                                oddProb:      Math.round(pred.odd         * 100),
                                evenProb:     Math.round(pred.even        * 100),
                                htScoring1stProb: Math.round(pred.htScoring1st * 100),
                                htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
                                htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
                                htft11Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft11 : 0) * 100),
                                htft1XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft1X : 0) * 100),
                                htft12Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft12 : 0) * 100),
                                htftX1Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX1 : 0) * 100),
                                htftXXProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftXX : 0) * 100),
                                htftX2Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX2 : 0) * 100),
                                htft21Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft21 : 0) * 100),
                                htft2XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft2X : 0) * 100),
                                htft22Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft22 : 0) * 100)
                            };

                            insertPred.run(
                                activeSeasonName, currentRound, timeStr, homeTeam, awayTeam,
                                predicted, JSON.stringify(probs), getTimestampFromTimeStr(timeStr, offsetMinutes)
                            );
                            predictionsCreated++;
                        }
                    } else if (!existing && isPlayed) {
                        // Generate a retroactive ML prediction and immediately mark it scored.
                        const pred = predictFromRows(allPriorMatches, homeTeam, awayTeam, decayRate, { poissonWeight, poissonWeightDraw, poissonWeightWin }, timeGoalsFactor);
                        if (pred) {
                            let predicted = 'Draw';
                            if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb) predicted = 'Home';
                            else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb) predicted = 'Away';

                            const probs = {
                                homeWinProb:  Math.round(pred.homeWinProb * 100),
                                drawProb:     Math.round(pred.drawProb    * 100),
                                awayWinProb:  Math.round(pred.awayWinProb * 100),
                                dnbHomeProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.home : 0.5) * 100),
                                dnbAwayProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.away : 0.5) * 100),
                                ggProb:       Math.round(pred.gg          * 100),
                                over15Prob:   Math.round(pred.over15      * 100),
                                over25Prob:   Math.round(pred.over25      * 100),
                                over35Prob:   Math.round(pred.over35      * 100),
                                over45Prob:   Math.round(pred.over45      * 100),
                                over55Prob:   Math.round(pred.over55      * 100),
                                htOver25Prob: Math.round(pred.htOver25    * 100),
                                htOver35Prob: Math.round(pred.htOver35    * 100),
                                oddProb:      Math.round(pred.odd         * 100),
                                evenProb:     Math.round(pred.even        * 100),
                                htScoring1stProb: Math.round(pred.htScoring1st * 100),
                                htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
                                htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
                                htft11Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft11 : 0) * 100),
                                htft1XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft1X : 0) * 100),
                                htft12Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft12 : 0) * 100),
                                htftX1Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX1 : 0) * 100),
                                htftXXProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftXX : 0) * 100),
                                htftX2Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htftX2 : 0) * 100),
                                htft21Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft21 : 0) * 100),
                                htft2XProb: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft2X : 0) * 100),
                                htft22Prob: Math.round((pred.halftimeFulltime ? pred.halftimeFulltime.htft22 : 0) * 100)
                            };

                            const actualScoreStr = `${homeScore}:${awayScore}`;
                            const actualHtScoreStr = htHomeScore !== null ? `${htHomeScore}:${htAwayScore}` : '0:0';

                            db.prepare(`
                                INSERT OR IGNORE INTO live_predictions (
                                    season_name, round_number, match_time, home_team, away_team,
                                    predicted_result, predicted_probs, actual_score, actual_ht_score,
                                    scored_status, scored_with_prediction, kickoff_timestamp
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
                            `).run(
                                activeSeasonName, currentRound, timeStr, homeTeam, awayTeam,
                                predicted, JSON.stringify(probs), actualScoreStr, actualHtScoreStr,
                                getTimestampFromTimeStr(timeStr, offsetMinutes)
                            );
                            predictionsCreated++;
                            predictionsScored++;
                        }
                    } else if (existing && existing.scored_status === 0 && isPlayed) {
                        // Match is completed, score the existing prediction!
                        const actualScoreStr = `${homeScore}:${awayScore}`;
                        const actualHtScoreStr = htHomeScore !== null ? `${htHomeScore}:${htAwayScore}` : '0:0';

                        updateScore.run(
                            actualScoreStr, actualHtScoreStr,
                            activeSeasonName, homeTeam, awayTeam
                        );

                        // Ensure round_number is populated
                        if ((existing.round_number === null || existing.round_number === undefined) && currentRound !== null) {
                            db.prepare(`
                                UPDATE live_predictions 
                                SET round_number = ? 
                                WHERE id = ?
                            `).run(currentRound, existing.id);
                        }

                        predictionsScored++;
                    }
                }

                console.log(`✅ Live companion processing complete.`);
                console.log(`   ↳ Active Season Name: ${activeSeasonName}`);
                console.log(`   ↳ Played matches: ${playedCount}, Unplayed: ${unplayedCount}`);
                console.log(`   ↳ Predictions created: ${predictionsCreated}, Scored: ${predictionsScored}`);

                try {
                    await updateAIPicksHistory(db, activeSeasonName, dbPath);
                    console.log(`   ↳ AI Recommended Picks History updated successfully.`);

                    // Automatically broadcast newly generated predictions / AI picks to Telegram
                    try {
                        const { broadcastPendingPredictions, broadcastSettledResults } = require('./telegram_broadcaster');
                        await broadcastPendingPredictions(db);
                        await broadcastSettledResults(db);
                    } catch (tgErr) {
                        console.warn(`   ⚠️ Telegram auto-broadcast notice:`, tgErr.message);
                    }
                } catch (e) {
                    console.error(`   ⚠️ Failed to update AI Recommended Picks History:`, e.message);
                }

                // 1. Check if entire season (240 matches) is complete and needs archiving
                let totalScored = 0;
                try {
                    const res = db.prepare("SELECT count(*) as count FROM live_predictions WHERE season_name = ? AND scored_status = 1").get(activeSeasonName);
                    totalScored = res ? res.count : 0;
                } catch (e) {}

                if (totalScored >= 240) {
                    console.log(`🎉 Season ${activeSeasonName} is 100% complete! Archiving to permanent table...`);
                    try {
                        const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ?").all(activeSeasonName);
                        const insertFixture = db.prepare(`
                            INSERT OR IGNORE INTO fixtures (
                                league_name, season_name, match_time, home_team, away_team,
                                ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `);

                        let fixturesArchived = 0;
                        for (const m of completedMatches) {
                            const scores = m.actual_score.split(':').map(Number);
                            const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                            insertFixture.run(
                                "Virtual Football Bundesliga", m.season_name, m.match_time, m.home_team, m.away_team,
                                htScores[0], htScores[1], scores[0], scores[1], m.bookmaker_odds
                            );
                            fixturesArchived++;
                        }
                        console.log(`💾 Successfully archived ${fixturesArchived} fixtures to fixtures table!`);

                        // Trigger AI Meta-Optimizer asynchronously to update decay rate / poisson weights for the next season
                        try {
                            const { runAIMetaOptimizer } = require('./ai_meta_optimizer');
                            runAIMetaOptimizer(dbPath, 'bet9ja')
                                .then(res => {
                                    if (res && res.success && res.optimized) {
                                        console.log(`[AI Meta-Optimizer] New parameters successfully applied: decayRate=${res.decayRate}, poissonWeight=${res.poissonWeight}`);
                                    }
                                })
                                .catch(optErr => console.error('[AI Meta-Optimizer] Error running season optimizer:', optErr.message));
                        } catch (optErr) {
                            console.error('[AI Meta-Optimizer] Failed to load optimizer module:', optErr.message);
                        }
                    } catch (archiveErr) {
                        console.error("❌ Failed to archive live completed season:", archiveErr.message);
                    }
                }

                // 2. Auto-archive any completed matches from PREVIOUS seasons that are still sitting in live_predictions
                try {
                    const previousSeasons = db.prepare("SELECT DISTINCT season_name FROM live_predictions WHERE season_name != ?").all(activeSeasonName).map(s => s.season_name);
                    for (const prevSeason of previousSeasons) {
                        const completedMatches = db.prepare("SELECT * FROM live_predictions WHERE season_name = ? AND scored_status = 1").all(prevSeason);
                        if (completedMatches.length > 0) {
                            console.log(`🎉 Found completed previous season ${prevSeason} in live predictions! Archiving ${completedMatches.length} fixtures to permanent table...`);
                            const insertFixture = db.prepare(`
                                INSERT OR IGNORE INTO fixtures (
                                    league_name, season_name, match_time, home_team, away_team,
                                    ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `);
                            
                            let fixturesArchived = 0;
                            for (const m of completedMatches) {
                                if (m.actual_score) {
                                    const scores = m.actual_score.split(':').map(Number);
                                    const htScores = (m.actual_ht_score || "0:0").split(':').map(Number);
                                    insertFixture.run(
                                        "Virtual Football Bundesliga", m.season_name, m.match_time, m.home_team, m.away_team,
                                        htScores[0], htScores[1], scores[0], scores[1], m.bookmaker_odds
                                    );
                                    fixturesArchived++;
                                }
                            }
                            console.log(`💾 Successfully archived ${fixturesArchived} fixtures for completed previous season ${prevSeason}!`);
                        }
                    }
                } catch (prevArchiveErr) {
                    console.error("❌ Failed to auto-archive previous seasons:", prevArchiveErr.message);
                }

                // Automatically live-sync updated databases to Google Drive if configured
                try {
                    const { syncDatabasesToGoogleDrive } = require('./google_sync_helper');
                    syncDatabasesToGoogleDrive();
                } catch (_) {}

            } catch (loopErr) {
                console.error("⚠️ Error in live companion loop tick:", loopErr);
            }

            if (!isContinuous) {
                console.log("[Live Loop] Single-tick mode. Exiting loop...");
                break;
            }

            // Sleep 15 seconds
            await delay(15000);
        }

        // Clean shutdown
        if (gismoDirect) { gismoDirect.destroy(); gismoDirect = null; }
        if (browser) await browser.close();
        db.close();

        // Final sync after closing database connection
        try {
            const { syncDatabasesToGoogleDrive } = require('./google_sync_helper');
            syncDatabasesToGoogleDrive();
        } catch (_) {}

        return {
            success: true,
            seasonName: activeSeasonName,
            playedCount: 0,
            unplayedCount: 0,
            predictionsCreated,
            predictionsScored
        };

    } catch (e) {
        if (browser) await browser.close();
        db.close();
        console.error("❌ Live companion failed with error:", e);
        return { success: false, error: e.message };
    }
}

function checkLosingStreakCooldown(db, seasonName, pickType, streakLimit = 3, cooldownRounds = 3) {
    return false; // Cooldown bypassed to track all picks for flat strategy
    try {
        const picks = db.prepare(`
            SELECT status 
            FROM ai_best_picks_history
            WHERE season_name = ? AND pick_type = ?
            ORDER BY id DESC LIMIT 15
        `).all(seasonName, pickType);

        if (picks.length === 0) return false;

        const resolvedPicks = [];
        let skippedCount = 0;
        let foundResolved = false;

        for (const p of picks) {
            if (p.status === 'skipped' || p.status === 'void') {
                if (!foundResolved) {
                    if (p.status === 'skipped') skippedCount++;
                }
            } else if (p.status === 'won' || p.status === 'lost') {
                foundResolved = true;
                resolvedPicks.push(p.status);
            }
        }

        let consecutiveLosses = 0;
        for (const status of resolvedPicks) {
            if (status === 'lost') {
                consecutiveLosses++;
            } else {
                break;
            }
        }

        if (consecutiveLosses >= streakLimit) {
            if (skippedCount < cooldownRounds) {
                return true; // Cooldown is active
            }
        }
    } catch (e) {
        console.error(`Error in checkLosingStreakCooldown for ${pickType}:`, e.message);
    }
    return false;
}

function loadLearningStatus(dbPath) {
    try {
        const fs = require('fs');
        const statusPath = dbPath + '.learning.json';
        if (fs.existsSync(statusPath)) {
            return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading learning status:', e.message);
    }
    return null;
}

function saveLearningStatus(dbPath, status) {
    try {
        const fs = require('fs');
        const statusPath = dbPath + '.learning.json';
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    } catch (e) {
        console.error('Error saving learning status:', e.message);
    }
}

function discoverBet9jaEdgeFromHistory(db, seasonName, lookbackWindow = 100, options = {}) {
    const {
        minSamples = 10,
        minProbability = 0,
        winRateThreshold = 0.56,
        roiThreshold = 0.05,
        minImpliedOdd = 4,
        maxImpliedOdd = 50
    } = options;

    let rows = [];
    try {
        if (seasonName) {
            rows = db.prepare(`
                SELECT market, status, probability, implied_odd
                FROM ai_best_picks_history
                WHERE season_name = ? AND status IN ('won','lost','void')
                ORDER BY id DESC LIMIT ?
            `).all(seasonName, lookbackWindow);
        } else {
            rows = db.prepare(`
                SELECT market, status, probability, implied_odd
                FROM ai_best_picks_history
                WHERE status IN ('won','lost','void')
                ORDER BY id DESC LIMIT ?
            `).all(lookbackWindow);
        }
    } catch (e) {
        return {
            success: false,
            error: 'Failed to query ai_best_picks_history for edge discovery: ' + e.message
        };
    }

    if (!rows || rows.length === 0) {
        return {
            success: true,
            discovered: false,
            reason: 'Not enough historical Bet9ja picks for edge discovery',
            lookbackWindow,
            candidates: []
        };
    }

    const marketStats = {};

    for (const row of rows) {
        const market = row.market || 'Unknown';
        const probability = Number(row.probability || (row.implied_odd ? 100 / row.implied_odd : 0));
        const impliedOdd = Number(row.implied_odd) || (probability > 0 ? parseFloat((100 / probability).toFixed(2)) : 0);

        if (probability < minProbability || impliedOdd <= 0) {
            continue;
        }
        if (impliedOdd < minImpliedOdd || impliedOdd > maxImpliedOdd) {
            continue;
        }

        if (!marketStats[market]) {
            marketStats[market] = {
                market,
                sampleSize: 0,
                wins: 0,
                losses: 0,
                voids: 0,
                totalProfit: 0,
                totalProbability: 0,
                totalImpliedOdd: 0,
                pickCount: 0
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
            winRate: parseFloat(winRate.toFixed(3)),
            roi: parseFloat(roi.toFixed(3)),
            avgProbability: parseFloat(avgProbability.toFixed(1)),
            avgImpliedOdd: parseFloat(avgImpliedOdd.toFixed(2)),
            totalProfit: parseFloat(stat.totalProfit.toFixed(2))
        };
    });

    const eligible = candidates.filter(c => c.sampleSize >= minSamples && c.winRate >= winRateThreshold && c.roi >= roiThreshold);
    eligible.sort((a, b) => {
        const scoreA = a.winRate * 100 + a.roi * 60 + Math.log10(a.sampleSize + 1) * 3 + a.avgProbability * 0.2;
        const scoreB = b.winRate * 100 + b.roi * 60 + Math.log10(b.sampleSize + 1) * 3 + b.avgProbability * 0.2;
        return scoreB - scoreA;
    });

    const activeEdge = eligible.length > 0 ? eligible[0] : null;

    return {
        success: true,
        discovered: Boolean(activeEdge),
        activeEdge,
        candidates,
        thresholds: {
            lookbackWindow,
            minSamples,
            minProbability,
            winRateThreshold,
            roiThreshold
        }
    };
}

function applyEdgeBoost(probability, marketLabel, edgeDiscovery, boostStrength) {
    if (!edgeDiscovery || !edgeDiscovery.activeEdge || !boostStrength) {
        return probability;
    }
    if (marketLabel === edgeDiscovery.activeEdge.market) {
        return probability + boostStrength;
    }
    return probability;
}

async function vetPickWithAI(db, seasonName, round, pick, dbPath, isSportybet, browserConfig) {
    const aiConfig = browserConfig.ai || {};
    const aiProvider = aiConfig.provider || 'deepseek';
    let apiKey = '';
    if (aiProvider === 'deepseek') apiKey = aiConfig.deepseekApiKey;
    else if (aiProvider === 'openai') apiKey = aiConfig.openaiApiKey;
    else if (aiProvider === 'anthropic') apiKey = aiConfig.anthropicApiKey;

    if (!apiKey) {
        console.warn(`[AI Vetting] Skipping vetting because API key for provider ${aiProvider} is missing.`);
        return { approved: true, reason: 'No API Key' };
    }

    try {
        const { callAI } = require('./ai_meta_optimizer');
        const tableName = isSportybet ? 'sporty_betting_analytics' : 'betting_analytics';
        const homeTeam = pick.match.home_team;
        const awayTeam = pick.match.away_team;
        
        let h2hMatches = [];
        try {
            h2hMatches = db.prepare(`
                SELECT home_team, away_team, home_score, away_score, match_time 
                FROM ${tableName} 
                WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?) 
                ORDER BY id DESC LIMIT 6
            `).all(homeTeam, awayTeam, awayTeam, homeTeam);
        } catch (e) {}
        
        const h2hSummary = h2hMatches.length > 0 
            ? h2hMatches.map(m => `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team}`).join('\n')
            : '- No previous H2H matches recorded.';

        let homeMatches = [];
        try {
            homeMatches = db.prepare(`
                SELECT home_team, away_team, home_score, away_score, match_time 
                FROM ${tableName} 
                WHERE home_team = ? OR away_team = ? 
                ORDER BY id DESC LIMIT 6
            `).all(homeTeam, homeTeam);
        } catch (e) {}
        
        const homeRecentSummary = homeMatches.length > 0
            ? homeMatches.map(m => `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${m.home_team === homeTeam ? 'Home' : 'Away'})`).join('\n')
            : '- No recent matches recorded.';

        let awayMatches = [];
        try {
            awayMatches = db.prepare(`
                SELECT home_team, away_team, home_score, away_score, match_time 
                FROM ${tableName} 
                WHERE home_team = ? OR away_team = ? 
                ORDER BY id DESC LIMIT 6
            `).all(awayTeam, awayTeam);
        } catch (e) {}
        
        const awayRecentSummary = awayMatches.length > 0
            ? awayMatches.map(m => `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${m.home_team === awayTeam ? 'Home' : 'Away'})`).join('\n')
            : '- No recent matches recorded.';

        const systemPrompt = "You are a professional Virtual Football Betting Risk Manager. Your role is to examine a high-risk bet candidate recommended by a local Poisson-ELO ML model and decide whether to APPROVE or REJECT the bet to optimize the user's betting accuracy and preserve their bankroll. IMPORTANT: Focus purely on matchup dynamics, recent forms, and the statistical likelihood of the event occurring. Do NOT take the bookmaker's odds or 'value/implied odds' into consideration. Your goal is to evaluate if the outcome is likely to happen, regardless of the odds. Reject bets where the historical data or recent forms show extreme volatility, inconsistent patterns, or high risk of failure.";

        const userPrompt = `Betting Candidate:
Provider: ${isSportybet ? 'SportyBet' : 'Bet9ja'}
Matchup: ${homeTeam} vs ${awayTeam}
Market: ${pick.market}
Poisson Calculated Probability: ${pick.prob}%

Historical Head-to-Head (H2H) Matches (latest first):
${h2hSummary}

${homeTeam} Recent Matches (latest first):
${homeRecentSummary}

${awayTeam} Recent Matches (latest first):
${awayRecentSummary}

Your task:
Analyze the H2H results, goal trends, and forms.
Does this bet ('${pick.market}') have a solid statistical backing, or is it too volatile/risky?
Note: Focus purely on whether the outcome is likely to occur based on matchup/forms. Do NOT evaluate bookmaker odds, value, or price.
Provide a brief analysis of the matchup (under 80 words) and then end your response with exactly:
VERDICT: APPROVED
or
VERDICT: REJECTED`;

        console.log(`[AI Vetting] Sending matchup ${homeTeam} vs ${awayTeam} (${pick.market}) to ${aiProvider.toUpperCase()} for vetting...`);
        const responseText = await callAI({
            provider: aiProvider,
            apiKey,
            model: aiConfig.model,
            systemPrompt,
            userPrompt,
            temperature: 0.1
        });
        
        const isApproved = responseText.toUpperCase().includes('VERDICT: APPROVED');
        const isRejected = responseText.toUpperCase().includes('VERDICT: REJECTED');
        
        console.log(`[AI Vetting] Verdict: ${isApproved ? 'APPROVED' : isRejected ? 'REJECTED' : 'UNRECOGNIZED (Default APPROVED)'}`);
        console.log(`[AI Vetting] Analysis: ${responseText}`);
        
        return {
            approved: isApproved || !isRejected,
            reason: responseText
        };

    } catch (err) {
        console.error("[AI Vetting] Failed to vet pick with AI, defaulting to APPROVED:", err.message);
        return { approved: true, reason: 'Error: ' + err.message };
    }
}

function getBookmakerOdd(bookmakerOdds, marketLabel) {
    if (!bookmakerOdds) return null;
    let odds = bookmakerOdds;
    if (typeof odds === 'string') {
        try {
            odds = JSON.parse(odds);
        } catch (e) {
            return null;
        }
    }
    
    const label = marketLabel.trim().toLowerCase();
    
    // 1X2
    if (label === 'home win' || label === 'home') return odds.home;
    if (label === 'away win' || label === 'away') return odds.away;
    if (label === 'draw') return odds.draw;
    
    // Double Chance
    if (label === 'double chance (x2)' || label === 'x2 (draw/away)' || label === 'x2') return odds.x2;
    if (label === 'double chance (12)' || label === '12 (home/away)' || label === '12') return odds.dc12;
    if (label === 'double chance (1x)' || label === '1x (home/draw)' || label === '1x') return odds.dc1x;
    
    // Over/Under
    if (label === 'over 0.5 goals' || label === 'over 0.5') {
        if (Array.isArray(odds.raw) && odds.raw[53]) return parseFloat(odds.raw[53]) || odds.over05;
        return odds.over05;
    }
    if (label === 'under 0.5 goals' || label === 'under 0.5') {
        if (Array.isArray(odds.raw) && odds.raw[52]) return parseFloat(odds.raw[52]) || odds.under05;
        return odds.under05;
    }
    if (label === 'over 1.5 goals' || label === 'over 1.5') {
        if (Array.isArray(odds.raw) && odds.raw[55]) return parseFloat(odds.raw[55]) || odds.over15;
        return odds.over15;
    }
    if (label === 'under 1.5 goals' || label === 'under 1.5') {
        if (Array.isArray(odds.raw) && odds.raw[54]) return parseFloat(odds.raw[54]) || odds.under15;
        return odds.under15;
    }
    if (label === 'over 2.5 goals' || label === 'over 2.5') {
        if (Array.isArray(odds.raw) && odds.raw[57]) return parseFloat(odds.raw[57]) || odds.over25;
        return odds.over25;
    }
    if (label === 'under 2.5 goals' || label === 'under 2.5') {
        if (Array.isArray(odds.raw) && odds.raw[56]) return parseFloat(odds.raw[56]) || odds.under25;
        return odds.under25;
    }
    if (label === 'over 3.5 goals' || label === 'over 3.5') {
        if (Array.isArray(odds.raw) && odds.raw[59]) return parseFloat(odds.raw[59]) || odds.over35;
        return odds.over35;
    }
    if (label === 'under 3.5 goals' || label === 'under 3.5') {
        if (Array.isArray(odds.raw) && odds.raw[58]) return parseFloat(odds.raw[58]) || odds.under35;
        return odds.under35;
    }
    if (label === 'over 4.5 goals' || label === 'over 4.5') {
        if (Array.isArray(odds.raw) && odds.raw[61]) return parseFloat(odds.raw[61]) || odds.over45;
        return odds.over45;
    }
    if (label === 'under 4.5 goals' || label === 'under 4.5') {
        if (Array.isArray(odds.raw) && odds.raw[60]) return parseFloat(odds.raw[60]) || odds.under45;
        return odds.under45;
    }
    
    // Both Teams to Score
    if (label === 'both teams to score' || label === 'both teams to score (gg)' || label === 'gg (both teams to score)' || label === 'gg' || label === 'yes (gg)' || label === 'btts') {
        if (Array.isArray(odds.raw) && odds.raw[51]) return parseFloat(odds.raw[51]) || odds.gg;
        return odds.gg;
    }
    if (label === 'both teams not to score' || label === 'both teams not to score (no gg)' || label === 'no gg' || label === 'ng' || label === 'no (ng)') {
        if (Array.isArray(odds.raw) && odds.raw[50]) return parseFloat(odds.raw[50]) || odds.ng;
        return odds.ng;
    }

    // HT/FT
    if (odds.htft) {
        if (label.includes('1/1')) return odds.htft.htft11;
        if (label.includes('1/x') || label.includes('1/draw')) return odds.htft.htft1X;
        if (label.includes('1/2')) return odds.htft.htft12;
        if (label.includes('x/1') || label.includes('draw/1')) return odds.htft.htftX1;
        if (label.includes('x/x') || label.includes('draw/draw')) return odds.htft.htftXX;
        if (label.includes('x/2') || label.includes('draw/2')) return odds.htft.htftX2;
        if (label.includes('2/1')) return odds.htft.htft21;
        if (label.includes('2/x') || label.includes('2/draw')) return odds.htft.htft2X;
        if (label.includes('2/2')) return odds.htft.htft22;
    }

    // Raw indices support
    if (Array.isArray(odds.raw)) {
        const raw = odds.raw;

        // 1X2 & DC
        if (label === '1' || label === 'home win' || label === 'home') return parseFloat(raw[0]) || null;
        if (label === '2' || label === 'away win' || label === 'away') return parseFloat(raw[1]) || null;
        if (label === 'x' || label === 'draw') return parseFloat(raw[2]) || null;
        if (label === 'x2' || label === 'double chance (x2)' || label === 'x2 (draw/away)') return parseFloat(raw[12]) || null;
        if (label === '12' || label === 'double chance (12)' || label === '12 (home/away)') return parseFloat(raw[13]) || null;
        if (label === '1x' || label === 'double chance (1x)' || label === '1x (home/draw)') return parseFloat(raw[14]) || null;

        // Goals & BTTS
        if (label === 'ng' || label === 'both teams not to score (no gg)' || label === 'no (ng)') return parseFloat(raw[50]) || null;
        if (label === 'gg' || label === 'both teams to score (gg)' || label === 'yes (gg)') return parseFloat(raw[51]) || null;
        if (label === 'under 0.5' || label === 'under 0.5 goals') return parseFloat(raw[52]) || null;
        if (label === 'over 0.5' || label === 'over 0.5 goals') return parseFloat(raw[53]) || null;
        if (label === 'under 1.5' || label === 'under 1.5 goals') return parseFloat(raw[54]) || null;
        if (label === 'over 1.5' || label === 'over 1.5 goals') return parseFloat(raw[55]) || null;
        if (label === 'under 2.5' || label === 'under 2.5 goals') return parseFloat(raw[56]) || null;
        if (label === 'over 2.5' || label === 'over 2.5 goals') return parseFloat(raw[57]) || null;
        if (label === 'under 3.5' || label === 'under 3.5 goals') return parseFloat(raw[58]) || null;
        if (label === 'over 3.5' || label === 'over 3.5 goals') return parseFloat(raw[59]) || null;
        if (label === 'under 4.5' || label === 'under 4.5 goals') return parseFloat(raw[60]) || null;
        if (label === 'over 4.5' || label === 'over 4.5 goals') return parseFloat(raw[61]) || null;
        
        // HT/FT raw indices
        if (label.includes('1/1') || label === 'htft 1/1') return parseFloat(raw[3]) || null;
        if (label.includes('1/x') || label.includes('1/draw') || label === 'htft 1/x') return parseFloat(raw[4]) || null;
        if (label.includes('1/2') || label === 'htft 1/2') return parseFloat(raw[5]) || null;
        if (label.includes('x/1') || label.includes('draw/1') || label === 'htft x/1') return parseFloat(raw[6]) || null;
        if (label.includes('x/x') || label.includes('draw/draw') || label === 'htft x/x') return parseFloat(raw[7]) || null;
        if (label.includes('x/2') || label.includes('draw/2') || label === 'htft x/2') return parseFloat(raw[8]) || null;
        if (label.includes('2/1') || label === 'htft 2/1') return parseFloat(raw[9]) || null;
        if (label.includes('2/x') || label.includes('2/draw') || label === 'htft 2/x') return parseFloat(raw[10]) || null;
        if (label.includes('2/2') || label === 'htft 2/2') return parseFloat(raw[11]) || null;

        // Correct Scores
        if (label === '0-0' || label === 'correct score 0-0' || label === 'cs 0-0') return parseFloat(raw[33]) || null;
        if (label === '1-1' || label === 'correct score 1-1' || label === 'cs 1-1') return parseFloat(raw[34]) || null;
        if (label === '2-2' || label === 'correct score 2-2' || label === 'cs 2-2') return parseFloat(raw[35]) || null;
        if (label === '3-3' || label === 'correct score 3-3' || label === 'cs 3-3') return parseFloat(raw[36]) || null;
        
        if (label === '1-0' || label === 'correct score 1-0' || label === 'cs 1-0') return parseFloat(raw[15]) || null;
        if (label === '2-0' || label === 'correct score 2-0' || label === 'cs 2-0') return parseFloat(raw[16]) || null;
        if (label === '2-1' || label === 'correct score 2-1' || label === 'cs 2-1') return parseFloat(raw[17]) || null;
        if (label === '3-0' || label === 'correct score 3-0' || label === 'cs 3-0') return parseFloat(raw[18]) || null;
        if (label === '3-1' || label === 'correct score 3-1' || label === 'cs 3-1') return parseFloat(raw[19]) || null;
        if (label === '3-2' || label === 'correct score 3-2' || label === 'cs 3-2') return parseFloat(raw[20]) || null;
        if (label === '4-0' || label === 'correct score 4-0' || label === 'cs 4-0') return parseFloat(raw[21]) || null;
        
        if (label === '0-1' || label === 'correct score 0-1' || label === 'cs 0-1') return parseFloat(raw[22]) || null;
        if (label === '0-2' || label === 'correct score 0-2' || label === 'cs 0-2') return parseFloat(raw[23]) || null;
        if (label === '1-2' || label === 'correct score 1-2' || label === 'cs 1-2') return parseFloat(raw[24]) || null;
        if (label === '0-3' || label === 'correct score 0-3' || label === 'cs 0-3') return parseFloat(raw[25]) || null;
        if (label === '1-3' || label === 'correct score 1-3' || label === 'cs 1-3') return parseFloat(raw[26]) || null;
        if (label === '2-3' || label === 'correct score 2-3' || label === 'cs 2-3') return parseFloat(raw[27]) || null;

        // Handicaps
        if (label.includes('handicap') || label.includes('(-1)') || label.includes('(+1)')) {
            if (label.includes('home')) return parseFloat(raw[78]) || null;
            if (label.includes('draw')) return parseFloat(raw[79]) || null;
            if (label.includes('away')) return parseFloat(raw[80]) || null;
        }
    }
    
    return null;
}

async function updateAIPicksHistory(db, seasonName, dbPath) {
    let lowGoalsHours = [16]; // Default fallback
    let highRiskThreshold = 65; // Default fallback
    let highRiskMinOdds = 3.3; // Default fallback
    let edgeBacktestWindow = 100;
    let edgeMinSamples = 10;
    let edgeSignalMinProbability = 55;
    let edgeWinRateThreshold = 0.56;
    let edgeRoiThreshold = 0.05;
    let edgeOddsMin = 4;
    let edgeOddsMax = 50;
    let edgeUseAcrossSeasons = false;
    let edgeBoostStrength = 10;
    let learningHourThreshold = 0.45;
    let learningMarketSevereThreshold = 0.45;
    let learningMarketModerateThreshold = 0.52;

    let browserConfig = {};
    let apiKey = '';
    try {
        const fs = require('fs');
        const path = require('path');
        const configPath = path.resolve(__dirname, '../browser-config.json');
        if (fs.existsSync(configPath)) {
            browserConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (browserConfig && browserConfig.ai) {
                const aiProvider = browserConfig.ai.provider || 'deepseek';
                if (aiProvider === 'deepseek') apiKey = browserConfig.ai.deepseekApiKey;
                else if (aiProvider === 'openai') apiKey = browserConfig.ai.openaiApiKey;
                else if (aiProvider === 'anthropic') apiKey = browserConfig.ai.anthropicApiKey;

                if (typeof browserConfig.ai.highRiskThreshold === 'number') {
                    highRiskThreshold = browserConfig.ai.highRiskThreshold;
                }
                if (typeof browserConfig.ai.highRiskMinOdds === 'number') {
                    highRiskMinOdds = browserConfig.ai.highRiskMinOdds;
                }
                if (typeof browserConfig.ai.edgeBacktestWindow === 'number') {
                    edgeBacktestWindow = browserConfig.ai.edgeBacktestWindow;
                }
                if (typeof browserConfig.ai.edgeMinSamples === 'number') {
                    edgeMinSamples = browserConfig.ai.edgeMinSamples;
                }
                if (typeof browserConfig.ai.edgeSignalMinProbability === 'number') {
                    edgeSignalMinProbability = browserConfig.ai.edgeSignalMinProbability;
                }
                if (typeof browserConfig.ai.edgeWinRateThreshold === 'number') {
                    edgeWinRateThreshold = browserConfig.ai.edgeWinRateThreshold;
                }
                if (typeof browserConfig.ai.edgeRoiThreshold === 'number') {
                    edgeRoiThreshold = browserConfig.ai.edgeRoiThreshold;
                }
                if (typeof browserConfig.ai.edgeOddsMin === 'number') {
                    edgeOddsMin = browserConfig.ai.edgeOddsMin;
                }
                if (typeof browserConfig.ai.edgeOddsMax === 'number') {
                    edgeOddsMax = browserConfig.ai.edgeOddsMax;
                }
                if (typeof browserConfig.ai.edgeUseAcrossSeasons === 'boolean') {
                    edgeUseAcrossSeasons = browserConfig.ai.edgeUseAcrossSeasons;
                }
                if (typeof browserConfig.ai.edgeBoostStrength === 'number') {
                    edgeBoostStrength = browserConfig.ai.edgeBoostStrength;
                }
                if (typeof browserConfig.ai.learningHourThreshold === 'number') {
                    learningHourThreshold = browserConfig.ai.learningHourThreshold;
                }
                if (typeof browserConfig.ai.learningMarketSevereThreshold === 'number') {
                    learningMarketSevereThreshold = browserConfig.ai.learningMarketSevereThreshold;
                }
                if (typeof browserConfig.ai.learningMarketModerateThreshold === 'number') {
                    learningMarketModerateThreshold = browserConfig.ai.learningMarketModerateThreshold;
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ Could not load browser-config.json for highRisk parameters:', e.message);
    }

    if (dbPath) {
        try {
            const report = analyseTimePatterns(dbPath);
            if (report && report.success && report.anomalies) {
                const detectedLowHours = report.anomalies
                    .filter(a => (a.marketKey === 'over25' || a.marketKey === 'avgGoals') && a.direction === 'LOW')
                    .map(a => a.hour);
                if (detectedLowHours.length > 0) {
                    lowGoalsHours = detectedLowHours;
                }
            }
        } catch (e) {
            console.error("Error detecting low goals hours dynamically in updateAIPicksHistory:", e);
        }
    }

    const persistedLearning = dbPath ? loadLearningStatus(dbPath) : null;
    const learningStatus = {
        volatileHours: [],
        marketPenalties: {},
        edgeDiscovery: persistedLearning && persistedLearning.edgeDiscovery ? persistedLearning.edgeDiscovery : null,
        lastUpdated: Date.now()
    };

    // --- CONTINUOUS LEARNING ENGINE ---
    
    try {
        const recentPicks = db.prepare(`
            SELECT a.market, a.status, l.match_time 
            FROM ai_best_picks_history a
            LEFT JOIN live_predictions l ON a.season_name = l.season_name AND a.home_team = l.home_team AND a.away_team = l.away_team
            WHERE a.status IN ('won', 'lost')
            ORDER BY a.id DESC LIMIT 250
        `).all();

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

            Object.keys(hourStats).forEach(h => {
                const s = hourStats[h];
                if (s.total >= 4) {
                    const wr = s.won / s.total;
                    if (wr < learningHourThreshold) learningStatus.volatileHours.push(parseInt(h, 10));
                }
            });

            Object.keys(marketStats).forEach(m => {
                const s = marketStats[m];
                if (s.total >= 5) {
                    const wr = s.won / s.total;
                    if (wr < learningMarketSevereThreshold) learningStatus.marketPenalties[m] = 12; // Severe penalty
                    else if (wr < learningMarketModerateThreshold) learningStatus.marketPenalties[m] = 6; // Moderate penalty
                }
            });
            
            saveLearningStatus(dbPath, learningStatus);
        }
    } catch (e) {
        console.error("Error in Continuous Learning Engine:", e);
    }

    // --- EDGE DISCOVERY ---
    try {
        if (dbPath && (seasonName || edgeUseAcrossSeasons)) {
            const discovery = discoverBet9jaEdgeFromHistory(db, edgeUseAcrossSeasons ? null : seasonName, edgeBacktestWindow, {
                minSamples: edgeMinSamples,
                minProbability: edgeSignalMinProbability,
                winRateThreshold: edgeWinRateThreshold,
                roiThreshold: edgeRoiThreshold,
                minImpliedOdd: edgeOddsMin,
                maxImpliedOdd: edgeOddsMax
            });

            if (discovery && discovery.success) {
                if (discovery.discovered) {
                    learningStatus.edgeDiscovery = {
                        ...discovery,
                        active: true,
                        discoveredAt: Date.now(),
                        boostStrength: edgeBoostStrength
                    };
                } else if (!learningStatus.edgeDiscovery || !learningStatus.edgeDiscovery.active) {
                    learningStatus.edgeDiscovery = {
                        ...discovery,
                        active: false,
                        discoveredAt: Date.now(),
                        boostStrength: edgeBoostStrength
                    };
                }
                saveLearningStatus(dbPath, learningStatus);
            }
        }
    } catch (e) {
        console.error('Error during Bet9ja edge discovery:', e.message);
    }
    // --- END EDGE DISCOVERY ---

    // 1. Find all rounds in the active season that have predictions
    const roundsWithPredictions = db.prepare(`
        SELECT DISTINCT round_number 
        FROM live_predictions 
        WHERE season_name = ? AND round_number IS NOT NULL
    `).all(seasonName).map(r => r.round_number);

    // EDGE GATE short-circuit: if no market currently has a validated edge, skip pick generation entirely
    // (avoids running the XGBoost/Python pipelines for picks that would all be blocked).
    let _roundsToProcess = roundsWithPredictions;
    if (edgeGate.isEnabled() && !edgeGate.anyMarketValidated(edgeGate.getEvidence(db))) {
        edgeGate.logThrottled('gate:none-validated',
            '🚫 [EdgeGate] No market has a demonstrated edge over the bookmaker — publishing no picks (run `node utils/edge_gate_report.js` for details).');
        _roundsToProcess = [];
    }

    for (const round of _roundsToProcess) {
        let aiVettingRejectedReason = null;
        // Check if we already have picks recorded for this season and round_number
        const hasSafest   = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'safest'").get(seasonName, round).count;
        const hasHighValue = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'high_value'").get(seasonName, round).count;
        const hasAIBest   = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'ai_best_pick'").get(seasonName, round).count;

        if (hasSafest === 0 || hasHighValue === 0 || hasAIBest === 0) {
        const predictions = db.prepare(`
            SELECT * FROM live_predictions 
            WHERE season_name = ? AND round_number = ?
        `).all(seasonName, round);

        if (predictions.length > 0) {
            const highOddsMarkets = [
                { key: 'homeWinProb', label: 'Home Win' },
                { key: 'awayWinProb', label: 'Away Win' },
                { key: 'ggProb', label: 'Both Teams to Score (GG)' },
                { key: 'over25Prob', label: 'Over 2.5 Goals' },
                { key: 'over35Prob', label: 'Over 3.5 Goals' }
            ];

            const isSportybet = seasonName && seasonName.startsWith('Sportybet');
            const allMarkets = [
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
                { key: 'noGgProb', label: 'Both Teams NOT to Score (No GG)' }
            ];

            if (!isSportybet) {
                allMarkets.push(
                    { key: 'dnbHomeProb', label: 'Home Draw No Bet' },
                    { key: 'dnbAwayProb', label: 'Away Draw No Bet' }
                );
            }

            // Always add halftime/fulltime options if probabilities are stored
            allMarkets.push(
                { key: 'htft11Prob', label: 'HT/FT 1/1' },
                { key: 'htft1XProb', label: 'HT/FT 1/X' },
                { key: 'htft12Prob', label: 'HT/FT 1/2' },
                { key: 'htftX1Prob', label: 'HT/FT X/1' },
                { key: 'htftXXProb', label: 'HT/FT X/X' },
                { key: 'htftX2Prob', label: 'HT/FT X/2' },
                { key: 'htft21Prob', label: 'HT/FT 2/1' },
                { key: 'htft2XProb', label: 'HT/FT 2/X' },
                { key: 'htft22Prob', label: 'HT/FT 2/2' }
            );

            // ─────────────────────────────────────────────────────────────────
            // PROFESSIONAL RECOMMENDATION ENGINE (Modules 1–11)
            // Build all market candidates, enrich with full engine metadata,
            // then route through three independent pick pipelines.
            // ─────────────────────────────────────────────────────────────────

            // Load calibration parameters from historical picks
            const calibParams = computeCalibrationParams(db, 'ai_best_pick', 300);
            const safestCalibParams = computeCalibrationParams(db, 'safest', 200);
            const hvCalibParams = computeCalibrationParams(db, 'high_value', 200);

            // Load EV thresholds from browser config (with backtest-proven defaults)
            const evThresholds = {
                safest:    browserConfig?.ai?.evThresholdSafest    ?? 8,   // proven: EV≥8% → +14.9–27.2% ROI
                highValue: browserConfig?.ai?.evThresholdHighValue  ?? 10,  // proven: EV 10-42%, odds 1.5-2.8 → +10.4–17.8% ROI
                highRisk:  browserConfig?.ai?.evThresholdHighRisk   ?? 40   // proven: EV≥40%, odds≥5 → +20.9% ROI
            };

            // Build enriched candidate pool from all match+market combos
            const enrichedPool = [];

            for (const m of predictions) {
                let probs = {};
                try {
                    probs = JSON.parse(m.predicted_probs) || {};
                    if (probs.drawProb === undefined) probs.drawProb = Math.max(0, 100 - (probs.homeWinProb || 0) - (probs.awayWinProb || 0));
                    if (probs.dnbHomeProb === undefined || probs.dnbAwayProb === undefined) {
                        const h = probs.homeWinProb || 0; const a = probs.awayWinProb || 0; const t = h + a || 1;
                        probs.dnbHomeProb = Math.round((h / t) * 100);
                        probs.dnbAwayProb = Math.round((a / t) * 100);
                    }
                    if (probs.under15Prob === undefined) probs.under15Prob = Math.max(0, 100 - (probs.over15Prob || 0));
                    if (probs.under25Prob === undefined) probs.under25Prob = Math.max(0, 100 - (probs.over25Prob || 0));
                    if (probs.under35Prob === undefined) probs.under35Prob = Math.max(0, 100 - (probs.over35Prob || 0));
                    if (probs.noGgProb === undefined) probs.noGgProb = Math.max(0, 100 - (probs.ggProb || 0));
                } catch (pe) { probs = {}; }

                // ── HT/FT CALIBRATION (isotonic regression, trained on 20,413 matches) ──
                // The raw model HT/FT probs have systematic overconfidence at high values
                // (e.g. +42pp bias for htft22 at model prob > 60%). Apply calibration.
                const calibratedHtft = calibrateHtftProbs(probs);
                const HTFT_KEYS_LC = ['htft11Prob','htft1XProb','htft12Prob','htftX1Prob','htftXXProb','htftX2Prob','htft21Prob','htft2XProb','htft22Prob'];
                HTFT_KEYS_LC.forEach(k => {
                    if (calibratedHtft[k] != null) probs[k] = Math.round(calibratedHtft[k]);
                });
                // ─────────────────────────────────────────────────────────────

                let hour = null;
                if (m.match_time && m.match_time.includes(':')) {
                    hour = parseInt(m.match_time.split(':')[0], 10);
                }

                // Determine main predicted outcome for agreement scoring
                const mainOutcome = (probs.homeWinProb || 0) >= (probs.awayWinProb || 0) && (probs.homeWinProb || 0) >= (probs.drawProb || 0) ? 'home'
                                  : (probs.awayWinProb || 0) >= (probs.drawProb || 0) ? 'away' : 'draw';

                // Get model agreement (async — do in parallel below, use fallback for now)
                const agreementData = { agreementScore: 0.6, available: false, source: 'pending' };

                allMarkets.forEach(market => {
                    const prob = probs[market.key] || 0;
                    if (prob <= 0) return;

                    // Midnight Danger Zone filter preserved
                    if (hour !== null && hour >= 0 && hour <= 8) return;
                    // Goals Blackout filter preserved
                    if (hour !== null && lowGoalsHours.includes(hour) && (market.label.includes('Over') || market.label.includes('GG') || market.label.includes('Both Teams'))) return;

                    let bookmakerOdd = null;
                    if (m.bookmaker_odds) bookmakerOdd = getBookmakerOdd(m.bookmaker_odds, market.label);
                    const impliedOdd = bookmakerOdd !== null ? bookmakerOdd : parseFloat((100 / prob).toFixed(2));

                    const raw = {
                        market: market.label,
                        prob,
                        impliedOdd,
                        match: m,
                        seasonName,
                        pickType: 'ai_best_pick'
                    };

                    try {
                        // Route each candidate through the correct calibration params for its pick type
                        // Safest uses safestCalibParams, HV uses hvCalibParams, HR uses calibParams (ai_best_pick)
                        // We enrich all with ai_best_pick calibration as the base (pipelines do final filtering)
                        const enriched = recEngine.enrichCandidate(db, raw, calibParams, evThresholds, agreementData);
                        // Attach per-type calibration variants for pipeline routing
                        enriched._safestCalibrated = recEngine.enrichCandidate(db, { ...raw, pickType: 'safest' }, safestCalibParams, evThresholds, agreementData);
                        enriched._hvCalibrated = recEngine.enrichCandidate(db, { ...raw, pickType: 'high_value' }, hvCalibParams, evThresholds, agreementData);
                        enrichedPool.push(enriched);
                    } catch (e) {
                        // Enrichment failed, skip this candidate
                    }
                });
            }

            // Attempt async model agreement enrichment in background (non-blocking)
            // We fire this and let subsequent rounds benefit from trained models
            const trainingMatchesForEnsemble = (() => {
                try {
                    const allM = db.prepare(`SELECT home_team as h, away_team as a, home_score as hs, away_score as \`as\` FROM ${
                        seasonName?.startsWith('Sportybet') ? 'sporty_fixtures' : 'fixtures'
                    } ORDER BY id DESC LIMIT 2000`).all();
                    return allM.reverse();
                } catch (e) { return []; }
            })();

            // Run ensemble agreement async — updates enriched pool asynchronously
            if (enrichedPool.length > 0 && trainingMatchesForEnsemble.length > 30) {
                // Get the top unique matchups from pool to minimize calls
                const uniqueMatchups = [...new Map(enrichedPool.map(c => [`${c.match.home_team}|${c.match.away_team}`, c])).values()];
                Promise.all(uniqueMatchups.map(async (c) => {
                    try {
                        const mainOutcome = c.calibratedProbDecimal >= 0.45 ?
                            (c.probs?.homeWinProb >= c.probs?.awayWinProb ? 'home' : 'away') : 'draw';
                        const agr = await ensembleBridge.getModelAgreement(
                            trainingMatchesForEnsemble, c.match.home_team, c.match.away_team, mainOutcome
                        );
                        // Update all pool entries for this matchup
                        enrichedPool.forEach(p => {
                            if (p.match.home_team === c.match.home_team && p.match.away_team === c.match.away_team) {
                                p.agreementScore = agr.agreementScore;
                                p.modelVotes = agr.modelVotes;
                                p.agreementSource = agr.source;
                                // Rescore with updated agreement
                                p.recommendationScore = recEngine.scoreCandidate(p);
                            }
                        });
                    } catch (e) {}
                })).catch(() => {});
            }

            // Pipeline 1: Safest Pick
             // ─── DEDICATED XGBOOST ENGINE (safest_predictor.js) ───
             // Separate from AI Best and High Chance — binary classifier
             // predicting P(1X2 pick wins) for short-odds markets (1.30–1.85).
             // BATCH: all predictions scored in ONE Python call via scoreRound().
             let safest = null;
             (() => {
                 const safestEngine = require('./safest_predictor');
                 // Build matchList for batch scoring
                 const matchList = predictions.map(predRow => {
                     let rawProbs = {}, bookOdds = {};
                     try { rawProbs = JSON.parse(predRow.predicted_probs) || {}; } catch(e) {}
                     try { bookOdds = predRow.bookmaker_odds ? JSON.parse(predRow.bookmaker_odds) : {}; } catch(e) {}
                     return { rawProbs, bookOdds, meta: predRow };
                 }).filter(e => e.bookOdds && Object.keys(e.bookOdds).length > 0);

                 const bestSafestBet = safestEngine.scoreRound(matchList);

                 if (bestSafestBet) {
                     const pr = bestSafestBet.meta;
                     safest = {
                         match:      pr,
                         market:     bestSafestBet.market,
                         prob:       bestSafestBet.modelProb,
                         impliedOdd: bestSafestBet.bookOdd,
                         engineMeta: {
                             calibratedProbPct:    bestSafestBet.modelProb,
                             bookmakerImpliedProb: parseFloat((1/bestSafestBet.bookOdd*100).toFixed(1)),
                             evPct:                bestSafestBet.ev,
                             kellyFraction:        bestSafestBet.kellyFraction,
                             source:               bestSafestBet.source,
                             engine:               'safest_xgboost'
                         }
                     };
                     try {
                         let ep = {};
                         try { ep = JSON.parse(pr.predicted_probs) || {}; } catch(e) {}
                         ep._engineMeta = safest.engineMeta;
                         safest.match = { ...pr, predicted_probs: JSON.stringify(ep) };
                     } catch(e) {}
                 } else {
                     // Fallback: rule-based engine when XGBoost not ready or no edge found
                     const safestPool = enrichedPool.map(c => c._safestCalibrated || c).filter(Boolean);
                     const safestPick = recEngine.selectSafestPick(db, safestPool, evThresholds.safest);
                     if (safestPick) {
                         safest = {
                             match: safestPick.match, market: safestPick.market,
                             prob: safestPick.prob, impliedOdd: safestPick.impliedOdd,
                             engineMeta: {
                                 calibratedProbPct: safestPick.calibratedProbPct,
                                 evPct: safestPick.evPct, source: 'rule_fallback', engine: 'safest_rules'
                             }
                         };
                         try {
                             let ep = {};
                             try { ep = JSON.parse(safestPick.match.predicted_probs) || {}; } catch(e) {}
                             ep._engineMeta = safest.engineMeta;
                             safest.match = { ...safestPick.match, predicted_probs: JSON.stringify(ep) };
                         } catch(e) {}
                     }
                 }
             })();

            // Pipeline 2: High Chance Pick
            // ─── DEDICATED XGBOOST ENGINE (high_chance_predictor.js) ───
            // Completely separate from AI Best and Safest engines.
            //   • Over 2.5 Goals model  → high_chance_over25_model.json
            //   • BTTS/GG model         → high_chance_gg_model.json
            // BATCH: all predictions scored in ONE Python call per model.
            let highValue = null;
            (() => {
                const hcEngine = require('./high_chance_predictor');
                const hcMatchList = predictions.map(predRow => {
                    let rawProbs = {}, bookOdds = {};
                    try { rawProbs = JSON.parse(predRow.predicted_probs) || {}; } catch(e) {}
                    try { bookOdds = predRow.bookmaker_odds ? JSON.parse(predRow.bookmaker_odds) : {}; } catch(e) {}
                    return { rawProbs, bookOdds, meta: predRow };
                }).filter(e => e.bookOdds && Object.keys(e.bookOdds).length > 0);

                const bestHCBet = hcEngine.scoreRound(hcMatchList);

                if (bestHCBet) {
                    const pr = bestHCBet.meta;
                    highValue = {
                        match:           pr,
                        market:          bestHCBet.market,
                        prob:            bestHCBet.modelProb,
                        impliedOdd:      bestHCBet.bookOdd,
                        oddsScore:       bestHCBet.ev,
                        oddsProbability: bestHCBet.modelProb,
                        engineMeta: {
                            calibratedProbPct:    bestHCBet.modelProb,
                            bookmakerImpliedProb: parseFloat((1/bestHCBet.bookOdd*100).toFixed(1)),
                            evPct:                bestHCBet.ev,
                            kellyFraction:        bestHCBet.kellyFraction,
                            source:               bestHCBet.source,
                            engine:               'high_chance_xgboost'
                        }
                    };
                    try {
                        let ep = {};
                        try { ep = JSON.parse(pr.predicted_probs) || {}; } catch(e) {}
                        ep._engineMeta = highValue.engineMeta;
                        highValue.match = { ...pr, predicted_probs: JSON.stringify(ep) };
                    } catch(e) {}
                } else {
                    // Fallback: rule-based engine when XGBoost not ready or no edge found
                    const hvPool = enrichedPool.map(c => c._hvCalibrated || c).filter(Boolean);
                    const hvPick = recEngine.selectHighValuePick(db, hvPool, evThresholds.highValue);
                    if (hvPick) {
                        highValue = {
                            match: hvPick.match, market: hvPick.market,
                            prob: hvPick.prob, impliedOdd: hvPick.impliedOdd,
                            oddsScore: hvPick.recommendationScore, oddsProbability: hvPick.evPct,
                            engineMeta: {
                                calibratedProbPct: hvPick.calibratedProbPct,
                                evPct: hvPick.evPct, source: 'rule_fallback', engine: 'high_chance_rules'
                            }
                        };
                        try {
                            let ep = {};
                            try { ep = JSON.parse(hvPick.match.predicted_probs) || {}; } catch(e) {}
                            ep._engineMeta = highValue.engineMeta;
                            highValue.match = { ...hvPick.match, predicted_probs: JSON.stringify(ep) };
                        } catch(e) {}
                    }
                }
            })();



            // 3. High-Risk AI Best Pick
            let aiBestPick = null;
            let aiVettingRejectedReason = '';
            // Legacy fallback for vetting (preserved)
            const _legacyPickCandidates = []; // no longer used for ranking, kept for vetting compat
            const _skipLegacy = true; // skip legacy block
            if (_skipLegacy) {
            // ─── High-Risk Pipeline ─── (uses dedicated XGBoost HT/FT engine)
                // For each prediction in this round, try the XGBoost model and pick
                // the match + market with the highest calibrated EV.
                const { loadTeamForm } = require('./ai_best_predictor');
                let hrPick = null;

                for (const predRow of predictions) {
                    let rawProbs = {};
                    try { rawProbs = JSON.parse(predRow.predicted_probs) || {}; } catch(e) { continue; }

                    let bookOdds = null;
                    try { bookOdds = predRow.bookmaker_odds ? JSON.parse(predRow.bookmaker_odds) : null; } catch(e) {}
                    // Odds stored under 'htft' key in DB (e.g. { htft11: 4.04, htft22: 5.8, ... })
                    if (!bookOdds || (!bookOdds.htft && !bookOdds.halftimeFulltime)) continue;


                    // Load team form (last 15 home/away matches) from DB history
                    const homeForm = loadTeamForm(db, predRow.home_team, true, 15);
                    const awayForm = loadTeamForm(db, predRow.away_team, false, 15);

                    const liveMatchData = {
                        rawProbs,
                        homeRecentMatches: homeForm,
                        awayRecentMatches: awayForm,
                        bookmakerOdds: bookOdds
                    };

                    const candidate = recEngine.selectHighRiskPick(db, enrichedPool, evThresholds.highRisk, liveMatchData);
                    if (!candidate) continue;

                    // Keep the candidate with highest EV
                    if (!hrPick || (candidate.evPct || 0) > (hrPick.evPct || 0)) {
                        hrPick = { ...candidate, match: predRow };
                    }
                }

                // Final regime + quality gate
                if (!hrPick) {
                    hrPick = recEngine.selectHighRiskPick(db, enrichedPool, evThresholds.highRisk);
                }

                if (hrPick) {
                    aiBestPick = {
                        match: hrPick.match,
                        market: hrPick.market,
                        prob: hrPick.prob,
                        impliedOdd: hrPick.impliedOdd,
                        oddsScore: hrPick.recommendationScore,
                        oddsProbability: hrPick.evPct,
                        engineMeta: {
                            calibratedProbPct: hrPick.calibratedProbPct,
                            bookmakerImpliedProb: hrPick.bookmakerImpliedProb,
                            evPct: hrPick.evPct,
                            recommendationScore: hrPick.recommendationScore,
                            displayedConfidence: hrPick.displayedConfidence,
                            marketROIPct: hrPick.marketMetrics?.roiPct,
                            leagueROIPct: hrPick.leagueMetrics?.roiPct,
                            agreementScore: hrPick.agreementScore,
                            penaltyMultiplier: hrPick.penaltyMultiplier,
                            isDrifting: hrPick.isDrifting
                        }
                    };
                    try {
                        let existingProbs = {};
                        try { existingProbs = JSON.parse(hrPick.match.predicted_probs) || {}; } catch(e) {}
                        existingProbs._engineMeta = aiBestPick.engineMeta;
                        aiBestPick.match = { ...hrPick.match, predicted_probs: JSON.stringify(existingProbs) };
                    } catch(e) {}
                }
                // If no high-risk pick passes strict gate → aiBestPick stays null → "No High-Risk Pick Today"
            }

            // Legacy AI Best fallback block (unreachable — kept for reference structure)
            const _legacyDummy = async () => {
            // 3-legacy. Calculate AI Best Pick (High-Risk AI Pick) — LEGACY REFERENCE ONLY
            let __aiBestPick = null;
            let __pickCandidates = [];
            predictions.forEach(m => {
                let probs = {};
                try {
                    probs = JSON.parse(m.predicted_probs) || {};
                    if (probs.drawProb === undefined) {
                        probs.drawProb = Math.max(0, 100 - (probs.homeWinProb || 0) - (probs.awayWinProb || 0));
                    }
                    if (probs.dnbHomeProb === undefined || probs.dnbAwayProb === undefined) {
                        const h = probs.homeWinProb || 0;
                        const a = probs.awayWinProb || 0;
                        const total = h + a || 1;
                        probs.dnbHomeProb = Math.round((h / total) * 100);
                        probs.dnbAwayProb = Math.round((a / total) * 100);
                    }
                    if (probs.under15Prob === undefined) probs.under15Prob = Math.max(0, 100 - (probs.over15Prob || 0));
                    if (probs.under25Prob === undefined) probs.under25Prob = Math.max(0, 100 - (probs.over25Prob || 0));
                    if (probs.under35Prob === undefined) probs.under35Prob = Math.max(0, 100 - (probs.over35Prob || 0));
                    if (probs.noGgProb === undefined) probs.noGgProb = Math.max(0, 100 - (probs.ggProb || 0));
                } catch (pe) {
                    probs = {};
                }

                let hour = null;
                if (m.match_time && m.match_time.includes(':')) {
                    hour = parseInt(m.match_time.split(':')[0], 10);
                }

                // Compute match confidence score
                let confidence = 0;
                try {
                    const hw = probs.homeWinProb || 0;
                    const dr = probs.drawProb || 0;
                    const aw = probs.awayWinProb || 0;
                    const maxProb = Math.max(hw, dr, aw) / 100;
                    confidence = Math.round(40 + (maxProb - 0.33) * 85);
                    confidence = Math.max(50, Math.min(98, confidence));
                } catch (e) {}

                // Apply continuous learning ML penalties for AI Best Pick
                allMarkets.forEach(mkt => {
                    let p = probs[mkt.key] || 0;
                    if (hour !== null && learningStatus.volatileHours.includes(hour)) p -= 15;
                    if (learningStatus.marketPenalties[mkt.label]) p -= learningStatus.marketPenalties[mkt.label];
                    probs[mkt.key] = p;
                });

                allMarkets.forEach(market => {
                    const prob = probs[market.key] || 0;
                    const adjustedProb = prob > 0 ? applyEdgeBoost(prob, market.label, learningStatus.edgeDiscovery, edgeBoostStrength) : 0;
                    if (prob <= 0) return;

                    if (hour !== null && hour >= 0 && hour <= 8) {
                        return; // SKIP
                    }

                    if (hour !== null && lowGoalsHours.includes(hour) && (market.label.includes('Over') || market.label.includes('GG') || market.label.includes('Both Teams'))) {
                        return; // SKIP
                    }

                    // Strict Risk Management: Skip volatile hours and penalized markets entirely for user safety
                    if (hour !== null && learningStatus && learningStatus.volatileHours && learningStatus.volatileHours.includes(hour)) {
                        return; // SKIP
                    }
                    if (learningStatus && learningStatus.marketPenalties && learningStatus.marketPenalties[market.label]) {
                        return; // SKIP
                    }

                    let bookmakerOdd = null;
                    if (m.bookmaker_odds) {
                        bookmakerOdd = getBookmakerOdd(m.bookmaker_odds, market.label);
                    }
                    const impliedOdd = bookmakerOdd !== null ? bookmakerOdd : parseFloat((100 / prob).toFixed(2));
                    if (impliedOdd >= highRiskMinOdds && confidence >= highRiskThreshold && prob >= 25) {
                        // Collect as candidate for odds-aware ranking
                        pickCandidates.push({
                            match: m,
                            market: market.label,
                            prob,
                            impliedOdd,
                            adjustedProb
                        });
                    }
                });
            });

            // Rank candidates by odds probability using historical market performance
            if (pickCandidates.length > 0) {
                // Convert to ranking format and sort
                const rankedPicks = oddsAnalyzer.rankPicksByOdds(db,
                    pickCandidates.map(p => ({
                        ...p,
                        prob: p.adjustedProb && p.adjustedProb > p.prob ? p.adjustedProb : p.prob
                    }))
                );

                if (rankedPicks.length > 0) {
                    const bestRanked = rankedPicks[0];
                    aiBestPick = {
                        match: bestRanked.match,
                        market: bestRanked.market,
                        prob: bestRanked.prob,
                        impliedOdd: bestRanked.impliedOdd,
                        oddsScore: bestRanked.oddsScore,
                        oddsProbability: bestRanked.oddsProbability
                    };

                    // Live LLM Vetting Check
                    const liveLlmVettingEnabled = browserConfig.ai && browserConfig.ai.liveLlmVettingEnabled !== false;
                    let isApproved = true;
                    let vettingReason = '';
                    if (liveLlmVettingEnabled && apiKey) {
                        const vettingResult = await vetPickWithAI(db, seasonName, round, aiBestPick, dbPath, isSportybet, browserConfig);
                        isApproved = vettingResult.approved;
                        vettingReason = vettingResult.reason;
                    }

                    if (!isApproved) {
                        aiBestPick = null;
                        aiVettingRejectedReason = vettingReason;
                    } else {
                        if (vettingReason) {
                            try {
                                let origProbs = {};
                                try {
                                    origProbs = JSON.parse(bestRanked.match.predicted_probs) || {};
                                } catch (e) {}
                                origProbs.aiReasoning = vettingReason;
                                bestRanked.match.predicted_probs = JSON.stringify(origProbs);
                                aiBestPick.match.predicted_probs = bestRanked.match.predicted_probs;
                            } catch (e) {}
                        }

                        // Record this pick for future odds tracking since it was approved
                        try {
                            oddsAnalyzer.recordMarketPick(db, seasonName, round,
                                aiBestPick.match.home_team, aiBestPick.match.away_team,
                                aiBestPick.market, aiBestPick.prob);
                        } catch (e) {
                            console.warn("Failed to record market pick:", e.message);
                        }
                    }
                }
            }

            // High-quality fallback if no AI Best Pick satisfies strict filters
            if (!aiBestPick && predictions.length > 0) {
                let fallbackCandidates = [];
                
                predictions.forEach(m => {
                    let probs = {};
                    try {
                        probs = JSON.parse(m.predicted_probs) || {};
                        if (probs.drawProb === undefined) {
                            probs.drawProb = Math.max(0, 100 - (probs.homeWinProb || 0) - (probs.awayWinProb || 0));
                        }
                        if (probs.dnbHomeProb === undefined || probs.dnbAwayProb === undefined) {
                            const h = probs.homeWinProb || 0;
                            const a = probs.awayWinProb || 0;
                            const total = h + a || 1;
                            probs.dnbHomeProb = Math.round((h / total) * 100);
                            probs.dnbAwayProb = Math.round((a / total) * 100);
                        }
                        if (probs.under15Prob === undefined) probs.under15Prob = Math.max(0, 100 - (probs.over15Prob || 0));
                        if (probs.under25Prob === undefined) probs.under25Prob = Math.max(0, 100 - (probs.over25Prob || 0));
                        if (probs.under35Prob === undefined) probs.under35Prob = Math.max(0, 100 - (probs.over35Prob || 0));
                        if (probs.noGgProb === undefined) probs.noGgProb = Math.max(0, 100 - (probs.ggProb || 0));
                    } catch (pe) {
                        probs = {};
                    }

                    let hour = null;
                    if (m.match_time && m.match_time.includes(':')) {
                        hour = parseInt(m.match_time.split(':')[0], 10);
                    }

                    // Compute match confidence score
                    let confidence = 0;
                    try {
                        const hw = probs.homeWinProb || 0;
                        const dr = probs.drawProb || 0;
                        const aw = probs.awayWinProb || 0;
                        const maxProb = Math.max(hw, dr, aw) / 100;
                        confidence = Math.round(40 + (maxProb - 0.33) * 85);
                        confidence = Math.max(50, Math.min(98, confidence));
                    } catch (e) {}

                    allMarkets.forEach(mkt => {
                        let p = probs[mkt.key] || 0;
                        if (hour !== null && learningStatus.volatileHours.includes(hour)) p -= 15;
                        if (learningStatus.marketPenalties[mkt.label]) p -= learningStatus.marketPenalties[mkt.label];
                        probs[mkt.key] = p;
                    });

                    allMarkets.forEach(market => {
                        const prob = probs[market.key] || 0;
                        if (prob <= 0) return;

                        if (hour !== null && hour >= 0 && hour <= 8 && (market.label.includes('Over') || market.label.includes('GG') || market.label.includes('Both Teams'))) {
                            return; // Skip goals in midnight zone
                        }

                        if (hour !== null && lowGoalsHours.includes(hour) && (market.label.includes('Over') || market.label.includes('GG') || market.label.includes('Both Teams'))) {
                            return; // Skip goals blackout
                        }

                        // Strict Risk Management: Skip volatile hours and penalized markets entirely for user safety
                        if (hour !== null && learningStatus && learningStatus.volatileHours && learningStatus.volatileHours.includes(hour)) {
                            return; // SKIP
                        }
                        if (learningStatus && learningStatus.marketPenalties && learningStatus.marketPenalties[market.label]) {
                            return; // SKIP
                        }

                        const adjustedProb = prob > 0 ? applyEdgeBoost(prob, market.label, learningStatus.edgeDiscovery, edgeBoostStrength) : 0;
                        let bookmakerOdd = null;
                        if (m.bookmaker_odds) {
                            bookmakerOdd = getBookmakerOdd(m.bookmaker_odds, market.label);
                        }
                        const impliedOdd = bookmakerOdd !== null ? bookmakerOdd : parseFloat((100 / prob).toFixed(2));
                        if (impliedOdd >= highRiskMinOdds && confidence >= (highRiskThreshold - 5) && adjustedProb > prob && prob >= 25) {
                            // Collect fallback candidates for odds-aware ranking
                            fallbackCandidates.push({
                                match: m,
                                market: market.label,
                                prob,
                                impliedOdd,
                                adjustedProb
                            });
                        }
                    });
                });
                
                // Rank fallback candidates by odds score
                if (fallbackCandidates.length > 0) {
                    const rankedFallbacks = oddsAnalyzer.rankPicksByOdds(db, 
                        fallbackCandidates.map(p => ({
                            ...p,
                            prob: p.adjustedProb && p.adjustedProb > p.prob ? p.adjustedProb : p.prob
                        }))
                    );
                    
                    if (rankedFallbacks.length > 0) {
                        const bestFallback = rankedFallbacks[0];
                        aiBestPick = {
                            match: bestFallback.match,
                            market: bestFallback.market,
                            prob: bestFallback.prob,
                            impliedOdd: bestFallback.impliedOdd,
                            oddsScore: bestFallback.oddsScore,
                            oddsProbability: bestFallback.oddsProbability
                        };
                        
                        // Live LLM Vetting Check for Fallback Pick
                        const liveLlmVettingEnabled = browserConfig.ai && browserConfig.ai.liveLlmVettingEnabled !== false;
                        let isApproved = true;
                        let vettingReason = '';
                        if (liveLlmVettingEnabled && apiKey) {
                            const vettingResult = await vetPickWithAI(db, seasonName, round, aiBestPick, dbPath, isSportybet, browserConfig);
                            isApproved = vettingResult.approved;
                            vettingReason = vettingResult.reason;
                        }

                        if (!isApproved) {
                            aiBestPick = null;
                            aiVettingRejectedReason = vettingReason;
                        } else {
                            if (vettingReason) {
                                try {
                                    let origProbs = {};
                                    try {
                                        origProbs = JSON.parse(bestFallback.match.predicted_probs) || {};
                                    } catch (e) {}
                                    origProbs.aiReasoning = vettingReason;
                                    bestFallback.match.predicted_probs = JSON.stringify(origProbs);
                                    aiBestPick.match.predicted_probs = bestFallback.match.predicted_probs;
                                } catch (e) {}
                            }

                            // Record this fallback pick since it was approved
                            try {
                                oddsAnalyzer.recordMarketPick(db, seasonName, round, 
                                    aiBestPick.match.home_team, aiBestPick.match.away_team, 
                                    aiBestPick.market, aiBestPick.prob);
                            } catch (e) {
                                console.warn("Failed to record fallback market pick:", e.message);
                        }
                    }
                }
            }
        };
            }; // close _legacyDummy — Insert section must be outside this function

        // ── EDGE GATE: only publish picks whose market has a demonstrated, time-stable edge ──
        // (see utils/edge_gate.js — backtests showed forced picks just pay the bookmaker margin)
        if (edgeGate.isEnabled()) {
            const _gateTargets = [['safest', safest], ['high_value', highValue], ['ai_best_pick', aiBestPick]];
            for (const [_gType, _gPick] of _gateTargets) {
                if (!_gPick) continue;
                const _gRes = edgeGate.check(db, _gType, _gPick);
                if (!_gRes.allowed) {
                    edgeGate.logThrottled(`block:${_gType}:${_gPick.market}`,
                        `🚫 [EdgeGate] ${_gType} pick "${_gPick.market}" blocked (round ${round}): ${_gRes.reason}`);
                    if (_gType === 'safest') safest = null;
                    else if (_gType === 'high_value') highValue = null;
                    else aiBestPick = null;
                }
            }
        }

        // Helper: Ensure match has not already kicked off in the past
        const isNotPast = (ko) => !ko || ko >= Date.now() - 30 * 1000;

        // Insert Safest Pick (Real Match Only)
            const hasSafest = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'safest'").get(seasonName, round).count;
            const sfKickoff = safest && safest.match ? (safest.match.kickoff_timestamp || safest.match.kickoffMs || null) : null;
            if (hasSafest === 0 && safest && safest.match && safest.match.home_team && !safest.match.home_team.includes('Skipped') && isNotPast(sfKickoff)) {
                const sfMeta = safest.engineMeta || {};
                const sfTime = safest.match.match_time || safest.match.matchTime || null;
                db.prepare(`
                    INSERT OR IGNORE INTO ai_best_picks_history (
                        season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd,
                        ev_score, calibrated_prob, recommendation_score, displayed_confidence,
                        market_roi, league_roi, agreement_score, penalty_multiplier, kickoff_timestamp, match_time, status
                    ) VALUES (?, ?, 'safest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `).run(
                    seasonName, round,
                    safest.match.home_team, safest.match.away_team,
                    safest.market, safest.prob, safest.impliedOdd,
                    sfMeta.evPct ?? null,
                    sfMeta.calibratedProbPct ?? null,
                    sfMeta.recommendationScore ?? null,
                    sfMeta.displayedConfidence ?? null,
                    sfMeta.marketROIPct ?? null,
                    sfMeta.leagueROIPct ?? null,
                    sfMeta.agreementScore ?? null,
                    sfMeta.penaltyMultiplier ?? null,
                    sfKickoff,
                    sfTime
                );
            }

            // Insert High Value Pick (Real Match Only)
            const hasHighValue = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'high_value'").get(seasonName, round).count;
            const hvKickoff = highValue && highValue.match ? (highValue.match.kickoff_timestamp || highValue.match.kickoffMs || null) : null;
            if (hasHighValue === 0 && highValue && highValue.match && highValue.match.home_team && !highValue.match.home_team.includes('Skipped') && isNotPast(hvKickoff)) {
                const hvMeta = highValue.engineMeta || {};
                const hvTime = highValue.match.match_time || highValue.match.matchTime || null;
                db.prepare(`
                    INSERT OR IGNORE INTO ai_best_picks_history (
                        season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd,
                        ev_score, calibrated_prob, recommendation_score, displayed_confidence,
                        market_roi, league_roi, agreement_score, penalty_multiplier, kickoff_timestamp, match_time, status
                    ) VALUES (?, ?, 'high_value', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `).run(
                    seasonName, round,
                    highValue.match.home_team, highValue.match.away_team,
                    highValue.market, highValue.prob, highValue.impliedOdd,
                    hvMeta.evPct ?? null,
                    hvMeta.calibratedProbPct ?? null,
                    hvMeta.recommendationScore ?? null,
                    hvMeta.displayedConfidence ?? null,
                    hvMeta.marketROIPct ?? null,
                    hvMeta.leagueROIPct ?? null,
                    hvMeta.agreementScore ?? null,
                    hvMeta.penaltyMultiplier ?? null,
                    hvKickoff,
                    hvTime
                );
            }

            // Insert High-Risk AI Pick (Real Match Only)
            const hasAIBest = db.prepare("SELECT count(*) as count FROM ai_best_picks_history WHERE season_name = ? AND round_number = ? AND pick_type = 'ai_best_pick'").get(seasonName, round).count;
            const hrKickoff = aiBestPick && aiBestPick.match ? (aiBestPick.match.kickoff_timestamp || aiBestPick.match.kickoffMs || null) : null;
            if (hasAIBest === 0 && aiBestPick && aiBestPick.match && aiBestPick.match.home_team && !aiBestPick.match.home_team.includes('Skipped') && isNotPast(hrKickoff)) {
                const hrMeta = aiBestPick.engineMeta || {};
                const hrTime = aiBestPick.match.match_time || aiBestPick.match.matchTime || null;
                db.prepare(`
                    INSERT OR IGNORE INTO ai_best_picks_history (
                        season_name, round_number, pick_type, home_team, away_team, market, probability, implied_odd, predicted_probs,
                        ev_score, calibrated_prob, recommendation_score, displayed_confidence,
                        market_roi, league_roi, agreement_score, penalty_multiplier, kickoff_timestamp, match_time, status
                    ) VALUES (?, ?, 'ai_best_pick', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
                `).run(
                    seasonName, round,
                    aiBestPick.match.home_team, aiBestPick.match.away_team,
                    aiBestPick.market, aiBestPick.prob, aiBestPick.impliedOdd,
                    aiBestPick.match.predicted_probs || null,
                    hrMeta.evPct ?? null,
                    hrMeta.calibratedProbPct ?? null,
                    hrMeta.recommendationScore ?? null,
                    hrMeta.displayedConfidence ?? null,
                    hrMeta.marketROIPct ?? null,
                    hrMeta.leagueROIPct ?? null,
                    hrMeta.agreementScore ?? null,
                    hrMeta.penaltyMultiplier ?? null,
                    hrKickoff,
                    hrTime
                );
            }
        }
        }
    }

    // 2. Update status of any pending picks in ai_best_picks_history where matches are completed
    settlePendingAIPicks(db);
}

function evaluatePickOutcome(market, actualScore, actualHtScore = '0:0') {
    if (!actualScore || !actualScore.includes(':')) return null;
    const [h, a] = actualScore.split(':').map(Number);
    const [htH, htA] = (actualHtScore || '0:0').split(':').map(Number);
    if (isNaN(h) || isNaN(a)) return null;
    const totalGoals = h + a;
    const label = String(market).trim();

    let won = false;
    if (label === 'Home Win' || label === 'Home') won = h > a;
    else if (label === 'Away Win' || label === 'Away') won = a > h;
    else if (label === 'Draw') won = h === a;
    else if (label === '1X' || label === 'Home or Draw') won = h >= a;
    else if (label === 'X2' || label === 'Away or Draw') won = a >= h;
    else if (label === '12' || label === 'Home or Away') won = h !== a;
    else if (label === 'Over 0.5 Goals' || label === 'Over 0.5') won = totalGoals > 0.5;
    else if (label === 'Under 0.5 Goals' || label === 'Under 0.5') won = totalGoals < 0.5;
    else if (label === 'Over 1.5 Goals' || label === 'Over 1.5') won = totalGoals > 1.5;
    else if (label === 'Under 1.5 Goals' || label === 'Under 1.5') won = totalGoals < 1.5;
    else if (label === 'Over 2.5 Goals' || label === 'Over 2.5') won = totalGoals > 2.5;
    else if (label === 'Under 2.5 Goals' || label === 'Under 2.5') won = totalGoals < 2.5;
    else if (label === 'Over 3.5 Goals' || label === 'Over 3.5') won = totalGoals > 3.5;
    else if (label === 'Under 3.5 Goals' || label === 'Under 3.5') won = totalGoals < 3.5;
    else if (label === 'Over 4.5 Goals' || label === 'Over 4.5') won = totalGoals > 4.5;
    else if (label === 'Under 4.5 Goals' || label === 'Under 4.5') won = totalGoals < 4.5;
    else if (label === 'Over 5.5 Goals' || label === 'Over 5.5') won = totalGoals > 5.5;
    else if (label === 'Under 5.5 Goals' || label === 'Under 5.5') won = totalGoals < 5.5;
    else if (label === 'Both Teams to Score (GG)' || label === 'GG' || label === 'Both Teams to Score') won = h > 0 && a > 0;
    else if (label.includes('No GG') || label.includes('NOT to Score') || label.includes('Not to Score') || label === 'NG') {
        won = h === 0 || a === 0;
    } else if (label.startsWith('HT/FT ')) {
        const htft = label.replace('HT/FT ', '').trim();
        const [expectedHT, expectedFT] = htft.split('/');
        let actualHT = 'X';
        if (htH > htA) actualHT = '1';
        else if (htH < htA) actualHT = '2';
        let actualFT = 'X';
        if (h > a) actualFT = '1';
        else if (h < a) actualFT = '2';
        won = (actualHT === expectedHT && actualFT === expectedFT);
    } else if (label.toLowerCase().includes('correct score') || label.toLowerCase().startsWith('cs ') || /^\d+-\d+$/.test(label)) {
        const match = label.match(/(\d+)-(\d+)/);
        if (match) {
            const expectedHome = parseInt(match[1], 10);
            const expectedAway = parseInt(match[2], 10);
            won = (h === expectedHome && a === expectedAway);
        }
    } else if (label.toLowerCase().includes('handicap') || label.includes('(-') || label.includes('(+')) {
        const valMatch = label.match(/([+-]?\d+)/);
        if (valMatch) {
            const hcVal = parseInt(valMatch[1], 10);
            const isHome = label.toLowerCase().includes('home');
            const isAway = label.toLowerCase().includes('away');
            const isDraw = label.toLowerCase().includes('draw');
            const adjustedHomeScore = h + hcVal;
            if (isHome) won = adjustedHomeScore > a;
            else if (isAway) won = adjustedHomeScore < a;
            else if (isDraw) won = adjustedHomeScore === a;
        }
    } else if (label === 'Home Draw No Bet') {
        if (h === a) won = null;
        else won = h > a;
    } else if (label === 'Away Draw No Bet') {
        if (h === a) won = null;
        else won = a > h;
    } else if (label === 'Odd') {
        won = totalGoals % 2 === 1;
    } else if (label === 'Even') {
        won = totalGoals % 2 === 0;
    }

    return won === null ? 'void' : (won ? 'won' : 'lost');
}

function settlePendingAIPicks(db, options = {}) {
    if (!db) return 0;
    let settledCount = 0;
    try {
        const includeVoid = !!options.includeVoid;
        const query = includeVoid
            ? "SELECT * FROM ai_best_picks_history WHERE (status = 'pending' OR (status = 'void' AND actual_score IS NULL)) AND home_team NOT LIKE 'Skipped%'"
            : "SELECT * FROM ai_best_picks_history WHERE status = 'pending' AND home_team NOT LIKE 'Skipped%'";

        const pendingPicks = db.prepare(query).all();
        if (pendingPicks.length === 0) return 0;

        const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        const hasLive = tableNames.includes('live_predictions');
        const hasHMP = tableNames.includes('historical_market_predictions');

        const stmtLP_Exact = hasLive ? db.prepare(`
            SELECT actual_score, actual_ht_score 
            FROM live_predictions 
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND scored_status = 1 AND actual_score IS NOT NULL
            LIMIT 1
        `) : null;

        const stmtHMP_Exact = hasHMP ? db.prepare(`
            SELECT actual_score, actual_ht_score 
            FROM historical_market_predictions 
            WHERE season_name = ? AND home_team = ? AND away_team = ? AND actual_score IS NOT NULL
            LIMIT 1
        `) : null;

        const stmtLP_Range = hasLive ? db.prepare(`
            SELECT actual_score, actual_ht_score, season_name, round_number
            FROM live_predictions 
            WHERE home_team = ? AND away_team = ? AND kickoff_timestamp BETWEEN ? AND ? AND actual_score IS NOT NULL
            ORDER BY id DESC LIMIT 1
        `) : null;

        const stmtHMP_Range = hasHMP ? db.prepare(`
            SELECT actual_score, actual_ht_score, season_name, round_number
            FROM historical_market_predictions 
            WHERE home_team = ? AND away_team = ? AND kickoff_timestamp BETWEEN ? AND ? AND actual_score IS NOT NULL
            ORDER BY id DESC LIMIT 1
        `) : null;

        const updateStmt = db.prepare(`
            UPDATE ai_best_picks_history 
            SET actual_score = ?, status = ?
            WHERE id = ?
        `);

        db.transaction(() => {
            for (const pick of pendingPicks) {
                let match = null;

                // 1. Exact match in live_predictions with season_name
                if (pick.season_name && stmtLP_Exact) {
                    match = stmtLP_Exact.get(pick.season_name, pick.home_team, pick.away_team);
                }

                // 2. Exact match in historical_market_predictions with season_name
                if (!match && pick.season_name && stmtHMP_Exact) {
                    match = stmtHMP_Exact.get(pick.season_name, pick.home_team, pick.away_team);
                }

                // 3. Match by kickoff_timestamp (±180s) in live_predictions using indexed range
                if (!match && pick.kickoff_timestamp && stmtLP_Range) {
                    match = stmtLP_Range.get(pick.home_team, pick.away_team, pick.kickoff_timestamp - 180000, pick.kickoff_timestamp + 180000);
                }

                // 4. Match by kickoff_timestamp (±180s) in historical_market_predictions using indexed range
                if (!match && pick.kickoff_timestamp && stmtHMP_Range) {
                    match = stmtHMP_Range.get(pick.home_team, pick.away_team, pick.kickoff_timestamp - 180000, pick.kickoff_timestamp + 180000);
                }

                if (match && match.actual_score) {
                    const actualScore = match.actual_score;
                    const actualHtScore = match.actual_ht_score || '0:0';
                    const finalStatus = evaluatePickOutcome(pick.market, actualScore, actualHtScore);

                    if (finalStatus) {
                        updateStmt.run(actualScore, finalStatus, pick.id);
                        settledCount++;
                        try {
                            settlementLogger.settled({
                                id: pick.id,
                                home_team: pick.home_team,
                                away_team: pick.away_team,
                                market: pick.market,
                                actual_score: actualScore,
                                actual_ht_score: actualHtScore,
                                status: finalStatus,
                                season_name: pick.season_name,
                                round_number: pick.round_number,
                                implied_odd: pick.implied_odd
                            });
                        } catch (_) {}

                        // Also ensure live_predictions is updated if it was sitting unscored
                        if (hasLive) {
                            try {
                                db.prepare(`
                                    UPDATE live_predictions 
                                    SET actual_score = ?, actual_ht_score = ?, scored_status = 1 
                                    WHERE home_team = ? AND away_team = ? AND scored_status = 0
                                      AND kickoff_timestamp BETWEEN ? AND ?
                                `).run(actualScore, actualHtScore, pick.home_team, pick.away_team, (pick.kickoff_timestamp || 0) - 180000, (pick.kickoff_timestamp || 0) + 180000);
                            } catch (_) {}
                        }

                        try {
                            recEngine.updateAfterSettlement(db, { ...pick, status: finalStatus });
                        } catch (e) {}

                        const actualOdd = pick.implied_odd && pick.implied_odd > 0
                            ? pick.implied_odd
                            : (pick.probability > 0 ? parseFloat((100 / pick.probability).toFixed(2)) : null);

                        if (actualOdd) {
                            try {
                                oddsAnalyzer.updatePickResult(
                                    db,
                                    pick.season_name,
                                    pick.round_number,
                                    pick.home_team,
                                    pick.away_team,
                                    pick.market,
                                    actualOdd,
                                    finalStatus
                                );
                            } catch (e) {}
                        }
                    }
                } else if (pick.status === 'pending') {
                    // If pick is older than maxAgeHours (default 3 hours) and has no score anywhere, mark as void
                    const maxAgeMs = (options.maxAgeHours !== undefined ? options.maxAgeHours : 3) * 3600 * 1000;
                    if (maxAgeMs > 0 && pick.kickoff_timestamp && (Date.now() - pick.kickoff_timestamp > maxAgeMs)) {
                        updateStmt.run(null, 'void', pick.id);
                        settledCount++;
                        try {
                            settlementLogger.warn(`[Void Bet] Pick #${pick.id} (${pick.home_team} vs ${pick.away_team}) marked as void due to expiry (>3h without match result)`, {
                                id: pick.id,
                                home_team: pick.home_team,
                                away_team: pick.away_team,
                                market: pick.market,
                                kickoff_timestamp: pick.kickoff_timestamp
                            });
                        } catch (_) {}
                    }
                }
            }
        })();
    } catch (err) {
        console.error('[Settlement Engine] Error settling pending AI picks:', err.message);
    }
    return settledCount;
}

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
        console.error("Error detecting low goals hours in getLivePredictions:", e.message);
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
        } else if (!dbPath || !fs.existsSync(dbPath)) {
            return { success: false, error: 'Database not found' };
        }
    }


    let db;
    try {
        db = openSafeDatabase(dbPath, { timeout: 10000 });
    } catch (e) {
        return { success: false, error: e.message };
    }
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 10000');
    } catch (e) {}

    try {
        initLiveTables(db);
    } catch (e) {
        // Table initialization non-critical if locked by companion
    }

    try {
        try {
            // Settle any pending picks whose matches have completed
            settlePendingAIPicks(db);
            // Only consider voiding if pick kickoff is older than 3 hours with no results anywhere in DB
            const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
            db.prepare("UPDATE ai_best_picks_history SET status = 'void' WHERE status = 'pending' AND kickoff_timestamp < ?").run(threeHoursAgo);
        } catch (e) {
            // Ignore if column doesn't exist or write locked
        }

        // Fetch the most recently ACTIVE season for the specific provider
        let latestSeasonRow;
        if (provider === 'sportybet') {
            latestSeasonRow = db.prepare(
                "SELECT season_name, MAX(id) as max_id FROM live_predictions WHERE season_name LIKE 'Sportybet%' GROUP BY season_name ORDER BY max_id DESC LIMIT 1"
            ).get();
        } else {
            latestSeasonRow = db.prepare(
                "SELECT season_name, MAX(id) as max_id FROM live_predictions WHERE season_name NOT LIKE 'Sportybet%' GROUP BY season_name ORDER BY max_id DESC LIMIT 1"
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
            return { success: true, seasonName: null, predictions: [], aiPicksHistory: [] };
        }

        const seasonName = latestSeasonRow.season_name;

        let limitNum = parseInt(limit, 10);
        if (isNaN(limitNum) || limitNum <= 0) limitNum = 300;
        const limitClause = limitNum >= 100000 ? '' : `LIMIT ${limitNum}`;

        const predCols = "id, season_name, round_number, match_time, home_team, away_team, predicted_result, predicted_probs, actual_score, actual_ht_score, scored_status, kickoff_timestamp, scored_with_prediction, anomaly_detected, league_id";
        let predictions;
        if (provider === 'sportybet' || seasonName.startsWith('Sportybet')) {
            const pending = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name LIKE 'Sportybet%' 
                  AND scored_status = 0
                ORDER BY round_number ASC, id ASC
            `).all();

            const scored = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name LIKE 'Sportybet%' 
                  AND scored_status = 1
                ORDER BY kickoff_timestamp DESC, id DESC
                ${limitClause}
            `).all();

            predictions = [...scored.reverse(), ...pending];
        } else {
            const pending = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name = ? 
                  AND scored_status = 0
                ORDER BY round_number ASC, id ASC
            `).all(seasonName);

            const scored = db.prepare(`
                SELECT ${predCols} FROM live_predictions 
                WHERE season_name = ? 
                  AND scored_status = 1
                ORDER BY round_number ASC, id ASC
                ${limitClause}
            `).all(seasonName);

            predictions = [...scored, ...pending];
        }
        
        // Fetch AI picks history from the permanent table filtered by provider with configurable limit
        let aiPicksHistory = [];
        try {
            const cols = "a.id, a.season_name, a.round_number, a.pick_type, a.home_team, a.away_team, a.market, a.probability, a.implied_odd, a.actual_score, a.status, a.predicted_probs, a.kickoff_timestamp, a.match_time";
            if (provider === 'sportybet') {
                aiPicksHistory = db.prepare(`
                    SELECT ${cols} 
                    FROM ai_best_picks_history a
                    WHERE a.season_name LIKE 'Sportybet%' 
                    ORDER BY a.id DESC ${limitClause}
                `).all();
            } else {
                aiPicksHistory = db.prepare(`
                    SELECT ${cols} 
                    FROM ai_best_picks_history a
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
            const fs = require('fs');
            const statusPath = dbPath + '.learning.json';
            if (fs.existsSync(statusPath)) {
                learningStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            }
        } catch (e) {
            console.error("Error reading learning status:", e.message);
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
                    // Compute DNB if missing
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
                // Compute confidence from ML probabilities (same formula as live predictions)
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
        db.close();
        return { success: false, error: e.message };
    }
}

module.exports = {
    scrapeAndPredictLiveSeason,
    getLivePredictions,
    updateAIPicksHistory,
    settlePendingAIPicks,
    evaluatePickOutcome,
    getBookmakerOdd
};
