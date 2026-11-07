'use strict';

/**
 * ai_best_feature_builder.js
 *
 * Extracts walk-forward safe feature vectors for the dedicated AI Best
 * HT/FT XGBoost classifier. Uses only information available BEFORE kick-off.
 *
 * Features per match:
 *   - Home team form (last 10 home games): HT/FT scoring rates, result rates
 *   - Away team form (last 10 away games): same
 *   - Raw model outputs from predicted_probs (as features, not final predictions)
 *   - Derived combined features (strength ratios, goal expectancy)
 *
 * Labels: 0-8 mapping to HT/FT outcomes in HTFT_LABELS order
 */

const path = require('path');
const fs = require('fs');

const HTFT_LABELS = [
    'htft11', 'htft1X', 'htft12',
    'htftX1', 'htftXX', 'htftX2',
    'htft21', 'htft2X', 'htft22'
];

const HTFT_LABEL_TO_IDX = {};
HTFT_LABELS.forEach((l, i) => { HTFT_LABEL_TO_IDX[l] = i; });

/**
 * Determine the HT/FT outcome key from score strings.
 * @returns {string} e.g. 'htft11', 'htftX2' etc.
 */
function getHtftKey(htScore, ftScore) {
    const [hH, hA] = htScore.split(':').map(Number);
    const [fH, fA] = ftScore.split(':').map(Number);
    const ht = hH > hA ? '1' : hH < hA ? '2' : 'X';
    const ft = fH > fA ? '1' : fH < fA ? '2' : 'X';
    return 'htft' + ht + ft;
}

/**
 * Compute rolling form stats for a team from their recent matches.
 * @param {Array} recentMatches - matches sorted ASC by id, already filtered for this team
 * @param {number} N - look-back window
 */
function computeTeamForm(recentMatches, N = 10) {
    const slice = recentMatches.slice(-N);
    if (slice.length === 0) {
        return {
            htGoalsFor: 0.75, htGoalsAgainst: 0.75,
            ftGoalsFor: 1.2, ftGoalsAgainst: 1.2,
            htWinRate: 0.33, htDrawRate: 0.33, htLossRate: 0.33,
            ftWinRate: 0.33, ftDrawRate: 0.33, ftLossRate: 0.33,
            htft11Rate: 0.28, htft22Rate: 0.20, htftXXRate: 0.16,
            htftX1Rate: 0.14, htftX2Rate: 0.11,
            form5: 5  // neutral
        };
    }

    let htGoalsFor=0, htGoalsAgainst=0, ftGoalsFor=0, ftGoalsAgainst=0;
    let htW=0, htD=0, htL=0, ftW=0, ftD=0, ftL=0;
    const htftCounts = {};
    HTFT_LABELS.forEach(l => { htftCounts[l] = 0; });
    let form5pts = 0;
    const last5 = slice.slice(-5);

    slice.forEach(m => {
        htGoalsFor     += m.teamHtGoalsFor;
        htGoalsAgainst += m.teamHtGoalsAgainst;
        ftGoalsFor     += m.teamFtGoalsFor;
        ftGoalsAgainst += m.teamFtGoalsAgainst;

        if (m.htResult === 'W') htW++;
        else if (m.htResult === 'D') htD++;
        else htL++;

        if (m.ftResult === 'W') ftW++;
        else if (m.ftResult === 'D') ftD++;
        else ftL++;

        const key = m.htftKey;
        if (htftCounts[key] !== undefined) htftCounts[key]++;
    });

    last5.forEach(m => {
        if (m.ftResult === 'W') form5pts += 3;
        else if (m.ftResult === 'D') form5pts += 1;
    });

    const n = slice.length;
    return {
        htGoalsFor:     htGoalsFor / n,
        htGoalsAgainst: htGoalsAgainst / n,
        ftGoalsFor:     ftGoalsFor / n,
        ftGoalsAgainst: ftGoalsAgainst / n,
        htWinRate:  htW / n,
        htDrawRate: htD / n,
        htLossRate: htL / n,
        ftWinRate:  ftW / n,
        ftDrawRate: ftD / n,
        ftLossRate: ftL / n,
        htft11Rate: htftCounts['htft11'] / n,
        htft22Rate: htftCounts['htft22'] / n,
        htftXXRate: htftCounts['htftXX'] / n,
        htftX1Rate: htftCounts['htftX1'] / n,
        htftX2Rate: htftCounts['htftX2'] / n,
        form5: form5pts
    };
}

/**
 * Build a feature vector from home + away form + raw model probs.
 * @returns {Array<number>} feature vector (56 features)
 */
