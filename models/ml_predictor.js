const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { getTimeAdjustmentFactor, analyseTimePatterns } = require('./time_pattern_analyzer');

function factorial(n) {
    if (n === 0 || n === 1) return 1;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
}

const poisson = (lambda, k) => {
    return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
};

function getDecayRateForDb(dbPath) {
    let decayRate = 0.015;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.decayRate === 'number') {
                decayRate = data.decayRate;
            }
        } catch (err) {
            console.error("Error reading ML decay weights file, using default:", err.message);
        }
    }
    return decayRate;
}

function getWeightedStats(allMatches, decayRate = 0.015) {
    const N = allMatches.length;
    let totalHomeGoalsWeighted = 0;
    let totalAwayGoalsWeighted = 0;
    let totalWeight = 0;

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        const w = Math.exp(-(N - 1 - i) * decayRate);
        totalHomeGoalsWeighted += (m.home_score || 0) * w;
        totalAwayGoalsWeighted += (m.away_score || 0) * w;
        totalWeight += w;
    }

    const avgHomeGoals = totalHomeGoalsWeighted / (totalWeight || 1);
    const avgAwayGoals = totalAwayGoalsWeighted / (totalWeight || 1);

    const stats = {};
    const initTeamStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        const w = Math.exp(-(N - 1 - i) * decayRate);

        if (!stats[m.home_team]) stats[m.home_team] = initTeamStats();
        if (!stats[m.away_team]) stats[m.away_team] = initTeamStats();

        stats[m.home_team].homeGoalsScored += (m.home_score || 0) * w;
        stats[m.home_team].homeGoalsConceded += (m.away_score || 0) * w;
        stats[m.home_team].homeMatchesWeight += w;

        stats[m.away_team].awayGoalsScored += (m.away_score || 0) * w;
        stats[m.away_team].awayGoalsConceded += (m.home_score || 0) * w;
        stats[m.away_team].awayMatchesWeight += w;
    }

    return {
        avgHomeGoals,
        avgAwayGoals,
        stats
    };
}

function getWeightedHTStats(allMatches, decayRate = 0.015) {
    const N = allMatches.length;
    let totalHomeHTGoalsWeighted = 0;
    let totalAwayHTGoalsWeighted = 0;
    let totalHTWeight = 0;

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        if (m.ht_home_score !== null && m.ht_away_score !== null && m.ht_home_score !== undefined && m.ht_away_score !== undefined) {
            const w = Math.exp(-(N - 1 - i) * decayRate);
            totalHomeHTGoalsWeighted += m.ht_home_score * w;
            totalAwayHTGoalsWeighted += m.ht_away_score * w;
            totalHTWeight += w;
        }
    }

    const avgHomeHTGoals = totalHomeHTGoalsWeighted / (totalHTWeight || 1);
    const avgAwayHTGoals = totalAwayHTGoalsWeighted / (totalHTWeight || 1);

    const htStats = {};
    const initHTStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });

    for (let i = 0; i < N; i++) {
        const m = allMatches[i];
        if (m.ht_home_score === null || m.ht_away_score === null || m.ht_home_score === undefined || m.ht_away_score === undefined) continue;

        const w = Math.exp(-(N - 1 - i) * decayRate);

        if (!htStats[m.home_team]) htStats[m.home_team] = initHTStats();
        if (!htStats[m.away_team]) htStats[m.away_team] = initHTStats();

        htStats[m.home_team].homeGoalsScored += m.ht_home_score * w;
        htStats[m.home_team].homeGoalsConceded += m.ht_away_score * w;
        htStats[m.home_team].homeMatchesWeight += w;

        htStats[m.away_team].awayGoalsScored += m.ht_away_score * w;
        htStats[m.away_team].awayGoalsConceded += m.ht_home_score * w;
        htStats[m.away_team].awayMatchesWeight += w;
    }

    return {
        avgHomeHTGoals,
        avgAwayHTGoals,
        htStats
    };
}

function getCleanedMatches(db, homeTeam = null, awayTeam = null, provider = 'bet9ja') {
    let rawMatches = [];
    const tableName = (provider === 'sportybet') ? 'sporty_fixtures' : 'fixtures';

    try {
        rawMatches = db.prepare(`SELECT home_team, away_team, home_score, away_score, ht_home_score, ht_away_score, match_time FROM ${tableName} ORDER BY id DESC LIMIT 10000`).all();
        rawMatches.reverse();
    } catch (e) {
        console.error(`Error reading ${tableName} database:`, e.message);
        return [];
    }

    const allMatches = [];
    for (const m of rawMatches) {
        if (!m.home_team || !m.away_team) continue;
        if (m.home_score === null || m.away_score === null || m.home_score === undefined || m.away_score === undefined) continue;

        const h = parseInt(m.home_score, 10);
        const a = parseInt(m.away_score, 10);
        if (isNaN(h) || isNaN(a) || h < 0 || a < 0) continue;

        let ht_h = null;
        let ht_a = null;
        if (m.ht_home_score !== null && m.ht_away_score !== null && m.ht_home_score !== undefined && m.ht_away_score !== undefined) {
            const parsed_ht_h = parseInt(m.ht_home_score, 10);
            const parsed_ht_a = parseInt(m.ht_away_score, 10);
            if (!isNaN(parsed_ht_h) && !isNaN(parsed_ht_a) && parsed_ht_h >= 0 && parsed_ht_a >= 0) {
                ht_h = parsed_ht_h;
                ht_a = parsed_ht_a;
            }
        }

        allMatches.push({
            home_team: m.home_team,
            away_team: m.away_team,
            home_score: h,
            away_score: a,
            ht_home_score: ht_h,
            ht_away_score: ht_a,
            match_time: m.match_time || ''
        });
    }
    return allMatches;
}

function getFormModifier(team, allMatches, lookbackCount = 5) {
    const lastMatches = [];
    for (let i = allMatches.length - 1; i >= 0; i--) {
        const m = allMatches[i];
        if (m.home_team === team || m.away_team === team) {
            lastMatches.push(m);
            if (lastMatches.length === lookbackCount) break;
        }
    }
    if (lastMatches.length === 0) return { attack: 1.0, defense: 1.0 };

    let points = 0;
    let gf = 0;
    let ga = 0;
    for (const m of lastMatches) {
        const hs = parseInt(m.home_score, 10) || 0;
        const as_ = parseInt(m.away_score, 10) || 0;

        if (m.home_team === team) {
            gf += hs;
            ga += as_;
            if (hs > as_) points += 3;
            else if (hs === as_) points += 1;
        } else {
            gf += as_;
            ga += hs;
            if (as_ > hs) points += 3;
            else if (as_ === hs) points += 1;
        }
    }

    const avgPoints = points / lastMatches.length;
    const pointsModifier = (avgPoints - 1.33) * 0.05;

    const avgGF = gf / lastMatches.length;
    const avgGA = ga / lastMatches.length;
    const gdModifier = (avgGF - avgGA) * 0.02;

    const attack = Math.max(0.90, Math.min(1.10, 1.0 + pointsModifier + gdModifier));
    const defense = Math.max(0.90, Math.min(1.10, 1.0 - (pointsModifier + gdModifier)));

    return { attack, defense };
}

function getH2HMatchupAdjustments(homeTeam, awayTeam, allMatches) {
    const h2h = [];
    for (const m of allMatches) {
        if (
            (m.home_team === homeTeam && m.away_team === awayTeam) ||
            (m.home_team === awayTeam && m.away_team === homeTeam)
        ) {
            h2h.push(m);
        }
    }

    if (h2h.length < 3) return null;

    let homeGoalsSum = 0;
    let awayGoalsSum = 0;
    let weightSum = 0;

    for (let i = 0; i < h2h.length; i++) {
        const m = h2h[i];
        const hs = parseInt(m.home_score, 10) || 0;
        const as_ = parseInt(m.away_score, 10) || 0;
        const w = Math.exp(-(h2h.length - 1 - i) * 0.1);

        if (m.home_team === homeTeam) {
            homeGoalsSum += hs * w;
            awayGoalsSum += as_ * w;
        } else {
            homeGoalsSum += as_ * w;
            awayGoalsSum += hs * w;
        }
        weightSum += w;
    }

    return {
        homeH2HAvg: homeGoalsSum / (weightSum || 1),
        awayH2HAvg: awayGoalsSum / (weightSum || 1),
        count: h2h.length
    };
}

function getMismatchCalibrations(allMatches) {
    const N = allMatches.length;
    if (N < 20) return { over15: 1.0, over25: 1.0, over35: 1.0, over45: 1.0, over55: 1.0, gg: 1.0, draw: 1.0 };

    let totalHome = 0, totalAway = 0;
    let actOver15 = 0, actOver25 = 0, actOver35 = 0, actOver45 = 0, actOver55 = 0, actGG = 0, actDraw = 0;

    for (const m of allMatches) {
        const hs = parseInt(m.home_score, 10) || 0;
        const as_ = parseInt(m.away_score, 10) || 0;

        totalHome += hs;
        totalAway += as_;

        const total = hs + as_;
        if (total > 1) actOver15++;
        if (total > 2) actOver25++;
        if (total > 3) actOver35++;
        if (total > 4) actOver45++;
        if (total > 5) actOver55++;
        if (hs > 0 && as_ > 0) actGG++;
        if (hs === as_) actDraw++;
    }

    const avgH = totalHome / N;
    const avgA = totalAway / N;

    const maxGoals = 6;
    const homeProb = [], awayProb = [];
    for (let i = 0; i <= maxGoals; i++) {
        homeProb.push(poisson(avgH, i));
        awayProb.push(poisson(avgA, i));
    }

    let thOver15 = 0, thOver25 = 0, thOver35 = 0, thOver45 = 0, thOver55 = 0, thGG = 0, thDraw = 0;
    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const p = homeProb[h] * awayProb[a];
            const tot = h + a;
            if (tot > 1) thOver15 += p;
            if (tot > 2) thOver25 += p;
            if (tot > 3) thOver35 += p;
            if (tot > 4) thOver45 += p;
            if (tot > 5) thOver55 += p;
            if (h > 0 && a > 0) thGG += p;
            if (h === a) thDraw += p;
        }
    }

    const getRatio = (act, th) => {
        if (th <= 0) return 1.0;
        const ratio = (act / N) / th;
        return Math.max(0.80, Math.min(1.20, ratio));
    };

    const drawVal = getRatio(actDraw, thDraw);
    return {
        over15: getRatio(actOver15, thOver15),
        over25: getRatio(actOver25, thOver25),
        over35: getRatio(actOver35, thOver35),
        over45: getRatio(actOver45, thOver45),
        over55: getRatio(actOver55, thOver55),
        gg: getRatio(actGG, thGG),
        draw: drawVal,
        drawBias: drawVal
    };
}

function getDynamicFormLookback(allMatches) {
    if (!allMatches || allMatches.length < 30) return 5;

    const stats = {};
    for (const m of allMatches) {
        if (!m.home_team || !m.away_team) continue;
        if (!stats[m.home_team]) stats[m.home_team] = { wins: 0, played: 0 };
        if (!stats[m.away_team]) stats[m.away_team] = { wins: 0, played: 0 };

        stats[m.home_team].played++;
        stats[m.away_team].played++;
        if (m.home_score > m.away_score) stats[m.home_team].wins++;
        else if (m.away_score > m.home_score) stats[m.away_team].wins++;
    }

    const winRates = [];
    for (const team of Object.keys(stats)) {
        const s = stats[team];
        if (s.played > 0) winRates.push(s.wins / s.played);
    }

    if (winRates.length === 0) return 5;

    const mean = winRates.reduce((a, b) => a + b, 0) / winRates.length;
    const variance = winRates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / winRates.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev > 0.12) return 7;
    if (stdDev < 0.08) return 3;
    return 5;
}

