/**
 * robust_logger.js
 * 
 * Production-grade structured rotating logging system for VFL AI Prediction & Scraping Suite.
 * Designed specifically for AI agents, remote monitoring, and developer debugging.
 * 
 * Channels:
 *  - settlement: Match scoring, bet outcomes (won/lost/void), evaluation logic
 *  - scraper:    Browser navigation, iframe status, WebSocket frames, DOM reads
 *  - ai:         Model predictions, feature extraction, weight calibration
 *  - api:        Remote microservice requests, streaming SSE/WS clients
 *  - system:     Process lifecycle, memory, watchdog, error alerts
 * 
 * Features:
 *  - Zero external dependencies (pure Node.js fs/path)
 *  - Automatic file rotation: Max 10MB per channel, keeps 3 backups (.1, .2, .3)
 *  - In-memory ring buffer (last 100 entries per channel) for sub-ms API diagnostics
 *  - Structured JSON metadata support
 *  - Dual output: Dedicated channel log file + formatted console stdout/stderr
 */

const fs = require('fs');
const path = require('path');

// Default config
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../logs');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per file
const MAX_BACKUP_FILES = 3;
const RING_BUFFER_SIZE_PER_CHANNEL = 100;

// Ensure logs directory exists
try {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
} catch (err) {
    console.error(`[Logger] Failed to create logs directory "${LOGS_DIR}":`, err.message);
}

// In-memory ring buffer for fast diagnostic telemetry
const ringBuffers = {
    settlement: [],
    scraper: [],
    ai: [],
    api: [],
    system: []
};

// Log rotation helper
function rotateFileIfNeeded(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const stats = fs.statSync(filePath);
        if (stats.size < MAX_FILE_SIZE_BYTES) return;

        // Shift backups: .2 -> .3, .1 -> .2, .log -> .log.1
        for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
            const oldBackup = `${filePath}.${i}`;
            const newBackup = `${filePath}.${i + 1}`;
            if (fs.existsSync(oldBackup)) {
                try {
                    if (fs.existsSync(newBackup)) fs.unlinkSync(newBackup);
                    fs.renameSync(oldBackup, newBackup);
                } catch (_) {}
            }
        }
        const firstBackup = `${filePath}.1`;
        if (fs.existsSync(firstBackup)) {
            try { fs.unlinkSync(firstBackup); } catch (_) {}
        }
        fs.renameSync(filePath, firstBackup);
    } catch (err) {
        console.error(`[Logger] File rotation error on ${filePath}:`, err.message);
    }
}

// Main write function
function writeLog(channel, level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const cleanChannel = (channel || 'system').toLowerCase();
    const cleanLevel = (level || 'info').toUpperCase();

    const entry = {
        timestamp,
        channel: cleanChannel,
        level: cleanLevel,
        message: typeof message === 'string' ? message : JSON.stringify(message),
        meta: meta && typeof meta === 'object' ? meta : undefined
    };

    // 1. In-memory buffer update
    if (!ringBuffers[cleanChannel]) {
        ringBuffers[cleanChannel] = [];
    }
    const buf = ringBuffers[cleanChannel];
    buf.push(entry);
    if (buf.length > RING_BUFFER_SIZE_PER_CHANNEL) {
        buf.shift();
    }

    // 2. Format string
    let metaStr = '';
    if (meta) {
        try {
            metaStr = ' ' + JSON.stringify(meta);
        } catch (_) {
            metaStr = ' [Circular Metadata]';
        }
    }
    const logLine = `[${timestamp}] [${cleanChannel.toUpperCase()}] [${cleanLevel}] ${entry.message}${metaStr}\n`;

    // 3. Write to file
    const logFilePath = path.join(LOGS_DIR, `${cleanChannel}.log`);
    try {
        rotateFileIfNeeded(logFilePath);
        fs.appendFileSync(logFilePath, logLine, 'utf8');
    } catch (err) {
        console.error(`[Logger] Failed to write to ${logFilePath}:`, err.message);
    }

    // 4. Mirror to stdout/stderr with clean human readability
    const consoleMsg = `[${cleanChannel.toUpperCase()}] ${entry.message}${metaStr}`;
    if (cleanLevel === 'ERROR') {
        console.error(consoleMsg);
    } else if (cleanLevel === 'WARN') {
        console.warn(consoleMsg);
    } else {
        console.log(consoleMsg);
    }

    return entry;
}

// Channel wrapper class
class ChannelLogger {
    constructor(channel) {
        this.channel = channel;
    }

    info(message, meta) {
        return writeLog(this.channel, 'INFO', message, meta);
    }

