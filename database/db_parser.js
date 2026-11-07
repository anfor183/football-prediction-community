const Database = require('better-sqlite3');
const fs = require('fs');

if (process.argv.length < 3) {
    console.error(JSON.stringify({ success: false, error: "Database path not provided" }));
    process.exit(1);
}

const dbPath = process.argv[2];

if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ success: false, error: "Database file does not exist" }));
    process.exit(1);
}

try {
    const db = new Database(dbPath);

    // Clean up dynamic per-season tables if they exist
    try {
        const dynamicTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'fixtures_%' OR name LIKE 'standings_%')").all();
        for (const tbl of dynamicTables) {
            db.exec(`DROP TABLE IF EXISTS "${tbl.name}"`);
        }
    } catch (e) {
        console.error("Error cleaning up dynamic tables:", e.message);
    }

    try { db.exec("DROP VIEW IF EXISTS betting_analytics"); } catch (e) {}
    try { db.exec("DROP TABLE IF EXISTS betting_analytics"); } catch (e) {}
    try { db.exec("DROP TABLE IF EXISTS league_tables"); } catch (e) {}

    db.exec(`
        CREATE TABLE IF NOT EXISTS fixtures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            ht_home_score INTEGER,
            ht_away_score INTEGER,
            home_score INTEGER,
            away_score INTEGER,
            UNIQUE(league_name, season_name, home_team, away_team) ON CONFLICT REPLACE
        );

        CREATE TABLE IF NOT EXISTS league_standings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            position INTEGER,
            team_name TEXT,
            played INTEGER,
            won INTEGER,
            drawn INTEGER,
            lost INTEGER,
            goals_scored INTEGER,
            goals_conceded INTEGER,
            goal_difference INTEGER,
            points INTEGER,
            UNIQUE(league_name, season_name, team_name) ON CONFLICT REPLACE
        );

        CREATE VIEW IF NOT EXISTS betting_analytics AS
        SELECT 
            id,
            league_name,
            season_name,
            home_team,
            away_team,
            home_score,
            away_score,
            ht_home_score,
            ht_away_score,
            (home_score + away_score) AS total_goals,
            CASE WHEN (home_score + away_score) > 0 THEN 'Yes' ELSE 'No' END AS over_0_5,
            CASE WHEN (home_score + away_score) > 1 THEN 'Yes' ELSE 'No' END AS over_1_5,
            CASE WHEN (home_score + away_score) > 2 THEN 'Yes' ELSE 'No' END AS over_2_5,
            CASE WHEN (home_score + away_score) > 3 THEN 'Yes' ELSE 'No' END AS over_3_5,
            CASE WHEN (home_score + away_score) > 4 THEN 'Yes' ELSE 'No' END AS over_4_5,
            CASE WHEN (home_score + away_score) > 5 THEN 'Yes' ELSE 'No' END AS over_5_5,
            CASE WHEN home_score > 0 AND away_score > 0 THEN 'GG' ELSE 'NG' END AS gg_ng,
            CASE 
                WHEN home_score > away_score THEN 'Home'
                WHEN away_score > home_score THEN 'Away'
                ELSE 'Draw'
            END AS match_result,
            match_time
        FROM fixtures;
    `);

    // Clear old tables
    db.exec('DELETE FROM fixtures');
    db.exec('DELETE FROM league_standings');

    const seasons = db.prepare('SELECT league_name, season_name, data FROM seasons').all();
    
    const insertStmt = db.prepare(`
        INSERT INTO fixtures (
            league_name, season_name, match_time, home_team, away_team, 
            ht_home_score, ht_away_score, home_score, away_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStandingStmt = db.prepare(`
        INSERT INTO league_standings (
            league_name, season_name, position, team_name,
            played, won, drawn, lost, goals_scored, goals_conceded, goal_difference, points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let parsedCount = 0;
    let parsedStandingsCount = 0;

    // Use a transaction for fast bulk inserts
    const insertTransaction = db.transaction((matchesToInsert, standingsToInsert) => {
        for (const m of matchesToInsert) {
            insertStmt.run(
                m.league_name, m.season_name, m.match_time, m.home_team, m.away_team,
                m.ht_home_score, m.ht_away_score, m.home_score, m.away_score
            );
            parsedCount++;
        }
        for (const s of standingsToInsert) {
            insertStandingStmt.run(
                s.league_name, s.season_name, s.position, s.team_name,
                s.played, s.won, s.drawn, s.lost, s.goals_scored, s.goals_conceded, s.goal_difference, s.points
            );
            parsedStandingsCount++;
        }
    });

    const matchesToInsert = [];
    const seenMatches = new Set();
    const standingsToInsert = [];
    const seenStandings = new Set();

    function getSeasonTableName(prefix, seasonName) {
        if (!seasonName) return null;
        let normalized = seasonName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
        normalized = normalized.replace(/^_+|_+$/g, '');
        return `${prefix}_${normalized}`;
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

    // Regex to match a score with (FT) in it (fallback parser)
    const matchRegex = /^(.*?)(?:\d{2}:\d{2})?(\d{1,2})\s*[: -]\s*(\d{1,2})\s*\(FT\)(.*)$/i;

    function extractScore(scoreStr) {
        if (!scoreStr) return null;
        let clean = scoreStr.replace(/\s+/g, '');
        // Check for duplicate pattern like "0:10:1" -> "0:1"
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

    function parseDOMMatchLine(row, line) {
        if (!line.includes('|')) return false;
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 4) return false;
        
        const timeStr = parts[0];
        if (!/^\d{1,2}:\d{2}$/.test(timeStr)) return false;

        let homeTeam = '';
        let awayTeam = '';
        let htHomeScore = null;
        let htAwayScore = null;
        let homeScore = null;
        let awayScore = null;

        if (parts.length >= 6 && parts[2] === '-') {
            // Old format: [Time] | [Home Team] | - | [Away Team] | [HT Score] | [FT Score]
            homeTeam = cleanMatchTeamName(parts[1]);
            awayTeam = cleanMatchTeamName(parts[3]);

            const ht = extractScore(parts[4]);
            if (ht) {
                htHomeScore = ht[0];
                htAwayScore = ht[1];
            }

            const ft = extractScore(parts[5]);
            if (ft) {
                homeScore = ft[0];
                awayScore = ft[1];
            }
        } else if (parts[1].includes('-')) {
            // New format: [Time] | [Home Team-Away Team] | [HT Score] | [FT Score]
            const teamParts = parts[1].split('-');
            if (teamParts.length < 2) return false;
            
            homeTeam = cleanMatchTeamName(teamParts[0]);
            awayTeam = cleanMatchTeamName(teamParts[1]);

            const ht = extractScore(parts[2]);
            if (ht) {
                htHomeScore = ht[0];
                htAwayScore = ht[1];
            }

            const ft = extractScore(parts[3]);
            if (ft) {
                homeScore = ft[0];
                awayScore = ft[1];
            }
        } else {
            return false;
        }

        if (!homeTeam || !awayTeam || homeTeam === awayTeam) return false;
        if (homeScore === null || awayScore === null) return false;

        const totalGoals = homeScore + awayScore;
        const o05 = totalGoals > 0 ? 'Yes' : 'No';
        const o15 = totalGoals > 1 ? 'Yes' : 'No';
        const o25 = totalGoals > 2 ? 'Yes' : 'No';
        const o35 = totalGoals > 3 ? 'Yes' : 'No';
        const o45 = totalGoals > 4 ? 'Yes' : 'No';
        const o55 = totalGoals > 5 ? 'Yes' : 'No';
        const gg_ng = (homeScore > 0 && awayScore > 0) ? 'GG' : 'NG';
        
        let matchResult = 'Draw';
        if (homeScore > awayScore) matchResult = 'Home';
        else if (awayScore > homeScore) matchResult = 'Away';

        const uniqueKey = `${row.league_name}_${row.season_name}_${homeTeam}_${awayTeam}`;
        if (!seenMatches.has(uniqueKey)) {
            seenMatches.add(uniqueKey);
            matchesToInsert.push({
                league_name: row.league_name,
                season_name: row.season_name,
                home_team: homeTeam,
                away_team: awayTeam,
                home_score: homeScore,
                away_score: awayScore,
                ht_home_score: htHomeScore,
                ht_away_score: htAwayScore,
                total_goals: totalGoals,
                over_0_5: o05,
                over_1_5: o15,
                over_2_5: o25,
                over_3_5: o35,
                over_4_5: o45,
                over_5_5: o55,
                gg_ng: gg_ng,
                match_result: matchResult,
                match_time: timeStr
            });
        }
        return true;
    }

    function parseDOMStandingsLine(row, line) {
        if (!line.includes('|')) return false;
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 5) return false;

        // If the first part is a time string, it's a match, not standings
        if (/^\d{1,2}:\d{2}$/.test(parts[0])) return false;

        const pos = parseInt(parts[0], 10);
        if (isNaN(pos) || pos < 1 || pos > 24) return false;

        let teamName = cleanMatchTeamName(parts[1]);
        let numbersStart = 2;
        if (!teamName || teamName.toLowerCase() === 'team') {
            teamName = cleanMatchTeamName(parts[2]);
            numbersStart = 3;
        }
        if (!teamName || teamName.toLowerCase() === 'team') return false;

        const numbers = [];
        let goalsStr = '';

        for (let i = numbersStart; i < parts.length; i++) {
            const val = parts[i];
            if (/^\d+:\d+$/.test(val)) {
                goalsStr = val;
            } else {
                const num = parseInt(val, 10);
                if (!isNaN(num)) {
                    numbers.push(num);
                }
            }
        }

        let played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0, gd = 0, pts = 0;

        if (goalsStr && numbers.length >= 4) {
            played = numbers[0];
            won = numbers[1];
            drawn = numbers[2];
            lost = numbers[3];
            
            const gParts = goalsStr.split(':');
            gf = parseInt(gParts[0], 10);
            ga = parseInt(gParts[1], 10);
            gd = gf - ga;
            
            pts = numbers[numbers.length - 1];
        } else if (numbers.length >= 7) {
            played = numbers[0];
            won = numbers[1];
            drawn = numbers[2];
            lost = numbers[3];
            
            if (numbers.length === 7) {
                gf = numbers[4];
                ga = numbers[5];
                gd = gf - ga;
                pts = numbers[6];
            } else {
                gf = numbers[4];
                ga = numbers[5];
                gd = numbers[6];
                pts = numbers[7];
            }
        } else {
            return false;
        }

        const uniqueKey = `${row.league_name}_${row.season_name}_${teamName}`;
        if (!seenStandings.has(uniqueKey)) {
            seenStandings.add(uniqueKey);
            standingsToInsert.push({
                league_name: row.league_name,
                season_name: row.season_name,
                position: pos,
                team_name: teamName,
                played,
                won,
                drawn,
                lost,
                goals_scored: gf,
                goals_conceded: ga,
                goal_difference: gd,
                points: pts
            });
        }
        return true;
    }

    function addParsedMatch(row, match) {
        const homeTeam = cleanMatchTeamName(match[1]);
        const homeScore = parseInt(match[2], 10);
        const awayScore = parseInt(match[3], 10);
        const awayTeam = cleanMatchTeamName(match[4]);
        
        if (!homeTeam || !awayTeam || homeTeam === awayTeam) return;

        const totalGoals = homeScore + awayScore;
        const o05 = totalGoals > 0 ? 'Yes' : 'No';
        const o15 = totalGoals > 1 ? 'Yes' : 'No';
        const o25 = totalGoals > 2 ? 'Yes' : 'No';
        const o35 = totalGoals > 3 ? 'Yes' : 'No';
        const o45 = totalGoals > 4 ? 'Yes' : 'No';
        const o55 = totalGoals > 5 ? 'Yes' : 'No';
        const gg_ng = (homeScore > 0 && awayScore > 0) ? 'GG' : 'NG';
        
        let matchResult = 'Draw';
        if (homeScore > awayScore) matchResult = 'Home';
        else if (awayScore > homeScore) matchResult = 'Away';

        const uniqueKey = `${row.league_name}_${row.season_name}_${homeTeam}_${awayTeam}`;
        if (!seenMatches.has(uniqueKey)) {
            seenMatches.add(uniqueKey);
            matchesToInsert.push({
                league_name: row.league_name,
                season_name: row.season_name,
                home_team: homeTeam,
                away_team: awayTeam,
                home_score: homeScore,
                away_score: awayScore,
                ht_home_score: null,
                ht_away_score: null,
                total_goals: totalGoals,
                over_0_5: o05,
                over_1_5: o15,
                over_2_5: o25,
                over_3_5: o35,
                over_4_5: o45,
                over_5_5: o55,
                gg_ng: gg_ng,
                match_result: matchResult,
                match_time: null
            });
        }
    }

    // 1. PRIMARY PARSER: Parse from api_feeds table
    try {
        const hasApiFeeds = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='api_feeds'").get();
        if (hasApiFeeds) {
            console.error("Parsing matches directly from api_feeds table...");
            
            // Map season IDs to season names
            const metaRows = db.prepare("SELECT response_data FROM api_feeds WHERE endpoint LIKE '%stats_season_meta%' OR endpoint LIKE '%stats_season_tables%'").all();
            const seasonIdToName = {};
            for (const r of metaRows) {
                try {
                    const data = JSON.parse(r.response_data);
                    const doc = data.doc && data.doc[0];
                    if (doc && doc.data) {
                        const s = doc.data.season || doc.data;
                        if (s && s._id && s.name) {
                            seasonIdToName[s._id.toString()] = s.name;
                        }
                    }
                } catch (e) {}
            }

            // Query standings/tables from api_feeds
            const tablesRows = db.prepare("SELECT response_data FROM api_feeds WHERE endpoint LIKE '%stats_season_tables%'").all();
            for (const r of tablesRows) {
                try {
                    const data = JSON.parse(r.response_data);
                    const doc = data.doc && data.doc[0];
                    if (doc && doc.data && doc.data.tables) {
                        const seasonName = doc.data.name;
                        if (!seasonName) continue;
                        
                        for (const table of doc.data.tables) {
                            if (table.tablerows && Array.isArray(table.tablerows)) {
                                for (const tr of table.tablerows) {
                                    const teamName = cleanMatchTeamName(tr.team.name);
                                    const pos = parseInt(tr.pos, 10);
                                    const played = parseInt(tr.total, 10);
                                    const won = parseInt(tr.winTotal, 10);
                                    const drawn = parseInt(tr.drawTotal, 10);
                                    const lost = parseInt(tr.lossTotal, 10);
                                    const gf = parseInt(tr.goalsForTotal, 10);
                                    const ga = parseInt(tr.goalsAgainstTotal, 10);
                                    const gd = parseInt(tr.goalDiffTotal, 10);
                                    const pts = parseInt(tr.pointsTotal, 10);

                                    if (!teamName || isNaN(pos)) continue;

                                    const uniqueKey = `Virtual Football Bundesliga_${seasonName}_${teamName}`;
                                    if (!seenStandings.has(uniqueKey)) {
                                        seenStandings.add(uniqueKey);
                                        standingsToInsert.push({
                                            league_name: 'Virtual Football Bundesliga',
                                            season_name: seasonName,
                                            position: pos,
                                            team_name: teamName,
                                            played,
                                            won,
                                            drawn,
                                            lost,
                                            goals_scored: gf,
                                            goals_conceded: ga,
                                            goal_difference: gd,
                                            points: pts
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {}
            }

            // Query fixtures
            const fixturesRows = db.prepare("SELECT endpoint, response_data FROM api_feeds WHERE endpoint LIKE '%stats_season_fixtures2%'").all();
            for (const r of fixturesRows) {
                const seasonIdMatch = r.endpoint.match(/stats_season_fixtures2\/(\d+)/);
                if (!seasonIdMatch) continue;
                const seasonId = seasonIdMatch[1];
                const seasonName = seasonIdToName[seasonId];
                if (!seasonName) continue;

                try {
                    const data = JSON.parse(r.response_data);
                    const matches = data.doc && data.doc[0] && data.doc[0].data && data.doc[0].data.matches;
                    if (!matches || matches.length === 0) continue;

                    // Verify season completeness (240 played matches)
                    let playedCount = 0;
                    for (const m of matches) {
                        if (m.result && m.result.home !== null && m.status !== 'Canceled' && !m.canceled) {
                            playedCount++;
                        }
                    }
                    if (playedCount < 240) continue;

                    for (const m of matches) {
                        const homeTeam = cleanMatchTeamName(m.teams.home.name);
                        const awayTeam = cleanMatchTeamName(m.teams.away.name);
                        if (!homeTeam || !awayTeam || homeTeam === awayTeam) continue;

                        const homeScore = parseInt(m.result.home, 10);
                        const awayScore = parseInt(m.result.away, 10);

                        let htHomeScore = null;
                        let htAwayScore = null;
                        if (m.periods && m.periods.p1) {
                            htHomeScore = parseInt(m.periods.p1.home, 10);
                            htAwayScore = parseInt(m.periods.p1.away, 10);
                        }

                        const totalGoals = homeScore + awayScore;
                        const o05 = totalGoals > 0 ? 'Yes' : 'No';
                        const o15 = totalGoals > 1 ? 'Yes' : 'No';
                        const o25 = totalGoals > 2 ? 'Yes' : 'No';
                        const o35 = totalGoals > 3 ? 'Yes' : 'No';
                        const o45 = totalGoals > 4 ? 'Yes' : 'No';
                        const o55 = totalGoals > 5 ? 'Yes' : 'No';
                        const gg_ng = (homeScore > 0 && awayScore > 0) ? 'GG' : 'NG';

                        let matchResult = 'Draw';
                        if (homeScore > awayScore) matchResult = 'Home';
                        else if (awayScore > homeScore) matchResult = 'Away';

                        const matchTime = m.time ? m.time.time : null;

                        const uniqueKey = `Bundesliga_${seasonName}_${homeTeam}_${awayTeam}`;
                        if (!seenMatches.has(uniqueKey)) {
                            seenMatches.add(uniqueKey);
                            matchesToInsert.push({
                                league_name: 'Virtual Football Bundesliga',
                                season_name: seasonName,
                                home_team: homeTeam,
                                away_team: awayTeam,
                                home_score: homeScore,
                                away_score: awayScore,
                                ht_home_score: htHomeScore,
                                ht_away_score: htAwayScore,
                                total_goals: totalGoals,
                                over_0_5: o05,
                                over_1_5: o15,
                                over_2_5: o25,
                                over_3_5: o35,
                                over_4_5: o45,
                                over_5_5: o55,
                                gg_ng: gg_ng,
                                match_result: matchResult,
                                match_time: matchTime
                            });
                        }
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error("Warning: Failed to parse api_feeds:", e.message);
    }

    // 2. FALLBACK PARSER: Parse from seasons table (DOM scraped data)
    for (const row of seasons) {
        if (!row.data) continue;
        try {
            const parsedData = JSON.parse(row.data);
            
            // Loop through all tabs in the season data
            for (const [tabName, tabContent] of Object.entries(parsedData)) {
                for (const [viewName, viewData] of Object.entries(tabContent)) {
                    if (!viewData) continue;

                    // Process viewData.tables
                    if (viewData.tables && Array.isArray(viewData.tables)) {
                        for (const line of viewData.tables) {
                            if (line.includes('|')) {
                                // Try standings parser first
                                if (parseDOMStandingsLine(row, line)) continue;

                                // Try new column parser first
                                if (parseDOMMatchLine(row, line)) continue;

                                if (!/\b\d{1,2}:\d{2}\b/.test(line)) continue;
                                const parts = line.split('|');
                                const lastPart = parts[parts.length - 1].trim();
                                const match = lastPart.match(matchRegex);
                                if (match) addParsedMatch(row, match);
                            }
                        }
                    }

                    // Process viewData.matches
                    if (viewData.matches && Array.isArray(viewData.matches)) {
                        for (const matchStr of viewData.matches) {
                            if (!/\b\d{1,2}:\d{2}\b/.test(matchStr)) continue;
                            const cleaned = matchStr.trim().replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\s+/g, ' ');
                            const match = cleaned.match(matchRegex);
                            if (match) addParsedMatch(row, match);
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 3. FALLBACK H2H PARSER: Parse from h2h_records table
    try {
        const h2hTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='h2h_records'").get();
        if (h2hTableExists) {
            const h2hRows = db.prepare('SELECT league_name, season_name, h2h_data FROM h2h_records').all();
            for (const row of h2hRows) {
                if (!row.h2h_data) continue;
                try {
                    const parsedH2H = JSON.parse(row.h2h_data);
                    
                    if (parsedH2H.tables && Array.isArray(parsedH2H.tables)) {
                        for (const line of parsedH2H.tables) {
                            if (line.includes('|')) {
                                // Try new column parser first
                                if (parseDOMMatchLine(row, line)) continue;

                                if (!/\b\d{1,2}:\d{2}\b/.test(line)) continue;
                                const parts = line.split('|');
                                const lastPart = parts[parts.length - 1].trim();
                                const match = lastPart.match(matchRegex);
                                if (match) addParsedMatch(row, match);
                            }
                        }
                    }

                    if (parsedH2H.matches && Array.isArray(parsedH2H.matches)) {
                        for (const matchStr of parsedH2H.matches) {
                            if (!/\b\d{1,2}:\d{2}\b/.test(matchStr)) continue;
                            const cleaned = matchStr.trim().replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\s+/g, ' ');
                            const match = cleaned.match(matchRegex);
                            if (match) addParsedMatch(row, match);
                        }
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error("Warning: Failed to parse h2h_records:", e.message);
    }

    insertTransaction(matchesToInsert, standingsToInsert);
    db.close();

    console.log(JSON.stringify({ success: true, parsed: parsedCount, parsedStandings: parsedStandingsCount }));

} catch (error) {
    console.error(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
}