function calculatePoissonMatchup(dbPath, homeTeam, awayTeam, passedDecayRate = null, provider = 'bet9ja') {
    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db, homeTeam, awayTeam, provider);
    
    if (allMatches.length < 5) {
        db.close();
        return null;
    }

    let decayRate = passedDecayRate;
    if (decayRate === null) {
        decayRate = getDecayRateForDb(dbPath);
    }

    // 1. Calculate overall league averages and team-specific stats
    const { avgHomeGoals, avgAwayGoals, stats } = getWeightedStats(allMatches, decayRate);

    if (!stats[homeTeam] || !stats[awayTeam]) {
        db.close();
        return null;
    }

    const homeTeamStats = stats[homeTeam];
    const awayTeamStats = stats[awayTeam];

    const homeMatchesWeight = homeTeamStats.homeMatchesWeight || 0;
    const totalHomeWeight = (homeTeamStats.homeMatchesWeight || 0) + (homeTeamStats.awayMatchesWeight || 0);

    const overallHomeAttack = totalHomeWeight > 0 ? 
        ((homeTeamStats.homeGoalsScored + homeTeamStats.awayGoalsScored) / totalHomeWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;
    const overallHomeDefense = totalHomeWeight > 0 ? 
        ((homeTeamStats.homeGoalsConceded + homeTeamStats.awayGoalsConceded) / totalHomeWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;

    const rawHomeAttack = homeMatchesWeight > 0 ? 
        (homeTeamStats.homeGoalsScored / homeMatchesWeight) / (avgHomeGoals || 1) : overallHomeAttack;
    const rawHomeDefense = homeMatchesWeight > 0 ? 
        (homeTeamStats.homeGoalsConceded / homeMatchesWeight) / (avgAwayGoals || 1) : overallHomeDefense;

    const homeBlend = Math.min(1.0, homeMatchesWeight / 1.5);
    let homeAttack = homeBlend * rawHomeAttack + (1 - homeBlend) * overallHomeAttack;
    let homeDefense = homeBlend * rawHomeDefense + (1 - homeBlend) * overallHomeDefense;

    const awayMatchesWeight = awayTeamStats.awayMatchesWeight || 0;
    const totalAwayWeight = (awayTeamStats.homeMatchesWeight || 0) + (awayTeamStats.awayMatchesWeight || 0);

    const overallAwayAttack = totalAwayWeight > 0 ? 
        ((awayTeamStats.homeGoalsScored + awayTeamStats.awayGoalsScored) / totalAwayWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;
    const overallAwayDefense = totalAwayWeight > 0 ? 
        ((awayTeamStats.homeGoalsConceded + awayTeamStats.awayGoalsConceded) / totalAwayWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;

    const rawAwayAttack = awayMatchesWeight > 0 ? 
        (awayTeamStats.awayGoalsScored / awayMatchesWeight) / (avgAwayGoals || 1) : overallAwayAttack;
    const rawAwayDefense = awayMatchesWeight > 0 ? 
        (awayTeamStats.awayGoalsConceded / awayMatchesWeight) / (avgHomeGoals || 1) : overallAwayDefense;

    const awayBlend = Math.min(1.0, awayMatchesWeight / 1.5);
    let awayAttack = awayBlend * rawAwayAttack + (1 - awayBlend) * overallAwayAttack;
    let awayDefense = awayBlend * rawAwayDefense + (1 - awayBlend) * overallAwayDefense;

    // Form/Streak Modifiers (Dynamic Horizon)
    const lookbackCount = getDynamicFormLookback(allMatches);
    const homeForm = getFormModifier(homeTeam, allMatches, lookbackCount);
    const awayForm = getFormModifier(awayTeam, allMatches, lookbackCount);
    homeAttack *= homeForm.attack;
    homeDefense *= homeForm.defense;
    awayAttack *= awayForm.attack;
    awayDefense *= awayForm.defense;

    // Expected Goals (xG)
    let homeXG = homeAttack * awayDefense * avgHomeGoals;
    let awayXG = awayAttack * homeDefense * avgAwayGoals;

    // H2H matchup bias
    const h2hAdjustments = getH2HMatchupAdjustments(homeTeam, awayTeam, allMatches);
    if (h2hAdjustments) {
        const h2hWeight = 0.25;
        homeXG = (1 - h2hWeight) * homeXG + h2hWeight * h2hAdjustments.homeH2HAvg;
        awayXG = (1 - h2hWeight) * awayXG + h2hWeight * h2hAdjustments.awayH2HAvg;
    }



    const maxGoals = 6;
    const homeProb = [];
    const awayProb = [];

    for (let i = 0; i <= maxGoals; i++) {
        homeProb.push(poisson(homeXG, i));
        awayProb.push(poisson(awayXG, i));
    }

    let homeWinProb = 0;
    let drawProb = 0;
    let awayWinProb = 0;
    const scores = [];

    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const prob = homeProb[h] * awayProb[a];
            if (h > a) homeWinProb += prob;
            else if (h === a) drawProb += prob;
            else awayWinProb += prob;

            scores.push({
                homeScore: h,
                awayScore: a,
                probability: prob
            });
        }
    }

    const totalMatrixProb = homeWinProb + drawProb + awayWinProb;
    if (totalMatrixProb > 0) {
        homeWinProb /= totalMatrixProb;
        drawProb /= totalMatrixProb;
        awayWinProb /= totalMatrixProb;
        for (const s of scores) {
            s.probability /= totalMatrixProb;
        }
    }

    // Apply draw bias calibration to individual scores and normalize
    const calibrations = getMismatchCalibrations(allMatches);
    for (const s of scores) {
        if (s.homeScore === s.awayScore) {
            s.probability *= calibrations.draw;
        }
    }
    const totalPAfterDraw = scores.reduce((acc, s) => acc + s.probability, 0);
    if (totalPAfterDraw > 0) {
        for (const s of scores) {
            s.probability /= totalPAfterDraw;
        }
    }
    // Re-calculate outcome probabilities from adjusted scores
    homeWinProb = 0;
    drawProb = 0;
    awayWinProb = 0;
    for (const s of scores) {
        if (s.homeScore > s.awayScore) homeWinProb += s.probability;
        else if (s.homeScore === s.awayScore) drawProb += s.probability;
        else awayWinProb += s.probability;
    }

    scores.sort((a, b) => b.probability - a.probability);
    const topScorelines = scores.slice(0, 3).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    // Comprehensive correct scores list
    const correctScoresList = scores.slice(0, 15).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    // Calculate Full-Time Goal Markets
    let over05 = 0, over15 = 0, over25 = 0, over35 = 0, over45 = 0, over55 = 0;
    let gg = 0, ng = 0;
    let evenProb = 0, oddProb = 0;
    let eg0 = 0, eg1 = 0, eg2 = 0, eg3 = 0, eg4 = 0, eg5 = 0, eg6Plus = 0;

    // Home / Away Total Goals Under/Over
    let hgOver05 = 0, hgOver15 = 0, hgOver25 = 0;
    let agOver05 = 0, agOver15 = 0, agOver25 = 0;

    for (const s of scores) {
        const total = s.homeScore + s.awayScore;
        if (total > 0) over05 += s.probability;
        if (total > 1) over15 += s.probability;
        if (total > 2) over25 += s.probability;
        if (total > 3) over35 += s.probability;
        if (total > 4) over45 += s.probability;
        if (total > 5) over55 += s.probability;
        
        if (s.homeScore > 0 && s.awayScore > 0) gg += s.probability;
        else ng += s.probability;

        if (total % 2 === 0) evenProb += s.probability;
        else oddProb += s.probability;

        if (total === 0) eg0 += s.probability;
        else if (total === 1) eg1 += s.probability;
        else if (total === 2) eg2 += s.probability;
        else if (total === 3) eg3 += s.probability;
        else if (total === 4) eg4 += s.probability;
        else if (total === 5) eg5 += s.probability;
        else if (total >= 6) eg6Plus += s.probability;

        if (s.homeScore > 0) hgOver05 += s.probability;
        if (s.homeScore > 1) hgOver15 += s.probability;
        if (s.homeScore > 2) hgOver25 += s.probability;

        if (s.awayScore > 0) agOver05 += s.probability;
        if (s.awayScore > 1) agOver15 += s.probability;
        if (s.awayScore > 2) agOver25 += s.probability;
    }

    // Apply Mismatch Calibration (calibrations is defined above)
    over15 = Math.max(0.0, Math.min(1.0, over15 * calibrations.over15));
    over25 = Math.max(0.0, Math.min(1.0, over25 * calibrations.over25));
    over35 = Math.max(0.0, Math.min(1.0, over35 * calibrations.over35));
    over45 = Math.max(0.0, Math.min(1.0, over45 * calibrations.over45));
    over55 = Math.max(0.0, Math.min(1.0, over55 * calibrations.over55));
    gg = Math.max(0.0, Math.min(1.0, gg * calibrations.gg));
    ng = 1 - gg;

    // Double Chance
    const dc1X = homeWinProb + drawProb;
    const dc12 = homeWinProb + awayWinProb;
    const dcX2 = drawProb + awayWinProb;

    // Draw No Bet
    const dnbTotal = homeWinProb + awayWinProb;
    const dnbHome = dnbTotal > 0 ? homeWinProb / dnbTotal : 0.5;
    const dnbAway = dnbTotal > 0 ? awayWinProb / dnbTotal : 0.5;

    // Handicaps 3-Way
    const calcHandicap3Way = (hVal) => {
        let hWin = 0, draw = 0, aWin = 0;
        for (const s of scores) {
            const diff = s.homeScore + hVal - s.awayScore;
            if (diff > 0) hWin += s.probability;
            else if (diff === 0) draw += s.probability;
            else aWin += s.probability;
        }
        return { home: hWin, draw, away: aWin };
    };

    const hcMinus2 = calcHandicap3Way(-2);
    const hcMinus1 = calcHandicap3Way(-1);
    const hcPlus1 = calcHandicap3Way(1);
    const hcPlus2 = calcHandicap3Way(2);

    // Asian Handicaps 2-Way
    const calcAH = (ahVal) => {
        let homeAH = 0;
        let awayAH = 0;
        for (const s of scores) {
            const diff = s.homeScore + ahVal - s.awayScore;
            if (diff > 0) homeAH += s.probability;
            else if (diff < 0) awayAH += s.probability;
            else {
                homeAH += 0.5 * s.probability;
                awayAH += 0.5 * s.probability;
            }
        }
        const total = homeAH + awayAH;
        return {
            home: total > 0 ? homeAH / total : 0.5,
            away: total > 0 ? awayAH / total : 0.5
        };
    };

    const ahMinus1_5 = calcAH(-1.5);
    const ahPlus1_5 = calcAH(1.5);
    const ahMinus1_25 = calcAH(-1.25);
    const ahPlus1_25 = calcAH(1.25);
    const ahMinus1_75 = calcAH(-1.75);
    const ahPlus1_75 = calcAH(1.75);

    // Calculate Half-Time (HT) averages and team stats
    const { avgHomeHTGoals, avgAwayHTGoals, htStats } = getWeightedHTStats(allMatches, decayRate);

    // Default to league averages if no specific team data is available
    const initHTStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatchesWeight: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatchesWeight: 0
    });
    const homeTeamHT = htStats[homeTeam] || initHTStats();
    const awayTeamHT = htStats[awayTeam] || initHTStats();

    const homeHTMatchesWeight = homeTeamHT.homeMatchesWeight || 0;
    const totalHomeHTWeight = (homeTeamHT.homeMatchesWeight || 0) + (homeTeamHT.awayMatchesWeight || 0);

    const overallHomeHTAttack = totalHomeHTWeight > 0 ?
        ((homeTeamHT.homeGoalsScored + homeTeamHT.awayGoalsScored) / totalHomeHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;
    const overallHomeHTDefense = totalHomeHTWeight > 0 ?
        ((homeTeamHT.homeGoalsConceded + homeTeamHT.awayGoalsConceded) / totalHomeHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;

    const rawHomeHTAttack = homeHTMatchesWeight > 0 ?
        (homeTeamHT.homeGoalsScored / homeHTMatchesWeight) / (avgHomeHTGoals || 1) : overallHomeHTAttack;
    const rawHomeHTDefense = homeHTMatchesWeight > 0 ?
        (homeTeamHT.homeGoalsConceded / homeHTMatchesWeight) / (avgAwayHTGoals || 1) : overallHomeHTDefense;

    const homeHTBlend = Math.min(1.0, homeHTMatchesWeight / 1.5);
    let homeHTAttack = homeHTBlend * rawHomeHTAttack + (1 - homeHTBlend) * overallHomeHTAttack;
    let homeHTDefense = homeHTBlend * rawHomeHTDefense + (1 - homeHTBlend) * overallHomeHTDefense;

    const awayHTMatchesWeight = awayTeamHT.awayMatchesWeight || 0;
    const totalAwayHTWeight = (awayTeamHT.homeMatchesWeight || 0) + (awayTeamHT.awayMatchesWeight || 0);

    const overallAwayHTAttack = totalAwayHTWeight > 0 ?
        ((awayTeamHT.homeGoalsScored + awayTeamHT.awayGoalsScored) / totalAwayHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;
    const overallAwayHTDefense = totalAwayHTWeight > 0 ?
        ((awayTeamHT.homeGoalsConceded + awayTeamHT.awayGoalsConceded) / totalAwayHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;

    const rawAwayHTAttack = awayHTMatchesWeight > 0 ?
        (awayTeamHT.awayGoalsScored / awayHTMatchesWeight) / (avgAwayHTGoals || 1) : overallAwayHTAttack;
    const rawAwayHTDefense = awayHTMatchesWeight > 0 ?
        (awayTeamHT.awayGoalsConceded / awayHTMatchesWeight) / (avgHomeHTGoals || 1) : overallAwayHTDefense;

    const awayHTBlend = Math.min(1.0, awayHTMatchesWeight / 1.5);
    let awayHTAttack = awayHTBlend * rawAwayHTAttack + (1 - awayHTBlend) * overallAwayHTAttack;
    let awayHTDefense = awayHTBlend * rawAwayHTDefense + (1 - awayHTBlend) * overallAwayHTDefense;

    const homeHT_XG = homeHTAttack * awayHTDefense * avgHomeHTGoals;
    const awayHT_XG = awayHTAttack * homeHTDefense * avgAwayHTGoals;

    // HT Poisson probabilities
    const maxHTGoals = 4;
    const homeHTProb = [];
    const awayHTProb = [];

    for (let i = 0; i <= maxHTGoals; i++) {
        homeHTProb.push(poisson(homeHT_XG, i));
        awayHTProb.push(poisson(awayHT_XG, i));
    }

    let htHomeWinProb = 0;
    let htDrawProb = 0;
    let htAwayWinProb = 0;
    const htScores = [];

    for (let h = 0; h <= maxHTGoals; h++) {
        for (let a = 0; a <= maxHTGoals; a++) {
            const prob = homeHTProb[h] * awayHTProb[a];
            if (h > a) htHomeWinProb += prob;
            else if (h === a) htDrawProb += prob;
            else htAwayWinProb += prob;

            htScores.push({
                homeScore: h,
                awayScore: a,
                probability: prob
            });
        }
    }

    const totalHTMatrixProb = htHomeWinProb + htDrawProb + htAwayWinProb;
    if (totalHTMatrixProb > 0) {
        htHomeWinProb /= totalHTMatrixProb;
        htDrawProb /= totalHTMatrixProb;
        htAwayWinProb /= totalHTMatrixProb;
        for (const s of htScores) {
            s.probability /= totalHTMatrixProb;
        }
    }

    htScores.sort((a, b) => b.probability - a.probability);
    const topHTScorelines = htScores.slice(0, 3).map(s => ({
        score: `${s.homeScore}-${s.awayScore}`,
        prob: s.probability
    }));

    let htOver05 = 0;
    let htOver15 = 0;
    let htOver25 = 0;
    let htOver35 = 0;
    let htOver45 = 0;
    let htOver55 = 0;
    let htGg = 0;
    let htNg = 0;

    for (const s of htScores) {
        const total = s.homeScore + s.awayScore;
        if (total > 0) htOver05 += s.probability;
        if (total > 1) htOver15 += s.probability;
        if (total > 2) htOver25 += s.probability;
        if (total > 3) htOver35 += s.probability;
        if (total > 4) htOver45 += s.probability;
        if (total > 5) htOver55 += s.probability;
        if (s.homeScore > 0 && s.awayScore > 0) htGg += s.probability;
        else htNg += s.probability;
    }

    // HT Double Chance
    const htDc1X = htHomeWinProb + htDrawProb;
    const htDc12 = htHomeWinProb + htAwayWinProb;
    const htDcX2 = htDrawProb + htAwayWinProb;

    // HT Handicap (3-way) for -1, +1
    const calcHTHandicap3Way = (hVal) => {
        let hWin = 0, draw = 0, aWin = 0;
        for (const s of htScores) {
            const diff = s.homeScore + hVal - s.awayScore;
            if (diff > 0) hWin += s.probability;
            else if (diff === 0) draw += s.probability;
            else aWin += s.probability;
        }
        return { home: hWin, draw, away: aWin };
    };
    const htHcMinus1 = calcHTHandicap3Way(-1);
    const htHcPlus1 = calcHTHandicap3Way(1);

    // Second Half (SH) calculation for HT/FT and Highest Scoring Half
    const homeSH_XG = Math.max(0, homeXG - homeHT_XG);
    const awaySH_XG = Math.max(0, awayXG - awayHT_XG);

    const maxSHGoals = 6;
    const shHomeProb = [];
    const shAwayProb = [];
    for (let i = 0; i <= maxSHGoals; i++) {
        shHomeProb.push(poisson(homeSH_XG, i));
        shAwayProb.push(poisson(awaySH_XG, i));
    }
    const shScores = [];
    for (let h = 0; h <= maxSHGoals; h++) {
        for (let a = 0; a <= maxSHGoals; a++) {
            shScores.push({
                homeScore: h,
                awayScore: a,
                probability: shHomeProb[h] * shAwayProb[a]
            });
        }
    }
    let totalSHMatrixProb = 0;
    for (const s of shScores) {
        totalSHMatrixProb += s.probability;
    }
    if (totalSHMatrixProb > 0) {
        for (const s of shScores) {
            s.probability /= totalSHMatrixProb;
        }
    }

    // HT/FT Combinations
    let htft11 = 0, htft1X = 0, htft12 = 0;
    let htftX1 = 0, htftXX = 0, htftX2 = 0;
    let htft21 = 0, htft2X = 0, htft22 = 0;

    for (const s1 of htScores) {
        const htResult = s1.homeScore > s1.awayScore ? '1' : (s1.homeScore === s1.awayScore ? 'X' : '2');
        for (const s2 of shScores) {
            const ftHome = s1.homeScore + s2.homeScore;
            const ftAway = s1.awayScore + s2.awayScore;
            const ftResult = ftHome > ftAway ? '1' : (ftHome === ftAway ? 'X' : '2');
            
            const prob = s1.probability * s2.probability;
            
            if (htResult === '1' && ftResult === '1') htft11 += prob;
            else if (htResult === '1' && ftResult === 'X') htft1X += prob;
            else if (htResult === '1' && ftResult === '2') htft12 += prob;
            else if (htResult === 'X' && ftResult === '1') htftX1 += prob;
            else if (htResult === 'X' && ftResult === 'X') htftXX += prob;
            else if (htResult === 'X' && ftResult === '2') htftX2 += prob;
            else if (htResult === '2' && ftResult === '1') htft21 += prob;
            else if (htResult === '2' && ftResult === 'X') htft2X += prob;
            else if (htResult === '2' && ftResult === '2') htft22 += prob;
        }
    }

    // Highest Scoring Half
    let hshFirst = 0, hshSecond = 0, hshEqual = 0;
    for (const s1 of htScores) {
        const htGoals = s1.homeScore + s1.awayScore;
        for (const s2 of shScores) {
            const shGoals = s2.homeScore + s2.awayScore;
            const prob = s1.probability * s2.probability;
            
            if (htGoals > shGoals) hshFirst += prob;
            else if (htGoals < shGoals) hshSecond += prob;
            else hshEqual += prob;
        }
    }

    // Classify Kickoff Time trends (Day vs Night)
    let homeDayPlayed = 0, homeDayWins = 0, homeDayGoals = 0;
    let homeNightPlayed = 0, homeNightWins = 0, homeNightGoals = 0;
    let awayDayPlayed = 0, awayDayWins = 0, awayDayGoals = 0;
    let awayNightPlayed = 0, awayNightWins = 0, awayNightGoals = 0;

    for (const m of allMatches) {
        let hour = 15; // default kickoff hour
        if (m.match_time && m.match_time.includes(':')) {
            let timeStr = m.match_time;
            if (timeStr.includes('T')) {
                timeStr = timeStr.split('T')[1];
            }
            const parsedHour = parseInt(timeStr.split(':')[0], 10);
            if (!isNaN(parsedHour)) hour = parsedHour;
        }
        const isDay = hour < 17;

        if (m.home_team === homeTeam) {
            const isWin = m.home_score > m.away_score;
            if (isDay) {
                homeDayPlayed += 1;
                if (isWin) homeDayWins += 1;
                homeDayGoals += m.home_score;
            } else {
                homeNightPlayed += 1;
                if (isWin) homeNightWins += 1;
                homeNightGoals += m.home_score;
            }
        } else if (m.away_team === homeTeam) {
            const isWin = m.away_score > m.home_score;
            if (isDay) {
                homeDayPlayed += 1;
                if (isWin) homeDayWins += 1;
                homeDayGoals += m.away_score;
            } else {
                homeNightPlayed += 1;
                if (isWin) homeNightWins += 1;
                homeNightGoals += m.away_score;
            }
        }

        if (m.home_team === awayTeam) {
            const isWin = m.home_score > m.away_score;
            if (isDay) {
                awayDayPlayed += 1;
                if (isWin) awayDayWins += 1;
                awayDayGoals += m.home_score;
            } else {
                awayNightPlayed += 1;
                if (isWin) awayNightWins += 1;
                awayNightGoals += m.home_score;
            }
        } else if (m.away_team === awayTeam) {
            const isWin = m.away_score > m.home_score;
            if (isDay) {
                awayDayPlayed += 1;
                if (isWin) awayDayWins += 1;
                awayDayGoals += m.away_score;
            } else {
                awayNightPlayed += 1;
                if (isWin) awayNightWins += 1;
                awayNightGoals += m.away_score;
            }
        }
    }

    // 1. First Goal probabilities
    const prob00 = scores.find(s => s.homeScore === 0 && s.awayScore === 0)?.probability || 0;
    const sumXG = homeXG + awayXG;
    const fgHome = sumXG > 0 ? (homeXG / sumXG) * (1 - prob00) : 0;
    const fgAway = sumXG > 0 ? (awayXG / sumXG) * (1 - prob00) : 0;
    const fgNone = prob00;

    // 2. Home/Away Exact Goals
    const homeExactGoals = {
        eg0: homeProb[0] || 0,
        eg1: homeProb[1] || 0,
        eg2: homeProb[2] || 0,
        eg3: homeProb[3] || 0,
        eg4Plus: Math.max(0, 1 - (homeProb[0] || 0) - (homeProb[1] || 0) - (homeProb[2] || 0) - (homeProb[3] || 0))
    };
    const awayExactGoals = {
        eg0: awayProb[0] || 0,
        eg1: awayProb[1] || 0,
        eg2: awayProb[2] || 0,
        eg3: awayProb[3] || 0,
        eg4Plus: Math.max(0, 1 - (awayProb[0] || 0) - (awayProb[1] || 0) - (awayProb[2] || 0) - (awayProb[3] || 0))
    };

    // 3. Teams to Score
    const teamsToScore = {
        both: gg,
        onlyHome: scores.filter(s => s.homeScore > 0 && s.awayScore === 0).reduce((acc, s) => acc + s.probability, 0),
        onlyAway: scores.filter(s => s.homeScore === 0 && s.awayScore > 0).reduce((acc, s) => acc + s.probability, 0),
        none: prob00
    };

    // 4. Correct Score Grid dictionary
    const correctScoreGrid = {};
    for (const score of ['0:0', '1:0', '2:0', '3:0', '0:1', '0:2', '0:3', '1:1', '2:1', '3:1', '1:2', '2:2', '3:2', '1:3', '2:3', '3:3']) {
        const [h, a] = score.split(':').map(Number);
        const matchScore = scores.find(s => s.homeScore === h && s.awayScore === a);
        correctScoreGrid[score.replace(':', '_')] = matchScore ? matchScore.probability : 0;
    }

    // 5. HT Asian Handicaps
    const htAHMinus0_5 = htHomeWinProb;
    const htAHPlus0_5 = htHomeWinProb + htDrawProb;
    const htAHMinus1_5 = htScores.filter(s => s.homeScore - s.awayScore > 1).reduce((acc, s) => acc + s.probability, 0);
    const htAHPlus1_5 = 1 - htScores.filter(s => s.awayScore - s.homeScore > 1).reduce((acc, s) => acc + s.probability, 0);

    const htAHMinus0_75 = htScores.filter(s => s.homeScore - s.awayScore >= 2).reduce((acc, s) => acc + s.probability, 0) +
                          0.5 * htScores.filter(s => s.homeScore - s.awayScore === 1).reduce((acc, s) => acc + s.probability, 0);
    const htAHPlus0_75 = htScores.filter(s => s.awayScore - s.homeScore >= 2).reduce((acc, s) => acc + s.probability, 0) +
                         0.5 * htScores.filter(s => s.awayScore - s.homeScore === 1).reduce((acc, s) => acc + s.probability, 0);

    const kickoffStats = {
        homeDay: {
            played: homeDayPlayed,
            winRate: homeDayPlayed > 0 ? (homeDayWins / homeDayPlayed) * 100 : 0,
            avgGoals: homeDayPlayed > 0 ? homeDayGoals / homeDayPlayed : 0
        },
        homeNight: {
            played: homeNightPlayed,
            winRate: homeNightPlayed > 0 ? (homeNightWins / homeNightPlayed) * 100 : 0,
            avgGoals: homeNightPlayed > 0 ? homeNightGoals / homeNightPlayed : 0
        },
        awayDay: {
            played: awayDayPlayed,
            winRate: awayDayPlayed > 0 ? (awayDayWins / awayDayPlayed) * 100 : 0,
            avgGoals: awayDayPlayed > 0 ? awayDayGoals / awayDayPlayed : 0
        },
        awayNight: {
            played: awayNightPlayed,
            winRate: awayNightPlayed > 0 ? (awayNightWins / awayNightPlayed) * 100 : 0,
            avgGoals: awayNightPlayed > 0 ? awayNightGoals / awayNightPlayed : 0
        }
    };

    db.close();

    return {
        homeXG,
        awayXG,
        homeWinProb,
        drawProb,
        awayWinProb,
        topScorelines,
        correctScoresList,
        correctScoreGrid,
        over05,
        over15,
        over25,
        over35,
        over45,
        over55,
        gg,
        ng,
        evenProb,
        oddProb,
        exactGoals: {
            eg0, eg1, eg2, eg3, eg4, eg5, eg6Plus
        },
        doubleChance: {
            dc1X, dc12, dcX2
        },
        drawNoBet: {
            home: dnbHome,
            away: dnbAway
        },
        handicap3Way: {
            minus2: hcMinus2,
            minus1: hcMinus1,
            plus1: hcPlus1,
            plus2: hcPlus2
        },
        asianHandicap: {
            minus1_5: ahMinus1_5,
            plus1_5: ahPlus1_5,
            minus1_25: ahMinus1_25,
            plus1_25: ahPlus1_25,
            minus1_75: ahMinus1_75,
            plus1_75: ahPlus1_75
        },
        halftimeFulltime: {
            htft11, htft1X, htft12,
            htftX1, htftXX, htftX2,
            htft21, htft2X, htft22
        },
        highestScoringHalf: {
            firstHalf: hshFirst,
            secondHalf: hshSecond,
            equal: hshEqual
        },
        firstGoal: {
            home: fgHome,
            away: fgAway,
            none: fgNone
        },
        homeTotalGoals: {
            over05: hgOver05,
            under05: Math.max(0, 1 - hgOver05),
            over15: hgOver15,
            under15: Math.max(0, 1 - hgOver15),
            over25: hgOver25,
            under25: Math.max(0, 1 - hgOver25)
        },
        awayTotalGoals: {
            over05: agOver05,
            under05: Math.max(0, 1 - agOver05),
            over15: agOver15,
            under15: Math.max(0, 1 - agOver15),
            over25: agOver25,
            under25: Math.max(0, 1 - agOver25)
        },
        homeExactGoals,
        awayExactGoals,
        teamsToScore,
        
        // HT statistics
        ht: {
            homeHT_XG,
            awayHT_XG,
            homeWinProb: htHomeWinProb,
            drawProb: htDrawProb,
            awayWinProb: htAwayWinProb,
            topScorelines: topHTScorelines,
            over05: htOver05,
            over15: htOver15,
            over25: htOver25,
            over35: htOver35,
            over45: htOver45,
            over55: htOver55,
            gg: htGg,
            ng: htNg,
            doubleChance: {
                dc1X: htDc1X,
                dc12: htDc12,
                dcX2: htDcX2
            },
            handicap3Way: {
                minus1: htHcMinus1,
                plus1: htHcPlus1
            },
            asianHandicap: {
                minus0_5: { home: htAHMinus0_5, away: Math.max(0, 1 - htAHMinus0_5) },
                plus0_5: { home: htAHPlus0_5, away: Math.max(0, 1 - htAHPlus0_5) },
                minus0_75: { home: htAHMinus0_75, away: Math.max(0, 1 - htAHMinus0_75) },
                plus0_75: { home: Math.max(0, 1 - htAHPlus0_75), away: htAHPlus0_75 },
                minus1_5: { home: htAHMinus1_5, away: Math.max(0, 1 - htAHMinus1_5) },
                plus1_5: { home: htAHPlus1_5, away: Math.max(0, 1 - htAHPlus1_5) }
            }
        },
        
        // Time stats
        kickoffStats
    };
}

function calculateEloRatings(dbPath, homeTeam, awayTeam, provider = 'bet9ja') {
    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db, homeTeam, awayTeam, provider);

    if (allMatches.length < 5) {
        db.close();
        return null;
    }

    const elo = {};
    const getElo = (team) => elo[team] || 1500;
    const K = 32;

    for (const m of allMatches) {
        const rHome = getElo(m.home_team);
        const rAway = getElo(m.away_team);

        const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
        const eAway = 1 - eHome;

        let sHome = 0.5;
        if (m.home_score > m.away_score) sHome = 1;
        else if (m.home_score < m.away_score) sHome = 0;
        const sAway = 1 - sHome;

        elo[m.home_team] = rHome + K * (sHome - eHome);
        elo[m.away_team] = rAway + K * (sAway - eAway);
    }

    const homeElo = getElo(homeTeam);
    const awayElo = getElo(awayTeam);

    const homeEloWinProb = 1 / (1 + Math.pow(10, (awayElo - homeElo) / 400));
    const awayEloWinProb = 1 - homeEloWinProb;

    db.close();

    return {
        homeElo,
        awayElo,
        homeEloWinProb,
        awayEloWinProb
    };
}

function optimizeBlendingWeights(dbPath, provider = 'bet9ja') {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const db = new Database(dbPath);
    const allMatches = getCleanedMatches(db, null, null, provider);

    if (allMatches.length < 20) {
        db.close();
        return { success: false, error: 'Insufficient matches to perform weights optimization (minimum 20 completed matches required).' };
    }

    // Chronological simulation variables
    let totalHomeGoals = 0;
    let totalAwayGoals = 0;
    let matchCount = 0;

    const stats = {};
    const initTeamStats = () => ({
        homeGoalsScored: 0,
        homeGoalsConceded: 0,
        homeMatches: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 0,
        awayMatches: 0
    });

    const elo = {};
    const getElo = (team) => elo[team] || 1500;
    const K = 32;

    const decayRates = [];
    for (let d = 0.0; d <= 0.06; d += 0.005) {
        decayRates.push(parseFloat(d.toFixed(4)));
    }
    const testCases = [];

    // Chronological simulation loop
    for (const m of allMatches) {
        // We only evaluate predictions for the last 150 matches to keep optimization fast and adaptive
        if (matchCount >= 10 && matchCount >= allMatches.length - 150 && stats[m.home_team] && stats[m.away_team]) {
            // Calculate Elo
            const rHome = getElo(m.home_team);
            const rAway = getElo(m.away_team);
            const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
            const eAway = 1 - eHome;

            // Actual outcome
            let actual = 0; // 0 for draw, 1 for home win, -1 for away win
            if (m.home_score > m.away_score) actual = 1;
            else if (m.home_score < m.away_score) actual = -1;

            const trainingRows = allMatches.slice(Math.max(0, matchCount - 500), matchCount);

            // Predict under each decay rate (using pure Poisson with weight = 1.0)
            const poissonPredictions = {};
            for (const d of decayRates) {
                const pred = predictFromRows(trainingRows, m.home_team, m.away_team, d, 1.0);
                if (pred) {
                    poissonPredictions[d] = {
                        pHome: pred.homeWinProb,
                        pAway: pred.awayWinProb
                    };
                } else {
                    poissonPredictions[d] = { pHome: 0.33, pAway: 0.33 };
                }
            }

            testCases.push({
                poissonPredictions,
                eHome,
                eAway,
                actual
            });
        }

        // Update Elo & Stats with this match
        const rHome = getElo(m.home_team);
        const rAway = getElo(m.away_team);
        const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
        const eAway = 1 - eHome;

        let sHome = 0.5;
        if (m.home_score > m.away_score) sHome = 1;
        else if (m.home_score < m.away_score) sHome = 0;
        const sAway = 1 - sHome;

        elo[m.home_team] = rHome + K * (sHome - eHome);
        elo[m.away_team] = rAway + K * (sAway - eAway);

        if (!stats[m.home_team]) stats[m.home_team] = initTeamStats();
        if (!stats[m.away_team]) stats[m.away_team] = initTeamStats();

        stats[m.home_team].homeGoalsScored += m.home_score;
        stats[m.home_team].homeGoalsConceded += m.away_score;
        stats[m.home_team].homeMatches += 1;

        stats[m.away_team].awayGoalsScored += m.away_score;
        stats[m.away_team].awayGoalsConceded += m.home_score;
        stats[m.away_team].awayMatches += 1;

        totalHomeGoals += m.home_score;
        totalAwayGoals += m.away_score;
        matchCount += 1;
    }

    db.close();

    if (testCases.length < 5) {
        return { success: false, error: 'Insufficient matchups evaluated to tune model weights.' };
    }

    // Grid search weights and decay rates to minimize Brier Score (Stage 1: Coarse Search)
    let bestCoarseW = 0.6;
    let bestCoarseDecay = 0.015;
    let minCoarseBrier = Infinity;

    for (const d of decayRates) {
        for (let w = 0; w <= 1.0; w += 0.05) {
            let brierSum = 0;
            for (const tc of testCases) {
                const pred = tc.poissonPredictions[d];
                const bHome = (pred.pHome * w) + (tc.eHome * (1 - w));
                const bAway = (pred.pAway * w) + (tc.eAway * (1 - w));
                const bDraw = Math.max(0, 1 - bHome - bAway);

                const actualHome = tc.actual === 1 ? 1 : 0;
                const actualDraw = tc.actual === 0 ? 1 : 0;
                const actualAway = tc.actual === -1 ? 1 : 0;

                const brier = Math.pow(bHome - actualHome, 2) + Math.pow(bDraw - actualDraw, 2) + Math.pow(bAway - actualAway, 2);
                brierSum += brier;
            }

            const avgBrier = brierSum / testCases.length;
            if (avgBrier < minCoarseBrier) {
                minCoarseBrier = avgBrier;
                bestCoarseW = w;
                bestCoarseDecay = d;
            }
        }
    }

    // Stage 2: Fine Grid Search (around bestCoarseDecay and bestCoarseW)
    const fineDecayRates = [];
    const minDecay = Math.max(0.0, bestCoarseDecay - 0.004);
    const maxDecay = Math.min(0.06, bestCoarseDecay + 0.004);
    for (let d = minDecay; d <= maxDecay; d += 0.0005) {
        fineDecayRates.push(parseFloat(d.toFixed(4)));
    }

    const fineWeights = [];
    const minWeight = Math.max(0.0, bestCoarseW - 0.10);
    const maxWeight = Math.min(1.0, bestCoarseW + 0.10);
    for (let w = minWeight; w <= maxWeight; w += 0.01) {
        fineWeights.push(parseFloat(w.toFixed(4)));
    }

    // Run a quick second pass to generate predictions for fine decay rates
    const fineTestCases = [];
    let matchCountFine = 0;
    const statsFine = {};
    const initTeamStatsFine = () => ({
        homeGoalsScored: 0, homeGoalsConceded: 0, homeMatches: 0,
        awayGoalsScored: 0, awayGoalsConceded: 0, awayMatches: 0
    });
    const eloFine = {};
    const getEloFine = (team) => eloFine[team] || 1500;

    for (const m of allMatches) {
        if (matchCountFine >= 10 && matchCountFine >= allMatches.length - 300 && statsFine[m.home_team] && statsFine[m.away_team]) {
            const rHome = getEloFine(m.home_team);
            const rAway = getEloFine(m.away_team);
            const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
            const eAway = 1 - eHome;

            let actual = 0;
            if (m.home_score > m.away_score) actual = 1;
            else if (m.home_score < m.away_score) actual = -1;

            const trainingRows = allMatches.slice(0, matchCountFine);
            const poissonPredictions = {};
            for (const d of fineDecayRates) {
                const pred = predictFromRows(trainingRows, m.home_team, m.away_team, d, 1.0);
                if (pred) {
                    poissonPredictions[d] = {
                        pHome: pred.homeWinProb,
                        pAway: pred.awayWinProb
                    };
                } else {
                    poissonPredictions[d] = { pHome: 0.33, pAway: 0.33 };
                }
            }

            fineTestCases.push({
                poissonPredictions,
                eHome,
                eAway,
                actual
            });
        }

        // Update ELO & Stats
        const rHome = getEloFine(m.home_team);
        const rAway = getEloFine(m.away_team);
        const eHome = 1 / (1 + Math.pow(10, (rAway - rHome) / 400));
        let sHome = 0.5;
        if (m.home_score > m.away_score) sHome = 1;
        else if (m.home_score < m.away_score) sHome = 0;
        eloFine[m.home_team] = rHome + K * (sHome - eHome);
        eloFine[m.away_team] = rAway + K * ((1 - sHome) - (1 - eHome));

        if (!statsFine[m.home_team]) statsFine[m.home_team] = initTeamStatsFine();
        if (!statsFine[m.away_team]) statsFine[m.away_team] = initTeamStatsFine();
        statsFine[m.home_team].homeGoalsScored += m.home_score;
        statsFine[m.home_team].homeGoalsConceded += m.away_score;
        statsFine[m.home_team].homeMatches += 1;
        statsFine[m.away_team].awayGoalsScored += m.away_score;
        statsFine[m.away_team].awayGoalsConceded += m.home_score;
        statsFine[m.away_team].awayMatches += 1;

        matchCountFine += 1;
    }

    // Now search the fine grid
    let bestW = bestCoarseW;
    let bestDecay = bestCoarseDecay;
    let minBrier = minCoarseBrier;

    for (const d of fineDecayRates) {
        for (const w of fineWeights) {
            let brierSum = 0;
            for (const tc of fineTestCases) {
                const pred = tc.poissonPredictions[d];
                const bHome = (pred.pHome * w) + (tc.eHome * (1 - w));
                const bAway = (pred.pAway * w) + (tc.eAway * (1 - w));
                const bDraw = Math.max(0, 1 - bHome - bAway);

                const actualHome = tc.actual === 1 ? 1 : 0;
                const actualDraw = tc.actual === 0 ? 1 : 0;
                const actualAway = tc.actual === -1 ? 1 : 0;

                const brier = Math.pow(bHome - actualHome, 2) + Math.pow(bDraw - actualDraw, 2) + Math.pow(bAway - actualAway, 2);
                brierSum += brier;
            }

            const avgBrier = brierSum / fineTestCases.length;
            if (avgBrier < minBrier) {
                minBrier = avgBrier;
                bestW = w;
                bestDecay = d;
            }
        }
    }

    const weightsPath = `${dbPath}.weights.json`;
    const weightsData = {
        poissonWeight: bestW,
        eloWeight: 1 - bestW,
        decayRate: bestDecay,
        optimizedAt: new Date().toISOString(),
        brierScore: minBrier,
        matchesAnalyzed: testCases.length
    };

    try {
        fs.writeFileSync(weightsPath, JSON.stringify(weightsData, null, 2));
    } catch (err) {
        console.error("Error writing ML weights file:", err.message);
        return { success: false, error: `Failed to save weights file: ${err.message}` };
    }

    return {
        success: true,
        poissonWeight: bestW,
        eloWeight: 1 - bestW,
        decayRate: bestDecay,
        brierScore: minBrier,
        matchesAnalyzed: testCases.length
    };
}

function predictMatchupML(dbPath, homeTeam, awayTeam, provider = 'bet9ja') {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const poissonResult = calculatePoissonMatchup(dbPath, homeTeam, awayTeam, null, provider);
    const eloResult = calculateEloRatings(dbPath, homeTeam, awayTeam, provider);

    if (!poissonResult) {
        return { success: false, error: 'Insufficient match data to train Machine Learning model (need at least 5 parsed matches in the database).' };
    }

    // Load optimized weights or default to 60/40
    let poissonWeight = 0.6;
    let eloWeight = 0.4;
    let poissonWeightDraw = 0.6;
    let poissonWeightWin = 0.6;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.poissonWeight === 'number' && typeof data.eloWeight === 'number') {
                poissonWeight = data.poissonWeight;
                eloWeight = data.eloWeight;
                poissonWeightDraw = typeof data.poissonWeightDraw === 'number' ? data.poissonWeightDraw : poissonWeight;
                poissonWeightWin = typeof data.poissonWeightWin === 'number' ? data.poissonWeightWin : poissonWeight;
            }
        } catch (err) {
            console.error("Error reading ML weights file, using defaults:", err.message);
        }
    }

    // Blend Poisson and Elo probabilities (Corrected 3-Way Blend)
    const pHome = poissonResult.homeWinProb;
    const pAway = poissonResult.awayWinProb;
    const pDraw = poissonResult.drawProb;

    const eloHome2way = eloResult ? eloResult.homeEloWinProb : pHome;
    const eloAway2way = eloResult ? eloResult.awayEloWinProb : pAway;

    const eloHome3way = eloHome2way * (1 - pDraw);
    const eloAway3way = eloAway2way * (1 - pDraw);
    const eloDraw3way = pDraw;

    const blendedHomeWin = (pHome * poissonWeightWin) + (eloHome3way * (1 - poissonWeightWin));
    const blendedAwayWin = (pAway * poissonWeightWin) + (eloAway3way * (1 - poissonWeightWin));
    const blendedDraw    = (pDraw * poissonWeightDraw) + (eloDraw3way * (1 - poissonWeightDraw));

    // Calculate Confidence Score
    const maxProb = Math.max(blendedHomeWin, blendedDraw, blendedAwayWin);
    let confidenceScore = Math.round(40 + (maxProb - 0.33) * 85);
    confidenceScore = Math.max(50, Math.min(98, confidenceScore));

    return {
        success: true,
        modelName: 'Blended Poisson-Elo Football Prediction Model v2.2',
        poisson: poissonResult,
        elo: eloResult,
        weights: {
            poissonWeight,
            eloWeight
        },
        blended: {
            homeWin: blendedHomeWin,
            draw: blendedDraw,
            awayWin: blendedAwayWin
        },
        confidenceScore
    };
}

