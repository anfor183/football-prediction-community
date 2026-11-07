const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Quarantine a bad WAL or SHM companion file.
 */
function quarantineCompanionFiles(dbPath) {
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    const dbDir = path.dirname(dbPath);
    const quarantineDir = path.join(dbDir, 'corrupt_wal_quarantine');

    let quarantined = false;

    if (fs.existsSync(walPath)) {
        try {
            if (!fs.existsSync(quarantineDir)) {
                fs.mkdirSync(quarantineDir, { recursive: true });
            }
            const base = path.basename(walPath);
            const dest = path.join(quarantineDir, `${base}_${Date.now()}`);
            fs.renameSync(walPath, dest);
            console.warn(`[db_safe] Quarantined corrupted/mismatched WAL file: ${walPath} -> ${dest}`);
            quarantined = true;
        } catch (e) {
            console.error(`[db_safe] Error quarantining WAL file: ${e.message}`);
        }
    }

    if (fs.existsSync(shmPath)) {
        try {
            fs.unlinkSync(shmPath);
            console.warn(`[db_safe] Removed stale SHM file: ${shmPath}`);
            quarantined = true;
        } catch (e) {
            console.error(`[db_safe] Error removing SHM file: ${e.message}`);
        }
    }

    return quarantined;
}

/**
 * Perform table-level data salvage if the main database file is damaged.
 */
function repairDatabase(dbPath) {
    console.warn(`[db_safe] Attempting table-level salvage for damaged database: ${dbPath}`);
    const backupPath = `${dbPath}.damaged_bak_${Date.now()}`;
    const freshPath = `${dbPath}.repaired_${Date.now()}`;

    try {
        const src = new Database(dbPath, { readonly: true });
        const tables = src.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        
        if (tables.length === 0) {
            src.close();
            return false;
        }

        const dst = new Database(freshPath);
        dst.exec('PRAGMA journal_mode=WAL');

        for (const t of tables) {
            if (t.sql) {
                try { dst.exec(t.sql); } catch (_) {}
            }
        }

        for (const t of tables) {
            try {
                const cols = src.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => c.name);
                const rows = src.prepare(`SELECT * FROM "${t.name}"`).all();
                if (rows.length > 0 && cols.length > 0) {
                    const placeholders = cols.map(() => '?').join(',');
                    const insert = dst.prepare(`INSERT OR IGNORE INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`);
                    const insertMany = dst.transaction((batch) => {
                        for (const row of batch) {
                            try { insert.run(cols.map(c => row[c])); } catch (_) {}
                        }
                    });
                    insertMany(rows);
                }
            } catch (copyErr) {
                console.warn(`[db_safe] Error salvaging table ${t.name}: ${copyErr.message}`);
            }
        }

        src.close();
        dst.close();

        // Swap repaired database
        fs.renameSync(dbPath, backupPath);
        fs.renameSync(freshPath, dbPath);
        console.log(`[db_safe] Successfully salvaged database! Damaged original backed up to: ${backupPath}`);
        return true;
    } catch (salvageErr) {
        console.error(`[db_safe] Table salvage failed: ${salvageErr.message}`);
        try { if (fs.existsSync(freshPath)) fs.unlinkSync(freshPath); } catch (_) {}
        return false;
    }
}

/**
 * Checks if an error message indicates SQLite database or WAL corruption.
 */
function isMalformedError(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return msg.includes('database disk image is malformed') ||
           msg.includes('file is not a database') ||
           msg.includes('sqlite_corrupt') ||
           msg.includes('corrupt') ||
           msg.includes('malformed');
}

/**
 * Safe database opener that automatically recovers from corrupt WAL/SHM or file issues.
 * 
 * @param {string} dbPath Absolute path to SQLite database
 * @param {object} options Options passed to better-sqlite3
 * @returns {Database} An open better-sqlite3 database instance
 */
function openSafeDatabase(dbPath, options = {}) {
    if (!dbPath) throw new Error('openSafeDatabase: dbPath is required');

    // First attempt to open normally
    let db;
    try {
        db = new Database(dbPath, options);
        // Quick probe to ensure the file/WAL is readable
        db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
        return db;
    } catch (err) {
        if (db) {
            try { db.close(); } catch (_) {}
            db = null;
        }

        if (!isMalformedError(err)) {
            // Rethrow non-corruption errors (e.g., permission denied, missing file if fileMustExist is set)
            throw err;
        }

        console.warn(`[db_safe] Detected malformed database error on ${dbPath}: ${err.message}. Initiating auto-recovery...`);

        // Check if companion WAL or SHM exists
        const walPath = dbPath + '-wal';
        const shmPath = dbPath + '-shm';
        if (fs.existsSync(walPath) || fs.existsSync(shmPath)) {
            quarantineCompanionFiles(dbPath);

            // Retry opening without the bad companion files
            try {
                db = new Database(dbPath, options);
                db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
                console.log(`[db_safe] Auto-recovery SUCCESS: ${dbPath} recovered cleanly after clearing out-of-sync WAL/SHM!`);
                return db;
            } catch (retryErr) {
                if (db) {
                    try { db.close(); } catch (_) {}
                    db = null;
                }
                console.warn(`[db_safe] Database still failing after clearing WAL: ${retryErr.message}`);
            }
        }

        // If still failing, attempt table-level salvage
        const repaired = repairDatabase(dbPath);
        if (repaired) {
            try {
                db = new Database(dbPath, options);
                db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
                console.log(`[db_safe] Auto-recovery SUCCESS: ${dbPath} recovered after full table salvage!`);
                return db;
            } catch (finalErr) {
                if (db) {
                    try { db.close(); } catch (_) {}
                }
                throw finalErr;
            }
        }

        throw err;
    }
}

/**
 * Safely checkpoint a WAL database before backing up or syncing.
 * Flushes all WAL transactions into the main .db file and truncates the WAL.
 */
function checkpointDatabase(dbPath) {
    if (!dbPath || !fs.existsSync(dbPath)) return false;
    try {
        const db = new Database(dbPath, { timeout: 3000 });
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            console.log(`[db_safe] Checkpointed WAL to main database: ${dbPath}`);
        } finally {
            db.close();
        }
        return true;
    } catch (e) {
        console.warn(`[db_safe] Checkpoint warning for ${dbPath}: ${e.message}`);
        return false;
    }
}

/**
 * Validate that a database file is healthy and accessible.
 */
function validateDatabase(dbPath) {
    if (!dbPath || !fs.existsSync(dbPath)) return { valid: false, error: 'File does not exist' };
    try {
        const db = openSafeDatabase(dbPath, { readonly: true, timeout: 3000 });
        db.close();
        return { valid: true };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

module.exports = {
    openSafeDatabase,
    checkpointDatabase,
    quarantineCompanionFiles,
    repairDatabase,
    validateDatabase,
    isMalformedError
};