    warn(message, meta) {
        return writeLog(this.channel, 'WARN', message, meta);
    }

    error(message, meta) {
        return writeLog(this.channel, 'ERROR', message, meta);
    }

    debug(message, meta) {
        return writeLog(this.channel, 'DEBUG', message, meta);
    }

    success(message, meta) {
        return writeLog(this.channel, 'SUCCESS', message, meta);
    }
}

// Specialized settlement logger with domain helper
class SettlementLogger extends ChannelLogger {
    constructor() {
        super('settlement');
    }

    /**
     * Log a completed bet settlement
     */
    settled(pick) {
        const {
            id,
            match,
            home_team,
            away_team,
            market,
            actual_score,
            actual_ht_score,
            status,
            season_name,
            round_number,
            odd,
            implied_odd
        } = pick;

        const matchTitle = match || `${home_team} vs ${away_team}`;
        const scoreStr = actual_score + (actual_ht_score ? ` (HT ${actual_ht_score})` : '');
        const oddsStr = odd || implied_odd ? ` @ ${odd || implied_odd}` : '';
        const icon = status === 'won' ? '✅ WON' : (status === 'lost' ? '❌ LOST' : '⚠️ ' + status.toUpperCase());

        const msg = `[Bet Settlement] ${icon} | Pick #${id || 'N/A'} | ${matchTitle} | Market: "${market}"${oddsStr} | Final: ${scoreStr} | Round ${round_number || '?'} (${season_name || 'VFL'})`;
        
        return writeLog('settlement', status === 'won' ? 'INFO' : (status === 'lost' ? 'INFO' : 'WARN'), msg, {
            id,
            home_team,
            away_team,
            market,
            status,
            actual_score,
            actual_ht_score,
            season_name,
            round_number
        });
    }

    /**
     * Log match score discovery before settlement
     */
    matchScored(home, away, ftScore, htScore, source = 'ws') {
        const msg = `[Match Result] ${home} ${ftScore} ${away} (HT: ${htScore || '0:0'}) via ${source.toUpperCase()}`;
        return writeLog('settlement', 'INFO', msg, {
            home_team: home,
            away_team: away,
            actual_score: ftScore,
            actual_ht_score: htScore,
            source
        });
    }
}

// Instantiate channels
const loggers = {
    settlement: new SettlementLogger(),
    scraper: new ChannelLogger('scraper'),
    ai: new ChannelLogger('ai'),
    api: new ChannelLogger('api'),
    system: new ChannelLogger('system')
};

/**
 * Diagnostics & Telemetry export
 */
function getDiagnostics() {
    const memory = process.memoryUsage();
    const diskInfo = {};

    // Check size of each channel log file
    const channelFiles = ['settlement', 'scraper', 'ai', 'api', 'system'];
    for (const ch of channelFiles) {
        const p = path.join(LOGS_DIR, `${ch}.log`);
        diskInfo[`${ch}_log_bytes`] = fs.existsSync(p) ? fs.statSync(p).size : 0;
    }

    return {
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: {
            rss: (memory.rss / 1024 / 1024).toFixed(2),
            heapTotal: (memory.heapTotal / 1024 / 1024).toFixed(2),
            heapUsed: (memory.heapUsed / 1024 / 1024).toFixed(2)
        },
        ring_buffer_counts: {
            settlement: ringBuffers.settlement.length,
            scraper: ringBuffers.scraper.length,
            ai: ringBuffers.ai.length,
            api: ringBuffers.api.length,
            system: ringBuffers.system.length
        },
        log_files: diskInfo
    };
}

/**
 * Retrieve recent logs for monitoring
 */
function getRecentLogs(options = {}) {
    const channel = options.channel ? options.channel.toLowerCase() : null;
    const level = options.level ? options.level.toUpperCase() : null;
    const limit = Math.min(parseInt(options.limit || 50, 10), 200);

    let entries = [];
    if (channel && ringBuffers[channel]) {
        entries = [...ringBuffers[channel]];
    } else {
        // Merge all channels sorted by timestamp
        for (const ch of Object.keys(ringBuffers)) {
            entries.push(...ringBuffers[ch]);
        }
        entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    if (level) {
        entries = entries.filter(e => e.level === level);
    }

    return entries.slice(-limit);
}

module.exports = {
    logger: loggers,
    settlementLogger: loggers.settlement,
    scraperLogger: loggers.scraper,
    aiLogger: loggers.ai,
    apiLogger: loggers.api,
    systemLogger: loggers.system,
    getDiagnostics,
    getRecentLogs,
    writeLog
};