function buildFeatureVector(homeForm, awayForm, probs) {
    const p = probs;
    const norm = v => (v || 0) / 100;  // probs stored as 0-100

    const homeStrength  = (norm(p.homeWinProb) + 0.001) / (norm(p.awayWinProb) + 0.001);
    const htGoalExp     = (homeForm.htGoalsFor + awayForm.htGoalsAgainst) / 2;
    const ftGoalExp     = (homeForm.ftGoalsFor + awayForm.ftGoalsAgainst) / 2;
    const homeFormDiff  = homeForm.ftWinRate - awayForm.ftWinRate;
    const htFormDiff    = homeForm.htWinRate  - awayForm.htWinRate;

    return [
        // ── HOME TEAM FORM (15 features) ──
        homeForm.htGoalsFor,
        homeForm.htGoalsAgainst,
        homeForm.ftGoalsFor,
        homeForm.ftGoalsAgainst,
        homeForm.htWinRate,
        homeForm.htDrawRate,
        homeForm.htLossRate,
        homeForm.ftWinRate,
        homeForm.ftDrawRate,
        homeForm.ftLossRate,
        homeForm.htft11Rate,
        homeForm.htft22Rate,
        homeForm.htftXXRate,
        homeForm.htftX1Rate,
        homeForm.htftX2Rate,
        homeForm.form5 / 15,   // normalise to [0,1]

        // ── AWAY TEAM FORM (15 features) ──
        awayForm.htGoalsFor,
        awayForm.htGoalsAgainst,
        awayForm.ftGoalsFor,
        awayForm.ftGoalsAgainst,
        awayForm.htWinRate,
        awayForm.htDrawRate,
        awayForm.htLossRate,
        awayForm.ftWinRate,
        awayForm.ftDrawRate,
        awayForm.ftLossRate,
        awayForm.htft11Rate,
        awayForm.htft22Rate,
        awayForm.htftXXRate,
        awayForm.htftX1Rate,
        awayForm.htftX2Rate,
        awayForm.form5 / 15,

        // ── RAW MODEL PROBS as features (18 features) ──
        norm(p.homeWinProb),
        norm(p.drawProb),
        norm(p.awayWinProb),
        norm(p.over15Prob),
        norm(p.over25Prob),
        norm(p.over35Prob),
        norm(p.ggProb),
        norm(p.htScoring1stProb),
        norm(p.htScoring2ndProb),
        norm(p.htScoringEqualProb),
        norm(p.htft11Prob),
        norm(p.htft1XProb),
        norm(p.htft12Prob),
        norm(p.htftX1Prob),
        norm(p.htftXXProb),
        norm(p.htftX2Prob),
        norm(p.htft21Prob),
        norm(p.htft2XProb),
        norm(p.htft22Prob),

        // ── DERIVED FEATURES (7 features) ──
        homeStrength,
        htGoalExp,
        ftGoalExp,
        homeFormDiff,
        htFormDiff,
        norm(p.over25Prob) > 0.6 ? 1 : 0,   // high scoring game flag
        norm(p.homeWinProb) > 0.5 ? 1 : 0    // strong home favourite flag
    ];
}

/**
 * Main export: build the full training dataset.
 * @param {string|Array} dbOrRows - path to sportybet_archive.db, JSON file path, or Array of rows
 * @returns {{ features: number[][], labels: number[], ids: number[] }}
 */
