#!/usr/bin/env node

/**
 * check_health.js
 * 
 * Standalone CLI diagnostic tool for AI agents and developers to inspect system health,
 * database integrity, match settlements, scraper status, and log activity in 1 second.
 * 
 * Usage:
 *   node utils/check_health.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../databases/sportybet_archive.db');
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../logs');

console.log('='.repeat(70));
console.log('       🔍 VFL AI PREDICTION & SCRAPER HEALTH DIAGNOSTIC REPORT       ');
console.log('='.repeat(70));
console.log(`Generated At: ${new Date().toISOString()}`);
console.log(`Node Version: ${process.version} | Platform: ${process.platform} (${process.arch})`);
console.log(`Database:     ${DB_PATH}`);
console.log(`Logs Dir:     ${LOGS_DIR}`);
console.log('-'.repeat(70));

let hasErrors = false;
let hasWarnings = false;

// 1. Check PM2 Services
console.log('\n[1] PM2 PROCESS STATUS:');
try {
    const pm2Raw = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const pm2List = JSON.parse(pm2Raw);
    const relevantNames = ['vfl-scraper', 'sporty-api', 'bot-dashboard', 'ai-trainer', 'google-sync'];
    const matched = pm2List.filter(p => relevantNames.includes(p.name));

    if (matched.length === 0) {
        console.log('  ⚠️  No target PM2 processes found running under current user.');
        hasWarnings = true;
    } else {
        matched.forEach(p => {
            const statusIcon = p.pm2_env.status === 'online' ? '✅' : '❌';
            const memMb = (p.monit.memory / 1024 / 1024).toFixed(1);
            const cpu = p.monit.cpu;
            const restarts = p.pm2_env.restart_time;
            console.log(`  ${statusIcon} [${p.pm2_env.status.toUpperCase()}] ${p.name.padEnd(16)} (PID: ${p.pid || 'N/A'}, Mem: ${memMb}MB, CPU: ${cpu}%, Restarts: ${restarts})`);
            if (p.pm2_env.status !== 'online') hasErrors = true;
        });
    }
} catch (e) {
    console.log('  ⚠️  Unable to query PM2 status:', e.message);
}

// 2. Inspect SQLite Database
console.log('\n[2] DATABASE HEALTH & BET SETTLEMENT AUDIT:');
if (!fs.existsSync(DB_PATH)) {
    console.log(`  ❌ FATAL: Database file does not exist at ${DB_PATH}`);
    process.exit(1);
}

try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    // Table checks
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    console.log(`  Tables Present: ${tables.join(', ')}`);

    // Status breakdown in ai_best_picks_history
    const statusCounts = db.prepare(`
        SELECT status, count(*) as count 
        FROM ai_best_picks_history 
        GROUP BY status
    `).all();

    const counts = { won: 0, lost: 0, void: 0, pending: 0 };
    statusCounts.forEach(r => { counts[r.status] = r.count; });
    const settledTotal = counts.won + counts.lost;
    const winRate = settledTotal > 0 ? ((counts.won / settledTotal) * 100).toFixed(2) : '0.00';

    console.log(`  📊 AI Best Picks Breakdown:`);
    console.log(`     - ✅ Won:      ${counts.won.toLocaleString()}`);
    console.log(`     - ❌ Lost:     ${counts.lost.toLocaleString()}`);
    console.log(`     - ⏳ Pending:  ${counts.pending.toLocaleString()}`);
    console.log(`     - ⚠️  Void:     ${counts.void.toLocaleString()}`);
    console.log(`     - 🎯 Win Rate: ${winRate}% (on ${settledTotal.toLocaleString()} settled bets)`);

    if (counts.void > 0) {
        console.log(`  ⚠️  WARNING: Found ${counts.void} VOID picks in database! Past voids should be investigated.`);
        hasWarnings = true;
    } else {
        console.log(`  ✅ Zero VOID picks in database (Clean state ✓)`);
    }

    // Check pending picks for stale / overdue bets
    const pendingPicks = db.prepare(`
        SELECT id, season_name, round_number, home_team, away_team, market, kickoff_timestamp 
        FROM ai_best_picks_history 
        WHERE status = 'pending' 
        ORDER BY kickoff_timestamp ASC
    `).all();

    console.log(`\n  Active Pending Picks (${pendingPicks.length}):`);
    const now = Date.now();
    let stalePendingCount = 0;

    pendingPicks.forEach(p => {
        const diffMs = p.kickoff_timestamp ? (p.kickoff_timestamp - now) : 0;
        const diffMin = Math.round(diffMs / 60000);
        let timeDesc = diffMin >= 0 ? `in ${diffMin}m` : `${Math.abs(diffMin)}m OVERDUE`;
        const icon = diffMin < -5 ? '⚠️ ' : '⏳';
        if (diffMin < -5) stalePendingCount++;
        console.log(`    ${icon} #${p.id} | R${p.round_number || '?'} | ${p.home_team} vs ${p.away_team} | Market: ${p.market} | Kickoff: ${timeDesc}`);
    });

    if (stalePendingCount > 0) {
        console.log(`  ⚠️  WARNING: ${stalePendingCount} pending picks are overdue by > 5 minutes without settlement!`);
        hasWarnings = true;
    } else if (pendingPicks.length > 0) {
        console.log(`  ✅ All active pending picks are within valid future/current timeframe.`);
    }

    // Last 5 Settled Bets
    console.log('\n  Last 5 Settled Bets:');
    const lastSettled = db.prepare(`
        SELECT id, round_number, home_team, away_team, market, actual_score, status 
        FROM ai_best_picks_history 
        WHERE status IN ('won', 'lost', 'void') 
        ORDER BY id DESC 
        LIMIT 5
    `).all();

    lastSettled.forEach(p => {
        const icon = p.status === 'won' ? '✅ WON ' : (p.status === 'lost' ? '❌ LOST' : '⚠️ VOID');
        console.log(`    ${icon} | #${p.id} | R${p.round_number || '?'} | ${p.home_team} vs ${p.away_team} | Market: ${p.market.padEnd(16)} | Result: ${p.actual_score}`);
    });

    db.close();
} catch (dbErr) {
    console.log(`  ❌ Database check error:`, dbErr.message);
    hasErrors = true;
}

// 3. Inspect Rotating Log Files
console.log('\n[3] LOGS HEALTH & ROTATION:');
const channelLogs = ['settlement.log', 'scraper.log', 'ai.log', 'api.log', 'system.log'];
channelLogs.forEach(file => {
    const fullPath = path.join(LOGS_DIR, file);
    if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        const kb = (stats.size / 1024).toFixed(1);
        console.log(`  📄 ${file.padEnd(18)} Size: ${kb} KB (Path: ${fullPath})`);
    } else {
        console.log(`  📄 ${file.padEnd(18)} (Not yet created or empty)`);
    }
});

// Tail last 3 settlement logs if present
const settlementLogPath = path.join(LOGS_DIR, 'settlement.log');
if (fs.existsSync(settlementLogPath)) {
    try {
        const lines = fs.readFileSync(settlementLogPath, 'utf8').trim().split('\n').filter(Boolean);
        console.log(`\n  Recent Settlement Log Activity (Last ${Math.min(3, lines.length)} lines):`);
        lines.slice(-3).forEach(l => console.log(`    ↳ ${l.substring(0, 110)}${l.length > 110 ? '...' : ''}`));
    } catch (_) {}
}

// 4. Overall Health Verdict
console.log('\n' + '='.repeat(70));
if (hasErrors) {
    console.log('🚨 VERDICT: UNHEALTHY (Critical process offline or database unreachable)');
    process.exit(1);
} else if (hasWarnings) {
    console.log('⚠️  VERDICT: DEGRADED (System running but warnings detected: check overdue/voids)');
    process.exit(0);
} else {
    console.log('🟢 VERDICT: ALL SYSTEMS HEALTHY & OPERATIONAL');
    process.exit(0);
}
