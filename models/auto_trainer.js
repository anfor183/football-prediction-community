/**
 * auto_trainer.js
 * ===============
 * Automated background training and continuous optimization engine for all AI models:
 *   1. Blending Weight Optimizer (Poisson, Elo, Momentum, Decay)
 *   2. Safest Pick XGBoost Model (1X2 top-confidence classifier)
 *   3. High Chance / High Value XGBoost Models (Over 2.5 Goals + GG/BTTS)
 *   4. HT/FT Isotonic Regression Calibration Tables
 *   5. HT/FT XGBoost Multi-Class Classifier (High-Risk AI Pick Engine)
 *
 * Runs non-blocking in the background with lock-safety and state tracking.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { optimizeBlendingWeights } = require('./ml_predictor');
const { autoOptimizeDatabase, analyzeOptimalDbTrim } = require('./db_optimizer');

const UTILS_DIR = __dirname;
const APP_DIR = path.resolve(UTILS_DIR, '..');
const STATE_FILE = path.join(APP_DIR, 'auto_trainer_state.json');
const LOG_FILE = path.join(APP_DIR, 'logs', 'auto_trainer.log');

let isTrainingInProgress = false;

function ensureLogDir() {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

function logMessage(msg) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [AutoTrainer] ${msg}`;
    console.log(formatted);
    try {
        ensureLogDir();
        fs.appendFileSync(LOG_FILE, formatted + '\n', 'utf8');
    } catch (_) {}
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (_) {}
    return {
        lastTrainedAt: null,
        lastTrainedRows: 0,
        totalRuns: 0,
        lastDurationMs: 0,
        lastStatus: 'idle',
        modelReports: {}
    };
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
        logMessage(`⚠️ Error saving auto trainer state: ${e.message}`);
    }
}

/**
 * Execute a command as a child process promise
 */
function runProcess(cmd, args, cwd = APP_DIR) {
    return new Promise((resolve, reject) => {
        logMessage(`▶️ Running: ${cmd} ${args.join(' ')}`);
        const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => {
            stdout += d.toString();
        });
        proc.stderr.on('data', d => {
            stderr += d.toString();
        });

        proc.on('close', code => {
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
            } else {
                reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
            }
        });

        proc.on('error', err => {
            reject(err);
        });
    });
}

/**
 * Run the complete AI Model Training & Optimization Pipeline
 */