function buildTrainingDataset(dbOrRows) {
    let rows = [];
    let allRows = [];

    if (Array.isArray(dbOrRows)) {
        rows = dbOrRows;
        allRows = dbOrRows;
    } else if (typeof dbOrRows === 'string' && (dbOrRows.endsWith('.json') || !dbOrRows.endsWith('.db'))) {
        try {
            const content = fs.readFileSync(dbOrRows, 'utf8');
            const parsed = JSON.parse(content);
            rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
            allRows = rows;
        } catch (e) {
            console.error('[FeatureBuilder] Error reading JSON row input:', e.message);
        }
    } else {
        const Database = require('better-sqlite3');
        const db = new Database(dbOrRows, { readonly: true });

        rows = db.prepare(`
            SELECT id, home_team, away_team, predicted_probs, actual_ht_score, actual_score
            FROM historical_market_predictions
            WHERE actual_ht_score IS NOT NULL AND actual_ht_score != ''
              AND actual_score IS NOT NULL AND actual_score LIKE '%:%'
              AND predicted_probs IS NOT NULL
            ORDER BY id ASC
        `).all();

        allRows = db.prepare(`
            SELECT id, home_team, away_team, actual_ht_score, actual_score
            FROM historical_market_predictions
            WHERE actual_ht_score IS NOT NULL AND actual_ht_score != ''
              AND actual_score IS NOT NULL AND actual_score LIKE '%:%'
            ORDER BY id ASC
        `).all();

        db.close();
    }

    // Build per-team match history (chronologically ordered)
    // homeHistory[team] = array of their home-perspective match stats
    const homeHistory = {};
    const awayHistory = {};

    // Pre-index: for each row, what was the result from home/away perspective?
    function matchStats(ht_score, ft_score, isHome) {
        const [hH, hA] = ht_score.split(':').map(Number);
        const [fH, fA] = ft_score.split(':').map(Number);

        const htFor   = isHome ? hH : hA;
        const htAgainst = isHome ? hA : hH;
        const ftFor   = isHome ? fH : fA;
        const ftAgainst = isHome ? fA : fH;

        const htResult = htFor > htAgainst ? 'W' : htFor < htAgainst ? 'L' : 'D';
        const ftResult = ftFor > ftAgainst ? 'W' : ftFor < ftAgainst ? 'L' : 'D';

        const ht = hH > hA ? '1' : hH < hA ? '2' : 'X';
        const ft = fH > fA ? '1' : fH < fA ? '2' : 'X';
        const htftKey = 'htft' + (isHome ? ht : (ht==='1'?'2':ht==='2'?'1':ht)) +
                               (isHome ? ft : (ft==='1'?'2':ft==='2'?'1':ft));
        return {
            teamHtGoalsFor: htFor,
            teamHtGoalsAgainst: htAgainst,
            teamFtGoalsFor: ftFor,
            teamFtGoalsAgainst: ftAgainst,
            htResult,
            ftResult,
            htftKey: HTFT_LABELS.includes(htftKey) ? htftKey : 'htft11' // fallback
        };
    }

    const features = [];
    const labels   = [];
    const ids      = [];

    // For each target row, build form ONLY from rows before it (walk-forward integrity)
    // Build running history incrementally as we iterate
    const homeHistCumul = {};
    const awayHistCumul = {};

    // Map allRows by id for quick lookup
    const allRowsById = {};
    allRows.forEach(r => { allRowsById[r.id] = r; });

    let featuresBuilt = 0, skipped = 0;

    rows.forEach((row, idx) => {
        // All allRows with id < row.id are safe to use as history
        // We already processed them in order, so homeHistCumul/awayHistCumul are current

        const probs = JSON.parse(row.predicted_probs);
        const htftKey = getHtftKey(row.actual_ht_score, row.actual_score);
        const labelIdx = HTFT_LABEL_TO_IDX[htftKey];
        if (labelIdx === undefined) { skipped++; goto_next(row, homeHistCumul, awayHistCumul, matchStats); return; }

        // Get form for home and away teams
        const homeForm = computeTeamForm(homeHistCumul[row.home_team] || []);
        const awayForm = computeTeamForm(awayHistCumul[row.away_team] || []);

        const fv = buildFeatureVector(homeForm, awayForm, probs);

        features.push(fv);
        labels.push(labelIdx);
        ids.push(row.id);
        featuresBuilt++;

        // NOW update history with this match's outcome (after using it as target)
        if (!homeHistCumul[row.home_team]) homeHistCumul[row.home_team] = [];
        if (!awayHistCumul[row.away_team]) awayHistCumul[row.away_team] = [];

        homeHistCumul[row.home_team].push(matchStats(row.actual_ht_score, row.actual_score, true));
        awayHistCumul[row.away_team].push(matchStats(row.actual_ht_score, row.actual_score, false));
    });

    console.log(`Feature build complete: ${featuresBuilt} vectors built, ${skipped} skipped`);
    return { features, labels, ids, htftLabels: HTFT_LABELS };
}

// Helper: update history without building feature (for skipped rows)
function goto_next(row, homeHistCumul, awayHistCumul, matchStats) {
    if (!homeHistCumul[row.home_team]) homeHistCumul[row.home_team] = [];
    if (!awayHistCumul[row.away_team]) awayHistCumul[row.away_team] = [];
    // Can't compute stats without valid scores — skip history update too
}

/**
 * Build feature vector for a LIVE match (inference time).
 * @param {object} probs - parsed predicted_probs object
 * @param {Array}  homeRecentMatches - recent home matches [{teamHtGoalsFor, ...}]
 * @param {Array}  awayRecentMatches - recent away matches
 */
function buildLiveFeatureVector(probs, homeRecentMatches, awayRecentMatches) {
    const homeForm = computeTeamForm(homeRecentMatches || []);
    const awayForm = computeTeamForm(awayRecentMatches || []);
    return buildFeatureVector(homeForm, awayForm, probs);
}

module.exports = {
    buildTrainingDataset,
    buildLiveFeatureVector,
    getHtftKey,
    computeTeamForm,
    HTFT_LABELS,
    HTFT_LABEL_TO_IDX
};