/**
 * Predict match outcome using raw match rows (no DB needed).
 * Used by the backtest walk-forward simulation so we don't re-open the DB per match.
 * matchRows must be an array of { home_team, away_team, home_score, away_score }.
 */
function predictFromRows(matchRows, homeTeam, awayTeam, decayRate = 0.015, poissonWeight = 0.6, timeGoalsFactor = 1.0) {
    if (!matchRows || matchRows.length < 5) return null;

    const { avgHomeGoals, avgAwayGoals, stats } = getWeightedStats(matchRows, decayRate);

    const homeTeamStats = stats[homeTeam];
    const awayTeamStats = stats[awayTeam];
    if (!homeTeamStats || !awayTeamStats) return null;

    const homeMatchesWeight = homeTeamStats.homeMatchesWeight || 0;
    const totalHomeWeight = (homeTeamStats.homeMatchesWeight || 0) + (homeTeamStats.awayMatchesWeight || 0);

    const overallHomeAttack = totalHomeWeight > 0 ? 
        ((homeTeamStats.homeGoalsScored + homeTeamStats.awayGoalsScored) / totalHomeWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;
    const overallHomeDefense = totalHomeWeight > 0 ? 
        ((homeTeamStats.homeGoalsConceded + homeTeamStats.awayGoalsConceded) / totalHomeWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;

    const rawHomeAttack = homeMatchesWeight > 0 ? 
        (homeTeamStats.homeGoalsScored / homeMatchesWeight) / (avgHomeGoals || 1) : overallHomeAttack;
    const rawHomeDefense = homeMatchesWeight > 0 ? 
        (homeTeamStats.homeGoalsConceded / homeMatchesWeight) / (avgAwayGoals || 1) : overallHomeDefense;

    const homeBlend = Math.min(1.0, homeMatchesWeight / 1.5);
    let homeAttack = homeBlend * rawHomeAttack + (1 - homeBlend) * overallHomeAttack;
    let homeDefense = homeBlend * rawHomeDefense + (1 - homeBlend) * overallHomeDefense;

    const awayMatchesWeight = awayTeamStats.awayMatchesWeight || 0;
    const totalAwayWeight = (awayTeamStats.homeMatchesWeight || 0) + (awayTeamStats.awayMatchesWeight || 0);

    const overallAwayAttack = totalAwayWeight > 0 ? 
        ((awayTeamStats.awayGoalsScored + awayTeamStats.awayGoalsScored) / totalAwayWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;
    const overallAwayDefense = totalAwayWeight > 0 ? 
        ((awayTeamStats.homeGoalsConceded + awayTeamStats.awayGoalsConceded) / totalAwayWeight) / (((avgHomeGoals + avgAwayGoals) / 2) || 1) : 1.0;

    const rawAwayAttack = awayMatchesWeight > 0 ? 
        (awayTeamStats.awayGoalsScored / awayMatchesWeight) / (avgAwayGoals || 1) : overallAwayAttack;
    const rawAwayDefense = awayMatchesWeight > 0 ? 
        (awayTeamStats.awayGoalsConceded / awayMatchesWeight) / (avgHomeGoals || 1) : overallAwayDefense;

    const awayBlend = Math.min(1.0, awayMatchesWeight / 1.5);
    let awayAttack = awayBlend * rawAwayAttack + (1 - awayBlend) * overallAwayAttack;
    let awayDefense = awayBlend * rawAwayDefense + (1 - awayBlend) * overallAwayDefense;

    // Form/Streak Modifiers (Dynamic Horizon)
    const lookbackCount = getDynamicFormLookback(matchRows);
    const homeForm = getFormModifier(homeTeam, matchRows, lookbackCount);
    const awayForm = getFormModifier(awayTeam, matchRows, lookbackCount);
    homeAttack *= homeForm.attack;
    homeDefense *= homeForm.defense;
    awayAttack *= awayForm.attack;
    awayDefense *= awayForm.defense;

    let homeXG = homeAttack * awayDefense * avgHomeGoals * timeGoalsFactor;
    let awayXG = awayAttack * homeDefense * avgAwayGoals * timeGoalsFactor;

    // H2H matchup bias
    const h2hAdjustments = getH2HMatchupAdjustments(homeTeam, awayTeam, matchRows);
    if (h2hAdjustments) {
        const h2hWeight = 0.25;
        homeXG = (1 - h2hWeight) * homeXG + h2hWeight * h2hAdjustments.homeH2HAvg;
        awayXG = (1 - h2hWeight) * awayXG + h2hWeight * h2hAdjustments.awayH2HAvg;
    }

    // Calculate HT stats
    const { avgHomeHTGoals, avgAwayHTGoals, htStats } = getWeightedHTStats(matchRows, decayRate);
    const initHTStats = () => ({
        homeGoalsScored: 0, homeGoalsConceded: 0, homeMatchesWeight: 0,
        awayGoalsScored: 0, awayGoalsConceded: 0, awayMatchesWeight: 0
    });
    const homeTeamHT = htStats[homeTeam] || initHTStats();
    const awayTeamHT = htStats[awayTeam] || initHTStats();

    const homeHTMatchesWeight = homeTeamHT.homeMatchesWeight || 0;
    const totalHomeHTWeight = (homeTeamHT.homeMatchesWeight || 0) + (homeTeamHT.awayMatchesWeight || 0);

    const overallHomeHTAttack = totalHomeHTWeight > 0 ?
        ((homeTeamHT.homeGoalsScored + homeTeamHT.awayGoalsScored) / totalHomeHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;
    const overallHomeHTDefense = totalHomeHTWeight > 0 ?
        ((homeTeamHT.homeGoalsConceded + homeTeamHT.awayGoalsConceded) / totalHomeHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;

    const rawHomeHTAttack = homeHTMatchesWeight > 0 ?
        (homeTeamHT.homeGoalsScored / homeHTMatchesWeight) / (avgHomeHTGoals || 1) : overallHomeHTAttack;
    const rawHomeHTDefense = homeHTMatchesWeight > 0 ?
        (homeTeamHT.homeGoalsConceded / homeHTMatchesWeight) / (avgAwayHTGoals || 1) : overallHomeHTDefense;

    const homeHTBlend = Math.min(1.0, homeHTMatchesWeight / 1.5);
    let homeHTAttack = homeHTBlend * rawHomeHTAttack + (1 - homeHTBlend) * overallHomeHTAttack;
    let homeHTDefense = homeHTBlend * rawHomeHTDefense + (1 - homeHTBlend) * overallHomeHTDefense;

    const awayHTMatchesWeight = awayTeamHT.awayMatchesWeight || 0;
    const totalAwayHTWeight = (awayTeamHT.homeMatchesWeight || 0) + (awayTeamHT.awayMatchesWeight || 0);

    const overallAwayHTAttack = totalAwayHTWeight > 0 ?
        ((awayTeamHT.awayGoalsScored + awayTeamHT.awayGoalsScored) / totalAwayHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;
    const overallAwayHTDefense = totalAwayHTWeight > 0 ?
        ((awayTeamHT.homeGoalsConceded + awayTeamHT.awayGoalsConceded) / totalAwayHTWeight) / (((avgHomeHTGoals + avgAwayHTGoals) / 2) || 1) : 1.0;

    const rawAwayHTAttack = awayHTMatchesWeight > 0 ?
        (awayTeamHT.awayGoalsScored / awayHTMatchesWeight) / (avgAwayHTGoals || 1) : overallAwayHTAttack;
    const rawAwayHTDefense = awayHTMatchesWeight > 0 ?
        (awayTeamHT.awayGoalsConceded / awayHTMatchesWeight) / (avgHomeHTGoals || 1) : overallAwayHTDefense;

    const awayHTBlend = Math.min(1.0, awayHTMatchesWeight / 1.5);
    let awayHTAttack = awayHTBlend * rawAwayHTAttack + (1 - awayHTBlend) * overallAwayHTAttack;
    let awayHTDefense = awayHTBlend * rawAwayHTDefense + (1 - awayHTBlend) * overallAwayHTDefense;

    // Apply Form modifiers to HT
    homeHTAttack *= homeForm.attack;
    homeHTDefense *= homeForm.defense;
    awayHTAttack *= awayForm.attack;
    awayHTDefense *= awayForm.defense;

    const homeHT_XG = homeHTAttack * awayHTDefense * avgHomeHTGoals;
    const awayHT_XG = awayHTAttack * homeHTDefense * avgAwayHTGoals;

    const maxHTGoals = 4;
    const homeHTProb = [], awayHTProb = [];
    for (let i = 0; i <= maxHTGoals; i++) {
        homeHTProb.push(poisson(homeHT_XG, i));
        awayHTProb.push(poisson(awayHT_XG, i));
    }
    const htScores = [];
    for (let h = 0; h <= maxHTGoals; h++) {
        for (let a = 0; a <= maxHTGoals; a++) {
            htScores.push({
                homeScore: h,
                awayScore: a,
                probability: homeHTProb[h] * awayHTProb[a]
            });
        }
    }
    let totalHTMatrixProb = htScores.reduce((acc, s) => acc + s.probability, 0) || 1;
    for (const s of htScores) {
        s.probability /= totalHTMatrixProb;
    }

    let htOver15 = 0;
    let htOver25 = 0;
    let htOver35 = 0;
    let htOver45 = 0;
    let htOver55 = 0;
    for (const s of htScores) {
        const total = s.homeScore + s.awayScore;
        if (total > 1) htOver15 += s.probability;
        if (total > 2) htOver25 += s.probability;
        if (total > 3) htOver35 += s.probability;
        if (total > 4) htOver45 += s.probability;
        if (total > 5) htOver55 += s.probability;
    }

    // ── Elo ──────────────────────────────────────────────────────────────────
    let homeEloWinProb = 0.33;
    let awayEloWinProb = 0.33;
    const elo = {};
    const getElo = (t) => elo[t] || 1500;
    
    let minPoissonWeight = 0.6;
    if (typeof poissonWeight === 'object' && poissonWeight !== null) {
        const pW = typeof poissonWeight.poissonWeight === 'number' ? poissonWeight.poissonWeight : 0.6;
        const pWin = typeof poissonWeight.poissonWeightWin === 'number' ? poissonWeight.poissonWeightWin : pW;
        const pDraw = typeof poissonWeight.poissonWeightDraw === 'number' ? poissonWeight.poissonWeightDraw : pW;
        minPoissonWeight = Math.min(pWin, pDraw);
    } else if (typeof poissonWeight === 'number') {
        minPoissonWeight = poissonWeight;
    }
    
    if (minPoissonWeight < 1.0) {
        const K = 32;
        for (const m of matchRows) {
            const rH = getElo(m.home_team), rA = getElo(m.away_team);
            const eH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
            let sH = 0.5;
            if ((m.home_score || 0) > (m.away_score || 0)) sH = 1;
            else if ((m.home_score || 0) < (m.away_score || 0)) sH = 0;
            elo[m.home_team] = rH + K * (sH - eH);
            elo[m.away_team] = rA + K * ((1 - sH) - (1 - eH));
        }
        homeEloWinProb = 1 / (1 + Math.pow(10, (getElo(awayTeam) - getElo(homeTeam)) / 400));
        awayEloWinProb = 1 - homeEloWinProb;
    }


    // ── Poisson matrix ───────────────────────────────────────────────────────
    const calibrations = getMismatchCalibrations(matchRows);
    const maxGoals = 6;
    const homeProb = [], awayProb = [];
    for (let i = 0; i <= maxGoals; i++) {
        homeProb.push(poisson(homeXG, i));
        awayProb.push(poisson(awayXG, i));
    }

    let pHome = 0, pDraw = 0, pAway = 0;
    let over05 = 0, over15 = 0, over25 = 0, over35 = 0, over45 = 0, over55 = 0, gg = 0;
    let odd = 0, even = 0;
    let hgOver05 = 0, hgOver15 = 0;
    let agOver05 = 0, agOver15 = 0;
    let tsOnlyHome = 0, tsOnlyAway = 0, tsNone = 0;

    // SportyBet: 1X2 + Over/Under combos
    let p1ov15=0, pXov15=0, p2ov15=0, p1un15=0, pXun15=0, p2un15=0;
    let p1ov25=0, pXov25=0, p2ov25=0, p1un25=0, pXun25=0, p2un25=0;
    let p1ov35=0, pXov35=0, p2ov35=0, p1un35=0, pXun35=0, p2un35=0;

    // SportyBet: Total Goals exact (0-6)
    let tg0=0, tg1=0, tg2=0, tg3=0, tg4=0, tg5=0, tg6=0;

    // SportyBet: Multigoal ranges (goal-range bets)
    const multigoalRanges = [
        [0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],
        [1,1],[1,2],[1,3],[1,4],[1,5],[1,6],
        [2,2],[2,3],[2,4],[2,5],[2,6],
        [3,3],[3,4],[3,5],[3,6],
        [4,4],[4,5],[4,6],
        [5,5],[5,6],
        [6,6]
    ];
    const multigoalProb = {};
    for (const [lo, hi] of multigoalRanges) {
        multigoalProb[`${lo}-${hi}`] = 0;
    }

    // SportyBet: Correct Score (home 0-6, away 0-6)
    const csProb = {};

    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const p = homeProb[h] * awayProb[a];
            if (h > a) pHome += p;
            else if (h === a) pDraw += p;
            else pAway += p;
            const tot = h + a;
            if (tot > 0) over05 += p;
            if (tot > 1) over15 += p;
            if (tot > 2) over25 += p;
            if (tot > 3) over35 += p;
            if (tot > 4) over45 += p;
            if (tot > 5) over55 += p;
            if (h > 0 && a > 0) gg += p;
            if (tot % 2 === 1) odd += p;
            else even += p;

            // Individual team goals
            if (h > 0) hgOver05 += p;
            if (h > 1) hgOver15 += p;
            if (a > 0) agOver05 += p;
            if (a > 1) agOver15 += p;

            // Teams to score
            if (h > 0 && a === 0) tsOnlyHome += p;
            else if (h === 0 && a > 0) tsOnlyAway += p;
            else if (h === 0 && a === 0) tsNone += p;

            // SportyBet: 1X2 + O/U combos
            const res = h > a ? '1' : (h === a ? 'X' : '2');
            const isOv15 = tot > 1, isUn15 = !isOv15;
            const isOv25 = tot > 2, isUn25 = !isOv25;
            const isOv35 = tot > 3, isUn35 = !isOv35;
            if (res==='1' && isOv15) p1ov15+=p; if (res==='X' && isOv15) pXov15+=p; if (res==='2' && isOv15) p2ov15+=p;
            if (res==='1' && isUn15) p1un15+=p; if (res==='X' && isUn15) pXun15+=p; if (res==='2' && isUn15) p2un15+=p;
            if (res==='1' && isOv25) p1ov25+=p; if (res==='X' && isOv25) pXov25+=p; if (res==='2' && isOv25) p2ov25+=p;
            if (res==='1' && isUn25) p1un25+=p; if (res==='X' && isUn25) pXun25+=p; if (res==='2' && isUn25) p2un25+=p;
            if (res==='1' && isOv35) p1ov35+=p; if (res==='X' && isOv35) pXov35+=p; if (res==='2' && isOv35) p2ov35+=p;
            if (res==='1' && isUn35) p1un35+=p; if (res==='X' && isUn35) pXun35+=p; if (res==='2' && isUn35) p2un35+=p;

            // SportyBet: Total Goals exact
            if (tot === 0) tg0 += p;
            else if (tot === 1) tg1 += p;
            else if (tot === 2) tg2 += p;
            else if (tot === 3) tg3 += p;
            else if (tot === 4) tg4 += p;
            else if (tot === 5) tg5 += p;
            else if (tot >= 6) tg6 += p;

            // SportyBet: Multigoal
            for (const [lo, hi] of multigoalRanges) {
                if (tot >= lo && tot <= hi) multigoalProb[`${lo}-${hi}`] += p;
            }

            // SportyBet: Correct Score
            const csKey = `${h}-${a}`;
            csProb[csKey] = (csProb[csKey] || 0) + p;
        }
    }

    const totalP = pHome + pDraw + pAway || 1;
    pHome /= totalP; pDraw /= totalP; pAway /= totalP;
    over05 /= totalP; over15 /= totalP; over25 /= totalP;
    over35 /= totalP; over45 /= totalP; over55 /= totalP;
    gg /= totalP;
    odd /= totalP; even /= totalP;
    hgOver05 /= totalP; hgOver15 /= totalP;
    agOver05 /= totalP; agOver15 /= totalP;
    tsOnlyHome /= totalP; tsOnlyAway /= totalP; tsNone /= totalP;

    // Normalize SportyBet market combos
    p1ov15/=totalP; pXov15/=totalP; p2ov15/=totalP; p1un15/=totalP; pXun15/=totalP; p2un15/=totalP;
    p1ov25/=totalP; pXov25/=totalP; p2ov25/=totalP; p1un25/=totalP; pXun25/=totalP; p2un25/=totalP;
    p1ov35/=totalP; pXov35/=totalP; p2ov35/=totalP; p1un35/=totalP; pXun35/=totalP; p2un35/=totalP;
    tg0/=totalP; tg1/=totalP; tg2/=totalP; tg3/=totalP; tg4/=totalP; tg5/=totalP; tg6/=totalP;
    for (const k of Object.keys(multigoalProb)) multigoalProb[k] /= totalP;
    for (const k of Object.keys(csProb)) csProb[k] /= totalP;

    // Apply draw bias calibration to Poisson matrix outcomes
    pDraw *= calibrations.draw;
    const sum = pHome + pDraw + pAway;
    if (sum > 0) {
        pHome /= sum;
        pDraw /= sum;
        pAway /= sum;
    }

    // Apply Mismatch Calibration (calibrations is defined above)
    over15 = Math.max(0.0, Math.min(1.0, over15 * calibrations.over15));
    over25 = Math.max(0.0, Math.min(1.0, over25 * calibrations.over25));
    over35 = Math.max(0.0, Math.min(1.0, over35 * calibrations.over35));
    over45 = Math.max(0.0, Math.min(1.0, over45 * calibrations.over45));
    over55 = Math.max(0.0, Math.min(1.0, over55 * calibrations.over55));
    gg = Math.max(0.0, Math.min(1.0, gg * calibrations.gg));

    // Highest Scoring Half calculation
    const lambda1H = (homeHT_XG || 0) + (awayHT_XG || 0);
    const lambda2H = Math.max(0, homeXG - (homeHT_XG || 0)) + Math.max(0, awayXG - (awayHT_XG || 0));

    const maxHalfGoals = 8;
    const p1H = [], p2H = [];
    for (let i = 0; i <= maxHalfGoals; i++) {
        p1H.push(poisson(lambda1H, i));
        p2H.push(poisson(lambda2H, i));
    }

    let htScoring1st = 0;
    let htScoring2nd = 0;
    let htScoringEqual = 0;

    for (let h1 = 0; h1 <= maxHalfGoals; h1++) {
        for (let h2 = 0; h2 <= maxHalfGoals; h2++) {
            const p = p1H[h1] * p2H[h2];
            if (h1 > h2) htScoring1st += p;
            else if (h2 > h1) htScoring2nd += p;
            else htScoringEqual += p;
        }
    }

    const totalHalfP = htScoring1st + htScoring2nd + htScoringEqual || 1;
    htScoring1st /= totalHalfP;
    htScoring2nd /= totalHalfP;
    htScoringEqual /= totalHalfP;

    // HT/FT Combinations
    const homeSH_XG = Math.max(0, homeXG - (homeHT_XG || 0));
    const awaySH_XG = Math.max(0, awayXG - (awayHT_XG || 0));
    
    const maxSHGoals = 4;
    const shHomeProb = [], shAwayProb = [];
    for (let i = 0; i <= maxSHGoals; i++) {
        shHomeProb.push(poisson(homeSH_XG, i));
        shAwayProb.push(poisson(awaySH_XG, i));
    }
    const shScores = [];
    for (let h = 0; h <= maxSHGoals; h++) {
        for (let a = 0; a <= maxSHGoals; a++) {
            shScores.push({
                homeScore: h,
                awayScore: a,
                probability: shHomeProb[h] * shAwayProb[a]
            });
        }
    }
    let totalSHMatrixProb = shScores.reduce((acc, s) => acc + s.probability, 0) || 1;
    for (const s of shScores) {
        s.probability /= totalSHMatrixProb;
    }

    let htft11 = 0, htft1X = 0, htft12 = 0;
    let htftX1 = 0, htftXX = 0, htftX2 = 0;
    let htft21 = 0, htft2X = 0, htft22 = 0;

    for (const s1 of htScores) {
        const htResult = s1.homeScore > s1.awayScore ? '1' : (s1.homeScore === s1.awayScore ? 'X' : '2');
        for (const s2 of shScores) {
            const ftHome = s1.homeScore + s2.homeScore;
            const ftAway = s1.awayScore + s2.awayScore;
            const ftResult = ftHome > ftAway ? '1' : (ftHome === ftAway ? 'X' : '2');
            
            const prob = s1.probability * s2.probability;
            
            if (htResult === '1' && ftResult === '1') htft11 += prob;
            else if (htResult === '1' && ftResult === 'X') htft1X += prob;
            else if (htResult === '1' && ftResult === '2') htft12 += prob;
            else if (htResult === 'X' && ftResult === '1') htftX1 += prob;
            else if (htResult === 'X' && ftResult === 'X') htftXX += prob;
            else if (htResult === 'X' && ftResult === '2') htftX2 += prob;
            else if (htResult === '2' && ftResult === '1') htft21 += prob;
            else if (htResult === '2' && ftResult === 'X') htft2X += prob;
            else if (htResult === '2' && ftResult === '2') htft22 += prob;
        }
    }

    // ── Blend Poisson + Elo (Corrected 3-Way Blend) ─────────────────────────
    let wWin = 0.6;
    let wDraw = 0.6;
    if (typeof poissonWeight === 'object' && poissonWeight !== null) {
        wWin = typeof poissonWeight.poissonWeightWin === 'number' ? poissonWeight.poissonWeightWin : (poissonWeight.poissonWeight || 0.6);
        wDraw = typeof poissonWeight.poissonWeightDraw === 'number' ? poissonWeight.poissonWeightDraw : (poissonWeight.poissonWeight || 0.6);
    } else if (typeof poissonWeight === 'number') {
        wWin = poissonWeight;
        wDraw = poissonWeight;
    }
    const eloHome3way = homeEloWinProb * (1 - pDraw);
    const eloAway3way = awayEloWinProb * (1 - pDraw);
    const eloDraw3way = pDraw;

    const blendedHomeWin = pHome * wWin + eloHome3way * (1 - wWin);
    const blendedAwayWin = pAway * wWin + eloAway3way * (1 - wWin);
    const blendedDraw    = pDraw * wDraw + eloDraw3way * (1 - wDraw);

    // Generate highly detailed AI reasoning
    const hElo = getElo(homeTeam);
    const aElo = getElo(awayTeam);
    const eloDiff = Math.round(hElo - aElo);
    const eloAdvantage = eloDiff > 0 ? homeTeam : (eloDiff < 0 ? awayTeam : 'Neither');
    
    // xG stats
    const hXG = homeXG.toFixed(2);
    const aXG = awayXG.toFixed(2);
    
    // Baseline probabilities
    const homeProbPct = Math.round(blendedHomeWin * 100);
    const drawProbPct = Math.round(blendedDraw * 100);
    const awayProbPct = Math.round(blendedAwayWin * 100);
    const over15Pct = Math.round(over15 * 100);
    const over25Pct = Math.round(over25 * 100);
    const ggPct = Math.round(gg * 100);
    
    let reasoning = `📊 Form & Statistical Matchup Profile:
• Expected Goals (xG): ${homeTeam} (${hXG} xG) vs ${awayTeam} (${aXG} xG). Total expected goals: ${(homeXG + awayXG).toFixed(2)}.
• Weighted Historical Strength: ${homeTeam} average home performance vs ${awayTeam} away defense yields a projected 1X2 model probability of: Home Win: ${homeProbPct}%, Draw: ${drawProbPct}%, Away Win: ${awayProbPct}%.
• Elo Rating Matrix: ${homeTeam} Elo is ${Math.round(hElo)} vs ${awayTeam} Elo of ${Math.round(aElo)}. rating difference of ${Math.abs(eloDiff)} pts in favor of ${eloAdvantage}.
• Key Market Projections: Over 1.5 Goals (${over15Pct}%), Over 2.5 Goals (${over25Pct}%), Both Teams to Score GG (${ggPct}%).

💡 AI Recommended Technical Verdict:
`;

    // Recommend highly accurate picks based on high confidence threshold rules
    let pick = 'Draw No Bet / Under-Over goals';
    let reasoningVerdict = '';
    
    if (blendedHomeWin >= 0.52 && homeEloWinProb >= 0.50) {
        pick = `${homeTeam} to Win`;
        reasoningVerdict = `The Poisson-Elo blended model indicates a high-conviction victory for ${homeTeam} (blended win probability: ${homeProbPct}%). Assisted by a strong Elo advantage (+${eloDiff} pts), ${homeTeam} has demonstrated solid attacking efficiency at home (${hXG} xG) while ${awayTeam}'s away defense is vulnerable.`;
    } else if (blendedAwayWin >= 0.52 && awayEloWinProb >= 0.50) {
        pick = `${awayTeam} to Win`;
        reasoningVerdict = `The model projects an away victory for ${awayTeam} (blended probability: ${awayProbPct}%). ${awayTeam}'s superior rating profile (Elo: ${Math.round(aElo)}) combined with a projected ${aXG} expected goals rate makes them high-value favorites against ${homeTeam} (${hXG} xG).`;
    } else if (over25 >= 0.65) {
        pick = `Over 2.5 Goals`;
        reasoningVerdict = `A high-scoring matchup is anticipated (Over 2.5 probability: ${over25Pct}%). Both sides exhibit high attacking intent (combined ${(homeXG + awayXG).toFixed(2)} xG), with a high likelihood of Both Teams to Score (${ggPct}%).`;
    } else if (over15 >= 0.76) {
        pick = `Over 1.5 Goals`;
        reasoningVerdict = `This fixture represents a safe, highly stable candidate for Over 1.5 Goals (${over15Pct}% probability). Attacking matrices suggest at least 2 goals will be scored under walk-forward simulation tests.`;
    } else if (gg >= 0.62) {
        pick = `Both Teams to Score (GG)`;
        reasoningVerdict = `Both teams are highly likely to find the back of the net (GG probability: ${ggPct}%). Attack-to-defense ratios for both home and away units indicate mutual concessions.`;
    } else {
        // Safe fallbacks
        const dnbHome = Math.round((blendedHomeWin / (blendedHomeWin + blendedAwayWin || 1)) * 100);
        if (dnbHome >= 58) {
            pick = `${homeTeam} Draw No Bet`;
            reasoningVerdict = `${homeTeam} is favored with defensive coverage (Draw No Bet probability: ${dnbHome}%). Model indicates a very low probability of an outright away win (${awayProbPct}%).`;
        } else {
            const dnbAway = 100 - dnbHome;
            pick = `${awayTeam} Draw No Bet`;
            reasoningVerdict = `${awayTeam} is favored with defensive coverage (Draw No Bet probability: ${dnbAway}%). Model indicates a very low probability of an outright home win (${homeProbPct}%).`;
        }
    }

    reasoning += `Based on historical simulations, the recommended pick is **${pick}**. ${reasoningVerdict}`;

    // Low confidence skip logic: max probability < 39%
    const isLowConfidence = Math.max(blendedHomeWin, blendedDraw, blendedAwayWin) < 0.39;
    if (isLowConfidence) {
        reasoning = `⚠️ WARNING: High-risk matchup with low-confidence probability profile (max probability below 39%). Proceed with caution.\n\n` + reasoning;
    }

    // Determine if an anomaly is present (e.g. extreme Elo deviation or extremely high draw probability or low confidence)
    const anomalyDetected = (Math.abs(blendedHomeWin - homeEloWinProb) > 0.28 || blendedDraw > 0.40 || isLowConfidence) ? 1 : 0;

    return {
        homeWinProb: blendedHomeWin,
        drawProb:    blendedDraw,
        awayWinProb: blendedAwayWin,
        over05, over15, over25, over35, over45, over55, gg,
        htOver25, htOver35,
        odd, even,
        htScoring1st, htScoring2nd, htScoringEqual,
        drawNoBet: {
            home: blendedHomeWin + blendedAwayWin > 0 ? blendedHomeWin / (blendedHomeWin + blendedAwayWin) : 0.5,
            away: blendedAwayWin + blendedHomeWin > 0 ? blendedAwayWin / (blendedHomeWin + blendedAwayWin) : 0.5
        },
        halftimeFulltime: {
            htft11, htft1X, htft12,
            htftX1, htftXX, htftX2,
            htft21, htft2X, htft22
        },
        ht: {
            over15: htOver15,
            over25: htOver25,
            over35: htOver35,
            over45: htOver45,
            over55: htOver55
        },
        homeTotalGoals: {
            over05: hgOver05,
            over15: hgOver15
        },
        awayTotalGoals: {
            over05: agOver05,
            over15: agOver15
        },
        teamsToScore: {
            both: gg,
            onlyHome: tsOnlyHome,
            onlyAway: tsOnlyAway,
            none: tsNone
        },
        // SportyBet-specific markets
        sportybet: {
            combo1X2_OU: {
                '1+OV 1.5': p1ov15, 'X+OV 1.5': pXov15, '2+OV 1.5': p2ov15,
                '1+UN 1.5': p1un15, 'X+UN 1.5': pXun15, '2+UN 1.5': p2un15,
                '1+OV 2.5': p1ov25, 'X+OV 2.5': pXov25, '2+OV 2.5': p2ov25,
                '1+UN 2.5': p1un25, 'X+UN 2.5': pXun25, '2+UN 2.5': p2un25,
                '1+OV 3.5': p1ov35, 'X+OV 3.5': pXov35, '2+OV 3.5': p2ov35,
                '1+UN 3.5': p1un35, 'X+UN 3.5': pXun35, '2+UN 3.5': p2un35
            },
            totalGoals: { 0: tg0, 1: tg1, 2: tg2, 3: tg3, 4: tg4, 5: tg5, 6: tg6 },
            multigoal: multigoalProb,
            correctScore: csProb
        },
        aiReasoning: reasoning,
        anomalyDetected
    };
}

/**
 * Full walk-forward backtest using Poisson+Elo.
 * Reads ALL matches from both the fixtures table AND betting_analytics table,
 * then for each match in the target season it predicts using only prior data.
 * dbPath – path to the SQLite DB that has a betting_analytics table.
 */
function runBacktestML(dbPath, seasonName, provider = 'bet9ja') {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const db = new Database(dbPath);
    const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';

    // Fetch the target season's matches (ordered chronologically)
    let seasonMatches = [];
    try {
        seasonMatches = db.prepare(
            `SELECT * FROM ${viewName} WHERE season_name = ? ORDER BY id ASC`
        ).all(seasonName);
    } catch (e) {
        db.close();
        return { success: false, error: `Could not read ${viewName}: ` + e.message };
    }

    if (seasonMatches.length === 0) {
        db.close();
        return { success: false, error: 'No matches found for season: ' + seasonName };
    }

    // Fetch ALL matches from the target view as training pool (ordered by id)
    let allMatches = [];
    try {
        allMatches = db.prepare(
            `SELECT id, home_team, away_team, home_score, away_score, ht_home_score, ht_away_score FROM ${viewName} ORDER BY id ASC`
        ).all();
    } catch (e) {
        db.close();
        return { success: false, error: `Could not read ${viewName} training data: ` + e.message };
    }

    db.close();

    let decayRate = 0.015;
    let poissonWeight = 0.6;
    const weightsPath = `${dbPath}.weights.json`;
    if (fs.existsSync(weightsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
            if (typeof data.decayRate === 'number') {
                decayRate = data.decayRate;
            }
            if (typeof data.poissonWeight === 'number') {
                poissonWeight = data.poissonWeight;
            }
        } catch (e) {
            // ignore
        }
    }

    // Load time pattern analyzer report once
    let timeReport = null;
    try {
        timeReport = analyseTimePatterns(dbPath);
    } catch (e) {
        // time_pattern_analyzer may fail or not exist, proceed without time correction
    }

    // Walk-forward: for each test match use only rows with id < match.id
    const results = [];

    for (const match of seasonMatches) {
        const { home_team, away_team, match_result, over_1_5, over_2_5, gg_ng, total_goals } = match;

        // Training set = up to the last 10000 rows strictly before this match (prevents data leakage & noise)
        const trainingRows = allMatches.filter(r => r.id < match.id).slice(-10000);

        // Resolve hourly time-of-day goal adjustment factor
        let hour = null;
        if (match.match_time && match.match_time.includes(':')) {
            let timeStr = match.match_time;
            if (timeStr.includes('T')) {
                timeStr = timeStr.split('T')[1];
            }
            hour = parseInt(timeStr.split(':')[0], 10);
        }

        let timeGoalsFactor = 1.0;
        if (hour !== null && timeReport && timeReport.success && timeReport.hasTimedData) {
            const slot = timeReport.hourlyStats.find(h => h.hour === hour);
            if (slot && slot.matchCount >= 20) {
                const leagueAvg = timeReport.leagueRates.avgGoals;
                const slotAvg   = slot.rates.avgGoals;
                if (leagueAvg > 0) {
                    timeGoalsFactor = Math.max(0.75, Math.min(1.25, slotAvg / leagueAvg));
                }
            }
        }

        const pred = predictFromRows(trainingRows, home_team, away_team, decayRate, poissonWeight, timeGoalsFactor);

        // Actual outcomes
        const actualResult  = match_result;              // 'Home', 'Draw', 'Away'
        const actualOver15  = over_1_5 === 'Yes';
        const actualOver25  = over_2_5 === 'Yes';
        const actualOver35  = (total_goals || 0) > 3;
        const actualOver45  = (total_goals || 0) > 4;
        const actualOver55  = (total_goals || 0) > 5;

        const actualUnder15  = !actualOver15;
        const actualUnder25  = !actualOver25;
        const actualUnder35  = !actualOver35;
        const actualUnder45  = !actualOver45;
        const actualUnder55  = !actualOver55;

        const actualGG      = gg_ng === 'GG';
        const actualHTGoals = (match.ht_home_score || 0) + (match.ht_away_score || 0);
        const actualHTOver15 = actualHTGoals > 1;
        const actualHTUnder15 = actualHTGoals <= 1;
        const actualHTOver25 = actualHTGoals > 2;
        const actualHTUnder25 = actualHTGoals <= 2;
        const actualHTOver35 = actualHTGoals > 3;
        const actualHTUnder35 = actualHTGoals <= 3;
        const actualHTOver45 = actualHTGoals > 4;
        const actualHTUnder45 = actualHTGoals <= 4;

        const actualOdd  = (total_goals || 0) % 2 === 1;
        const actualEven = (total_goals || 0) % 2 === 0;
        const actual2HGoals = (match.home_score || 0) - (match.ht_home_score || 0) + (match.away_score || 0) - (match.ht_away_score || 0);
        const actual1stHalfHigher = actualHTGoals > actual2HGoals;
        const actual2ndHalfHigher = actualHTGoals < actual2HGoals;
        const actualHalvesEqual   = actualHTGoals === actual2HGoals;
        const actualTeamsToScoreBoth = (match.home_score > 0 && match.away_score > 0);
        const actualTeamsToScoreOnlyHome = (match.home_score > 0 && match.away_score === 0);
        const actualTeamsToScoreOnlyAway = (match.home_score === 0 && match.away_score > 0);
        const actualTeamsToScoreNone = (match.home_score === 0 && match.away_score === 0);
        const actualHTResult = (match.ht_home_score || 0) > (match.ht_away_score || 0)
            ? 'Home'
            : (match.ht_home_score || 0) < (match.ht_away_score || 0)
                ? 'Away'
                : 'Draw';
        const actualHTft11 = actualHTResult === 'Home' && actualResult === 'Home';
        const actualHTft1X = actualHTResult === 'Home' && actualResult === 'Draw';
        const actualHTft12 = actualHTResult === 'Home' && actualResult === 'Away';
        const actualHTftX1 = actualHTResult === 'Draw' && actualResult === 'Home';
        const actualHTftXX = actualHTResult === 'Draw' && actualResult === 'Draw';
        const actualHTftX2 = actualHTResult === 'Draw' && actualResult === 'Away';
        const actualHTft21 = actualHTResult === 'Away' && actualResult === 'Home';
        const actualHTft2X = actualHTResult === 'Away' && actualResult === 'Draw';
        const actualHTft22 = actualHTResult === 'Away' && actualResult === 'Away';
        const actualHomeGoals = match.home_score || 0;
        const actualAwayGoals = match.away_score || 0;

        // SportyBet actual outcomes
        const ftTotalGoals = actualHomeGoals + actualAwayGoals;
        const actualTotalGoalsExact = ftTotalGoals >= 6 ? 6 : ftTotalGoals; // cap at 6+
        const actualCS = `${actualHomeGoals}-${actualAwayGoals}`;
        // 1X2 combo actual result token
        const actual1X2Token = actualResult === 'Home' ? '1' : (actualResult === 'Away' ? '2' : 'X');
        const actualIsOv15 = ftTotalGoals > 1, actualIsUn15 = !actualIsOv15;
        const actualIsOv25 = ftTotalGoals > 2, actualIsUn25 = !actualIsOv25;
        const actualIsOv35 = ftTotalGoals > 3, actualIsUn35 = !actualIsOv35;

        if (!pred) {
            // Not enough training data for this match – skip
            results.push({
                homeTeam: home_team, awayTeam: away_team,
                actualResult, actualOver15, actualOver25, actualOver35, actualOver45, actualOver55, actualGG,
                actualUnder15, actualUnder25, actualUnder35, actualUnder45, actualUnder55,
                actualHTOver25, actualHTUnder25, actualHTOver35, actualHTUnder35, actualHTOver45, actualHTUnder45,
                actualOdd, actualEven, actual1stHalfHigher, actual2ndHalfHigher, actualHalvesEqual,
                predicted: null, predOver15: null, predOver25: null, predOver35: null,
                predOver45: null, predOver55: null, predGG: null,
                predUnder15: null, predUnder25: null, predUnder35: null, predUnder45: null, predUnder55: null,
                predHTOver25: null, predHTUnder25: null, predHTOver35: null, predHTUnder35: null,
                under15Prob: null, under25Prob: null, under35Prob: null, under45Prob: null, under55Prob: null,
                ngProb: null,
                htOver15Prob: null, htUnder15Prob: null, htOver25Prob: null, htUnder25Prob: null, htOver35Prob: null, htUnder35Prob: null, htOver45Prob: null, htUnder45Prob: null, htOver55Prob: null,
                htScoring1stProb: null, htScoring2ndProb: null, htScoringEqualProb: null,
                htft11Prob: null, htft1XProb: null, htft12Prob: null, htftX1Prob: null, htftXXProb: null, htftX2Prob: null, htft21Prob: null, htft2XProb: null, htft22Prob: null,
                homeTotalGoalsOver05Prob: null, homeTotalGoalsUnder05Prob: null, homeTotalGoalsOver15Prob: null, homeTotalGoalsUnder15Prob: null,
                awayTotalGoalsOver05Prob: null, awayTotalGoalsUnder05Prob: null, awayTotalGoalsOver15Prob: null, awayTotalGoalsUnder15Prob: null,
                actualHomeGoals: match.home_score || 0,
                actualAwayGoals: match.away_score || 0,
                homeWinProb: null, drawProb: null, awayWinProb: null,
                ggProb: null, oddProb: null, evenProb: null,
                trainingSize: trainingRows.length,
                skipped: true,
                actualDNBHome: false,
                actualDNBAway: false,
                isNotDraw: false,
                dnbHomeProb: null,
                dnbAwayProb: null,
                actualTeamsToScoreBoth: false,
                actualTeamsToScoreOnlyHome: false,
                actualTeamsToScoreOnlyAway: false,
                actualTeamsToScoreNone: false,
                teamsToScoreBothProb: null,
                teamsToScoreOnlyHomeProb: null,
                teamsToScoreOnlyAwayProb: null,
                teamsToScoreNoneProb: null,
                correct1X2: false, correctOver15: false, correctOver25: false,
                correctOver35: false, correctOver45: false, correctOver55: false, correctGG: false,
                correctUnder15: false, correctUnder25: false, correctUnder35: false, correctUnder45: false, correctUnder55: false,
                correctHTOver25: false, correctHTUnder25: false, correctHTOver35: false, correctHTUnder35: false
            });
            continue;
        }

        // Determine predicted outcomes using Poisson probabilities
        let predicted;
        if (pred.homeWinProb >= pred.drawProb && pred.homeWinProb >= pred.awayWinProb)
            predicted = 'Home';
        else if (pred.awayWinProb >= pred.homeWinProb && pred.awayWinProb >= pred.drawProb)
            predicted = 'Away';
        else
            predicted = 'Draw';

        const predOver15 = pred.over15 > 0.50;
        const predOver25 = pred.over25 > 0.50;
        const predOver35 = pred.over35 > 0.50;
        const predOver45 = pred.over45 > 0.50;
        const predOver55 = pred.over55 > 0.50;
        const predGG     = pred.gg     > 0.50;

        const predUnder15 = pred.over15 <= 0.50;
        const predUnder25 = pred.over25 <= 0.50;
        const predUnder35 = pred.over35 <= 0.50;
        const predUnder45 = pred.over45 <= 0.50;
        const predUnder55 = pred.over55 <= 0.50;

        const predHTOver25  = pred.htOver25 > 0.50;
        const predHTUnder25 = pred.htOver25 <= 0.50;
        const predHTOver35  = pred.htOver35 > 0.50;
        const predHTUnder35 = pred.htOver35 <= 0.50;

        // SportyBet predicted probabilities (as integer percentages)
        const sbCombo = pred.sportybet ? pred.sportybet.combo1X2_OU : {};
        const sbTG    = pred.sportybet ? pred.sportybet.totalGoals   : {};
        const sbMG    = pred.sportybet ? pred.sportybet.multigoal    : {};
        const sbCS    = pred.sportybet ? pred.sportybet.correctScore : {};

        const toP = (v) => Math.round((v || 0) * 100);

        results.push({
            homeTeam: home_team,
            awayTeam: away_team,
            actualResult,
            actualOver15,
            actualOver25,
            actualOver35,
            actualOver45,
            actualOver55,
            actualUnder15,
            actualUnder25,
            actualUnder35,
            actualUnder45,
            actualUnder55,
            actualGG,
            actualHTOver15,
            actualHTUnder15,
            actualHTOver25,
            actualHTUnder25,
            actualHTOver35,
            actualHTUnder35,
            actualHTOver45,
            actualHTUnder45,
            actualOdd,
            actualEven,
            actual1stHalfHigher,
            actual2ndHalfHigher,
            actualHalvesEqual,
            predicted,
            predOver15,
            predOver25,
            predOver35,
            predOver45,
            predOver55,
            predUnder15,
            predUnder25,
            predUnder35,
            predUnder45,
            predUnder55,
            predGG,
            predHTOver25,
            predHTUnder25,
            predHTOver35,
            predHTUnder35,
            homeWinProb:  Math.round(pred.homeWinProb * 100),
            drawProb:     Math.round(pred.drawProb    * 100),
            awayWinProb:  Math.round(pred.awayWinProb * 100),
            ggProb:       Math.round(pred.gg          * 100),
            ngProb:       Math.round((1 - pred.gg)      * 100),
            over15Prob:   Math.round(pred.over15      * 100),
            under15Prob:  Math.round((1 - pred.over15) * 100),
            over25Prob:   Math.round(pred.over25      * 100),
            under25Prob:  Math.round((1 - pred.over25) * 100),
            over35Prob:   Math.round(pred.over35      * 100),
            under35Prob:  Math.round((1 - pred.over35) * 100),
            over45Prob:   Math.round(pred.over45      * 100),
            under45Prob:  Math.round((1 - pred.over45) * 100),
            over55Prob:   Math.round(pred.over55      * 100),
            under55Prob:  Math.round((1 - pred.over55) * 100),
            htOver15Prob: Math.round(pred.ht.over15    * 100),
            htUnder15Prob: Math.round((1 - pred.ht.over15) * 100),
            htOver25Prob: Math.round(pred.ht.over25    * 100),
            htUnder25Prob: Math.round((1 - pred.ht.over25) * 100),
            htOver35Prob: Math.round(pred.ht.over35    * 100),
            htUnder35Prob: Math.round((1 - pred.ht.over35) * 100),
            htOver45Prob: Math.round(pred.ht.over45    * 100),
            htUnder45Prob: Math.round((1 - pred.ht.over45) * 100),
            htOver55Prob: Math.round(pred.ht.over55    * 100),
            htScoring1stProb: Math.round(pred.htScoring1st * 100),
            htScoring2ndProb: Math.round(pred.htScoring2nd * 100),
            htScoringEqualProb: Math.round(pred.htScoringEqual * 100),
            htft11Prob: Math.round((pred.halftimeFulltime?.htft11 || 0) * 100),
            htft1XProb: Math.round((pred.halftimeFulltime?.htft1X || 0) * 100),
            htft12Prob: Math.round((pred.halftimeFulltime?.htft12 || 0) * 100),
            htftX1Prob: Math.round((pred.halftimeFulltime?.htftX1 || 0) * 100),
            htftXXProb: Math.round((pred.halftimeFulltime?.htftXX || 0) * 100),
            htftX2Prob: Math.round((pred.halftimeFulltime?.htftX2 || 0) * 100),
            htft21Prob: Math.round((pred.halftimeFulltime?.htft21 || 0) * 100),
            htft2XProb: Math.round((pred.halftimeFulltime?.htft2X || 0) * 100),
            htft22Prob: Math.round((pred.halftimeFulltime?.htft22 || 0) * 100),
            homeTotalGoalsOver05Prob: Math.round(pred.homeTotalGoals.over05 * 100),
            homeTotalGoalsUnder05Prob: Math.round((1 - pred.homeTotalGoals.over05) * 100),
            homeTotalGoalsOver15Prob: Math.round(pred.homeTotalGoals.over15 * 100),
            homeTotalGoalsUnder15Prob: Math.round((1 - pred.homeTotalGoals.over15) * 100),
            awayTotalGoalsOver05Prob: Math.round(pred.awayTotalGoals.over05 * 100),
            awayTotalGoalsUnder05Prob: Math.round((1 - pred.awayTotalGoals.over05) * 100),
            awayTotalGoalsOver15Prob: Math.round(pred.awayTotalGoals.over15 * 100),
            awayTotalGoalsUnder15Prob: Math.round((1 - pred.awayTotalGoals.over15) * 100),
            actualHomeGoals,
            actualAwayGoals,
            actualDNBHome: actualResult === 'Home',
            actualDNBAway: actualResult === 'Away',
            isNotDraw:      actualResult !== 'Draw',
            dnbHomeProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.home : 0.5) * 100),
            dnbAwayProb:  Math.round((pred.drawNoBet ? pred.drawNoBet.away : 0.5) * 100),
            actualTeamsToScoreBoth,
            actualTeamsToScoreOnlyHome,
            actualTeamsToScoreOnlyAway,
            actualTeamsToScoreNone,
            teamsToScoreBothProb: Math.round((pred.teamsToScore ? pred.teamsToScore.both : 0) * 100),
            teamsToScoreOnlyHomeProb: Math.round((pred.teamsToScore ? pred.teamsToScore.onlyHome : 0) * 100),
            teamsToScoreOnlyAwayProb: Math.round((pred.teamsToScore ? pred.teamsToScore.onlyAway : 0) * 100),
            teamsToScoreNoneProb: Math.round((pred.teamsToScore ? pred.teamsToScore.none : 0) * 100),
            // SportyBet: 1X2 + Over/Under combo probs
            sb_1ov15: toP(sbCombo['1+OV 1.5']), sb_Xov15: toP(sbCombo['X+OV 1.5']), sb_2ov15: toP(sbCombo['2+OV 1.5']),
            sb_1un15: toP(sbCombo['1+UN 1.5']), sb_Xun15: toP(sbCombo['X+UN 1.5']), sb_2un15: toP(sbCombo['2+UN 1.5']),
            sb_1ov25: toP(sbCombo['1+OV 2.5']), sb_Xov25: toP(sbCombo['X+OV 2.5']), sb_2ov25: toP(sbCombo['2+OV 2.5']),
            sb_1un25: toP(sbCombo['1+UN 2.5']), sb_Xun25: toP(sbCombo['X+UN 2.5']), sb_2un25: toP(sbCombo['2+UN 2.5']),
            sb_1ov35: toP(sbCombo['1+OV 3.5']), sb_Xov35: toP(sbCombo['X+OV 3.5']), sb_2ov35: toP(sbCombo['2+OV 3.5']),
            sb_1un35: toP(sbCombo['1+UN 3.5']), sb_Xun35: toP(sbCombo['X+UN 3.5']), sb_2un35: toP(sbCombo['2+UN 3.5']),
            // SportyBet: Total Goals exact
            sb_tg0: toP(sbTG[0]), sb_tg1: toP(sbTG[1]), sb_tg2: toP(sbTG[2]),
            sb_tg3: toP(sbTG[3]), sb_tg4: toP(sbTG[4]), sb_tg5: toP(sbTG[5]), sb_tg6: toP(sbTG[6]),
            // SportyBet: Multigoal probabilities stored as JSON string
            sbMultigoalProbs: JSON.stringify(Object.fromEntries(Object.entries(sbMG).map(([k,v]) => [k, toP(v)]))),
            // SportyBet: Correct Score probabilities stored as JSON string
            sbCSProbs: JSON.stringify(Object.fromEntries(Object.entries(sbCS).map(([k,v]) => [k, toP(v)]))),
            // Actual SportyBet outcomes
            actualTotalGoalsExact,
            actualCS,
            actual1X2Token,
            actualIsOv15, actualIsUn15,
            actualIsOv25, actualIsUn25,
            actualIsOv35, actualIsUn35,
            trainingSize: trainingRows.length,
            skipped: false,
            correct1X2:    predicted  === actualResult,
            correctOver15: predOver15 === actualOver15,
            correctOver25: predOver25 === actualOver25,
            correctOver35: predOver35 === actualOver35,
            correctOver45: predOver45 === actualOver45,
            correctOver55: predOver55 === actualOver55,
            correctUnder15: predUnder15 === actualUnder15,
            correctUnder25: predUnder25 === actualUnder25,
            correctUnder35: predUnder35 === actualUnder35,
            correctUnder45: predUnder45 === actualUnder45,
            correctUnder55: predUnder55 === actualUnder55,
            correctGG:     predGG     === actualGG,
            correctHTOver25:  predHTOver25  === actualHTOver25,
            correctHTUnder25: predHTUnder25 === actualHTUnder25,
            correctHTOver35:  predHTOver35  === actualHTOver35,
            correctHTUnder35: predHTUnder35 === actualHTUnder35
        });
    }

    // Aggregate accuracy (only non-skipped rows)
    const evaluated = results.filter(r => !r.skipped);
    const total = evaluated.length;
    const acc = (field) => total > 0 ? (evaluated.filter(r => r[field]).length / total) * 100 : 0;

    return {
        success: true,
        seasonName,
        totalMatches: results.length,
        evaluatedMatches: total,
        skippedMatches: results.length - total,
        modelName: 'Blended Poisson-Elo Football Prediction Model v2.2 (Walk-Forward Backtest)',
        accuracy: {
            result:  acc('correct1X2'),
            over15:  acc('correctOver15'),
            over25:  acc('correctOver25'),
            over35:  acc('correctOver35'),
            over45:  acc('correctOver45'),
            over55:  acc('correctOver55'),
            under15: acc('correctUnder15'),
            under25: acc('correctUnder25'),
            under35: acc('correctUnder35'),
            under45: acc('correctUnder45'),
            under55: acc('correctUnder55'),
            gg:      acc('correctGG'),
            htOver25: acc('correctHTOver25'),
            htUnder25: acc('correctHTUnder25'),
            htOver35: acc('correctHTOver35'),
            htUnder35: acc('correctHTUnder35')
        },
        results
    };
}

function calculateEdgeMetricsFromBacktest(results, lookbackWindow = 100, options = {}) {
    const {
        provider = 'bet9ja',
        minProbability = 55,
        minSamples = 10,
        winRateThreshold = 0.56,
        roiThreshold = 0.05,
        minImpliedOdd = 0,
        maxImpliedOdd = Infinity
    } = options;

    // SportyBet multigoal range keys
    const _mgRanges = [
        '0-0','0-1','0-2','0-3','0-4','0-5','0-6',
        '1-1','1-2','1-3','1-4','1-5','1-6',
        '2-2','2-3','2-4','2-5','2-6',
        '3-3','3-4','3-5','3-6',
        '4-4','4-5','4-6',
        '5-5','5-6',
        '6-6'
    ];
    // SportyBet correct score keys (home 0-6 x away 0-6, same as maxGoals)
    const _csKeys = [];
    for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) _csKeys.push(`${h}-${a}`);

    let markets = [
        'Home Win',
        'Away Win',
        'Draw',
        'Over 1.5 Goals',
        'Under 1.5 Goals',
        'Over 2.5 Goals',
        'Under 2.5 Goals',
        'Over 3.5 Goals',
        'Under 3.5 Goals',
        'Over 4.5 Goals',
        'Under 4.5 Goals',
        'Over 5.5 Goals',
        'No Goal (NG)',
        'Both Teams to Score (GG)',
        'Home Draw No Bet',
        'Away Draw No Bet',
        'HT Over 1.5',
        'HT Under 1.5',
        'HT Over 2.5',
        'HT Under 2.5',
        'HT Over 3.5',
        'HT Under 3.5',
        'HT Over 4.5',
        'HT Under 4.5',
        'HT/FT 1/1',
        'HT/FT 1/X',
        'HT/FT X/1',
        'HT/FT X/X',
        'HT/FT X/2',
        'HT/FT 2/X',
        'HT/FT 2/2',
        'Home Goals Over 0.5',
        'Home Goals Under 0.5',
        'Home Goals Over 1.5',
        'Home Goals Under 1.5',
        'Away Goals Over 0.5',
        'Away Goals Under 0.5',
        'Away Goals Over 1.5',
        'Away Goals Under 1.5',
        'First Half Higher Scoring',
        'Second Half Higher Scoring',
        // SportyBet: 1X2 + Over/Under combos
        '1+OV 1.5','X+OV 1.5','2+OV 1.5','1+UN 1.5','X+UN 1.5','2+UN 1.5',
        '1+OV 2.5','X+OV 2.5','2+OV 2.5','1+UN 2.5','X+UN 2.5','2+UN 2.5',
        '1+OV 3.5','X+OV 3.5','2+OV 3.5','1+UN 3.5','X+UN 3.5','2+UN 3.5',
        // SportyBet: Total Goals exact
        'Total Goals 0','Total Goals 1','Total Goals 2','Total Goals 3',
        'Total Goals 4','Total Goals 5','Total Goals 6+',
        // SportyBet: Multigoal ranges
        ..._mgRanges.map(r => `Multigoal ${r}`),
        // SportyBet: Correct Score
        ..._csKeys.map(k => `CS ${k}`)
    ];

    if (provider === 'sportybet') {
        markets = markets.filter(m => m !== 'Home Draw No Bet' && m !== 'Away Draw No Bet');
    }

    const sliceStart = Math.max(0, results.length - lookbackWindow);
    const rows = results.slice(sliceStart);
    const marketStats = {};

    for (const market of markets) {
        marketStats[market] = {
            market,
            picks: 0,
            wins: 0,
            losses: 0,
            voids: 0,
            totalProfit: 0,
            avgProb: 0,
            totalProb: 0,
            totalOdd: 0,
            candidateCount: 0,
            pickType: null
        };
    }

    for (const row of rows) {
        const probability = Number(row.over15Prob || row.over25Prob || row.homeWinProb || row.drawProb || row.awayWinProb || 0);
        const dnbHomeProb = Number(row.dnbHomeProb || 0);
        const dnbAwayProb = Number(row.dnbAwayProb || 0);
        const ggProb = Number(row.ggProb || 0);
        const over15Prob = Number(row.over15Prob || 0);
        const over25Prob = Number(row.over25Prob || 0);
        const over35Prob = Number(row.over35Prob || 0);

        const candidateDefinitions = [
            { market: 'Home Win', cond: () => row.homeWinProb >= minProbability, won: () => row.actualResult === 'Home', prob: row.homeWinProb },
            { market: 'Away Win', cond: () => row.awayWinProb >= minProbability, won: () => row.actualResult === 'Away', prob: row.awayWinProb },
            { market: 'Draw', cond: () => row.drawProb >= minProbability, won: () => row.actualResult === 'Draw', prob: row.drawProb },
            { market: 'Over 1.5 Goals', cond: () => row.over15Prob >= minProbability, won: () => row.actualOver15, prob: row.over15Prob },
            { market: 'Under 1.5 Goals', cond: () => row.under15Prob >= minProbability, won: () => row.actualUnder15, prob: row.under15Prob },
            { market: 'Over 2.5 Goals', cond: () => row.over25Prob >= minProbability, won: () => row.actualOver25, prob: row.over25Prob },
            { market: 'Under 2.5 Goals', cond: () => row.under25Prob >= minProbability, won: () => row.actualUnder25, prob: row.under25Prob },
            { market: 'Over 3.5 Goals', cond: () => row.over35Prob >= minProbability, won: () => row.actualOver35, prob: row.over35Prob },
            { market: 'Under 3.5 Goals', cond: () => row.under35Prob >= minProbability, won: () => row.actualUnder35, prob: row.under35Prob },
            { market: 'Over 4.5 Goals', cond: () => row.over45Prob >= minProbability, won: () => row.actualOver45, prob: row.over45Prob },
            { market: 'Under 4.5 Goals', cond: () => row.under45Prob >= minProbability, won: () => row.actualUnder45, prob: row.under45Prob },
            { market: 'Over 5.5 Goals', cond: () => row.over55Prob >= minProbability, won: () => row.actualOver55, prob: row.over55Prob },
            { market: 'No Goal (NG)', cond: () => row.ngProb >= minProbability, won: () => !row.actualGG, prob: row.ngProb },
            { market: 'Both Teams to Score (GG)', cond: () => row.ggProb >= minProbability, won: () => row.actualGG, prob: row.ggProb },
            { market: 'Home Draw No Bet', cond: () => row.dnbHomeProb >= minProbability, won: () => row.actualResult === 'Home', void: () => row.actualResult === 'Draw', prob: row.dnbHomeProb },
            { market: 'Away Draw No Bet', cond: () => row.dnbAwayProb >= minProbability, won: () => row.actualResult === 'Away', void: () => row.actualResult === 'Draw', prob: row.dnbAwayProb },
            { market: 'HT Over 1.5', cond: () => row.htOver15Prob >= minProbability, won: () => row.actualHTOver15, prob: row.htOver15Prob },
            { market: 'HT Under 1.5', cond: () => row.htUnder15Prob >= minProbability, won: () => row.actualHTUnder15, prob: row.htUnder15Prob },
            { market: 'HT Over 2.5', cond: () => row.htOver25Prob >= minProbability, won: () => row.actualHTOver25, prob: row.htOver25Prob },
            { market: 'HT Under 2.5', cond: () => row.htUnder25Prob >= minProbability, won: () => row.actualHTUnder25, prob: row.htUnder25Prob },
            { market: 'HT Over 3.5', cond: () => row.htOver35Prob >= minProbability, won: () => row.actualHTOver35, prob: row.htOver35Prob },
            { market: 'HT Under 3.5', cond: () => row.htUnder35Prob >= minProbability, won: () => row.actualHTUnder35, prob: row.htUnder35Prob },
            { market: 'HT Over 4.5', cond: () => row.htOver45Prob >= minProbability, won: () => row.actualHTOver45, prob: row.htOver45Prob },
            { market: 'HT Under 4.5', cond: () => row.htUnder45Prob >= minProbability, won: () => row.actualHTUnder45, prob: row.htUnder45Prob },
            { market: 'HT/FT 1/1', cond: () => row.htft11Prob >= minProbability, won: () => row.actualHTft11, prob: row.htft11Prob },
            { market: 'HT/FT 1/X', cond: () => row.htft1XProb >= minProbability, won: () => row.actualHTft1X, prob: row.htft1XProb },
            { market: 'HT/FT X/1', cond: () => row.htftX1Prob >= minProbability, won: () => row.actualHTftX1, prob: row.htftX1Prob },
            { market: 'HT/FT X/X', cond: () => row.htftXXProb >= minProbability, won: () => row.actualHTftXX, prob: row.htftXXProb },
            { market: 'HT/FT X/2', cond: () => row.htftX2Prob >= minProbability, won: () => row.actualHTftX2, prob: row.htftX2Prob },
            { market: 'HT/FT 2/X', cond: () => row.htft2XProb >= minProbability, won: () => row.actualHTft2X, prob: row.htft2XProb },
            { market: 'HT/FT 2/2', cond: () => row.htft22Prob >= minProbability, won: () => row.actualHTft22, prob: row.htft22Prob },
            { market: 'Home Goals Over 0.5', cond: () => row.homeTotalGoalsOver05Prob >= minProbability, won: () => row.actualHomeGoals > 0, prob: row.homeTotalGoalsOver05Prob },
            { market: 'Home Goals Under 0.5', cond: () => row.homeTotalGoalsUnder05Prob >= minProbability, won: () => row.actualHomeGoals === 0, prob: row.homeTotalGoalsUnder05Prob },
            { market: 'Home Goals Over 1.5', cond: () => row.homeTotalGoalsOver15Prob >= minProbability, won: () => row.actualHomeGoals > 1, prob: row.homeTotalGoalsOver15Prob },
            { market: 'Home Goals Under 1.5', cond: () => row.homeTotalGoalsUnder15Prob >= minProbability, won: () => row.actualHomeGoals <= 1, prob: row.homeTotalGoalsUnder15Prob },
            { market: 'Away Goals Over 0.5', cond: () => row.awayTotalGoalsOver05Prob >= minProbability, won: () => row.actualAwayGoals > 0, prob: row.awayTotalGoalsOver05Prob },
            { market: 'Away Goals Under 0.5', cond: () => row.awayTotalGoalsUnder05Prob >= minProbability, won: () => row.actualAwayGoals === 0, prob: row.awayTotalGoalsUnder05Prob },
            { market: 'Away Goals Over 1.5', cond: () => row.awayTotalGoalsOver15Prob >= minProbability, won: () => row.actualAwayGoals > 1, prob: row.awayTotalGoalsOver15Prob },
            { market: 'Away Goals Under 1.5', cond: () => row.awayTotalGoalsUnder15Prob >= minProbability, won: () => row.actualAwayGoals <= 1, prob: row.awayTotalGoalsUnder15Prob },
            { market: 'First Half Higher Scoring', cond: () => row.htScoring1stProb >= minProbability, won: () => row.actual1stHalfHigher, prob: row.htScoring1stProb },
            { market: 'Second Half Higher Scoring', cond: () => row.htScoring2ndProb >= minProbability, won: () => row.actual2ndHalfHigher, prob: row.htScoring2ndProb },
            // SportyBet: 1X2 + Over/Under combos
            { market: '1+OV 1.5', cond: () => row.sb_1ov15 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsOv15, prob: row.sb_1ov15 },
            { market: 'X+OV 1.5', cond: () => row.sb_Xov15 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsOv15, prob: row.sb_Xov15 },
            { market: '2+OV 1.5', cond: () => row.sb_2ov15 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsOv15, prob: row.sb_2ov15 },
            { market: '1+UN 1.5', cond: () => row.sb_1un15 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsUn15, prob: row.sb_1un15 },
            { market: 'X+UN 1.5', cond: () => row.sb_Xun15 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsUn15, prob: row.sb_Xun15 },
            { market: '2+UN 1.5', cond: () => row.sb_2un15 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsUn15, prob: row.sb_2un15 },
            { market: '1+OV 2.5', cond: () => row.sb_1ov25 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsOv25, prob: row.sb_1ov25 },
            { market: 'X+OV 2.5', cond: () => row.sb_Xov25 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsOv25, prob: row.sb_Xov25 },
            { market: '2+OV 2.5', cond: () => row.sb_2ov25 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsOv25, prob: row.sb_2ov25 },
            { market: '1+UN 2.5', cond: () => row.sb_1un25 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsUn25, prob: row.sb_1un25 },
            { market: 'X+UN 2.5', cond: () => row.sb_Xun25 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsUn25, prob: row.sb_Xun25 },
            { market: '2+UN 2.5', cond: () => row.sb_2un25 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsUn25, prob: row.sb_2un25 },
            { market: '1+OV 3.5', cond: () => row.sb_1ov35 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsOv35, prob: row.sb_1ov35 },
            { market: 'X+OV 3.5', cond: () => row.sb_Xov35 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsOv35, prob: row.sb_Xov35 },
            { market: '2+OV 3.5', cond: () => row.sb_2ov35 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsOv35, prob: row.sb_2ov35 },
            { market: '1+UN 3.5', cond: () => row.sb_1un35 >= minProbability, won: () => row.actual1X2Token==='1' && row.actualIsUn35, prob: row.sb_1un35 },
            { market: 'X+UN 3.5', cond: () => row.sb_Xun35 >= minProbability, won: () => row.actual1X2Token==='X' && row.actualIsUn35, prob: row.sb_Xun35 },
            { market: '2+UN 3.5', cond: () => row.sb_2un35 >= minProbability, won: () => row.actual1X2Token==='2' && row.actualIsUn35, prob: row.sb_2un35 },
            // SportyBet: Total Goals exact
            { market: 'Total Goals 0', cond: () => row.sb_tg0 >= minProbability, won: () => row.actualTotalGoalsExact === 0, prob: row.sb_tg0 },
            { market: 'Total Goals 1', cond: () => row.sb_tg1 >= minProbability, won: () => row.actualTotalGoalsExact === 1, prob: row.sb_tg1 },
            { market: 'Total Goals 2', cond: () => row.sb_tg2 >= minProbability, won: () => row.actualTotalGoalsExact === 2, prob: row.sb_tg2 },
            { market: 'Total Goals 3', cond: () => row.sb_tg3 >= minProbability, won: () => row.actualTotalGoalsExact === 3, prob: row.sb_tg3 },
            { market: 'Total Goals 4', cond: () => row.sb_tg4 >= minProbability, won: () => row.actualTotalGoalsExact === 4, prob: row.sb_tg4 },
            { market: 'Total Goals 5', cond: () => row.sb_tg5 >= minProbability, won: () => row.actualTotalGoalsExact === 5, prob: row.sb_tg5 },
            { market: 'Total Goals 6+', cond: () => row.sb_tg6 >= minProbability, won: () => row.actualTotalGoalsExact === 6, prob: row.sb_tg6 },
            // SportyBet: Multigoal ranges (parsed from JSON string)
            ...((() => {
                const mgProbs = row.sbMultigoalProbs ? (() => { try { return JSON.parse(row.sbMultigoalProbs); } catch(e){ return {}; } })() : {};
                const mgRanges = ['0-0','0-1','0-2','0-3','0-4','0-5','0-6','1-1','1-2','1-3','1-4','1-5','1-6','2-2','2-3','2-4','2-5','2-6','3-3','3-4','3-5','3-6','4-4','4-5','4-6','5-5','5-6','6-6'];
                return mgRanges.map(range => {
                    const [lo, hi] = range.split('-').map(Number);
                    const tg = (row.actualHomeGoals || 0) + (row.actualAwayGoals || 0);
                    return { market: `Multigoal ${range}`, cond: () => (mgProbs[range] || 0) >= minProbability, won: () => tg >= lo && tg <= hi, prob: mgProbs[range] || 0 };
                });
            })()),
            // SportyBet: Correct Score (parsed from JSON string)
            ...((() => {
                const csProbs = row.sbCSProbs ? (() => { try { return JSON.parse(row.sbCSProbs); } catch(e){ return {}; } })() : {};
                const csKeys = [];
                for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) csKeys.push(`${h}-${a}`);
                return csKeys.map(k => {
                    return { market: `CS ${k}`, cond: () => (csProbs[k] || 0) >= minProbability, won: () => row.actualCS === k, prob: csProbs[k] || 0 };
                });
            })())
        ];

        for (const def of candidateDefinitions) {
            if (!marketStats[def.market]) continue;
            if (!def.cond()) continue;

            const stat = marketStats[def.market];
            const prob = Number(def.prob || 0);
            const impliedOdd = prob > 0 ? parseFloat((100 / prob).toFixed(2)) : 0;
            if (impliedOdd > 0 && (impliedOdd < minImpliedOdd || impliedOdd > maxImpliedOdd)) {
                continue;
            }
            const result = def.won();
            const isVoid = typeof def.void === 'function' ? def.void() : false;

            stat.picks += 1;
            stat.totalProb += prob;
            stat.totalOdd += impliedOdd;
            stat.candidateCount += 1;

            if (result) {
                stat.wins += 1;
                stat.totalProfit += impliedOdd - 1;
            } else if (isVoid) {
                stat.voids += 1;
            } else {
                stat.losses += 1;
                stat.totalProfit -= 1;
            }
        }
    }

    const candidates = Object.values(marketStats).map(stat => {
        const sampleSize = stat.wins + stat.losses;
        const winRate = sampleSize > 0 ? stat.wins / sampleSize : 0;
        const avgProb = stat.candidateCount > 0 ? stat.totalProb / stat.candidateCount : 0;
        const avgOdd = stat.candidateCount > 0 ? stat.totalOdd / stat.candidateCount : 0;
        const roi = sampleSize > 0 ? stat.totalProfit / sampleSize : 0;
        return {
            market: stat.market,
            sampleSize,
            wins: stat.wins,
            losses: stat.losses,
            voids: stat.voids,
            winRate,
            roi,
            avgProbability: parseFloat(avgProb.toFixed(1)),
            avgImpliedOdd: parseFloat(avgOdd.toFixed(2)),
            totalProfit: parseFloat(stat.totalProfit.toFixed(2))
        };
    });

    const eligible = candidates.filter(c => c.sampleSize >= minSamples && c.winRate >= winRateThreshold && c.roi >= roiThreshold);
    const sorted = eligible.sort((a, b) => {
        const scoreA = a.winRate * 100 + a.roi * 50 + Math.log10(a.sampleSize + 1);
        const scoreB = b.winRate * 100 + b.roi * 50 + Math.log10(b.sampleSize + 1);
        return scoreB - scoreA;
    });

    return {
        success: true,
        candidates,
        eligible,
        activeEdge: sorted.length > 0 ? sorted[0] : null,
        thresholds: { minProbability, minSamples, winRateThreshold, roiThreshold, minImpliedOdd, maxImpliedOdd }
    };
}

