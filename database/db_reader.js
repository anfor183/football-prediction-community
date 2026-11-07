const Database = require('better-sqlite3');
const fs = require('fs');
const { openSafeDatabase } = require('./utils/db_safe.js');

function run() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error(JSON.stringify({ error: "Missing arguments. Usage: node db_reader.js <dbPath> <query> [params...]" }));
        process.exit(1);
    }

    let dbPath = args[0];
    if (dbPath && process.platform !== 'win32') {
        dbPath = dbPath.replace(/\\/g, '/');
    }
    const query = args[1];
    
    // Any remaining arguments are query parameters
    let params = [];
    if (args.length > 2) {
        try {
            params = JSON.parse(args[2]);
        } catch(e) {
            params = args.slice(2);
        }
    }

    if (!fs.existsSync(dbPath)) {
        console.error(JSON.stringify({ error: `Database file not found: ${dbPath}` }));
        process.exit(1);
    }

    try {
        // Add timeout to prevent hanging connections (30 second timeout)
        const timeout = setTimeout(() => {
            console.error(JSON.stringify({ error: 'Database query timeout after 30 seconds' }));
            process.exit(1);
        }, 30000);

        let db;
        try {
            db = openSafeDatabase(dbPath);
        } catch (connErr) {
            clearTimeout(timeout);
            const errMsg = connErr.message || '';
            if (errMsg.includes('ECONNECT') || errMsg.includes('Cannot open database')) {
                console.error(JSON.stringify({ error: 'ECONNECT: Failed to connect to database. File may be locked or corrupted. Try closing other connections and reopening.' }));
            } else {
                console.error(JSON.stringify({ error: 'Database connection error: ' + errMsg }));
            }
            process.exit(1);
        }
        clearTimeout(timeout);
        
        let result;
        if (query === '__INFO__') {
            const fileSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            let tableSizes = [];
            try {
                const tableSizeQuery = `
                    SELECT 
                        m.name AS tableName,
                        COALESCE(t.sizeBytes, 0) AS sizeBytes
                    FROM (
                        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
                    ) m
                    LEFT JOIN (
                        SELECT 
                            COALESCE(
                                (SELECT tbl_name FROM sqlite_master WHERE name = dbstat.name),
                                dbstat.name
                            ) AS tbl_name,
                            SUM(pgsize) AS sizeBytes
                        FROM dbstat
                        GROUP BY tbl_name
                    ) t ON m.name = t.tbl_name;
                `;
                tableSizes = db.prepare(tableSizeQuery).all();
            } catch (e) {
                // Fallback if dbstat is not available
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
                tableSizes = tables.map(t => ({ tableName: t.name, sizeBytes: 0 }));
            }

            const tablesInfo = tableSizes.map(item => {
                let rowCount = 0;
                try {
                    const row = db.prepare(`SELECT count(*) AS count FROM "${item.tableName}"`).get();
                    rowCount = row ? row.count : 0;
                } catch (e) {}
                return {
                    name: item.tableName,
                    sizeBytes: item.sizeBytes,
                    rowCount: rowCount
                };
            });

            db.close();
            console.log(JSON.stringify({ success: true, fileSize, tables: tablesInfo }));
            process.exit(0);
        }

        const upperQuery = query.trim().toUpperCase();
        if (upperQuery.startsWith('SELECT') || upperQuery.startsWith('PRAGMA') || upperQuery.startsWith('DROP') || upperQuery.startsWith('DELETE')) {
            const stmt = db.prepare(query);
            if (upperQuery.startsWith('SELECT') || upperQuery.startsWith('PRAGMA')) {
                result = stmt.all(...params);
            } else {
                const runInfo = stmt.run(...params);
                result = [{ success: true, changes: runInfo.changes }];
            }
        } else {
            console.error(JSON.stringify({ error: "Only SELECT, PRAGMA, DROP, or DELETE queries are allowed for safety." }));
            process.exit(1);
        }

        db.close();
        
        // Output strictly JSON so the dashboard can parse it
        const outStr = JSON.stringify({ success: true, data: result }) + '\n';
        process.stdout.write(outStr, () => {
            process.exit(0);
        });
        
    } catch (err) {
        const errMsg = err.message || '';
        if (errMsg.includes('ECONNECT') || errMsg.includes('database is locked')) {
            console.error(JSON.stringify({ error: 'ECONNECT: Database connection failed or is locked. The file may be in use by another process. Try: 1) Closing other connections, 2) Restarting the app, 3) Checking if the database file is corrupt.' }));
        } else if (errMsg.includes('Syntax') || errMsg.includes('no such table')) {
            console.error(JSON.stringify({ error: 'Database query error: ' + errMsg }));
        } else {
            console.error(JSON.stringify({ error: 'Database error: ' + errMsg }));
        }
        process.exit(1);
    }
}

run();