async function runFullModelTrainingPipeline(dbPath, options = {}) {
    if (isTrainingInProgress) {
        logMessage('⏳ Auto-training is already running. Skipping concurrent request.');
        return { success: false, skipped: true, reason: 'Already in progress' };
    }

    if (!dbPath || !fs.existsSync(dbPath)) {
        return { success: false, error: `Database path not found: ${dbPath}` };
    }

    isTrainingInProgress = true;
    const startTime = Date.now();
    const state = loadState();
    state.lastStatus = 'training';
    saveState(state);

    logMessage(`🚀 Starting full AI Model Training & Calibration pipeline on ${dbPath}...`);

    let pythonExec = 'python3';
    const venvPython = path.join(UTILS_DIR, 'venv', 'bin', 'python3');
    if (fs.existsSync(venvPython)) {
        pythonExec = venvPython;
    }

    const results = {};

    try {
        // ── STEP 0: Intelligent Database Optimization (Auto-Trim to Optimal Window) ──
        logMessage('🧹 [Step 0/5] Checking and optimizing database size for AI model training...');
        try {
            let autoOptimizeEnabled = true;
            let targetOptimalWindow = null;
            try {
                const settingsFile = path.join(APP_DIR, 'bot_settings.json');
                if (fs.existsSync(settingsFile)) {
                    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
                    if (settings.autoOptimizeDbEnabled !== undefined) {
                        autoOptimizeEnabled = !!settings.autoOptimizeDbEnabled;
                    }
                    if (settings.autoOptimizeTrimThreshold) {
                        targetOptimalWindow = parseInt(settings.autoOptimizeTrimThreshold, 10);
                    }
                }
            } catch (_) {}

            if (options.autoOptimize !== false && autoOptimizeEnabled) {
                const optRes = autoOptimizeDatabase(dbPath, {
                    optimalWindow: targetOptimalWindow,
                    force: !!options.forceOptimize
                });
                results.databaseOptimization = optRes;
                if (optRes.optimized) {
                    logMessage(`✂️ [Step 0/5] ${optRes.message}`);
                } else {
                    logMessage(`✅ [Step 0/5] Database is already at optimal size (${optRes.totalMatches?.toLocaleString() || 'N/A'} matches). No trimming needed.`);
                }
            } else {
                logMessage('ℹ️ [Step 0/5] Database auto-optimization skipped (disabled in settings).');
            }
        } catch (dbOptErr) {
            logMessage(`⚠️ [Step 0/5] Database optimization warning: ${dbOptErr.message}`);
            results.databaseOptimization = { success: false, error: dbOptErr.message };
        }

        // ── STEP 1: Blending Weight Optimization (Poisson / Elo / Decay) ──────
        logMessage('⚙️ [Step 1/5] Optimizing statistical blending weights...');
        try {
            const weightsResult = optimizeBlendingWeights(dbPath, 'sportybet');
            results.weights = weightsResult;
            logMessage('✅ [Step 1/5] Blending weights optimized successfully.');
        } catch (wErr) {
            logMessage(`⚠️ [Step 1/5] Weight optimization warning: ${wErr.message}`);
            results.weights = { error: wErr.message };
        }

        // ── STEP 2: Safest Pick XGBoost Engine ────────────────────────────────
        logMessage('🛡️ [Step 2/5] Training Safest Pick XGBoost classifier...');
        try {
            const safestScript = path.join(UTILS_DIR, 'safest_model.py');
            await runProcess(pythonExec, [safestScript, '--db', dbPath, '--out', UTILS_DIR]);
            results.safest = { success: true };
            logMessage('✅ [Step 2/5] Safest Pick model retrained and calibrated.');
        } catch (sErr) {
            logMessage(`⚠️ [Step 2/5] Safest model error: ${sErr.message}`);
            results.safest = { success: false, error: sErr.message };
        }

        // ── STEP 3: High Chance (Over 2.5 & GG) XGBoost Engine ────────────────
        logMessage('⚡ [Step 3/5] Training High Chance (Over 2.5 & BTTS) XGBoost classifiers...');
        try {
            const highChanceScript = path.join(UTILS_DIR, 'high_chance_model.py');
            await runProcess(pythonExec, [highChanceScript, '--db', dbPath, '--out', UTILS_DIR]);
            results.highChance = { success: true };
            logMessage('✅ [Step 3/5] High Chance models retrained and calibrated.');
        } catch (hcErr) {
            logMessage(`⚠️ [Step 3/5] High Chance model error: ${hcErr.message}`);
            results.highChance = { success: false, error: hcErr.message };
        }

        // ── STEP 4: HT/FT Isotonic Regression Calibration Tables ──────────────
        logMessage('📊 [Step 4/5] Recomputing HT/FT isotonic calibration tables...');
        try {
            const calibScript = path.join(APP_DIR, 'retrain_htft_calibration.js');
            if (fs.existsSync(calibScript)) {
                await runProcess('node', [calibScript, dbPath]);
                results.calibration = { success: true };
                logMessage('✅ [Step 4/5] HT/FT calibration tables updated.');
            } else {
                logMessage('ℹ️ [Step 4/5] retrain_htft_calibration.js not found, skipping.');
            }
        } catch (cErr) {
            logMessage(`⚠️ [Step 4/5] Calibration update warning: ${cErr.message}`);
            results.calibration = { success: false, error: cErr.message };
        }

        // ── STEP 5: AI Best Pick HT/FT Multi-Class XGBoost Model ──────────────
        logMessage('🤖 [Step 5/5] Training AI Best Pick HT/FT XGBoost Multi-Class classifier...');
        try {
            const htftScript = path.join(UTILS_DIR, 'ai_best_htft_model.py');
            await runProcess(pythonExec, [htftScript, '--db', dbPath, '--out', UTILS_DIR]);
            results.htft = { success: true };
            logMessage('✅ [Step 5/5] AI Best HT/FT XGBoost classifier retrained.');
        } catch (hErr) {
            logMessage(`⚠️ [Step 5/5] HT/FT model training error: ${hErr.message}`);
            results.htft = { success: false, error: hErr.message };
        }

        // Count current scored rows
        let currentRows = 0;
        try {
            const db = new Database(dbPath, { readonly: true });
            const row = db.prepare("SELECT COUNT(*) as count FROM historical_market_predictions WHERE actual_score IS NOT NULL").get();
            currentRows = row ? row.count : 0;
            db.close();
        } catch (_) {}

        const durationMs = Date.now() - startTime;
        state.lastTrainedAt = new Date().toISOString();
        state.lastTrainedRows = currentRows;
        state.totalRuns = (state.totalRuns || 0) + 1;
        state.lastDurationMs = durationMs;
        state.lastStatus = 'completed';
        state.modelReports = {
            safest: fs.existsSync(path.join(UTILS_DIR, 'safest_report.json')) ? JSON.parse(fs.readFileSync(path.join(UTILS_DIR, 'safest_report.json'), 'utf8')) : null,
            highChance: fs.existsSync(path.join(UTILS_DIR, 'high_chance_report.json')) ? JSON.parse(fs.readFileSync(path.join(UTILS_DIR, 'high_chance_report.json'), 'utf8')) : null,
            htft: fs.existsSync(path.join(UTILS_DIR, 'ai_best_htft_report.json')) ? JSON.parse(fs.readFileSync(path.join(UTILS_DIR, 'ai_best_htft_report.json'), 'utf8')) : null
        };
        saveState(state);

        logMessage(`✨ AI Model Training pipeline finished successfully in ${(durationMs / 1000).toFixed(1)}s.`);
        return { success: true, durationMs, results };
    } catch (e) {
        logMessage(`❌ Pipeline encountered an error: ${e.message}`);
        state.lastStatus = 'error';
        saveState(state);
        return { success: false, error: e.message };
    } finally {
        isTrainingInProgress = false;
    }
}