function discoverBet9jaEdgeAcrossSeasons(dbPath, provider = 'bet9ja', options = {}) {
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';
    const db = new Database(dbPath, { readonly: true });
    let seasons = [];
    try {
        seasons = db.prepare(`SELECT DISTINCT season_name FROM ${viewName} WHERE season_name IS NOT NULL ORDER BY season_name ASC`).all().map(r => r.season_name).filter(Boolean);
    } catch (e) {
        db.close();
        return { success: false, error: 'Could not list seasons for cross-season discovery: ' + e.message };
    }
    db.close();

    if (seasons.length === 0) {
        return { success: false, error: 'No seasons available for cross-season discovery' };
    }

    const {
        lookbackWindow = 100,
        minProbability = 0,
        minSamples = 5,
        winRateThreshold: _winRateThreshold = 0.55,
        roiThreshold = 0.05,
        minImpliedOdd = 4,
        maxImpliedOdd = 50,
        minSeasonCount = 2
    } = options;

    // For high-odds markets (implied odds >= 3.0), a 55% win-rate is mathematically
    // impossible (prob <= 33%), so we lower the threshold and rely on ROI instead.
    const winRateThreshold = minImpliedOdd >= 3.0 ? 0.02 : _winRateThreshold;

    const analysisOptions = {
        provider,
        minProbability,
        minSamples,
        winRateThreshold,
        roiThreshold,
        minImpliedOdd,
        maxImpliedOdd
    };

    const seasonsAnalyzed = [];
    const marketSummary = {};
    const activeMarkets = {};

    for (const season of seasons) {
        const backtestResult = runBacktestML(dbPath, season, provider);
        if (!backtestResult.success) {
            continue;
        }

        const edgeReport = calculateEdgeMetricsFromBacktest(backtestResult.results, lookbackWindow, analysisOptions);
        seasonsAnalyzed.push({ season, totalMatches: backtestResult.results.length, edgeReport });

        for (const candidate of edgeReport.eligible || []) {
            if (!marketSummary[candidate.market]) {
                marketSummary[candidate.market] = {
                    market: candidate.market,
                    seasonCount: 0,
                    totalSampleSize: 0,
                    totalWins: 0,
                    totalLosses: 0,
                    totalProfit: 0,
                    totalProbability: 0,
                    totalImpliedOdd: 0,
                    activeSeasonCount: 0,
                    seasons: []
                };
            }
            const summary = marketSummary[candidate.market];
            summary.seasonCount += 1;
            summary.totalSampleSize += candidate.sampleSize;
            summary.totalWins += candidate.wins;
            summary.totalLosses += candidate.losses;
            summary.totalProfit += candidate.totalProfit;
            summary.totalProbability += candidate.avgProbability;
            summary.totalImpliedOdd += candidate.avgImpliedOdd;
            summary.seasons.push(season);
        }

        if (edgeReport.activeEdge) {
            if (!activeMarkets[edgeReport.activeEdge.market]) {
                activeMarkets[edgeReport.activeEdge.market] = 0;
            }
            activeMarkets[edgeReport.activeEdge.market] += 1;
        }
    }

    const stableEdges = Object.values(marketSummary).map(stat => {
        const avgWinRate = stat.totalSampleSize > 0 ? stat.totalWins / stat.totalSampleSize : 0;
        const avgRoi = stat.totalSampleSize > 0 ? stat.totalProfit / stat.totalSampleSize : 0;
        const avgProbability = stat.seasonCount > 0 ? stat.totalProbability / stat.seasonCount : 0;
        const avgImpliedOdd = stat.seasonCount > 0 ? stat.totalImpliedOdd / stat.seasonCount : 0;
        return {
            market: stat.market,
            seasonCount: stat.seasonCount,
            activeSeasonCount: activeMarkets[stat.market] || 0,
            seasons: stat.seasons,
            sampleSize: stat.totalSampleSize,
            wins: stat.totalWins,
            losses: stat.totalLosses,
            totalProfit: parseFloat(stat.totalProfit.toFixed(2)),
            winRate: parseFloat(avgWinRate.toFixed(3)),
            roi: parseFloat(avgRoi.toFixed(3)),
            avgProbability: parseFloat(avgProbability.toFixed(1)),
            avgImpliedOdd: parseFloat(avgImpliedOdd.toFixed(2)),
            consistencyScore: parseFloat((activeMarkets[stat.market] || 0) * 20 + avgWinRate * 100 + avgRoi * 60).toFixed(2)
        };
    }).filter(stat => stat.seasonCount >= minSeasonCount && stat.winRate >= winRateThreshold && stat.roi >= roiThreshold);

    stableEdges.sort((a, b) => parseFloat(b.consistencyScore) - parseFloat(a.consistencyScore));

    let timePatternReport = null;
    try {
        timePatternReport = analyseTimePatterns(dbPath, provider === 'sportybet');
    } catch (e) {
        timePatternReport = { success: false, error: e.message };
    }

    return {
        success: true,
        provider,
        seasonsAvailable: seasons.length,
        seasonsAnalyzed: seasonsAnalyzed.length,
        lookbackWindow,
        analysisOptions,
        seasons: seasonsAnalyzed,
        stableEdges,
        activeEdge: stableEdges.length > 0 ? stableEdges[0] : null,
        discovered: stableEdges.length > 0,
        marketSummary,
        timePatternReport
    };
}

function discoverBet9jaEdge(dbPath, seasonName, lookbackWindow = 100, provider = 'bet9ja', options = {}) {
    const fs = require('fs');
    if (!fs.existsSync(dbPath)) {
        return { success: false, error: 'Database file not found' };
    }

    const result = runBacktestML(dbPath, seasonName, provider);
    if (!result || !result.success) {
        return { success: false, error: result.error || 'Backtest failed while discovering edge' };
    }

    const edgeReport = calculateEdgeMetricsFromBacktest(result.results, lookbackWindow, { ...options, provider });
    const activeEdge = edgeReport.activeEdge;
    const discovered = activeEdge !== null;

    return {
        success: true,
        seasonName,
        provider,
        lookbackWindow,
        discovered,
        activeEdge,
        edgeReport
    };
}

module.exports = {
    predictMatchupML,
    optimizeBlendingWeights,
    predictFromRows,
    runBacktestML,
    discoverBet9jaEdge,
    discoverBet9jaEdgeAcrossSeasons
};
