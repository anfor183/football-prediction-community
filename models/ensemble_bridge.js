/**
 * ensemble_bridge.js — Node.js ↔ Python IPC Bridge for ML Ensemble (Module 6)
 *
 * Spawns the Python ensemble service as a long-lived child process.
 * Communicates via newline-delimited JSON on stdin/stdout.
 *
 * The Python service supports:
 *   - LightGBM, XGBoost, CatBoost, Logistic Regression, Random Forest, MLP
 *   - Returns model-by-model outcome predictions + agreement score
 *   - EV threshold optimization via walk-forward backtest
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const PYTHON_SCRIPT = path.join(__dirname, 'ensemble_service.py');
const VENV_PYTHON = path.join(__dirname, 'venv', 'bin', 'python3');

// Prefer venv python, fall back to system python3
function getPythonBin() {
    if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
    return 'python3';
}

let _proc = null;
let _pendingRequests = new Map();
let _reqId = 0;
let _buffer = '';
let _alive = false;
let _lastError = null;

const emitter = new EventEmitter();

function startEnsembleService() {
    if (_proc && _alive) return;

    const pythonBin = getPythonBin();
    console.error(`[EnsembleBridge] Starting Python ensemble service: ${pythonBin} ${PYTHON_SCRIPT}`);

    _proc = spawn(pythonBin, [PYTHON_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    _alive = true;
    _buffer = '';

    // Suppress EPIPE on stdin — Python may close its stdin before we do
    _proc.stdin.on('error', (err) => {
        if (err.code !== 'EPIPE') {
            console.warn('[EnsembleBridge] stdin error:', err.message);
        }
    });

    _proc.stdout.on('data', (data) => {
        _buffer += data.toString();
        const lines = _buffer.split('\n');
        _buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                const { requestId, ...payload } = msg;
                if (_pendingRequests.has(requestId)) {
                    const { resolve } = _pendingRequests.get(requestId);
                    _pendingRequests.delete(requestId);
                    resolve(payload);
                }
            } catch (e) {
                console.warn('[EnsembleBridge] Failed to parse response:', line, e.message);
            }
        }
    });

    _proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[EnsembleBridge Python] ${msg}`);
    });

    _proc.on('close', (code) => {
        console.error(`[EnsembleBridge] Python process exited with code ${code}`);
        _alive = false;
        _proc = null;
        // Reject all pending
        for (const [, { reject }] of _pendingRequests) {
            reject(new Error(`Python ensemble service exited (code ${code})`));
        }
        _pendingRequests.clear();
    });

    _proc.on('error', (err) => {
        console.error('[EnsembleBridge] Failed to start Python process:', err.message);
        _alive = false;
        _lastError = err.message;
        _proc = null;
    });
}

/**
 * Send a request to the Python ensemble service.
 * Returns a Promise that resolves when the Python service responds.
 *
 * @param {object} payload - JSON payload to send
 * @param {number} timeoutMs - timeout in milliseconds
 * @returns {Promise<object>}
 */
function sendRequest(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        if (!_alive || !_proc) {
            startEnsembleService();
        }

        // Give process a moment to start if freshly spawned
        if (!_alive) {
            setTimeout(() => {
                if (!_alive) {
                    return reject(new Error('[EnsembleBridge] Python service failed to start: ' + (_lastError || 'unknown')));
                }
                doSend(payload, timeoutMs, resolve, reject);
            }, 2000);
            return;
        }

        doSend(payload, timeoutMs, resolve, reject);
    });
}

function doSend(payload, timeoutMs, resolve, reject) {
    if (!_alive || !_proc) {
        return reject(new Error('[EnsembleBridge] Python service not available'));
    }

    const requestId = ++_reqId;
    const message = JSON.stringify({ requestId, ...payload }) + '\n';

    const timer = setTimeout(() => {
        _pendingRequests.delete(requestId);
        reject(new Error('[EnsembleBridge] Python request timed out'));
    }, timeoutMs);

    _pendingRequests.set(requestId, {
        resolve: (data) => { clearTimeout(timer); resetIdleTimer(); resolve(data); },
        reject: (err) => { clearTimeout(timer); resetIdleTimer(); reject(err); }
    });

    try {
        _proc.stdin.write(message);
    } catch (e) {
        _pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(e);
    }
}