/**
 * Check if training is due based on newly settled matches or time threshold
 */
function triggerAutoTrainingIfDue(dbPath, options = {}) {
    if (isTrainingInProgress) return { queued: false, reason: 'Already running' };
    if (!dbPath || !fs.existsSync(dbPath)) return { queued: false, reason: 'DB not found' };

    const minNewMatches = options.minNewMatches || 20;
    const maxIntervalMs = (options.intervalMinutes || 60) * 60 * 1000;

    let currentRows = 0;
    try {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare("SELECT COUNT(*) as count FROM historical_market_predictions WHERE actual_score IS NOT NULL").get();
        currentRows = row ? row.count : 0;
        db.close();
    } catch (e) {
        return { queued: false, error: e.message };
    }

    const state = loadState();
    const rowsSinceLastTrain = currentRows - (state.lastTrainedRows || 0);
    const lastTrainedMs = state.lastTrainedAt ? new Date(state.lastTrainedAt).getTime() : 0;
    const timeSinceLastTrainMs = Date.now() - lastTrainedMs;

    const isDueByRows = rowsSinceLastTrain >= minNewMatches;
    const isDueByTime = timeSinceLastTrainMs >= maxIntervalMs && rowsSinceLastTrain > 0;
    const isFirstTime = !state.lastTrainedAt && currentRows >= 100;

    if (isDueByRows || isDueByTime || isFirstTime || options.force) {
        logMessage(`🎯 Auto-training triggered! (New rows: ${rowsSinceLastTrain}, Elapsed: ${Math.round(timeSinceLastTrainMs / 60000)}m)`);
        // Launch non-blocking in background
        setImmediate(() => {
            runFullModelTrainingPipeline(dbPath, options).catch(err => {
                logMessage(`❌ Background training failed: ${err.message}`);
            });
        });
        return { queued: true, rowsSinceLastTrain, timeSinceLastTrainMs };
    }

    return { queued: false, reason: 'Not due yet', rowsSinceLastTrain, timeSinceLastTrainMs };
}

module.exports = {
    runFullModelTrainingPipeline,
    triggerAutoTrainingIfDue,
    loadState,
    isTrainingInProgress: () => isTrainingInProgress
};