/**
 * Get model agreement for a specific matchup.
 *
 * @param {Array} trainingMatches - historical match rows from DB
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {string} predictedOutcome - 'home' | 'draw' | 'away'
 * @returns {Promise<{
 *   agreementScore: number,  // 0-1 fraction of models agreeing with main prediction
 *   modelVotes: { home: number, draw: number, away: number },
 *   consensusOutcome: string,
 *   modelDetails: object,
 *   available: boolean
 * }>}
 */
async function getModelAgreement(trainingMatches, homeTeam, awayTeam, predictedOutcome) {
    // Fallback agreement scores using 4 lightweight JS heuristics
    // (used if Python service is unavailable)
    const jsAgreement = computeJSAgreement(trainingMatches, homeTeam, awayTeam, predictedOutcome);

    try {
        if (!fs.existsSync(PYTHON_SCRIPT)) {
            console.warn('[EnsembleBridge] ensemble_service.py not found, using JS fallback');
            return { ...jsAgreement, available: false, source: 'js_fallback' };
        }

        // Limit training data to last 2000 matches for performance
        const limitedMatches = trainingMatches.slice(-2000).map(m => ({
            hs: m.hs !== undefined ? m.hs : (m.home_score !== undefined ? m.home_score : 0),
            as: m.as !== undefined ? m.as : (m.away_score !== undefined ? m.away_score : 0),
            h: m.h || m.home_team || '',
            a: m.a || m.away_team || ''
        }));

        const response = await sendRequest({
            action: 'predict',
            homeTeam,
            awayTeam,
            trainingMatches: limitedMatches,
            predictedOutcome
        }, 15000);

        return {
            agreementScore: response.agreementScore || 0.5,
            modelVotes: response.modelVotes || { home: 0, draw: 0, away: 0 },
            consensusOutcome: response.consensusOutcome || predictedOutcome,
            modelDetails: response.modelDetails || {},
            available: true,
            source: 'python_ensemble'
        };
    } catch (e) {
        console.warn('[EnsembleBridge] Python service error, using JS fallback:', e.message);
        return { ...jsAgreement, available: false, source: 'js_fallback', error: e.message };
    }
}

/**
 * JS-only fallback model agreement using 4 lightweight Poisson variants.
 * Used when Python service is unavailable.
 */
function computeJSAgreement(matches, homeTeam, awayTeam, predictedOutcome) {
    if (!matches || matches.length < 10) {
        return { agreementScore: 0.5, modelVotes: { home: 0.33, draw: 0.33, away: 0.33 }, consensusOutcome: predictedOutcome, available: false, source: 'insufficient_data' };
    }

    const recent = matches.slice(-500);
    
    // Compute goals averages
    let totalHome = 0, totalAway = 0, n = 0;
    for (const m of recent) {
        if (m.home_score !== null && m.away_score !== null) {
            totalHome += (m.home_score || 0);
            totalAway += (m.away_score || 0);
            n++;
        }
    }
    if (n === 0) return { agreementScore: 0.5, modelVotes: { home: 0.33, draw: 0.33, away: 0.33 }, consensusOutcome: predictedOutcome, available: false, source: 'no_data' };

    const avgH = totalHome / n;
    const avgA = totalAway / n;

    // Simple variant predictions (heuristic, not full Poisson)
    const variants = [
        quickOutcomePrediction(matches.slice(-100), homeTeam, awayTeam, avgH, avgA, 1.0, 1.0),  // base
        quickOutcomePrediction(matches.slice(-50), homeTeam, awayTeam, avgH, avgA, 1.05, 0.95), // form-adjusted
        quickOutcomePrediction(matches.slice(-200), homeTeam, awayTeam, avgH, avgA, 0.98, 1.02), // regression
        quickH2HOutcome(matches, homeTeam, awayTeam)                                              // H2H
    ].filter(v => v !== null);

    if (variants.length === 0) {
        return { agreementScore: 0.5, modelVotes: { home: 0.33, draw: 0.33, away: 0.33 }, consensusOutcome: predictedOutcome, available: false, source: 'no_variants' };
    }

    const votes = { home: 0, draw: 0, away: 0 };
    for (const v of variants) votes[v]++;
    
    const total = variants.length;
    const matchVotes = votes[predictedOutcome] || 0;
    const agreementScore = matchVotes / total;

    const consensusOutcome = Object.keys(votes).reduce((a, b) => votes[a] >= votes[b] ? a : b);

    return {
        agreementScore,
        modelVotes: {
            home: votes.home / total,
            draw: votes.draw / total,
            away: votes.away / total
        },
        consensusOutcome,
        available: true,
        source: 'js_variants'
    };
}

function quickOutcomePrediction(matches, homeTeam, awayTeam, avgH, avgA, homeBoost, awayBoost) {
    const homeMatches = matches.filter(m => m.home_team === homeTeam);
    const awayMatches = matches.filter(m => m.away_team === awayTeam);
    if (homeMatches.length < 3 || awayMatches.length < 3) return null;

    const homeScore = homeMatches.reduce((s, m) => s + (m.home_score || 0), 0) / homeMatches.length;
    const awayScore = awayMatches.reduce((s, m) => s + (m.away_score || 0), 0) / awayMatches.length;

    const expH = (homeScore / (avgH || 1)) * avgH * homeBoost;
    const expA = (awayScore / (avgA || 1)) * avgA * awayBoost;

    if (Math.abs(expH - expA) < 0.2) return 'draw';
    return expH > expA ? 'home' : 'away';
}

function quickH2HOutcome(matches, homeTeam, awayTeam) {
    const h2h = matches.filter(m =>
        (m.home_team === homeTeam && m.away_team === awayTeam) ||
        (m.home_team === awayTeam && m.away_team === homeTeam)
    ).slice(-10);
    if (h2h.length < 3) return null;

    let homeWins = 0, awayWins = 0, draws = 0;
    for (const m of h2h) {
        if (m.home_team === homeTeam) {
            if (m.home_score > m.away_score) homeWins++;
            else if (m.home_score < m.away_score) awayWins++;
            else draws++;
        } else {
            if (m.away_score > m.home_score) homeWins++; // homeTeam was away
            else if (m.away_score < m.home_score) awayWins++;
            else draws++;
        }
    }
    if (homeWins > awayWins && homeWins > draws) return 'home';
    if (awayWins > homeWins && awayWins > draws) return 'away';
    return 'draw';
}

/**
 * Request optimal EV thresholds from Python ensemble backtester.
 *
 * @param {Array} settledPicks - historical settled picks with ev_score and status
 * @returns {Promise<{ safest: number, highValue: number, highRisk: number }>}
 */
async function getOptimalEVThresholds(settledPicks) {
    try {
        if (!fs.existsSync(PYTHON_SCRIPT)) {
            return { safest: 0.02, highValue: 0.05, highRisk: 0.08, source: 'default' };
        }

        const response = await sendRequest({
            action: 'optimize_ev_thresholds',
            settledPicks
        }, 60000);

        return {
            safest: response.safest || 0.02,
            highValue: response.highValue || 0.05,
            highRisk: response.highRisk || 0.08,
            roi: response.expectedROI,
            source: 'ml_optimized'
        };
    } catch (e) {
        console.warn('[EnsembleBridge] EV threshold optimization failed:', e.message);
        return { safest: 0.02, highValue: 0.05, highRisk: 0.08, source: 'default' };
    }
}

/**
 * Gracefully shut down the Python service.
 */
function shutdown() {
    if (_proc && _alive) {
        console.error('[EnsembleBridge] Shutting down Python ensemble service...');
        try {
            // Only write if stdin is still writable (avoid EPIPE crash)
            if (_proc.stdin && !_proc.stdin.destroyed && _proc.stdin.writable) {
                _proc.stdin.write(JSON.stringify({ action: 'shutdown', requestId: 0 }) + '\n');
            }
            setTimeout(() => {
                if (_proc) _proc.kill('SIGTERM');
            }, 2000);
        } catch (e) {
            if (e.code !== 'EPIPE') {
                console.warn('[EnsembleBridge] shutdown write error:', e.message);
            }
            if (_proc) { try { _proc.kill('SIGTERM'); } catch (_) {} }
        }
    }
}

// Auto-start on module load disabled for low-RAM / VPS performance.
// The Python service is lazily started on first request via sendRequest().

let _idleTimeout = null;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function resetIdleTimer() {
    if (_idleTimeout) clearTimeout(_idleTimeout);
    _idleTimeout = setTimeout(() => {
        if (_alive && _pendingRequests.size === 0) {
            console.log('[EnsembleBridge] Python service idle for 10m. Shutting down to conserve memory...');
            shutdown();
        }
    }, IDLE_TIMEOUT_MS);
}

// Hook resetIdleTimer into doSend
const originalDoSend = doSend;

// Graceful shutdown on app exit
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

module.exports = {
    getModelAgreement,
    getOptimalEVThresholds,
    startEnsembleService,
    shutdown
};
