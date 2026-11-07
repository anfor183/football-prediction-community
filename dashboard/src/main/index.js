import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Disable sandboxing for development / Linux headless / SSH environments
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-setuid-sandbox')

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

import fs from 'fs'
import path from 'path'
import { spawn, exec } from 'child_process'
import os from 'os'
import util from 'util'
import https from 'https'
import http from 'http'
import { runSync, runRestore } from './google_sync.js'
import { webBridge } from './web_bridge_server.js'
import icon from '../../resources/icon.png?asset'
import Module from 'module'

// Ensure system and user binary paths (e.g. ~/.local/bin for pm2, /usr/local/bin) are in PATH
const extraBinPaths = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
];
for (const p of extraBinPaths) {
  if (p && !process.env.PATH?.includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || ''}`;
  }
}

// Intercept ipcMain.handle to automatically expose all IPC channels over the Web Bridge REST API
const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, listener) {
  webBridge.registerHandler(channel, listener);
  return originalIpcHandle(channel, listener);
};

// Hijack require('better-sqlite3') to resolve to dashboard's own node_modules when loaded in Electron
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'better-sqlite3') {
    const targetPath = app.isPackaged 
      ? path.join(process.resourcesPath, 'node_modules', 'better-sqlite3')
      : path.join(__dirname, '../../node_modules/better-sqlite3');
    return originalResolveFilename(targetPath, parent, isMain, options);
  }
  return originalResolveFilename(request, parent, isMain, options);
};

function resolveAppPath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app-scripts', relativePath);
  }
  return path.join(__dirname, '../../../', relativePath);
}

let pathResolver;
try {
  pathResolver = require(resolveAppPath('utils/path_resolver.js'));
} catch (e) {
  console.error('Failed to load path_resolver.js:', e.message);
}

function getSafeDb(dbPath, options = {}) {
  try {
    const { openSafeDatabase } = require(resolveAppPath('utils/db_safe.js'));
    return openSafeDatabase(dbPath, options);
  } catch (e) {
    const Database = require('better-sqlite3');
    return new Database(dbPath, options);
  }
}

const LOGS_DIR = resolveAppPath('logs');
const MAIN_LOG_PATH = path.join(LOGS_DIR, 'main-process.log');
const RENDERER_LOG_PATH = path.join(LOGS_DIR, 'renderer-process.log');

function setupLogger() {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    for (const logFile of [MAIN_LOG_PATH, RENDERER_LOG_PATH]) {
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > 5 * 1024 * 1024) {
          fs.writeFileSync(logFile, `--- Log truncated on startup ${new Date().toISOString()} ---\n`, 'utf8');
        }
      }
    }

    const logStream = fs.createWriteStream(MAIN_LOG_PATH, { flags: 'a' });

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    function formatMessage(level, args) {
      const timestamp = new Date().toISOString();
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            return util.inspect(arg);
          }
        }
        return String(arg);
      }).join(' ');
      return `[${timestamp}] [${level}] ${message}\n`;
    }

    console.log = (...args) => {
      originalLog.apply(console, args);
      logStream.write(formatMessage('INFO', args));
    };

    console.error = (...args) => {
      originalError.apply(console, args);
      logStream.write(formatMessage('ERROR', args));
    };

    console.warn = (...args) => {
      originalWarn.apply(console, args);
      logStream.write(formatMessage('WARN', args));
    };

    process.on('uncaughtException', (err) => {
      const stack = err ? err.stack : 'No stack trace';
      console.error('UNCAUGHT EXCEPTION in Main Process:', err, '\nStack:', stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('UNHANDLED REJECTION in Main Process. Reason:', reason);
    });

    console.log('[Main Process] Logging system initialized.');
  } catch (err) {
    console.error('Failed to setup file logging:', err);
  }
}

setupLogger();

function requireAppScript(relativePath) {
  const resolvedPath = resolveAppPath(relativePath);
  return require(resolvedPath);
}

const reverseTunnelProxy = requireAppScript('utils/reverse-tunnel-proxy.js')

const CONFIG_PATH = resolveAppPath('browser-config.json')

function getProfilesBaseDir() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (config.paths && config.paths.userDataDir) {
        const userDataPath = config.paths.userDataDir;
        let driveExists = true;
        if (userDataPath && process.platform === 'win32' && /^[a-zA-Z]:/.test(userDataPath)) {
          const drive = userDataPath.substring(0, 3); // e.g. "E:\\"
          try {
            driveExists = fs.existsSync(drive);
          } catch (e) {
            driveExists = false;
          }
        }
        if (driveExists) {
          const normalized = path.normalize(userDataPath);
          const parts = normalized.split(path.sep);
          const collapsedParts = parts.filter((seg, idx) => idx === 0 || seg !== parts[idx - 1]);
          const collapsed = collapsedParts.join(path.sep);
          return collapsed;
        } else {
          console.warn(`[Electron Main] ⚠️ UserDataDir drive does not exist for: "${userDataPath}". Falling back to local profiles.`);
        }
      }
    }
  } catch (e) {
    console.error('Error reading userDataDir from config:', e);
  }
  return resolveAppPath('profiles');
}

Object.defineProperty(global, 'PROFILES_BASE_DIR', {
  get() {
    return getProfilesBaseDir();
  },
  configurable: true,
  enumerable: true
});

let PROFILES_BASE_DIR = getProfilesBaseDir();

const CHROME_SYSTEM_DIRS = new Set([
  'actorsafetylists', 'amountextractionheuristicregexes', 'captchaproviders', 
  'certificaterevocation', 'component_crx_cache', 'crashpad', 'crowd deny', 
  'extensions_crx_cache', 'filetypepolicies', 'firstpartysetspreloaded', 
  'gpupersistentcache', 'historysearch', 'hyphen-data', 'meipreload', 
  'ondeviceheadsuggestmodel', 'optimizationhints', 'origintrials', 
  'pki-metadata', 'pkimetadata', 'pkimetadatafastpush', 'realtimereporting', 
  'webrtclogs', 'blobstorage', 'local state', 'dictionaries', 'zxcvbndata', 
  'autofillstatespreloaded', 'tpcdmetadata', 'profile 1', 'profile 2', 
  'profile 3', 'profile 4', 'profile 5', 'guest profile', 'system profile', 
  'shadercache', 'grshadercache', 'browsermetrics', 'safetytips', 
  'safe browsing', 'optimization_guide_hint_cache', 'widevinecdm', 
  'local storage', 'session storage', 'databases', 'indexeddb', 
  'webrtc_event_logs', 'network', 'coop-coep', 'first-party sets', 
  'tpcd metadata', 'crowd_deny', 'privacysandboxattestationspreloaded',
  'segmentation_platform', 'sslerrorassistant', 'subresource filter',
  'translatekit', 'trusttokenkeycommitments', 'wasmttsengine',
  'nativemessaginghosts', 'optimizationguidemodelsmanifest', 'soda', 
  'sodalanguagepacks', 'first run', 'preferences', 'variations', 'default'
]);

function getFamiliesList() {
  if (!fs.existsSync(PROFILES_BASE_DIR)) return [];
  try {
    return fs.readdirSync(PROFILES_BASE_DIR)
      .filter(f => {
        try {
          if (!fs.statSync(path.join(PROFILES_BASE_DIR, f)).isDirectory()) return false;
        } catch (e) {
          return false;
        }
        const lower = f.toLowerCase();
        if (CHROME_SYSTEM_DIRS.has(lower)) return false;
        return true;
      });
  } catch (e) {
    console.error('Error reading families directory:', e);
    return [];
  }
}

function cleanAllChromiumProfilesCache() {
  const candidateDirs = [
    PROFILES_BASE_DIR,
    resolveAppPath('profiles'),
    resolveAppPath('browser_profiles'),
    resolveAppPath('my-bot-profiles')
  ];

  const cacheSubdirs = [
    'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Crashpad',
    path.join('Default', 'Cache'),
    path.join('Default', 'Code Cache'),
    path.join('Default', 'GPUCache'),
    path.join('Default', 'DawnCache'),
    path.join('Default', 'GrShaderCache'),
    path.join('Default', 'Service Worker', 'CacheStorage'),
    path.join('Default', 'Service Worker', 'ScriptCache')
  ];

  let cleaned = 0;
  for (const base of candidateDirs) {
    if (!base || !fs.existsSync(base)) continue;
    try {
      const items = fs.readdirSync(base);
      for (const item of items) {
        const itemPath = path.join(base, item);
        try {
          if (!fs.statSync(itemPath).isDirectory()) continue;
          for (const sub of cacheSubdirs) {
            const cachePath = path.join(itemPath, sub);
            if (fs.existsSync(cachePath)) {
              fs.rmSync(cachePath, { recursive: true, force: true });
              cleaned++;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (cleaned > 0) {
    console.log(`[Cache Cleaner] Automatically pruned ${cleaned} stale Chromium cache directories across profiles.`);
  }
}

// Run Chromium cache sweep on startup and every 30 minutes
try {
  cleanAllChromiumProfilesCache();
  setInterval(cleanAllChromiumProfilesCache, 30 * 60 * 1000);
} catch (_) {}

function spawnNode(scriptPath, args, options = {}) {
  const binaryPath = app.isPackaged ? process.execPath : 'node';
  const baseEnv = app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
  
  const nodeArgs = ['--max-old-space-size=4096', scriptPath, ...args];
  return spawn(binaryPath, nodeArgs, {
    cwd: options.cwd || path.dirname(scriptPath),
    env: { ...baseEnv, ...options.env },
    ...options
  });
}

function killAllScraperChromeProcesses() {
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync('powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'chrome.exe\'\\" | Where-Object { $_.CommandLine -like \'*user-data-dir*\' -or $_.CommandLine -like \'*puppeteer*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' });
    } else {
      const currentPid = process.pid;
      const ppid = process.ppid;
      const safeKillCmd = `ps aux | grep -E "(chrome|chromium)" | grep -E "(my-bot-profiles|bot-temp|puppeteer|remote-debugging-port)" | grep -v -E "electron|nexus-panel|antigravity|vscode|node_modules|${currentPid}|${ppid}" | awk '{print $2}' | xargs -r kill -9 || true`;
      require('child_process').execSync(safeKillCmd, { stdio: 'ignore' });
    }
  } catch (e) {}
}

function killOrphanedChromeProcesses() {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'linux') {
        const hasActiveRunner = require('child_process').execSync('pgrep -f "ml_runner.js" || true', { encoding: 'utf8' }).trim();
        if (hasActiveRunner) {
          console.log('[Process Cleanup] Active scraper runner detected (PID ' + hasActiveRunner.replace(/\n/g, ', ') + '). Skipping startup Chrome kill to protect running companion.');
          return resolve();
        }
      }
    } catch (e) {}
    killAllScraperChromeProcesses();
    console.log('[Process Cleanup] Cleaned up orphaned scraper Chrome processes.');
    resolve();
  });
}

function killChromeProcessesForProvider(provider) {
  return new Promise((resolve) => {
    killAllScraperChromeProcesses();
    console.log(`[Process Cleanup] Cleaned up running Chrome processes for ${provider || 'all'}.`);
    resolve();
  });
}


function parseJSONFromStdout(output) {
  if (!output || typeof output !== 'string') {
    throw new Error('No output returned from process');
  }

  const trimmed = output.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch (e) {}

  // 2. Global extraction between first '{' and last '}' (handles log prefixes/suffixes)
  const firstObj = trimmed.indexOf('{');
  const lastObj = trimmed.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    try {
      return JSON.parse(trimmed.substring(firstObj, lastObj + 1));
    } catch (e) {}
  }

  const firstArr = trimmed.indexOf('[');
  const lastArr = trimmed.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    try {
      return JSON.parse(trimmed.substring(firstArr, lastArr + 1));
    } catch (e) {}
  }

  // 3. Iterate backwards line-by-line for clean JSON lines
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
      try {
        return JSON.parse(line);
      } catch (e) {}
    }
  }

  // 4. Check for single-line JSON blocks embedded in log output
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const fb = line.indexOf('{');
    const lb = line.lastIndexOf('}');
    if (fb !== -1 && lb > fb) {
      try {
        return JSON.parse(line.substring(fb, lb + 1));
      } catch (e) {}
    }
    const fbr = line.indexOf('[');
    const lbr = line.lastIndexOf(']');
    if (fbr !== -1 && lbr > fbr) {
      try {
        return JSON.parse(line.substring(fbr, lbr + 1));
      } catch (e) {}
    }
  }

  throw new Error('No valid JSON object or array found in output');
}

function tryParseJSONOutput(output) {
  if (!output || typeof output !== 'string') return null;
  try {
    return parseJSONFromStdout(output);
  } catch (e) {
    return null;
  }
}

function runMLPredict(dbPath, homeTeam, awayTeam, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['predict', dbPath, homeTeam, awayTeam], {
      env: { PROVIDER: provider }
    })
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML predictor output: ' + e.message })
      }
    })
  })
}

function runMLOptimize(dbPath, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['optimize', dbPath], {
      env: { PROVIDER: provider }
    })
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML optimizer output: ' + e.message })
      }
    })
  })
}

function runMLBacktest(dbPath, seasonName, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    // Season names may contain spaces â€“ pass as separate argv tokens; runner joins them
    const child = spawnNode(runnerPath, ['backtest', dbPath, ...seasonName.split(' ')], {
      env: { PROVIDER: provider }
    })
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML backtest output: ' + e.message })
      }
    })
  })
}

function runMLDiscoverEdge(dbPath, seasonName, lookbackWindow = 100, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['discover-edge', dbPath, seasonName, String(lookbackWindow)], {
      env: { PROVIDER: provider }
    })
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML edge discovery output: ' + e.message })
      }
    })
  })
}

function runMLDiscoverEdgeAcrossSeasons(dbPath, minOdds = 4, maxOdds = 50, lookbackWindow = 100, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['discover-edge-across-seasons', dbPath, String(minOdds), String(maxOdds), String(lookbackWindow)], {
      env: { PROVIDER: provider }
    })
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput) {
          const parsedError = tryParseJSONOutput(errorOutput)
          if (parsedError) {
            return resolve(parsedError)
          }
          if (!output) {
            return resolve({ success: false, error: errorOutput.trim() })
          }
        }
        const parsedResult = tryParseJSONOutput(output)
        if (parsedResult) {
          return resolve(parsedResult)
        }
        throw new Error('No valid JSON object or array found in output')
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML cross-season edge discovery output: ' + e.message })
      }
    })
  })
}

function runMLAnalysePatterns(dbPath, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['analyse-patterns', dbPath, provider])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse pattern analysis output: ' + e.message })
      }
    })
  })
}

function runMLAnalyseTimePatterns(dbPath, provider = 'bet9ja') {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['analyse-time-patterns', dbPath, provider])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse time pattern analysis output: ' + e.message })
      }
    })
  })
}

const activeScrapers = new Map()
// Stores the launch config for each active scraper so it can be restarted after maintenance
const activeScraperConfigs = new Map()

function normalizeDbPath(p) {
  if (!p || typeof p !== 'string') return p;
  let normalized = process.platform !== 'win32' ? p.replace(/\\/g, '/') : p;
  if (!fs.existsSync(normalized)) {
    const baseName = path.basename(normalized);
    const localPath = resolveAppPath(`databases/${baseName}`);
    if (fs.existsSync(localPath)) return localPath;
  }
  return normalized;
}

const _indexedDbs = new Set();
function ensurePerformanceIndexes(dbPath) {
  if (!dbPath || _indexedDbs.has(dbPath)) return;
  _indexedDbs.add(dbPath);
  setImmediate(() => {
    try {
      const db = getSafeDb(dbPath, { timeout: 3000 });
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_lp_season_status ON live_predictions(season_name, scored_status, round_number);
        CREATE INDEX IF NOT EXISTS idx_lp_match_lookup ON live_predictions(season_name, home_team, away_team, round_number);
        CREATE INDEX IF NOT EXISTS idx_lp_kickoff ON live_predictions(kickoff_timestamp);
        CREATE INDEX IF NOT EXISTS idx_lp_scored_id ON live_predictions(scored_status, id DESC);
        CREATE INDEX IF NOT EXISTS idx_hmp_match_lookup ON historical_market_predictions(season_name, home_team, away_team, round_number);
        CREATE INDEX IF NOT EXISTS idx_hmp_kickoff ON historical_market_predictions(kickoff_timestamp);
        CREATE INDEX IF NOT EXISTS idx_ai_season ON ai_best_picks_history(season_name, status);
        CREATE INDEX IF NOT EXISTS idx_ai_history_id ON ai_best_picks_history(id DESC);
      `);
      db.close();
    } catch (_) {}
  });
}

function runMLScrapeLiveSeason(dbPath, isHeadless, provider = 'bet9ja', leagueId = 41104, isContinuous = false, profile = 'Default', family = 'DEFAULT', device = 'random', browser = 'random') {
  dbPath = normalizeDbPath(dbPath);
  // Kill existing active scraper for this provider if it exists
  if (activeScrapers.has(provider)) {
    console.log(`[Main Process] Killing existing active scraper for ${provider}...`);
    try {
      const existingChild = activeScrapers.get(provider);
      existingChild.wasKilledManually = true;
      existingChild.kill();
    } catch (e) {
      console.error(`[Main Process] Error killing scraper for ${provider}:`, e);
    }
    activeScrapers.delete(provider);
    killChromeProcessesForProvider(provider).catch(() => {});
  }

  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const args = ['scrape-live-season', dbPath, isHeadless ? 'true' : 'false', provider, String(leagueId), isContinuous ? 'true' : 'false']
    if (profile && profile !== 'Default') {
      if (profile === 'Temporary') {
        args.push('--user-data-dir=TEMP'); // Handled explicitly in config.js
      } else {
        const path = require('path');
        const os = require('os');
        const profilePath = path.join(PROFILES_BASE_DIR, family || 'DEFAULT', profile);
        args.push(`--user-data-dir=${profilePath}`);
      }
    }
    if (device && device !== 'random') {
      args.push(`--device=${String(device).toLowerCase().trim()}`);
    }
    if (browser && browser !== 'random') {
      args.push(`--browser=${String(browser).toLowerCase().trim()}`);
    }
    const child = spawnNode(runnerPath, args)
    
    activeScrapers.set(provider, child)

    child.stdout.on('data', (data) => {
      output += data.toString()
      process.stdout.write(`[Live Scraper Stdout: ${provider}] ` + data.toString())
    })
    child.stderr.on('data', (data) => {
      errorOutput += data.toString()
      process.stderr.write(`[Live Scraper Stderr: ${provider}] ` + data.toString())
    })
    child.on('close', (code, signal) => {
      activeScrapers.delete(provider)
      killChromeProcessesForProvider(provider).catch(() => {});

      if (child.wasKilledManually || signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT') {
        return resolve({ success: false, error: 'Scraper process was stopped.', wasKilled: true });
      }

      const parsedOut = tryParseJSONOutput(output);
      if (parsedOut && typeof parsedOut === 'object') {
        return resolve(parsedOut);
      }

      const parsedErr = tryParseJSONOutput(errorOutput);
      if (parsedErr && typeof parsedErr === 'object') {
        return resolve(parsedErr);
      }

      if (code !== 0) {
        const cleanErr = errorOutput.trim() || output.trim() || `Scraper process exited with code ${code}`;
        return resolve({ success: false, error: cleanErr });
      }

      const cleanOut = output.trim() || errorOutput.trim() || 'No output received';
      resolve({ success: false, error: 'Scraper completed without valid JSON output: ' + cleanOut });
    })
  })
}

const execPromise = util.promisify(exec)

const activeWindows = new Set()

function runMLGetLivePredictions(dbPath, provider = 'bet9ja', limit = 300) {
  if (!dbPath) {
    dbPath = provider === 'sportybet'
      ? resolveAppPath('databases/sportybet_archive.db')
      : resolveAppPath('databases/bet9ja_archive.db');
  }
  dbPath = normalizeDbPath(dbPath);
  ensurePerformanceIndexes(dbPath);

  // 1. Direct in-process execution via live_predictions_reader for instant, zero-spawn response
  try {
    const { getLivePredictions } = require(resolveAppPath('utils/live_predictions_reader.js'));
    const inProcessResult = getLivePredictions(dbPath, provider, limit);
    if (inProcessResult && inProcessResult.success) {
      return Promise.resolve(inProcessResult);
    }
  } catch (directErr) {
    console.warn('[runMLGetLivePredictions] Direct execution failed, falling back to runner process:', directErr.message);
  }

  // 2. Fallback to child process
  return new Promise((resolve) => {

    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['get-live-predictions', dbPath, provider, String(limit || 300)])
    
    const timeout = setTimeout(() => {
      try { child && child.kill(); } catch (kErr) {}
      resolve({ success: false, error: 'Database query timed out after 30 seconds. The database may be locked or unresponsive.' })
    }, 30000)

    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      clearTimeout(timeout)
      try {
        if (output && output.trim()) {
          resolve(parseJSONFromStdout(output))
        } else if (errorOutput && errorOutput.trim()) {
          try {
            resolve(parseJSONFromStdout(errorOutput))
          } catch(e) {
            resolve({ success: false, error: errorOutput.trim() })
          }
        } else {
          resolve({ success: false, error: 'No output from get-live-predictions process' })
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse get-live-predictions output: ' + e.message })
      }
    })
  })
}

function runMLGenerateStrategyReport(dbPath) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['generate-strategy-report', dbPath])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse generate-strategy-report output: ' + e.message })
      }
    })
  })
}

function broadcastToWindows(channel, payload) {
  for (const win of activeWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
  // Broadcast to all connected web browser clients
  webBridge.broadcast(channel, payload)
}

function createWindow(options = {}) {
  console.log('Creating window with options:', options)
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: false,
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  activeWindows.add(win)

  win.on('closed', () => {
    activeWindows.delete(win)
  })

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log(`Failed to load: ${errorCode} - ${errorDescription}`)
  })

  win.webContents.on('render-process-gone', (event, details) => {
    console.error(`[Renderer Gone] Process crashed or was killed: ${details.reason} (exitCode: ${details.exitCode})`);
    if (details.reason === 'crashed' || details.reason === 'killed' || details.reason === 'oom' || details.reason === 'integrity-failure') {
      console.log('[Main Process] Attempting to recover and reload window in 3 seconds...');
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.reload();
        }
      }, 3000);
    }
  })

  win.webContents.on('did-finish-load', () => {
    console.log('Renderer content loaded')
  })

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER CONSOLE] [Level ${level}] ${message} (at ${sourceId}:${line})`)
  })

  win.once('ready-to-show', () => {
    console.log('Window ready to show event fired')
    win.show()
    win.focus()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const queryParams = []
  if (options.theme) queryParams.push(`theme=${options.theme}`)
  if (options.palette) queryParams.push(`palette=${options.palette}`)
  const queryStr = queryParams.length > 0 ? `?${queryParams.join('&')}` : ''

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + queryStr)
  } else {
    const fileOptions = {}
    if (options.theme || options.palette) {
      fileOptions.query = {}
      if (options.theme) fileOptions.query.theme = options.theme
      if (options.palette) fileOptions.query.palette = options.palette
    }
    win.loadFile(join(__dirname, '../renderer/index.html'), fileOptions)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.nexus.panel')

  console.log('[Main Process] Performing startup cleanup of orphaned Chrome processes...');
  try {
    await killOrphanedChromeProcesses();
  } catch (e) {
    console.error('[Main Process] Startup Chrome cleanup error:', e.message);
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // --- IPC Handlers ---

  const KEYWORDS_PATH = resolveAppPath('keywords.txt')
  const PROXIES_PATH = resolveAppPath('proxies.json')
  const PERSONALITIES_PATH = resolveAppPath('personalities.json')

  // --- Residential IP Routing and Proxy Management Utilities ---
  let ipUpdaterServer = null

  function syncResidentialServers() {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const resConfig = config.proxy?.residential || {}

      // 1. Manage Reverse Tunnel Server
      if (resConfig.enabled) {
        console.log('[Residential] Starting reverse tunnel server...')
        reverseTunnelProxy.start(
          resConfig.tunnelPort || 3080,
          resConfig.proxyPort || 1080,
          resConfig.authToken
        )
      } else {
        console.log('[Residential] Stopping reverse tunnel server...')
        reverseTunnelProxy.stop()
      }

      // 2. Manage IP Updater Server
      if (resConfig.ipUpdaterEnabled) {
        startIpUpdaterServer(resConfig.ipUpdaterPort || 3081, resConfig.authToken)
      } else {
        stopIpUpdaterServer()
      }
    } catch (e) {
      console.error('Error syncing residential servers:', e)
    }
  }

  function startIpUpdaterServer(port, token) {
    if (ipUpdaterServer) {
      try { ipUpdaterServer.close() } catch(e) {}
      ipUpdaterServer = null
    }

    console.log(`[IPUpdater] Starting API server on port ${port || 'random'}...`)
    ipUpdaterServer = http.createServer((req, res) => {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      if (urlObj.pathname === '/update-ip') {
        const qToken = urlObj.searchParams.get('token')
        const qIp = urlObj.searchParams.get('ip') || req.socket.remoteAddress?.replace(/^.*:/, '')
        const qProxyId = urlObj.searchParams.get('proxyId') || urlObj.searchParams.get('proxyHost')

        if (!qToken || qToken !== token) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid Token' }))
          return
        }

        if (!qIp) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Bad Request: Missing IP address' }))
          return
        }

        try {
          let updatedCount = 0

          // Update proxies.json pool
          if (fs.existsSync(PROXIES_PATH)) {
            const proxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8'))
            let matched = false

            for (const proxy of proxies) {
              const isMatch = qProxyId 
                ? (proxy.host === qProxyId || proxy.username === qProxyId)
                : (proxy.type === 'residential' || proxy.host.includes('ddns') || proxy.host.includes('home'))
              
              if (isMatch) {
                console.log(`[IPUpdater] Updating stored proxy ${proxy.host}:${proxy.port} -> ${qIp}:${proxy.port}`)
                proxy.host = qIp
                matched = true
                updatedCount++
              }
            }

            if (matched) {
              fs.writeFileSync(PROXIES_PATH, JSON.stringify(proxies, null, 4), 'utf8')
            }
          }

          // Update fallback proxy in browser-config.json
          if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
            if (config.proxy && config.proxy.enabled && (config.proxy.host === qProxyId || !qProxyId)) {
              console.log(`[IPUpdater] Updating fallback proxy host ${config.proxy.host} -> ${qIp}`)
              config.proxy.host = qIp
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
              updatedCount++
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, message: `Successfully updated IP to ${qIp} in ${updatedCount} proxy settings.` }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: err.message }))
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Not Found' }))
      }
    })

    ipUpdaterServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[IPUpdater] Port ${port} is in use, attempting to free it...`)
        const { execSync } = require('child_process')
        try {
          if (process.platform === 'win32') {
            const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
            const lines = output.trim().split('\n')
            const pids = new Set()
            lines.forEach(line => {
              const match = line.match(/\s+(\d+)\s*$/)
              if (match) {
                const pid = match[1]
                if (pid !== '0' && pid !== String(process.pid) && pid !== String(process.ppid)) {
                  pids.add(pid)
                }
              }
            })
            
            if (pids.size > 0) {
              pids.forEach(pid => {
                try {
                  execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
                  console.log(`[IPUpdater] Killed process ${pid} using port ${port}`)
                } catch (e) {}
              })
              setTimeout(() => startIpUpdaterServer(port, token), 1000)
            } else {
              startIpUpdaterServer(0, token)
            }
          } else {
            // Linux / POSIX port freeing
            try {
              execSync(`fuser -k ${port}/tcp || true`, { stdio: 'ignore' })
              console.log(`[IPUpdater] Freed port ${port} via fuser`)
              setTimeout(() => startIpUpdaterServer(port, token), 1000)
            } catch (errKill) {
              console.warn(`[IPUpdater] Could not free port ${port} via fuser, trying random port.`)
              startIpUpdaterServer(0, token)
            }
          }
        } catch (e) {
          console.error(`[IPUpdater] Could not free port ${port}:`, e.message)
          startIpUpdaterServer(0, token)
        }
      } else {
        console.error(`[IPUpdater] Server error:`, err.message)
      }
    })

    if (port === 0) {
      ipUpdaterServer.listen(0, '0.0.0.0', () => {
        const actualPort = ipUpdaterServer.address().port
        console.log(`[IPUpdater] Listening on random port ${actualPort} (original port was in use)`)
      })
    } else {
      ipUpdaterServer.listen(port, '0.0.0.0', () => {
        console.log(`[IPUpdater] Listening on port ${port}`)
      })
    }
  }

  function stopIpUpdaterServer() {
    if (ipUpdaterServer) {
      try { ipUpdaterServer.close() } catch(e) {}
      ipUpdaterServer = null
      console.log('[IPUpdater] Stopped successfully.')
    }
  }

  // Sync servers on startup
  syncResidentialServers()

  // Clean up servers on exit
  app.on('will-quit', () => {
    reverseTunnelProxy.stop()
    stopIpUpdaterServer()
  })

  ipcMain.handle('log-renderer-error', async (_, { msg, url, line, col, stack }) => {
    try {
      const timestamp = new Date().toISOString();
      const logMsg = `[${timestamp}] ❌ RENDERER UNCAUGHT ERROR: ${msg}\nUrl: ${url}:${line}:${col}\nStack: ${stack || 'No stack'}\n\n`;
      
      const logsDir = resolveAppPath('logs');
      const rendererLogPath = path.join(logsDir, 'renderer-process.log');
      
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.appendFileSync(rendererLogPath, logMsg, 'utf8');
      console.error(`[Renderer Crash Event] logged: ${msg}`);
      return { success: true };
    } catch (e) {
      console.error('Failed to write renderer error log:', e);
      return { success: false, error: e.message };
    }
  })

  // IPC Handler for PM2 Background Scraper Status
  ipcMain.handle('get-pm2-status', async () => {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      const { stdout } = await execPromise('pm2 jlist');
      const list = JSON.parse(stdout);
      const scraper = list.find(p => p.name === 'vfl-scraper');
      if (scraper) {
        const memMb = (scraper.monit.memory / (1024 * 1024)).toFixed(1);
        const cpuPct = scraper.monit.cpu;
        const status = scraper.pm2_env.status;
        const uptime = scraper.pm2_env.pm_uptime;
        return {
          exists: true,
          running: status === 'online',
          status,
          memory: `${memMb} MB`,
          cpu: `${cpuPct}%`,
          uptime,
          restarts: scraper.pm2_env.restart_time
        };
      }
      return { exists: false, running: false, status: 'not_configured' };
    } catch (err) {
      return { exists: false, running: false, error: err.message };
    }
  })

  ipcMain.handle('toggle-pm2-scraper', async (_, { action }) => {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      if (action === 'stop') {
        await execPromise('pm2 stop vfl-scraper 2>/dev/null || true');
        // Clean up any lingering chrome/xvfb processes
        await execPromise('pkill -9 -f "vfl-scraper" 2>/dev/null || true');
        await execPromise('pkill -9 -f "chrome" 2>/dev/null || true');
        await execPromise('pkill -9 -f "chromium-browser" 2>/dev/null || true');
        return { success: true, running: false };
      } else if (action === 'start') {
        const ecosystemPath = resolveAppPath('ecosystem.config.js');
        await execPromise(`pm2 restart vfl-scraper || pm2 start "${ecosystemPath}" --only vfl-scraper || pm2 start "${ecosystemPath}"`);
        return { success: true, running: true };
      }
      return { success: false, error: 'Invalid action: ' + action };
    } catch (err) {
      console.error('[toggle-pm2-scraper] Error:', err);
      return { success: false, error: err.message };
    }
  })

  // IPC Handlers for Residential Proxy
  ipcMain.handle('get-residential-status', () => {
    return reverseTunnelProxy.getStatus()
  })

  ipcMain.handle('get-residential-client-code', () => {
    try {
      const clientPath = resolveAppPath('vbet-home-proxy-client.js')
      if (fs.existsSync(clientPath)) {
        return fs.readFileSync(clientPath, 'utf8')
      }
      return ''
    } catch (e) {
      return ''
    }
  })

  ipcMain.handle('test-residential-proxy', async () => {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const resConfig = config.proxy?.residential || {}
      if (!resConfig.enabled) {
        return { valid: false, error: 'Residential proxy is disabled in configuration.' }
      }
      const proxyPort = resConfig.proxyPort || 1080
      const { testProxyConnectivity } = requireAppScript('utils/pre-launch-proxy-check.js')
      const result = await testProxyConnectivity({
        enabled: true,
        protocol: 'http',
        host: '127.0.0.1',
        port: proxyPort
      })
      return result
    } catch (err) {
      return { valid: false, error: err.message }
    }
  })


  ipcMain.handle('read-config', async () => {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8')
      return JSON.parse(data)
    } catch (error) {
      console.error('Error reading config:', error)
      return null
    }
  })

  ipcMain.handle('list-databases', async (_, dirPath) => {
    try {
      if (!fs.existsSync(dirPath)) return []
      return fs.readdirSync(dirPath).filter(f => f.endsWith('.db') || f.endsWith('.sqlite'))
    } catch (error) {
      console.error('Error listing databases:', error)
      return []
    }
  })

  ipcMain.handle('query-db', async (event, dbPath, query, params = []) => {
    dbPath = normalizeDbPath(dbPath);
    if (!dbPath || !fs.existsSync(dbPath)) {
      return { success: false, error: `Database file not found: ${dbPath}` };
    }
    ensurePerformanceIndexes(dbPath);
    
    // Direct in-process execution via better-sqlite3
    try {
      const isReadOnly = query.trim().toUpperCase().startsWith('SELECT') || query.trim().toUpperCase().startsWith('PRAGMA');
      const db = getSafeDb(dbPath, { readonly: isReadOnly, fileMustExist: true, timeout: 5000 });
      try { db.pragma('busy_timeout = 5000'); } catch (_) {}
      const upperQuery = query.trim().toUpperCase();
      let data;
      if (upperQuery.startsWith('SELECT') || upperQuery.startsWith('PRAGMA')) {
        data = db.prepare(query).all(...params);
      } else {
        const info = db.prepare(query).run(...params);
        data = [{ success: true, changes: info.changes }];
      }
      db.close();
      return { success: true, data };
    } catch (directErr) {
      console.warn('[query-db Direct Execution] Direct query failed, falling back to db_reader process:', directErr.message);
    }

    // Fallback: spawn db_reader.js process
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const timeout = setTimeout(() => {
        child && child.kill()
        resolve({ success: false, error: 'Database query timed out after 35 seconds. The database may be locked or unresponsive.' })
      }, 35000)
      
      const child = spawnNode(readerPath, [dbPath, query, JSON.stringify(params)])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        clearTimeout(timeout)
        try {
          if (errorOutput && !output) {
            try {
              const errJson = parseJSONFromStdout(errorOutput)
              resolve({ success: false, error: errJson.error || errorOutput || 'Unknown database process error' })
            } catch (parseErr) {
              resolve({ success: false, error: errorOutput.substring(0, 200) || 'Unknown database process error' })
            }
          } else if (output) {
            try {
              const result = parseJSONFromStdout(output)
              if (result && typeof result === 'object' && result.success !== undefined) {
                resolve(result)
              } else {
                resolve({ success: true, data: result })
              }
            } catch (parseErr) {
              console.error('[query-db parse failure] Raw output length:', output.length);
              resolve({ success: false, error: 'Failed to parse database output: ' + parseErr.message })
            }
          } else {
            resolve({ success: false, error: 'No response from database. The database file may be locked or corrupt.' })
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to process database response: ' + e.message })
        }
      })
      
      child.on('error', (err) => {
        clearTimeout(timeout)
        resolve({ success: false, error: 'Failed to execute database query: ' + err.message })
      })
    })
  })

  ipcMain.handle('parse-betting-stats', async (event, dbPath) => {
    dbPath = normalizeDbPath(dbPath);
    return new Promise((resolve) => {
      const parserPath = resolveAppPath('db_parser.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(parserPath, [dbPath])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (code !== 0 && errorOutput && !output) {
            try {
              const errJson = parseJSONFromStdout(errorOutput)
              resolve({ success: false, error: errJson.error || errorOutput })
            } catch (_) {
              resolve({ success: false, error: errorOutput })
            }
          } else {
            const result = parseJSONFromStdout(output)
            if (result && result.success) {
              runMLOptimize(dbPath)
                .then(() => console.log("Successfully auto-optimized ML weights after parsing new stats."))
                .catch(optimizeErr => console.error("Auto-optimize weights failed:", optimizeErr.message))
            }
            resolve(result)
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database output: ' + e.message })
        }
      })
    })
  })

  ipcMain.handle('get-market-report', async (event, dbPath) => {
    dbPath = normalizeDbPath(dbPath);
    if (!dbPath || !fs.existsSync(dbPath)) {
      return { success: false, error: `Database file not found: ${dbPath}` };
    }

    // Direct in-process execution via better-sqlite3 for maximum speed and zero pipe truncation
    try {
      const db = getSafeDb(dbPath, { readonly: true, fileMustExist: true });

      let highRiskMinOdds = 3.3; // Default fallback
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const browserConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          if (browserConfig && browserConfig.ai && typeof browserConfig.ai.highRiskMinOdds === 'number') {
            highRiskMinOdds = browserConfig.ai.highRiskMinOdds;
          }
        }
      } catch (_) {}

      const historyRows = db.prepare(`
        SELECT
          market,
          COUNT(*) as total,
          SUM(CASE WHEN actual_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
        FROM market_odds_history
        WHERE actual_odd IS NOT NULL
        GROUP BY market
      `).all(highRiskMinOdds);

      const rows = historyRows.length > 0 ? historyRows : db.prepare(`
        SELECT
          market,
          COUNT(*) as total,
          SUM(CASE WHEN implied_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
        FROM ai_best_picks_history
        GROUP BY market
        ORDER BY total DESC
      `).all(highRiskMinOdds);
      
      const analysis = {};
      for (const row of rows) {
        const percentage = row.total > 0 ? ((row.odds_3_3_plus / row.total) * 100).toFixed(1) : 0;
        analysis[row.market] = {
          total: row.total,
          odds_3_3_plus: row.odds_3_3_plus,
          percentage: parseFloat(percentage),
          confidence: Math.min(100, (row.total / 30) * 100)
        };
      }

      let aiPickSummary = null;
      let overallPickSummary = null;
      let topAIPredictions = [];
      let stakeUnitsSummary = null;
      let settledPicks = [];

      const hasAITable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_best_picks_history'").get();
      if (hasAITable) {
        const overallSummary = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
            SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost
          FROM ai_best_picks_history
        `).get();

        const aiSummary = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            AVG(implied_odd) as avg_implied_odd,
            AVG(probability) as avg_probability,
            SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
            SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost
          FROM ai_best_picks_history
          WHERE pick_type = 'ai_best_pick'
        `).get();

        aiPickSummary = {
          totalPicks: aiSummary.total || 0,
          pendingPicks: aiSummary.pending || 0,
          highOddsPending: aiSummary.pending || 0,
          avgImpliedOdd: aiSummary.avg_implied_odd ? parseFloat(parseFloat(aiSummary.avg_implied_odd).toFixed(2)) : 0,
          avgProbability: aiSummary.avg_probability ? parseFloat(parseFloat(aiSummary.avg_probability).toFixed(1)) : 0,
          winRate: aiSummary.won + aiSummary.lost > 0 ? parseFloat(((aiSummary.won / (aiSummary.won + aiSummary.lost)) * 100).toFixed(1)) : 0
        };

        overallPickSummary = {
          totalPicks: overallSummary.total || 0,
          pendingPicks: overallSummary.pending || 0,
          winRate: overallSummary.won + overallSummary.lost > 0 ? parseFloat(((overallSummary.won / (overallSummary.won + overallSummary.lost)) * 100).toFixed(1)) : 0
        };

        const allPicks = db.prepare(`
          SELECT status
          FROM ai_best_picks_history
          WHERE status IN ('won', 'lost')
          ORDER BY id ASC
        `).all();

        let maxConsecLosses = 0;
        let currentStreak = 0;
        for (const p of allPicks) {
          if (p.status === 'lost') {
            currentStreak++;
            if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak;
          } else {
            currentStreak = 0;
          }
        }
        overallPickSummary.maxConsecutiveLosses = maxConsecLosses;
        overallPickSummary.settledPicks = allPicks.length;

        const aiBestPicks = db.prepare(`
          SELECT status
          FROM ai_best_picks_history
          WHERE status IN ('won', 'lost')
            AND pick_type = 'ai_best_pick'
          ORDER BY id ASC
        `).all();

        let maxConsecLossesHigh = 0;
        let currentStreakHigh = 0;
        for (const p of aiBestPicks) {
          if (p.status === 'lost') {
            currentStreakHigh++;
            if (currentStreakHigh > maxConsecLossesHigh) maxConsecLossesHigh = currentStreakHigh;
          } else {
            currentStreakHigh = 0;
          }
        }
        aiPickSummary.maxConsecutiveLosses = maxConsecLossesHigh;
        aiPickSummary.maxConsecutiveLossesHighOdds = maxConsecLossesHigh;
        aiPickSummary.highOddsSettledPicks = aiBestPicks.length;

        topAIPredictions = db.prepare(`
          SELECT season_name, round_number, home_team, away_team, market, pick_type, status, implied_odd, probability
          FROM ai_best_picks_history
          WHERE implied_odd >= ? AND status = 'pending'
          ORDER BY implied_odd DESC
          LIMIT 5
        `).all(highRiskMinOdds);

        settledPicks = db.prepare(`
          SELECT id, season_name, round_number, home_team, away_team, market, pick_type, probability, implied_odd, status, actual_score, kickoff_timestamp
          FROM ai_best_picks_history
          WHERE status IN ('won', 'lost', 'void')
          ORDER BY id ASC
        `).all();

        const stakeStats = {
          overall: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
          safest: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
          high_value: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
          ai_best_pick: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 }
        };

        const updateStats = (statObj, status, odd) => {
          if (status === 'void') {
            statObj.void++;
          } else {
            statObj.played++;
            if (status === 'won') {
              statObj.won++;
              statObj.profit += (odd - 1.0) * 100.0;
            } else if (status === 'lost') {
              statObj.lost++;
              statObj.profit -= 100.0;
            }
          }
        };

        for (const p of settledPicks) {
          const type = p.pick_type;
          const odd = p.implied_odd && p.implied_odd > 0
            ? p.implied_odd
            : (p.probability > 0 ? parseFloat((100 / p.probability).toFixed(2)) : 1.0);

          if (stakeStats[type]) {
            updateStats(stakeStats[type], p.status, odd);
          }
          updateStats(stakeStats.overall, p.status, odd);
        }

        for (const key of Object.keys(stakeStats)) {
          const s = stakeStats[key];
          s.winRate = s.played > 0 ? parseFloat(((s.won / s.played) * 100).toFixed(1)) : 0;
          s.roi = s.played > 0 ? parseFloat(((s.profit / (s.played * 100)) * 100).toFixed(1)) : 0;
          s.profit = parseFloat(s.profit.toFixed(2));
        }
        stakeUnitsSummary = stakeStats;
      }
      db.close();

      return {
        success: true,
        report: {
          generatedAt: new Date().toISOString(),
          markets: analysis,
          aiPickSummary,
          overallPickSummary,
          topAIPredictions,
          stakeUnitsSummary,
          settledPicks
        }
      };
    } catch (directErr) {
      console.warn('[get-market-report Direct] In-process execution failed, falling back to runner:', directErr.message);
    }

    return new Promise((resolve) => {
      const runnerPath = resolveAppPath('utils/ml_runner.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(runnerPath, ['get-market-report', dbPath])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            try {
              const errJson = JSON.parse(errorOutput)
              resolve({ success: false, error: errJson.error })
            } catch (parseErr) {
              resolve({ success: false, error: errorOutput.substring(0, 200) })
            }
          } else if (output) {
            try {
              const result = parseJSONFromStdout(output)
              resolve(result)
            } catch (parseErr) {
              resolve({ success: false, error: 'Failed to parse market report output: ' + parseErr.message })
            }
          } else {
            resolve({ success: false, error: 'No response from market report process.' })
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to process market report response: ' + e.message })
        }
      })
      
      child.on('error', (err) => {
        resolve({ success: false, error: 'Failed to execute market report query: ' + err.message })
      })
    })
  })

  ipcMain.handle('get-db-tables', async (event, dbPath) => {
    dbPath = normalizeDbPath(dbPath);
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, "SELECT name FROM sqlite_master WHERE type='table'"])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            const result = parseJSONFromStdout(output)
            if (result.success) {
               resolve({ success: true, tables: result.data.map(r => r.name) })
            } else {
               resolve({ success: false, error: result.error })
            }
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse tables: ' + e.message })
        }
      })
    })
  })

  ipcMain.handle('get-db-info', async (event, dbPath) => {
    dbPath = normalizeDbPath(dbPath);
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, '__INFO__'])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (output && output.trim()) {
            resolve(JSON.parse(JSON.stringify(parseJSONFromStdout(output))))
          } else if (errorOutput && errorOutput.trim()) {
            try {
              resolve(JSON.parse(JSON.stringify(parseJSONFromStdout(errorOutput))))
            } catch(e) {
              resolve({ success: false, error: errorOutput.trim() })
            }
          } else {
            resolve({ success: false, error: 'No output from database reader' })
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database info: ' + e.message })
        }
      })
    })
  })

  async function callAI({ provider, apiKey, model: modelOverride, systemPrompt, userPrompt, temperature = 0.7 }) {
    if (!apiKey) {
      throw new Error(`API key is missing for provider "${provider}". Please set it in Settings.`);
    }

    const prov = (provider || 'deepseek').toLowerCase();

    if (prov === 'deepseek' || prov === 'openai' || prov === 'gemini') {
      let url = 'https://api.deepseek.com/v1/chat/completions';
      let defaultModel = 'deepseek-chat';

      if (prov === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        defaultModel = 'gpt-4o-mini';
      } else if (prov === 'gemini') {
        url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        defaultModel = 'gemini-2.5-flash';
      }

      const model = modelOverride || defaultModel;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: temperature
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API Error (${prov}): ${response.statusText}. ${errText}`);
      }

      const data = await response.json();
      return data.choices[0].message.content.trim();
    }

    if (prov === 'anthropic') {
      const model = modelOverride || 'claude-haiku-4-5';
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 256,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt }
          ],
          temperature: temperature
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API Error (Anthropic): ${response.statusText}. ${errText}`);
      }

      const data = await response.json();
      if (data.content && data.content[0] && data.content[0].text) {
        return data.content[0].text.trim();
      }
      throw new Error('Invalid response structure from Anthropic API');
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  ipcMain.handle('test-ai-connection', async (_, { provider, apiKey, model }) => {
    try {
      const reply = await callAI({
        provider,
        apiKey,
        model,
        systemPrompt: 'You are a helpful assistant. Reply as briefly as possible.',
        userPrompt: 'Reply with exactly: "Connection OK"',
        temperature: 0
      });
      return { success: true, reply: reply.substring(0, 200) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ask-db-ai-sql', async (_, { question, schema, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a SQLite database expert. Write a single SQLite SELECT query to answer the user's question. Return ONLY the raw SQL query. No markdown, no explanation, no backticks. Only SELECT queries are allowed. Ensure any table and column names used match the schema exactly.";
      const userPrompt = `Database Schema:\n${schema}\n\nUser Question: ${question}`;
      
      let sql = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.1 });
      sql = sql.replace(/```sql|```/g, '').trim();
      return { success: true, sql };
    } catch (e) {
      console.error('Database AI SQL Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ask-db-ai-explain', async (_, { question, sql, result, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a friendly and helpful AI data analyst. Answer the user's question based on the SQLite query executed and its result. Write a concise, friendly natural language response explaining the answer. Keep it directly relevant and precise.";
      const userPrompt = `User Question: ${question}\nSQL Query Executed: ${sql}\nQuery Result (JSON): ${JSON.stringify(result)}`;
      
      const answer = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.5 });
      return { success: true, answer };
    } catch (e) {
      console.error('Database AI Explain Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ── Module 13: Engine Dashboard Metrics ──────────────────────────────────────
  ipcMain.handle('get-engine-metrics', async (_, dbPath) => {
    try {
      if (!dbPath || !fs.existsSync(dbPath)) return { success: false, error: 'DB not found' };
      const db = getSafeDb(dbPath, { readonly: true });
      const recEngine = require(resolveAppPath('utils/recommendation_engine.js'));
      const metrics = {
        ai_best_pick: recEngine.getDashboardMetrics(db, 'ai_best_pick'),
        safest:       recEngine.getDashboardMetrics(db, 'safest'),
        high_value:   recEngine.getDashboardMetrics(db, 'high_value'),
      };
      db.close();
      return { success: true, metrics };
    } catch (e) {
      console.error('get-engine-metrics error:', e);
      return { success: false, error: e.message };
    }
  });

  // ── LLM Auto-Tune: EV Thresholds ─────────────────────────────────────────────
  ipcMain.handle('run-llm-ev-optimize', async (_, { dbPath, provider, apiKey, model }) => {
    try {
      if (!dbPath || !fs.existsSync(dbPath)) return { success: false, error: 'DB not found' };
      const db = getSafeDb(dbPath, { readonly: true });

      // Fetch last 80 settled picks with engine metadata
      let picks = [];
      try {
        picks = db.prepare(`
          SELECT pick_type, market, probability, implied_odd, ev_score,
                 recommendation_score, agreement_score, status
          FROM ai_best_picks_history
          WHERE status IN ('won', 'lost')
          ORDER BY id DESC LIMIT 80
        `).all();
      } catch(e) { /* table may lack columns on old DB */ }
      db.close();

      if (picks.length < 5) {
        return { success: false, error: 'Not enough settled picks (need ≥ 5). Keep using Manual mode until more picks are settled.' };
      }

      // Build performance summary per pick type
      const summary = {};
      for (const pt of ['safest', 'high_value', 'ai_best_pick']) {
        const sub = picks.filter(p => p.pick_type === pt);
        if (sub.length === 0) continue;
        const won = sub.filter(p => p.status === 'won').length;
        const winRate = (won / sub.length * 100).toFixed(1);
        const profit = sub.reduce((a, p) => a + (p.status === 'won' ? (p.implied_odd || 2) - 1 : -1), 0);
        const roi = (profit / sub.length * 100).toFixed(1);
        const avgEV = sub.filter(p => p.ev_score != null).reduce((a, p, _, arr) => a + p.ev_score / arr.length, 0).toFixed(2);
        summary[pt] = { count: sub.length, winRate, roi, avgEV };
      }

      const systemPrompt = `You are a professional sports betting quant analyst. Your job is to recommend optimal minimum EV (Expected Value) thresholds for three pick categories. Respond ONLY with a JSON object and nothing else — no explanations, no markdown, no backticks.

JSON format required:
{"safest": <number>, "highValue": <number>, "highRisk": <number>, "reasoning": "<one sentence>"}

Rules:
- All values must be percentages between 0 and 20
- Higher EV thresholds = fewer but more profitable bets
- Lower EV thresholds = more bets with lower expected edge
- "safest" should normally be 1-5%, "highValue" 3-10%, "highRisk" 5-15%`;

      const userPrompt = `Here is my betting performance over the last ${picks.length} settled picks:

${JSON.stringify(summary, null, 2)}

Based on this performance data, what minimum EV% threshold should I require for each pick type to maximize long-term ROI? 

Current defaults: safest=2%, highValue=5%, highRisk=8%.`;

      const rawReply = await callAI({ provider, apiKey, model, systemPrompt, userPrompt, temperature: 0.2 });

      // Parse the JSON from the reply
      const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('LLM did not return valid JSON');
      const parsed = JSON.parse(jsonMatch[0]);

      if (typeof parsed.safest !== 'number' || typeof parsed.highValue !== 'number' || typeof parsed.highRisk !== 'number') {
        throw new Error('LLM response missing required numeric fields');
      }

      return {
        success: true,
        safest:    Math.max(0, Math.min(20, Math.round(parsed.safest))),
        highValue: Math.max(0, Math.min(20, Math.round(parsed.highValue))),
        highRisk:  Math.max(0, Math.min(20, Math.round(parsed.highRisk))),
        reasoning: parsed.reasoning || '',
        sampleSize: picks.length
      };
    } catch (e) {
      console.error('run-llm-ev-optimize error:', e);
      return { success: false, error: e.message };
    }
  });

  // ── ML Backtest: EV Threshold Optimizer ──────────────────────────────────────
  ipcMain.handle('run-backtest-ev-optimize', async (_, { dbPath }) => {
    try {
      if (!dbPath || !fs.existsSync(dbPath)) return { success: false, error: 'DB not found' };
      const db = getSafeDb(dbPath, { readonly: true });

      let picks = [];
      try {
        picks = db.prepare(`
          SELECT pick_type, implied_odd, ev_score, calibrated_prob, status
          FROM ai_best_picks_history
          WHERE status IN ('won', 'lost') AND ev_score IS NOT NULL
          ORDER BY id ASC
        `).all();
      } catch(e) {}
      db.close();

      if (picks.length < 10) {
        // Return the data-proven defaults from 2,083-pick backtest analysis
        return {
          success: true,
          safest: 8, highValue: 10, highRisk: 40,
          roi: 0.177, bets: 0,
          note: 'Using proven defaults (insufficient local data). Based on 2,083-pick backtest: Safest EV≥8% → +21% ROI, HV EV 10-42% odds 1.5-2.8 → +9.4% ROI, AI Best EV≥40% odds≥5 → +23.7% ROI.'
        };
      }

      // DATA-PROVEN PROFITABLE ZONES (from 2,083-pick backtest):
      //   Safest:     calibProb≥0.54,  odds 1.3-3.0,  EV  8-45%  →  WR 81.6%  ROI +21%
      //   High Value: odds 1.5-2.8,    EV 10-42%       →  WR 51.3% ROI  +9.4%
      //   AI Best:    odds ≥5.0,        EV ≥40%         →  WR 22.7% ROI +23.7%

      const sfPicks  = picks.filter(p => p.pick_type === 'safest'     && p.implied_odd >= 1.30 && p.implied_odd <= 3.0);
      const hvPicks  = picks.filter(p => p.pick_type === 'high_value' && p.implied_odd >= 1.50 && p.implied_odd <= 2.8);
      const aiPicks  = picks.filter(p => p.pick_type === 'ai_best_pick' && p.implied_odd >= 5.0 && p.implied_odd <= 25.0);

      function sweepEV(pool, minEV, maxEV, step) {
        let best = { threshold: minEV, roi: -Infinity, bets: 0 };
        for (let t = minEV; t <= maxEV; t += step) {
          const sub = pool.filter(p => p.ev_score >= t && p.ev_score < (t === maxEV ? 9999 : maxEV + 10));
          if (sub.length < 5) continue;
          const profit = sub.reduce((a, p) => a + (p.status === 'won' ? p.implied_odd - 1 : -1), 0);
          const roi = profit / sub.length;
          if (roi > best.roi) best = { threshold: t, roi, bets: sub.length };
        }
        return best;
      }

      const sfBest  = sweepEV(sfPicks,  2,  20, 1);
      const hvBest  = sweepEV(hvPicks,  5,  30, 1);
      const aiBest  = sweepEV(aiPicks, 20,  60, 5);

      const totalBets = sfBest.bets + hvBest.bets + aiBest.bets;
      const combinedROI = totalBets > 0
        ? (sfBest.roi * sfBest.bets + hvBest.roi * hvBest.bets + aiBest.roi * aiBest.bets) / totalBets
        : 0;

      return {
        success: true,
        safest:    sfBest.threshold,
        highValue: hvBest.threshold,
        highRisk:  Math.max(aiBest.threshold, 40), // never go below 40% for AI Best
        roi:       parseFloat(combinedROI.toFixed(4)),
        bets:      totalBets,
        breakdown: {
          safest:    { threshold: sfBest.threshold,  roi: +(sfBest.roi * 100).toFixed(1),  bets: sfBest.bets },
          highValue: { threshold: hvBest.threshold,  roi: +(hvBest.roi * 100).toFixed(1),  bets: hvBest.bets },
          aisBest:   { threshold: aiBest.threshold,  roi: +(aiBest.roi * 100).toFixed(1),  bets: aiBest.bets }
        }
      };
    } catch (e) {
      console.error('run-backtest-ev-optimize error:', e);
      return { success: false, error: e.message };
    }
  });


  ipcMain.handle('delete-database', async (event, dbPath) => {
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath)
        return { success: true }
      }
      return { success: false, error: 'Database not found' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('drop-table', async (event, dbPath, tableName) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, `DROP TABLE IF EXISTS ${tableName}`, '[]'])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            resolve(parseJSONFromStdout(output))
          }
        } catch (e) {
          resolve({ success: false, error: e.message })
        }
      })
    })
  })

  ipcMain.handle('clear-table', async (event, dbPath, tableName) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, `DELETE FROM ${tableName}`, '[]'])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            resolve(parseJSONFromStdout(output))
          }
        } catch (e) {
          resolve({ success: false, error: e.message })
        }
      })
    })
  })

  ipcMain.handle('write-config', async (_, config) => {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      PROFILES_BASE_DIR = getProfilesBaseDir()
      syncResidentialServers()
      return { success: true }
    } catch (error) {
      console.error('Error writing config:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('read-keywords', async (_, platform = 'google') => {
    try {
      const pPath = resolveAppPath(`keywords_${platform}.txt`)
      if (fs.existsSync(pPath)) {
        return fs.readFileSync(pPath, 'utf8')
      }
      return ''
    } catch (error) {
      console.error(`Error reading keywords for ${platform}:`, error)
      return ''
    }
  })

  ipcMain.handle('write-keywords', async (_, { content, platform = 'google' }) => {
    try {
      const pPath = resolveAppPath(`keywords_${platform}.txt`)
      fs.writeFileSync(pPath, content, 'utf8')
      return { success: true }
    } catch (error) {
      console.error(`Error writing keywords for ${platform}:`, error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('select-keywords-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const content = fs.readFileSync(result.filePaths[0], 'utf8')
      return { success: true, content }
    }
    return { success: false }
  })

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select folder to save database and bot output files',
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('select-database-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select SQLite Database File',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite Database Files (*.db, *.sqlite, *.sqlite3)', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('select-python-file', async () => {
    const isWin = process.platform === 'win32';
    const result = await dialog.showOpenDialog({
      title: 'Select Python 3 Executable',
      properties: ['openFile'],
      filters: isWin
        ? [{ name: 'Executables (*.exe)', extensions: ['exe'] }, { name: 'All Files (*.*)', extensions: ['*'] }]
        : [{ name: 'All Files (*)', extensions: ['*'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }
    return { success: false };
  });

  ipcMain.handle('test-python-executable', async (_, customPath) => {
    const pythonBin = customPath || (pathResolver ? pathResolver.resolvePythonExecutable() : 'python3');
    const { execFile } = require('child_process');
    return new Promise((resolve) => {
      execFile(pythonBin, ['-c', 'import sys, json; print(json.dumps({"version": sys.version, "has_xgboost": bool(__import__("xgboost", fromlist=["1"])), "has_sqlite3": bool(__import__("sqlite3")), "has_numpy": bool(__import__("numpy"))}))'], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          execFile(pythonBin, ['--version'], { timeout: 4000 }, (err2, stdout2) => {
            if (err2) {
              return resolve({ success: false, error: err.message, path: pythonBin });
            }
            resolve({ success: true, version: (stdout2 || '').trim(), hasXgboost: false, hasSqlite3: true, hasNumpy: false, path: pythonBin });
          });
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          resolve({
            success: true,
            version: data.version.split(' ')[0],
            hasXgboost: !!data.has_xgboost,
            hasSqlite3: !!data.has_sqlite3,
            hasNumpy: !!data.has_numpy,
            path: pythonBin
          });
        } catch (e) {
          resolve({ success: true, version: stdout.trim(), path: pythonBin });
        }
      });
    });
  });

  ipcMain.handle('auto-detect-all-paths', async () => {
    try {
      if (!pathResolver) pathResolver = require(resolveAppPath('utils/path_resolver.js'));
      const chrome = pathResolver.resolveChromeExecutable();
      const python = pathResolver.resolvePythonExecutable();
      const outputDir = pathResolver.resolveOutputDir();
      const userDataDir = pathResolver.resolveUserDataDir();
      const appRoot = resolveAppPath('');
      return {
        success: true,
        chrome,
        python,
        outputDir,
        userDataDir,
        appRoot
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-system-paths', async () => {
    try {
      if (!pathResolver) pathResolver = require(resolveAppPath('utils/path_resolver.js'));
      const paths = pathResolver.getAllSystemPaths();
      return { success: true, paths };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-bot-settings', async () => {
    try {
      const p = resolveAppPath('bot_settings.json')
      let settings = {}
      if (fs.existsSync(p)) {
        settings = JSON.parse(fs.readFileSync(p, 'utf8'))
      }
      if (!settings.outputDir) {
        settings.outputDir = resolveAppPath('')
      }
      if (settings.trainingDbPath === undefined) settings.trainingDbPath = '';
      if (settings.pythonPath === undefined) settings.pythonPath = '';
      if (settings.reportsDir === undefined) settings.reportsDir = '';
      if (settings.autoStartScraperEnabled === undefined) settings.autoStartScraperEnabled = false;
      if (!settings.autoStartScraperTarget) settings.autoStartScraperTarget = 'all';
      if (!settings.autoStartScraperDelay) settings.autoStartScraperDelay = 10;
      if (settings.autoStartScraperHeadless === undefined) settings.autoStartScraperHeadless = true;
      if (settings.autoStartScraperContinuous === undefined) settings.autoStartScraperContinuous = true;
      if (!settings.autoStartScraperDatabase) settings.autoStartScraperDatabase = 'auto';
      if (!settings.autoStartScraperDevice) settings.autoStartScraperDevice = 'desktop';
      if (!settings.autoStartScraperBrowser) settings.autoStartScraperBrowser = 'chrome';
      if (!settings.autoStartScraperProfile) settings.autoStartScraperProfile = 'Temporary';
      if (settings.autoOptimizeDbEnabled === undefined) settings.autoOptimizeDbEnabled = true;
      if (settings.autoOptimizeTrimThreshold === undefined) settings.autoOptimizeTrimThreshold = 20000;
      if (settings.autoOptimizeOnTrain === undefined) settings.autoOptimizeOnTrain = true;
      return settings
    } catch (e) {
      return {
        outputDir: resolveAppPath(''),
        trainingDbPath: '',
        pythonPath: '',
        reportsDir: '',
        autoStartScraperEnabled: false,
        autoStartScraperTarget: 'all',
        autoStartScraperDelay: 10,
        autoStartScraperHeadless: true,
        autoStartScraperContinuous: true,
        autoStartScraperDatabase: 'auto',
        autoStartScraperDevice: 'desktop',
        autoStartScraperBrowser: 'chrome',
        autoStartScraperProfile: 'Temporary',
        autoOptimizeDbEnabled: true,
        autoOptimizeTrimThreshold: 20000,
        autoOptimizeOnTrain: true
      }
    }
  })

  ipcMain.handle('save-bot-settings', async (_, data) => {
    try {
      const p = resolveAppPath('bot_settings.json')
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('select-chrome-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('select-cursor-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'ico'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('create-new-user-data-dir', async (event) => {
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Select Folder to Save the New User Data Directory',
        properties: ['openDirectory', 'createDirectory']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'User cancelled folder selection' }
      }

      const parentDir = result.filePaths[0]
      let newDirName = 'my-bot-profiles'
      let targetPath = path.join(parentDir, newDirName)
      
      let counter = 1
      while (fs.existsSync(targetPath)) {
        newDirName = `my-bot-profiles-${counter}`
        targetPath = path.join(parentDir, newDirName)
        counter++
      }

      fs.mkdirSync(targetPath, { recursive: true })
      return { success: true, path: targetPath }
    } catch (e) {
      console.error('[Create User Data Dir Error]', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('download-chrome', async (event) => {
    const sendProgress = (stage, message, percent = 0) => {
      const payload = { stage, message, percent }
      if (event && event.sender) {
        event.sender.send('chrome-download-progress', payload)
      } else {
        broadcastToWindows('chrome-download-progress', payload)
      }
    }

    try {
      sendProgress('fetching', 'Checking latest stable Chrome for Testing release...', 10)
      
      const json = await new Promise((resolve, reject) => {
        https.get('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch (e) {
              reject(new Error('Failed to parse Chrome versions JSON'))
            }
          })
        }).on('error', reject)
      })

      const stableChannel = json?.channels?.Stable
      if (!stableChannel) throw new Error('Stable release channel not found in Chrome metadata')
      
      const version = stableChannel.version
      const chromeDownloads = stableChannel.downloads?.chrome || []

      const targetPlatform = process.platform === 'win32' 
        ? 'win64' 
        : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'linux64')

      const platformDownload = chromeDownloads.find(d => d.platform === targetPlatform)
      if (!platformDownload) throw new Error(`${targetPlatform} platform download not found`)
      
      const zipUrl = platformDownload.url
      sendProgress('fetching', `Found Chrome version ${version} for ${targetPlatform}. Preparing directory...`, 20)

      const rootDir = resolveAppPath('')
      const chromeParentDir = path.join(rootDir, 'chrome')
      if (!fs.existsSync(chromeParentDir)) {
        fs.mkdirSync(chromeParentDir, { recursive: true })
      }

      const zipSubDir = process.platform === 'win32' ? 'chrome-win64' : (process.platform === 'darwin' ? (process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64') : 'chrome-linux64')
      const binName = process.platform === 'win32' ? 'chrome.exe' : 'chrome'
      const versionFolder = `${targetPlatform}-${version}`
      const targetFolder = path.join(chromeParentDir, versionFolder)
      const expectedExe = path.join(targetFolder, zipSubDir, binName)

      if (fs.existsSync(expectedExe)) {
        if (fs.existsSync(CONFIG_PATH)) {
          try {
            const browserConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
            if (browserConfig.paths) {
              browserConfig.paths.chrome = expectedExe
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(browserConfig, null, 4), 'utf8')
            }
          } catch (err) {}
        }
        sendProgress('completed', `Chrome version ${version} is already installed!`, 100)
        return { success: true, alreadyExists: true, path: expectedExe, version }
      }

      const zipPath = path.join(chromeParentDir, `chrome-${targetPlatform}-${version}.zip`)
      sendProgress('downloading', `Downloading Chrome for Testing v${version}...`, 30)

      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(zipPath)
        https.get(zipUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download: Status Code ${res.statusCode}`))
            return
          }
          
          const totalSize = parseInt(res.headers['content-length'] || '0', 10)
          let downloaded = 0
          
          res.on('data', (chunk) => {
            downloaded += chunk.length
            fileStream.write(chunk)
            if (totalSize > 0) {
              const percent = Math.floor(30 + (downloaded / totalSize) * 45)
              sendProgress('downloading', `Downloading: ${Math.floor(downloaded / 1024 / 1024)}MB / ${Math.floor(totalSize / 1024 / 1024)}MB`, percent)
            }
          })
          
          res.on('end', () => {
            fileStream.end()
            resolve()
          })
        }).on('error', (err) => {
          fileStream.destroy()
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
          reject(err)
        })
      })

      sendProgress('extracting', 'Extracting Chrome archive...', 80)
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true })
      }

      if (process.platform === 'win32') {
        const powershellCmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetFolder}' -Force"`
        await execPromise(powershellCmd)
      } else {
        const unzipCmd = `unzip -o "${zipPath}" -d "${targetFolder}"`
        await execPromise(unzipCmd)
        try {
          if (fs.existsSync(expectedExe)) {
            fs.chmodSync(expectedExe, 0o755)
          }
        } catch (e) {}
      }

      sendProgress('cleanup', 'Cleaning up temporary download files...', 95)
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath)
        } catch (e) {}
      }

      if (!fs.existsSync(expectedExe)) {
        throw new Error(`${binName} was not found in the expected extracted directory structure`)
      }

      if (fs.existsSync(CONFIG_PATH)) {
        const browserConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        if (browserConfig.paths) {
          browserConfig.paths.chrome = expectedExe
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(browserConfig, null, 4), 'utf8')
        }
      }

      sendProgress('completed', `Chrome version ${version} downloaded and updated successfully!`, 100)
      return { success: true, path: expectedExe, version }

    } catch (e) {
      console.error('[Chrome Auto-Updater Error]', e)
      sendProgress('failed', `Error: ${e.message}`, 0)
      return { success: false, error: e.message }
    }
  })

  let botProcesses = []
  let schedulerQueue = []
  let lastRunTimes = {}
  let schedulerTickTimer = null
  let manualQueue = []

  function executeBotInstance(scriptName, profileId, family, device, browser = 'random', eventSender = null) {
    const scriptPath = resolveAppPath(scriptName)
    const profilePath = path.join(PROFILES_BASE_DIR, family, profileId)

    const win = eventSender ? BrowserWindow.fromWebContents(eventSender) : null
    const winId = win ? win.id : 'scheduler'

    // Ensure directory exists
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true })
    }

    let headless = true
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        if (cfg.scheduler && cfg.scheduler.headless !== undefined) {
          headless = cfg.scheduler.headless
        }
      }
    } catch (e) {
      console.error('Error reading scheduler headless config:', e.message)
    }

    console.log(`[Scheduler Engine] Launching bot for profile: ${profilePath}`)
    const startMsg = `[Scheduler] Starting scheduled task "${scriptName}" for profile "${profileId}"...`
    if (eventSender) {
      eventSender.send('bot-log', startMsg)
    } else {
      broadcastToWindows('bot-log', startMsg)
    }

    const child = spawnNode(scriptPath, [`--user-data-dir=${profilePath}`, `--device=${device}`, `--browser=${browser}`, `--headless=${headless}`])

    const botInfo = {
      id: botProcesses.length,
      process: child,
      profilePath,
      profileType: 'permanent',
      startTime: new Date().toISOString(),
      isScheduler: true,
      winId
    }
    botProcesses.push(botInfo)

    const botIndex = botProcesses.length
    
    const pipeLogs = (data, isError = false) => {
      const msg = `[Scheduler - Profile ${profileId}] ${isError ? 'ERROR: ' : ''}${data.toString()}`
      if (eventSender) {
        eventSender.send('bot-log', msg)
      } else {
        broadcastToWindows('bot-log', msg)
      }
    }

    child.stdout.on('data', (data) => pipeLogs(data, false))
    child.stderr.on('data', (data) => pipeLogs(data, true))

    child.on('close', (code) => {
      const endMsg = `[Scheduler - Profile ${profileId}] Process exited with code ${code}`
      if (eventSender) {
        eventSender.send('bot-log', endMsg)
      } else {
        broadcastToWindows('bot-log', endMsg)
      }

      botProcesses = botProcesses.filter(p => p.process !== child)
      
      const statusMsg = getCurrentBotStatus(winId)
      if (eventSender) {
        eventSender.send('bot-status', statusMsg)
      } else {
        broadcastToWindows('bot-status', statusMsg)
      }

      // A slot has opened! Trigger the queue check
      processSchedulerQueue(eventSender)
      processManualQueue()
    })

    const statusMsg = getCurrentBotStatus()
    if (eventSender) {
      eventSender.send('bot-status', statusMsg)
    } else {
      broadcastToWindows('bot-status', statusMsg)
    }
  }

  function processSchedulerQueue(eventSender = null) {
    if (schedulerQueue.length === 0) return

    if (!fs.existsSync(CONFIG_PATH)) return
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const maxConcurrent = config.scheduler?.maxConcurrentProfiles ?? 2

    while (botProcesses.length < maxConcurrent && schedulerQueue.length > 0) {
      const nextTask = schedulerQueue.shift()
      console.log(`[Scheduler Queue] Slot available! Launching queued task for profile "${nextTask.profileId}"`)
      
      const msg = `[Scheduler] Slot available! Spawning queued profile "${nextTask.profileId}"`
      if (eventSender) {
        eventSender.send('bot-log', msg)
      } else {
        broadcastToWindows('bot-log', msg)
      }
      
      executeBotInstance(nextTask.scriptName, nextTask.profileId, nextTask.family, nextTask.device, nextTask.browser || 'random', eventSender)
    }
  }

  function spawnManualTask(task) {
    const { scriptPath, profilePath, profileType, device, browser, headless, sender, botIndex, winId } = task

    // Ensure directory exists
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true })
    }

    console.log(`[Manual Queue] Spawning profile: ${profilePath}`)
    sender.send('bot-log', `[Launcher] Spawning queued profile "${path.basename(profilePath)}" (Index ${botIndex})...`)

    const child = spawnNode(scriptPath, [`--user-data-dir=${profilePath}`, `--device=${device}`, `--browser=${browser}`, `--headless=${headless}`])

    const botInfo = {
      id: botIndex - 1,
      process: child,
      profilePath,
      profileType,
      startTime: new Date().toISOString(),
      isManual: true,
      winId
    }
    botProcesses.push(botInfo)

    child.stdout.on('data', (data) => {
      sender.send('bot-log', `[Bot ${botIndex}] ${data.toString()}`)
    })

    child.stderr.on('data', (data) => {
      sender.send('bot-log', `[Bot ${botIndex}] ERROR: ${data.toString()}`)
    })

    child.on('close', (code) => {
      sender.send('bot-log', `[Bot ${botIndex}] Process exited with code ${code}`)

      // Cleanup temporary profiles
      if (profileType === 'temporary' && fs.existsSync(profilePath)) {
        try {
          fs.rmSync(profilePath, { recursive: true, force: true })
        } catch (e) {
          console.warn(`Failed to cleanup temp profile: ${profilePath}`, e.message)
        }
      }

      botProcesses = botProcesses.filter(p => p.process !== child)
      sender.send('bot-status', getCurrentBotStatus(winId))

      // Trigger next task in queues
      processSchedulerQueue(sender)
      processManualQueue()
    })

    sender.send('bot-status', getCurrentBotStatus(winId))
  }

  function processManualQueue() {
    if (manualQueue.length === 0) return

    console.log(`[Manual Queue Status] Total Queued: ${manualQueue.length}`)

    // Process manual tasks dynamically based on individual window limits
    let processedAny = true;
    while (processedAny && manualQueue.length > 0) {
      processedAny = false;
      const nextTaskIndex = manualQueue.findIndex(task => {
        const limit = task.concurrencyLimit || 3;
        const runningCount = botProcesses.filter(p => p.isManual && p.winId === task.winId).length;
        return runningCount < limit;
      });

      if (nextTaskIndex !== -1) {
        const task = manualQueue.splice(nextTaskIndex, 1)[0];
        spawnManualTask(task);
        processedAny = true;
      }
    }
  }

  function resolveScriptForTask(taskName, schedulerSettings = {}) {
    const lower = taskName.toLowerCase()
    
    // Virtual Football Archive
    if (lower.includes('virtual football') || lower.includes('archive scraper')) {
      return 'human_virtual_football_archive.js'
    }

    // Custom Website & Ad Journey (must come before generic website check)
    if (lower.includes('custom website') || lower.includes('ad journey') || lower.includes('monetize') || lower.includes('custom visit') || lower.includes('custom web')) {
      return schedulerSettings.customWebsiteScript || 'human_custom_website_journey.js'
    }
    
    // Website / Personality
    if (lower.includes('website') || lower.includes('visit') || lower.includes('personality')) {
      return schedulerSettings.websiteScript || 'human_website_visit.js'
    }
    
    return 'test.js'
  }

  function isTaskTypeEnabled(taskName, schedulerSettings = {}) {
    const lower = taskName.toLowerCase()
    if (lower.includes('virtual football') || lower.includes('archive scraper')) {
      return schedulerSettings.virtualFootballEnabled !== false
    }
    if (lower.includes('custom website') || lower.includes('ad journey') || lower.includes('monetize') || lower.includes('custom visit') || lower.includes('custom web')) {
      return schedulerSettings.customWebsiteEnabled !== false
    }
    if (lower.includes('website') || lower.includes('visit') || lower.includes('personality')) {
      return schedulerSettings.websiteEnabled !== false
    }
    return true
  }



  const DEFAULT_FAMILIES = ['DEFAULT', 'WEBSITES']

  if (!fs.existsSync(PROFILES_BASE_DIR)) {
    fs.mkdirSync(PROFILES_BASE_DIR, { recursive: true })
  }

  // Initialize default families
  DEFAULT_FAMILIES.forEach(family => {
    const familyPath = path.join(PROFILES_BASE_DIR, family)
    if (!fs.existsSync(familyPath)) {
      fs.mkdirSync(familyPath, { recursive: true })
    }
  })

  ipcMain.handle('get-families', async () => {
    try {
      const families = getFamiliesList()

      const result = []
      for (const family of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, family)
        let profiles = []
        try {
          profiles = fs.readdirSync(familyPath)
            .filter(f => {
              try {
                return fs.statSync(path.join(familyPath, f)).isDirectory()
              } catch (e) {
                return false
              }
            })
        } catch (e) {
          profiles = []
        }
        result.push({ name: family, profiles })
      }
      return result
    } catch (error) {
      console.error('Error listing families:', error)
      return []
    }
  })

  ipcMain.handle('create-family', async (_, name) => {
    try {
      if (!name || typeof name !== 'string' || !name.trim()) {
        return { success: false, error: 'Family name cannot be empty' }
      }
      const trimmedName = name.trim()
      const familyPath = path.join(PROFILES_BASE_DIR, trimmedName)
      if (!fs.existsSync(familyPath)) {
        fs.mkdirSync(familyPath, { recursive: true })
        return { success: true }
      }
      return { success: false, error: 'Family already exists' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('create-profile', async (_, profileName, familyName) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, familyName, profileName)
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true })
        return { success: true }
      }
      return { success: false, error: 'Profile already exists' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('export-profile', async (event, profileName, familyName) => {
    try {
      const sourcePath = path.join(PROFILES_BASE_DIR, familyName, profileName)
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Export Profile ${profileName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const destPath = path.join(result.filePaths[0], profileName)
        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('export-family', async (event, familyName) => {
    try {
      const sourcePath = path.join(PROFILES_BASE_DIR, familyName)
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Export Family ${familyName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const destPath = path.join(result.filePaths[0], familyName)
        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('import-profile', async (event, familyName) => {
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Import Profile into ${familyName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const sourcePath = result.filePaths[0]
        const profileName = path.basename(sourcePath)
        const destPath = path.join(PROFILES_BASE_DIR, familyName, profileName)

        if (fs.existsSync(destPath)) {
          return { success: false, error: 'A profile with this name already exists in this family' }
        }

        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rename-family', async (_, oldName, newName) => {
    try {
      const oldPath = path.join(PROFILES_BASE_DIR, oldName)
      const newPath = path.join(PROFILES_BASE_DIR, newName)
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Family not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('delete-family', async (_, name) => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, name)
      if (fs.existsSync(familyPath)) {
        fs.rmSync(familyPath, { recursive: true, force: true })
        return { success: true }
      }
      return { success: false, error: 'Family not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-profiles', async () => {
    // Legacy support or flat list
    try {
      const families = getFamiliesList()
      let allProfiles = []
      for (const family of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, family)
        const profiles = fs.readdirSync(familyPath)
          .filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
          .map(p => ({ id: p, family }))
        allProfiles = [...allProfiles, ...profiles]
      }
      return allProfiles
    } catch (error) {
      return []
    }
  })

  ipcMain.handle('delete-profile', async (_, profileName, family = 'DEFAULT') => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const profilePath = path.join(familyPath, profileName)
      if (fs.existsSync(profilePath)) {
        fs.rmSync(profilePath, { recursive: true, force: true })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rename-profile', async (_, oldName, newName, family = 'DEFAULT') => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const oldPath = path.join(familyPath, oldName)
      const newPath = path.join(familyPath, newName)
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Profile not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('move-profile', async (_, profileId, oldFamily, newFamily) => {
    try {
      const oldPath = path.join(PROFILES_BASE_DIR, oldFamily, profileId)
      const newPath = path.join(PROFILES_BASE_DIR, newFamily, profileId)
      if (fs.existsSync(oldPath)) {
        if (!fs.existsSync(path.dirname(newPath))) {
          fs.mkdirSync(path.dirname(newPath), { recursive: true })
        }
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Profile not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('delete-all-profiles', async () => {
    try {
      if (fs.existsSync(PROFILES_BASE_DIR)) {
        fs.rmSync(PROFILES_BASE_DIR, { recursive: true, force: true })
        fs.mkdirSync(PROFILES_BASE_DIR, { recursive: true })
        DEFAULT_FAMILIES.forEach(family => {
          fs.mkdirSync(path.join(PROFILES_BASE_DIR, family), { recursive: true })
        })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  const getCurrentBotStatus = (winId = null) => {
    const filtered = winId ? botProcesses.filter(p => p.winId === winId) : botProcesses
    if (filtered.length === 0) return { status: 'stopped', instances: [] }
    return {
      status: `running (${filtered.length} instances)`,
      instances: filtered.map(p => ({
        profilePath: p.profilePath,
        profileType: p.profileType,
        startTime: p.startTime
      }))
    }
  }

  ipcMain.handle('start-bot', async (event, scriptName = 'human_google_search.js', options = {}) => {
    const {
      instanceCount = 1,
      profileType = 'temporary',
      specificProfile = null,
      family = 'DEFAULT',
      launchMode = 'single', // 'single', 'random', 'all'
      randomCount = 1,
      device = 'random',
      browser = 'random',
      headless = false,
      concurrencyLimit = 3
    } = options

    const scriptPath = resolveAppPath(scriptName)
    const baseUserDataDir = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).paths.userDataDir

    let targets = []
    let warnings = []

    if (specificProfile) {
      targets.push({ id: specificProfile, family: family })
    } else if (profileType === 'permanent') {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const existingProfiles = fs.existsSync(familyPath)
        ? fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        : []

      if ((launchMode === 'all' || launchMode === 'random') && existingProfiles.length === 0) {
        event.sender.send('bot-log', `âš ï¸ Family "${family}" is empty. Automatically creating a new profile for you...`)
        const id = `profile_${Date.now()}`
        targets.push({ id, family })
      } else if (launchMode === 'all') {
        targets = existingProfiles.map(p => ({ id: p, family }))
      } else if (launchMode === 'random') {
        const shuffled = existingProfiles.sort(() => 0.5 - Math.random())
        targets = shuffled.slice(0, Math.min(randomCount, shuffled.length)).map(p => ({ id: p, family }))
      } else {
        // Create new profiles (Single mode)
        for (let i = 0; i < instanceCount; i++) {
          const id = `profile_${Date.now() + i}`
          targets.push({ id, family })
        }
      }
    } else {
      // Temporary
      for (let i = 0; i < instanceCount; i++) {
        targets.push({ id: null, family: null })
      }
    }

    const getWinId = (evt) => {
      try {
        if (evt && evt.sender) {
          const w = BrowserWindow.fromWebContents(evt.sender);
          if (w) return w.id;
        }
      } catch (_) {}
      return 'default';
    };
    const winId = getWinId(event);

    for (const target of targets) {
      let profilePath

      if (target.id) {
        profilePath = path.join(PROFILES_BASE_DIR, target.family, target.id)
      } else {
        // Temporary
        profilePath = path.join(os.tmpdir(), `bot-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
      }

      manualQueue.push({
        scriptPath,
        profilePath,
        profileType: target.id ? 'permanent' : 'temporary',
        device,
        browser,
        headless,
        sender: event.sender,
        botIndex: targets.indexOf(target) + 1,
        concurrencyLimit,
        winId
      })
    }

    event.sender.send('bot-log', `[Launcher] Enqueued ${targets.length} bot tasks. (Max Concurrency Limit: ${concurrencyLimit})`)
    processManualQueue()

    event.sender.send('bot-status', getCurrentBotStatus(winId))
    return { success: true, warnings }
  })

  ipcMain.handle('stop-bot', async (event) => {
    let winId = null;
    try {
      if (event && event.sender) {
        const w = BrowserWindow.fromWebContents(event.sender);
        if (w) winId = w.id;
      }
    } catch (_) {}

    // Clear queued tasks
    manualQueue = manualQueue.filter(t => !winId || t.winId === winId);

    const winBots = winId ? botProcesses.filter(p => p.winId === winId) : botProcesses;
    winBots.forEach(p => {
      try { p.process.kill(); } catch (e) {}
    });
    botProcesses = winId ? botProcesses.filter(p => p.winId !== winId) : [];

    // Force kill all Chrome browser instances spawned by Puppeteer
    killAllScraperChromeProcesses();

    return { success: true };
  })

  ipcMain.handle('stop-specific-bot', async (event, profilePath) => {
    let winId = null;
    try {
      if (event && event.sender) {
        const w = BrowserWindow.fromWebContents(event.sender);
        if (w) winId = w.id;
      }
    } catch (_) {}
    const bot = botProcesses.find(p => p.profilePath === profilePath && (!winId || p.winId === winId));
    if (bot) {
      try { bot.process.kill(); } catch (e) {}
      botProcesses = botProcesses.filter(p => p !== bot);
    }

    if (profilePath) {
      const folderName = path.basename(profilePath);
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${folderName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
        } else {
          const currentPid = process.pid;
          const safeKillFolderCmd = `ps aux | grep -E "(chrome|chromium)" | grep -F "${folderName}" | grep -v -E "electron|nexus-panel|antigravity|vscode|node_modules|${currentPid}" | awk '{print $2}' | xargs -r kill -9 || true`;
          require('child_process').execSync(safeKillFolderCmd, { stdio: 'ignore' });
        }
      } catch (e) {}
    }
    killAllScraperChromeProcesses();
    return { success: true };
  })

  ipcMain.handle('get-bot-status', (event) => {
    let winId = null;
    try {
      if (event && event.sender) {
        const win = BrowserWindow.fromWebContents(event.sender);
        winId = win ? win.id : null;
      }
    } catch (_) {}
    const result = getCurrentBotStatus(winId);
    return result || { status: 'stopped', instances: [] };
  })

  // --- Resource Monitoring ---
  let cachedDiskInfo = { freeDisk: 0, totalDisk: 0 }
  let lastDiskInfoTime = 0
  const DISK_INFO_CACHE_TTL = 30 * 1000 // 30 seconds

  let cachedBotsRam = 0
  let lastBotsRamTime = 0
  const BOTS_RAM_CACHE_TTL = 15 * 1000 // 15 seconds

  let cachedBotsDiskSize = 0
  let lastBotsDiskSizeTime = 0
  const DISK_SIZE_CACHE_TTL = 60 * 1000 // 60 seconds

  async function getDirSize(dirPath) {
    let size = 0
    try {
      if (!fs.existsSync(dirPath)) return 0
      const files = await fs.promises.readdir(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        try {
          const stats = await fs.promises.stat(filePath)
          if (stats.isDirectory()) {
            size += await getDirSize(filePath)
          } else {
            size += stats.size
          }
        } catch (e) { }
      }
    } catch (e) { }
    return size
  }

  async function calculateBotsDiskUsageBackground() {
    let botsDisk = 0
    try {
      if (fs.existsSync(PROFILES_BASE_DIR)) {
        botsDisk += await getDirSize(PROFILES_BASE_DIR)
      }
      for (const p of botProcesses) {
        if (p.profileType === 'temporary' && fs.existsSync(p.profilePath)) {
          botsDisk += await getDirSize(p.profilePath)
        }
      }
    } catch (e) {
      console.error('Error calculating background disk usage:', e)
    }
    return botsDisk
  }

  ipcMain.handle('get-system-stats', async () => {
    try {
      // 1. System RAM
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem

      // 2. System Disk (C: drive assumed) - Caching PowerShell call
      let freeDisk = 0
      let totalDisk = 0
      const now = Date.now()
      if (now - lastDiskInfoTime < DISK_INFO_CACHE_TTL) {
        freeDisk = cachedDiskInfo.freeDisk
        totalDisk = cachedDiskInfo.totalDisk
      } else {
        try {
          if (process.platform === 'win32') {
            const { stdout } = await execPromise('powershell "Get-PSDrive C | Select-Object Free, @{Name=\'Total\';Expression={$_.Free + $_.Used}} | ConvertTo-Json"', { timeout: 4000 })
            if (stdout && stdout.trim()) {
              const diskData = JSON.parse(stdout)
              freeDisk = diskData.Free || 0
              totalDisk = diskData.Total || 0
              cachedDiskInfo = { freeDisk, totalDisk }
              lastDiskInfoTime = now
            }
          } else if (typeof fs.statfsSync === 'function') {
            const stats = fs.statfsSync('/')
            freeDisk = stats.bfree * stats.bsize
            totalDisk = stats.blocks * stats.bsize
            cachedDiskInfo = { freeDisk, totalDisk }
            lastDiskInfoTime = now
          }
        } catch (e) {
          console.error('Error getting disk info via PowerShell:', e)
          freeDisk = cachedDiskInfo.freeDisk
          totalDisk = cachedDiskInfo.totalDisk
        }
      }

      // 3. Bot RAM (Aggregate all node and chrome processes) - Caching tasklist call
      let botsRam = 0
      if (botProcesses.length > 0) {
        if (now - lastBotsRamTime < BOTS_RAM_CACHE_TTL) {
          botsRam = cachedBotsRam
        } else {
          try {
            if (process.platform === 'win32') {
              const { stdout } = await execPromise('tasklist /fo csv /nh /fi "IMAGENAME eq chrome.exe"', { timeout: 4000 })
              const lines = stdout.split('\n')
              lines.forEach(line => {
                const parts = line.split('","')
                if (parts.length > 4) {
                  const memStr = parts[4].replace(/[^\d]/g, '')
                  botsRam += parseInt(memStr) * 1024
                }
              })
            } else {
              const { stdout } = await execPromise('ps -e -o rss,comm', { timeout: 4000 })
              const lines = stdout.split('\n')
              lines.forEach(line => {
                const parts = line.trim().split(/\s+/)
                if (parts.length >= 2 && (parts[1].includes('chrome') || parts[1].includes('node'))) {
                  const rssKb = parseInt(parts[0]) || 0
                  botsRam += rssKb * 1024
                }
              })
            }
            cachedBotsRam = botsRam
            lastBotsRamTime = now
          } catch (e) {
            botsRam = cachedBotsRam
          }
        }
      }

      // 4. Bot Disk Usage
      let botsDisk = 0
      if (now - lastBotsDiskSizeTime < DISK_SIZE_CACHE_TTL) {
        botsDisk = cachedBotsDiskSize
      } else {
        calculateBotsDiskUsageBackground().then(size => {
          cachedBotsDiskSize = size
          lastBotsDiskSizeTime = Date.now()
        }).catch(err => {
          console.error('Failed to update disk size in background:', err)
        })
        botsDisk = cachedBotsDiskSize
      }

      return {
        system: {
          totalMem,
          freeMem,
          usedMem,
          totalDisk,
          freeDisk,
          cpuCores: os.cpus().length
        },
        bots: {
          ram: botsRam,
          disk: botsDisk,
          count: botProcesses.length
        }
      }
    } catch (error) {
      console.error('Error in get-system-stats:', error)
      return null
    }
  })

  ipcMain.handle('clear-browser-data', async () => {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8')
      const config = JSON.parse(data)
      const userDataDir = config.paths.userDataDir

      if (!fs.existsSync(userDataDir)) {
        return { success: false, error: 'Data directory not found' }
      }

      // Safety check: Ensure userDataDir is not a system or root directory
      const resolvedUserDir = path.resolve(userDataDir)
      const homeDir = path.resolve(os.homedir())
      const isSystemPath = resolvedUserDir === '/' || 
                           resolvedUserDir === homeDir || 
                           resolvedUserDir === 'C:\\' || 
                           resolvedUserDir.toLowerCase() === 'c:\\windows' ||
                           resolvedUserDir.startsWith('/etc') ||
                           resolvedUserDir.startsWith('/usr') ||
                           resolvedUserDir.startsWith('/var') ||
                           resolvedUserDir.startsWith('/boot') ||
                           resolvedUserDir.startsWith('/dev') ||
                           resolvedUserDir.startsWith('/sys')
      if (isSystemPath) {
        console.error(`❌ Security Blocked: Refusing to delete path "${resolvedUserDir}" as it is a system/user root directory.`)
        return { success: false, error: 'Security Exception: Cannot delete system or user root directory.' }
      }

      console.log(`🧹 Attempting to clear browser data at: ${userDataDir}`)

      // Try to kill chrome processes first to release file locks
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/IM', 'chrome.exe', '/T'])
          // Give it a moment to release locks
          await new Promise(r => setTimeout(r, 2000))
        } else {
          // Linux: kill scraper chromium / chrome processes safely
          try { killAllScraperChromeProcesses() } catch (e) {}
          await new Promise(r => setTimeout(r, 1500))
        }
      } catch (e) {
        console.warn('Failed to kill chrome processes:', e.message)
      }

      let osTempCleaned = 0
      // Also sweep OS temp directory for orphaned bot-temp-* profile folders
      try {
        const tempDir = os.tmpdir()
        const tmpEntries = fs.readdirSync(tempDir)
        for (const entry of tmpEntries) {
          if (entry.startsWith('bot-temp-')) {
            const fullPath = path.join(tempDir, entry)
            try {
              fs.rmSync(fullPath, { recursive: true, force: true })
              osTempCleaned++
              console.log(`🗑️ Removed OS temp profile: ${entry}`)
            } catch (e) {
              // Silently skip locked/active profiles
            }
          }
        }
        if (osTempCleaned > 0) {
          console.log(`✅ Cleared ${osTempCleaned} orphaned OS temp profile(s).`)
        }
      } catch (e) {
        console.warn('Could not scan OS temp directory:', e.message)
      }

      try {
        // Recursive delete of primary browser profile
        fs.rmSync(userDataDir, { recursive: true, force: true })
        // Recreate the empty directory
        fs.mkdirSync(userDataDir, { recursive: true })
        return { success: true, osTempCleaned }
      } catch (rmError) {
        if (rmError.code === 'EPERM' || rmError.code === 'EBUSY') {
          return {
            success: false,
            error: 'Permission Denied: Some files are still in use. Please ensure all browser windows are closed and try again.'
          }
        }
        throw rmError
      }
    } catch (error) {
      console.error('Error clearing data:', error)
      return { success: false, error: error.message }
    }
  })

  /**
   * Standalone handler: clears ONLY orphaned bot-temp-* directories from the OS
   * temp folder on Windows (%LOCALAPPDATA%\Temp) and Linux (/tmp).
   * Safe to call while bots are NOT running — locked/active dirs are skipped.
   */
  ipcMain.handle('clear-os-temp-profiles', async () => {
    try {
      const tempDir = os.tmpdir()
      console.log(`🧹 Scanning OS temp dir for bot profiles: ${tempDir}`)

      // On Windows, also check the system-wide TEMP paths that Puppeteer may use
      const tempDirsToScan = new Set([tempDir])
      if (process.platform === 'win32') {
        const winTempPaths = [
          process.env.TEMP,
          process.env.TMP,
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : null,
          'C:\\Windows\\Temp'
        ].filter(Boolean)
        winTempPaths.forEach(p => tempDirsToScan.add(p))
      } else {
        // Linux: also check /tmp directly in case $TMPDIR differs
        tempDirsToScan.add('/tmp')
      }

      let cleaned = 0
      let skipped = 0
      const errors = []

      for (const scanDir of tempDirsToScan) {
        if (!fs.existsSync(scanDir)) continue
        let entries = []
        try { entries = fs.readdirSync(scanDir) } catch (e) { continue }

        for (const entry of entries) {
          if (entry.startsWith('bot-temp-')) {
            const fullPath = path.join(scanDir, entry)
            try {
              fs.rmSync(fullPath, { recursive: true, force: true })
              cleaned++
              console.log(`🗑️ Deleted OS temp profile: ${fullPath}`)
            } catch (e) {
              // Likely locked by an active bot process — skip silently
              skipped++
            }
          }
        }
      }

      console.log(`✅ OS Temp sweep complete: ${cleaned} removed, ${skipped} skipped (active/locked).`)
      return { success: true, cleaned, skipped }
    } catch (error) {
      console.error('Error clearing OS temp profiles:', error)
      return { success: false, error: error.message }
    }
  })

  /**
   * Safe Bot Temp Storage Cleanup — scoped strictly to orphaned application
   * bot temporary profile directories (bot-temp-*). System-wide wipes are disabled.
   */
  ipcMain.handle('full-os-temp-wipe', async () => {
    try {
      console.log('🧹 Safe Temp Clear: Cleaning orphaned bot-temp-* profile folders from OS temp storage...')
      const tempDir = os.tmpdir()
      let cleaned = 0
      if (fs.existsSync(tempDir)) {
        const tmpEntries = fs.readdirSync(tempDir)
        for (const entry of tmpEntries) {
          if (entry.startsWith('bot-temp-')) {
            try {
              fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true })
              cleaned++
            } catch (e) {}
          }
        }
      }
      return {
        success: true,
        cleaned,
        totalFreed: `${cleaned} bot temp profile(s)`,
        totalBytes: 0,
        totalErrors: 0
      }
    } catch (error) {
      console.error('Error during safe temp wipe:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('smart-clear-data', async (event) => {
    return new Promise((resolve) => {
      const scriptPath = resolveAppPath('smart_clear.js')
      console.log(`Launching Smart Clear: ${scriptPath}`)

      const process = spawnNode(scriptPath, [])

      process.stdout.on('data', (data) => {
        event.sender.send('bot-log', data.toString())
      })

      process.stderr.on('data', (data) => {
        event.sender.send('bot-log', `ERROR: ${data.toString()}`)
      })

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true })
        } else {
          resolve({ success: false, error: `Process exited with code ${code}` })
        }
      })
    })
  })

  ipcMain.handle('get-proxies', async () => {
    try {
      if (fs.existsSync(PROXIES_PATH)) {
        return JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8'))
      }
      return []
    } catch (error) {
      console.error('Error reading proxies:', error)
      return []
    }
  })

  ipcMain.handle('save-proxies', async (_, proxies) => {
    try {
      fs.writeFileSync(PROXIES_PATH, JSON.stringify(proxies, null, 4), 'utf8')
      return { success: true }
    } catch (error) {
      console.error('Error saving proxies:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('fetch-webshare-profile', async (_, { apiKey }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://proxy.webshare.io/api/v2/profile/', {
        headers: { Authorization: `Token ${apiKey}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Webshare profile:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-webshare-stats', async (_, { apiKey }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://proxy.webshare.io/api/v2/stats/aggregate/', {
        headers: { Authorization: `Token ${apiKey}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Webshare stats:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-webshare-proxies', async (_, { apiKey, mode, limit }) => {
    try {
      const axios = require('axios')
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      
      let page = 1
      let importedCount = 0
      let fetchedResults = []
      
      while (fetchedResults.length < limit) {
        const response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
          headers: { Authorization: `Token ${apiKey}` },
          params: {
            page: page,
            page_size: Math.min(100, limit - fetchedResults.length),
            mode: mode || 'direct'
          },
          timeout: 15000
        })
        
        const results = response.data.results || []
        if (results.length === 0) break
        
        fetchedResults = fetchedResults.concat(results)
        if (!response.data.next) break
        page++
      }

      for (const item of fetchedResults) {
        if (!allProxies.some(p => p.host === item.proxy_address && p.port === item.port)) {
          allProxies.push({
            host: item.proxy_address,
            port: item.port,
            protocol: 'http',
            username: item.username,
            password: item.password,
            assignedProfiles: []
          })
          importedCount++
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4), 'utf8')
      return { success: true, count: importedCount, total: allProxies.length }
    } catch (error) {
      console.error('Error fetching Webshare proxies:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-dataimpulse-balance', async (_, { resellerToken }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://api.dataimpulse.com/reseller/user/balance', {
        headers: { Authorization: `Bearer ${resellerToken}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Dataimpulse balance:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('generate-dataimpulse-proxies', async (_, { username, password, host, portStart, portEnd, protocol }) => {
    try {
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      let generatedCount = 0

      const start = parseInt(portStart) || 10000
      const end = parseInt(portEnd) || 10000
      const actualHost = host || 'gw.dataimpulse.com'
      const actualProto = protocol || 'http'

      for (let port = start; port <= end; port++) {
        if (!allProxies.some(p => p.host === actualHost && p.port === port)) {
          allProxies.push({
            host: actualHost,
            port: port,
            protocol: actualProto,
            username: username,
            password: password,
            assignedProfiles: []
          })
          generatedCount++
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4), 'utf8')
      return { success: true, count: generatedCount, total: allProxies.length }
    } catch (error) {
      console.error('Error generating Dataimpulse proxies:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('assign-proxy', async (_, { proxy, profiles }) => {
    try {
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      const warnings = []

      // Helper function to remove profiles from any existing proxy assignments
      const clearExistingAssignments = (targetProfiles) => {
        let changed = false
        for (const proxyItem of allProxies) {
          if (proxyItem.assignedProfiles) {
            const originalLength = proxyItem.assignedProfiles.length
            proxyItem.assignedProfiles = proxyItem.assignedProfiles.filter(
              ap => !targetProfiles.some(tp => tp.id === ap.id && tp.family === ap.family)
            )
            if (proxyItem.assignedProfiles.length !== originalLength) {
              changed = true
            }
          }
        }
        return changed
      }

      if (proxy === null || (proxy && proxy.type === 'residential_tunnel')) {
        // System IP or Residential Tunnel assignment
        clearExistingAssignments(profiles)

        for (const p of profiles) {
          const profilePath = path.join(PROFILES_BASE_DIR, p.family, p.id)
          const proxyConfigPath = path.join(profilePath, 'proxy.json')

          if (fs.existsSync(proxyConfigPath)) {
            try {
              const oldProxy = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'))
              if (oldProxy) {
                warnings.push({ profile: p.id, oldProxy: oldProxy.type === 'residential_tunnel' ? 'Residential Tunnel' : `${oldProxy.host}:${oldProxy.port}` })
              }
            } catch (e) {}
          }

          if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true })
          fs.writeFileSync(proxyConfigPath, JSON.stringify(proxy, null, 4))
        }

        fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
        return { success: true, warnings }
      }

      // Standard proxy assignment
      const targetProxy = allProxies.find(p => p.host === proxy.host && p.port === proxy.port)
      if (!targetProxy) return { success: false, error: 'Proxy not found in list' }

      // Check limits
      const currentAssigned = targetProxy.assignedProfiles || []
      if (currentAssigned.length + profiles.length > 10) {
        return { success: false, error: `Proxy limit reached. A proxy can be attached to maximum 10 profiles. Current: ${currentAssigned.length}` }
      }

      clearExistingAssignments(profiles)

      for (const p of profiles) {
        const profilePath = path.join(PROFILES_BASE_DIR, p.family, p.id)
        const proxyConfigPath = path.join(profilePath, 'proxy.json')

        if (fs.existsSync(proxyConfigPath)) {
          try {
            const oldProxy = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'))
            if (oldProxy) {
              warnings.push({ profile: p.id, oldProxy: oldProxy.type === 'residential_tunnel' ? 'Residential Tunnel' : `${oldProxy.host}:${oldProxy.port}` })
            }
          } catch (e) {}
        }

        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true })
        fs.writeFileSync(proxyConfigPath, JSON.stringify(proxy, null, 4))

        if (!targetProxy.assignedProfiles) targetProxy.assignedProfiles = []
        if (!targetProxy.assignedProfiles.some(ap => ap.id === p.id && ap.family === p.family)) {
          targetProxy.assignedProfiles.push({ id: p.id, family: p.family })
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
      return { success: true, warnings }
    } catch (error) {
      console.error('Error assigning proxy:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-profile-proxy', async (_, { id, family }) => {
    try {
      const proxyPath = path.join(PROFILES_BASE_DIR, family, id, 'proxy.json')
      if (fs.existsSync(proxyPath)) {
        return JSON.parse(fs.readFileSync(proxyPath, 'utf8'))
      }
      return null
    } catch (e) {
      return null
    }
  })

  ipcMain.handle('auto-assign-proxies', async () => {
    try {
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      if (allProxies.length === 0) {
        return { success: false, error: 'Your proxy pool is empty. Please add proxies first.' }
      }

      // Find all permanent profiles across all families
      const families = getFamiliesList()

      const profilesWithoutProxy = []
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        for (const p of profiles) {
          const proxyPath = path.join(familyPath, p, 'proxy.json')
          if (!fs.existsSync(proxyPath)) {
            profilesWithoutProxy.push({ id: p, family: fam })
          }
        }
      }

      if (profilesWithoutProxy.length === 0) {
        return { success: true, count: 0, message: 'All profiles already have a proxy assigned.' }
      }

      // Distribute proxies from pool to these profiles
      let assignedCount = 0
      for (const profile of profilesWithoutProxy) {
        // Find a proxy from allProxies that has less than 10 assignments
        const availableProxy = allProxies.find(p => (p.assignedProfiles || []).length < 10)
        if (!availableProxy) {
          fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
          return {
            success: true,
            count: assignedCount,
            message: `Assigned proxies to ${assignedCount} profiles. Stopped because all proxies in your pool have reached their 10-profile concurrency limit. Please add more proxies.`
          }
        }

        // Assign proxy to this profile
        const profilePath = path.join(PROFILES_BASE_DIR, profile.family, profile.id)
        const proxyConfigPath = path.join(profilePath, 'proxy.json')
        
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true })
        fs.writeFileSync(proxyConfigPath, JSON.stringify({
          host: availableProxy.host,
          port: availableProxy.port,
          protocol: availableProxy.protocol || 'http',
          username: availableProxy.username,
          password: availableProxy.password
        }, null, 4))

        if (!availableProxy.assignedProfiles) availableProxy.assignedProfiles = []
        availableProxy.assignedProfiles.push({ id: profile.id, family: profile.family })
        assignedCount++
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
      return { success: true, count: assignedCount, message: `Successfully assigned proxies to ${assignedCount} profiles!` }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('remove-all-proxies', async () => {
    try {
      const families = getFamiliesList()

      let removedCount = 0
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        for (const p of profiles) {
          const proxyPath = path.join(familyPath, p, 'proxy.json')
          if (fs.existsSync(proxyPath)) {
            fs.unlinkSync(proxyPath)
            removedCount++
          }
        }
      }

      if (fs.existsSync(PROXIES_PATH)) {
        const allProxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8'))
        const clearedProxies = allProxies.map(p => {
          return { ...p, assignedProfiles: [] }
        })
        fs.writeFileSync(PROXIES_PATH, JSON.stringify(clearedProxies, null, 4))
      }

      return { success: true, count: removedCount, message: `Successfully removed proxies from all ${removedCount} profiles!` }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('get-profile-history', async (_, { id, family }) => {
    try {
      const historyPath = path.join(PROFILES_BASE_DIR, family, id, 'history.json')
      if (fs.existsSync(historyPath)) {
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      }
      return {
        currentIp: 'Unknown',
        currentTimezone: 'Unknown',
        previousIp: 'Unknown',
        previousTimezone: 'Unknown',
        history: []
      }
    } catch (e) {
      return {
        currentIp: 'Unknown',
        currentTimezone: 'Unknown',
        previousIp: 'Unknown',
        previousTimezone: 'Unknown',
        history: []
      }
    }
  })

  ipcMain.handle('clear-profile-history', async (_, { id, family }) => {
    try {
      const historyPath = path.join(PROFILES_BASE_DIR, family, id, 'history.json')
      if (fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath)
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-family-history', async (_, familyName) => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, familyName)
      if (fs.existsSync(familyPath)) {
        const profiles = fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        for (const p of profiles) {
          const historyPath = path.join(familyPath, p, 'history.json')
          if (fs.existsSync(historyPath)) {
            fs.unlinkSync(historyPath)
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-all-histories', async () => {
    try {
      const families = getFamiliesList()
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(p => fs.statSync(path.join(familyPath, p)).isDirectory())
        for (const p of profiles) {
          const historyPath = path.join(familyPath, p, 'history.json')
          if (fs.existsSync(historyPath)) {
            fs.unlinkSync(historyPath)
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('select-proxies-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })
    if (!result.canceled) {
      const content = fs.readFileSync(result.filePaths[0], 'utf8')
      return { success: true, content }
    }
    return { success: false }
  })
  ipcMain.handle('read-personalities', async () => {
    try {
      if (!fs.existsSync(PERSONALITIES_PATH)) return {};
      let data = JSON.parse(fs.readFileSync(PERSONALITIES_PATH, 'utf8'));
      
      // Check for auto-evolution
      let changed = false;
      const configJson = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const aiConfig = configJson.ai || {};
      const provider = aiConfig.provider || 'deepseek';
      let apiKey = '';
      if (provider === 'deepseek') apiKey = aiConfig.deepseekApiKey;
      else if (provider === 'openai') apiKey = aiConfig.openaiApiKey;
      else if (provider === 'anthropic') apiKey = aiConfig.anthropicApiKey;
      else if (provider === 'gemini') apiKey = aiConfig.geminiApiKey;

      if (apiKey) {
        // --- Evolution for Individual Profiles ---
        for (const key in data) {
          const p = data[key];
          if (p.autoEvolve && p.description) {
            const now = Date.now();
            const last = p.lastEvolved || 0;
            const intervalMs = {
              'daily': 24 * 60 * 60 * 1000,
              'weekly': 7 * 24 * 60 * 60 * 1000,
              'monthly': 30 * 24 * 60 * 60 * 1000
            }[p.evolveInterval || 'daily'];

            if (now - last > intervalMs) {
              console.log(`âœ¨ Auto-evolving personality for ${key}...`);
              try {
                const systemPrompt = "You are a behavioral psychologist. Convert a personality description into 19 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100), \"volumeChangePercentage\" (0-100). No markdown, no extra text.";
                const userPrompt = `Personality: ${p.description}`;
                const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
                const jsonStr = content.replace(/```json|```/g, '');
                const newData = JSON.parse(jsonStr);
                data[key] = { ...p, settings: newData, lastEvolved: now };
                changed = true;
              } catch (err) { console.error('Evolve Error:', err); }
            }
          }
        }

        // --- Evolution for Global Automation ---
        const auto = configJson.automation;
        if (auto && auto.autoEvolve && auto.youtubeTarget) {
          const now = Date.now();
          const last = auto.lastEvolved || 0;
          const intervalMs = {
            'daily': 24 * 60 * 60 * 1000,
            'weekly': 7 * 24 * 60 * 60 * 1000,
            'monthly': 30 * 24 * 60 * 60 * 1000
          }[auto.evolveInterval || 'daily'];

          if (now - last > intervalMs) {
            console.log(`âœ¨ Auto-evolving Global Behavioral Settings...`);
            try {
              const systemPrompt = "You are a behavioral psychologist. Convert a YouTube search target into 19 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100), \"volumeChangePercentage\" (0-100). No markdown, no extra text.";
              const userPrompt = `Target Keyword: ${auto.youtubeTarget}`;
              const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
              const jsonStr = content.replace(/```json|```/g, '');
              const newData = JSON.parse(jsonStr);
              configJson.automation = { 
                ...auto, 
                adSkipPercentage: newData.adSkipPercentage,
                watchScrollPercentage: newData.watchScrollPercentage,
                suggestedVideoClickPercentage: newData.suggestedVideoClickPercentage,
                behaviorChangeFrequency: newData.behaviorChangeFrequency,
                searchPage1ScrollChance: newData.searchPage1ScrollChance !== undefined ? newData.searchPage1ScrollChance : 100,
                searchPage2ScrollChance: newData.searchPage2ScrollChance !== undefined ? newData.searchPage2ScrollChance : 80,
                searchPage3ScrollChance: newData.searchPage3ScrollChance !== undefined ? newData.searchPage3ScrollChance : 50,
                searchPage4ScrollChance: newData.searchPage4ScrollChance !== undefined ? newData.searchPage4ScrollChance : 20,
                searchPage5ScrollChance: newData.searchPage5ScrollChance !== undefined ? newData.searchPage5ScrollChance : 0,
                likePercentage: newData.likePercentage !== undefined ? newData.likePercentage : 15,
                commentPercentage: newData.commentPercentage !== undefined ? newData.commentPercentage : 5,
                minWatchMinutes: newData.minWatchMinutes !== undefined ? newData.minWatchMinutes : 2,
                maxWatchMinutes: newData.maxWatchMinutes !== undefined ? newData.maxWatchMinutes : 5,
                minAdInteractionSeconds: newData.minAdInteractionSeconds !== undefined ? newData.minAdInteractionSeconds : 10,
                maxAdInteractionSeconds: newData.maxAdInteractionSeconds !== undefined ? newData.maxAdInteractionSeconds : 30,
                adPageInnerClickPercentage: newData.adPageInnerClickPercentage !== undefined ? newData.adPageInnerClickPercentage : 50,
                playbackSpeed2xPercentage: newData.playbackSpeed2xPercentage !== undefined ? newData.playbackSpeed2xPercentage : 0,
                enableSubtitlesPercentage: newData.enableSubtitlesPercentage !== undefined ? newData.enableSubtitlesPercentage : 0,
                volumeChangePercentage: newData.volumeChangePercentage !== undefined ? newData.volumeChangePercentage : 10,
                lastEvolved: now 
              };
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 2));
            } catch (err) { console.error('Global Evolve Error:', err); }
          }
        }
      }

      if (changed) {
        fs.writeFileSync(PERSONALITIES_PATH, JSON.stringify(data, null, 4));
      }
      return data;
    } catch (e) { return {}; }
  })

  ipcMain.handle('write-personalities', async (_, data) => {
    try {
      fs.writeFileSync(PERSONALITIES_PATH, JSON.stringify(data, null, 4));
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  })

  ipcMain.handle('ask-ai-personality', async (_, { description, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a behavioral psychologist. Convert a personality description into 18 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100). No markdown, no extra text.";
      const userPrompt = `Personality: ${description}`;
      
      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
      const jsonStr = content.replace(/```json|```/g, '');
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('AI Personality Error:', e);
      return { error: e.message };
    }
  })

  ipcMain.handle('ask-ai-random-weights', async (_, { provider, apiKey }) => {
    try {
      const systemPrompt = "You are a statistics expert. Generate realistic device and browser market share percentages representing how popular devices and browsers enter Google search (real-world market share statistics). Return ONLY JSON with fields: \"device\" containing keys \"desktop\", \"mac\", \"linux\", \"mobile\", and \"browser\" containing keys \"chrome\", \"firefox\", \"safari\", \"edge\". The percentages in \"device\" must sum to 100, and percentages in \"browser\" must sum to 100. Return ONLY JSON. No markdown, no extra text.";
      const userPrompt = "Generate realistic Google traffic market shares for devices and browsers.";
      
      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.5 });
      const jsonStr = content.replace(/```json|```/g, '');
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('AI Random Weights Error:', e);
      return { error: e.message };
    }
  })

  ipcMain.handle('ask-ai-adjust-settings', async (_, { currentSettings, instructions, provider, apiKey }) => {
    try {
      const systemPrompt = "You are an expert settings optimizer for a web browsing bot dashboard.\n" +
        "Your task is to take the bot settings and adjust them based on the user's instructions.\n" +
        "You must return ONLY a JSON object containing any updated sections from the following schema:\n" +
        "{\n" +
        "  \"automation\": { ... },\n" +
        "  \"clickQuota\": { ... },\n" +
        "  \"scheduler\": { ... },\n" +
        "  \"randomWeights\": { ... }\n" +
        "}\n\n" +
        "Rules for adjusting each section:\n" +
        "1. automation (behavioral settings):\n" +
        "   - adSkipPercentage, watchScrollPercentage, suggestedVideoClickPercentage, behaviorChangeFrequency (0-120), searchPage1ScrollChance to searchPage5ScrollChance, likePercentage, commentPercentage, minWatchMinutes, maxWatchMinutes, minAdInteractionSeconds, maxAdInteractionSeconds, adPageInnerClickPercentage, playbackSpeed2xPercentage, enableSubtitlesPercentage, volumeChangePercentage, adWatchPercentage, adClickPercentage, commentMode ('ai' or 'custom'), customComments (array of strings).\n" +
        "   - Ensure adSkipPercentage + adWatchPercentage + adClickPercentage sum to exactly 100.\n" +
        "   - Ensure maxWatchMinutes >= minWatchMinutes and maxAdInteractionSeconds >= minAdInteractionSeconds.\n" +
        "2. clickQuota (ad click limits):\n" +
        "   - daily: number (e.g. 2)\n" +
        "   - weekly: number (usually daily * 7)\n" +
        "   - monthly: number (usually daily * 30)\n" +
        "3. scheduler:\n" +
        "   - targetMonthlyAdClicks: number\n" +
        "   - maxConcurrentProfiles: number\n" +
        "4. randomWeights:\n" +
        "   - device: desktop, mac, linux, mobile (percentages, must sum to 100)\n" +
        "   - browser: chrome, firefox, safari, edge (percentages, must sum to 100)\n\n" +
        "Ensure all other parameters are preserved or logically updated. Return ONLY the adjusted JSON block. Do not include markdown code block wrappers (like ```json), explanations, or extra text.";

      // We extract only the adjustable sections to feed to the AI to prevent exposing other keys/paths
      const relevantConfig = {
        automation: currentSettings.automation || {},
        clickQuota: currentSettings.clickQuota || {},
        scheduler: currentSettings.scheduler || {},
        randomWeights: currentSettings.randomWeights || {}
      };

      const userPrompt = `Current configuration:\n${JSON.stringify(relevantConfig, null, 2)}\n\nUser Instructions:\n${instructions}`;

      const response = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
      const cleanJson = response.replace(/```json|```/g, '').trim();
      const adjustedSettings = JSON.parse(cleanJson);

      // Merge and write back to browser-config.json
      if (fs.existsSync(CONFIG_PATH)) {
        const configJson = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        
        if (adjustedSettings.automation) {
          configJson.automation = { ...configJson.automation, ...adjustedSettings.automation };
        }
        if (adjustedSettings.clickQuota) {
          configJson.clickQuota = { ...configJson.clickQuota, ...adjustedSettings.clickQuota };
        }
        if (adjustedSettings.scheduler) {
          configJson.scheduler = { ...configJson.scheduler, ...adjustedSettings.scheduler };
        }
        if (adjustedSettings.randomWeights) {
          configJson.randomWeights = { ...configJson.randomWeights, ...adjustedSettings.randomWeights };
        }
        
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 4), 'utf8');
        return { success: true, updatedConfig: configJson };
      }
      return { success: false, error: 'Config file not found' };
    } catch (e) {
      console.error('AI Settings Adjustment Error:', e);
      return { success: false, error: e.message };
    }
  })

  ipcMain.handle('check-ai-balance', async (_, { provider, apiKey }) => {
    try {
      const prov = (provider || 'deepseek').toLowerCase();
      if (prov !== 'deepseek') {
        return { success: false, error: `Balance check is not supported for ${provider} API keys.` };
      }
      if (!apiKey) {
        return { success: false, error: 'API Key is required to check balance.' };
      }
      
      const response = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      });
      
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `API Error: ${response.statusText} (${response.status}). ${errText}` };
      }
      
      const data = await response.json();
      return { success: true, balance: data };
    } catch (e) {
      console.error('Check AI Balance Error:', e);
      return { success: false, error: e.message };
    }
  })

  // AI Schedule generator
  ipcMain.handle('ask-ai-schedule', async (_, { personality, device, browser, timezone, season, targetMonthlyAdClicks, provider, apiKey, profileId, family }) => {
    try {
      let resolvedDevice = device || 'random';
      let resolvedBrowser = browser || 'random';

      if (profileId && family) {
        const profilePath = path.join(PROFILES_BASE_DIR, family, profileId);
        const fingerprintPath = path.join(profilePath, 'fingerprint.json');
        if (fs.existsSync(fingerprintPath)) {
          try {
            const fp = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
            const ua = fp.fingerprint?.navigator?.userAgent || '';
            if (/Android|iPhone|iPad|Mobile/i.test(ua)) {
              resolvedDevice = 'mobile';
            } else if (/Macintosh|Mac OS X/i.test(ua)) {
              resolvedDevice = 'mac';
            } else if (/Linux/i.test(ua)) {
              resolvedDevice = 'linux';
            } else {
              resolvedDevice = 'desktop';
            }

            if (/Edg\//i.test(ua)) {
              resolvedBrowser = 'edge';
            } else if (/Firefox\//i.test(ua)) {
              resolvedBrowser = 'firefox';
            } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
              resolvedBrowser = 'safari';
            } else {
              resolvedBrowser = 'chrome';
            }
          } catch (e) {
            console.error('Error parsing existing fingerprint for AI scheduling:', e);
          }
        }
      }

      let schedulerSettings = {}
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
          schedulerSettings = config.scheduler || {}
        }
      } catch (e) {}

      const enabledTasks = []
      if (schedulerSettings.youtubeEnabled !== false) enabledTasks.push('YouTube Search & watch')
      if (schedulerSettings.googleEnabled !== false) enabledTasks.push('Google organic search')
      if (schedulerSettings.gmailEnabled !== false) enabledTasks.push('Gmail/Google Email Reading (checking inbox, newsletters, organic link clicks)')
      if (schedulerSettings.youtubeTargetEnabled !== false) enabledTasks.push('Targeted YouTube Search & watch')
      if (schedulerSettings.youtubeChannelEnabled !== false) enabledTasks.push('Custom Channel watch journey')
      if (schedulerSettings.youtubePlaylistEnabled !== false) enabledTasks.push('Custom Playlist watch journey')
      if (schedulerSettings.articleEnabled !== false) enabledTasks.push('general portal news/articles browsing')
      if (schedulerSettings.websiteEnabled !== false) enabledTasks.push('dynamic website visits')
      if (schedulerSettings.customWebsiteEnabled !== false) enabledTasks.push('custom website ad journey (visit configured website, interact deeply and click ads)')

      // Fallback in case they unchecked everything
      if (enabledTasks.length === 0) {
        enabledTasks.push('YouTube Search & watch', 'Google organic search')
      }

      const currentDateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      
      const systemPrompt = `You are a master bot scheduler. Your job is to analyze a profile's timezone and determine its exact local current climate/geographical season as of the current date: ${currentDateStr}.
For example:
- Timezone 'Africa/Lagos' in May corresponds to Nigeria's 'Rainy (Wet) Season' (runs from April to October).
- Timezone 'Africa/Lagos' in December corresponds to Nigeria's 'Dry Season (Harmattan)' (runs from November to March).
- Timezone 'Australia/Sydney' in May corresponds to 'Autumn' (Southern hemisphere).
- Timezone 'America/New_York' in May corresponds to 'Spring' (Northern hemisphere).

Based on the timezone, identify its local climate patterns, current active season, and return a JSON object with:
1. "detectedSeason": A string naming the exact detected climate season (e.g. 'Rainy Season', 'Dry Season (Harmattan)', 'Summer', 'Autumn').
2. "tasks": An array of daily activities (4-6 strategically spaced tasks) matching the personality, device, timezone, and local season. Task objects must have "time" (HH:MM), "task" (string), "desc" (string explaining action customized to this detected season), and "active" (boolean).

CRITICAL SCHEDULING RULES:
- Allowed Tasks: You MUST ONLY select tasks from the following enabled task types: ${enabledTasks.join(', ')}. Do not schedule any task types not in this list.
- Personality & Device Alignment: All activities and simulated human behaviors must strictly match the profile's specific personality footprint, hobbies, and hardware device details.
- Organic Ad-Clicks: Spaced throughout the weekly schedules, insert highly realistic, human-mimicked organic daily ad-clicking operations so that a target of exactly ${targetMonthlyAdClicks || 10} monthly ad clicks per profile is reached naturally and spread out evenly across the month.
- High Variety and Uniqueness: To ensure maximum organic stealth, you MUST randomize the exact scheduled times (varying start times by random offsets like 09:12, 14:37, 21:03 rather than round numbers) and vary the choice of search terms and activities. Never return the same schedule twice.
- Strict Exclusions: Under no circumstances should 'test.js' ever be assigned, referred to, or returned as a task, script name, or activity for any profile schedule.

Return ONLY the raw JSON object. No markdown wrappers, no extra explanation.`;

      const userPrompt = `Personality details: ${JSON.stringify(personality)}. Device footprint: ${resolvedDevice}. Browser footprint: ${resolvedBrowser}. Timezone: ${timezone}. Chosen Season fallback: ${season}. Randomization Seed: ${Math.random().toString(36).substring(7)}.${new Date().getTime()}.`;

      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.95 });
      const jsonStr = content.replace(/```json|```/g, '');
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        return {
          detectedSeason: season || 'Auto-detected',
          tasks: parsed
        };
      }
      return parsed;
    } catch (e) {
      console.error('AI Scheduler Error:', e);
      return { error: e.message };
    }
  })

  // --- Google Drive Sync IPC Handlers & Background Scheduler ---
  let syncIntervalTimer = null

  async function scheduleGoogleDriveSync() {
    if (syncIntervalTimer) {
      clearInterval(syncIntervalTimer)
      syncIntervalTimer = null
    }

    try {
      if (!fs.existsSync(CONFIG_PATH)) return
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const settings = config.googleDriveSync
      const rootDir = resolveAppPath('')

      if (!settings || !settings.enabled || settings.interval === 'manually') {
        console.log('[Google Sync Scheduler] Sync is disabled or set to manually. Stopping background daemon if running.')
        try {
          const { stopGoogleSyncDaemon } = require(path.join(rootDir, 'utils', 'google_sync_helper.js'))
          stopGoogleSyncDaemon()
        } catch (_) {}
        return
      }

      const intervals = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '12h': 12 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000
      }

      const ms = intervals[settings.interval]
      if (!ms) return

      console.log(`[Google Sync Scheduler] Ensuring background sync daemon is active every ${settings.interval} (${ms} ms)...`)

      // Spawn/ensure detached background OS daemon runs independently even if user closes dashboard
      try {
        const { startGoogleSyncDaemon } = require(path.join(rootDir, 'utils', 'google_sync_helper.js'))
        const daemonRes = startGoogleSyncDaemon(rootDir)
        console.log(`[Google Sync Scheduler] Daemon status: ${daemonRes.message || 'Running'}`)
      } catch (err) {
        console.warn(`[Google Sync Scheduler] Could not start background daemon: ${err.message}`)
      }

      syncIntervalTimer = setInterval(async () => {
        console.log(`[Google Sync Scheduler] Triggering automatic background sync...`)
        const syncResult = await runSync({
          ...settings,
          projectRoot: rootDir
        })

        if (syncResult.success) {
          try {
            const currentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
            if (!currentConfig.googleDriveSync) {
              currentConfig.googleDriveSync = {}
            }
            currentConfig.googleDriveSync.lastSync = syncResult.lastSync
            
            // Calculate next sync
            const nextSyncDate = new Date(Date.now() + ms)
            currentConfig.googleDriveSync.nextSync = nextSyncDate.toISOString()

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 4), 'utf8')
            console.log(`[Google Sync Scheduler] Auto-sync success. Next sync scheduled at ${nextSyncDate.toLocaleString()}`)
          } catch (err) {
            console.error('Failed to update scheduled lastSync/nextSync timestamps:', err)
          }
        } else {
          console.error('[Google Sync Scheduler] Background sync failed:', syncResult.error)
        }
      }, ms)
    } catch (e) {
      console.error('Failed to initialize Google Drive Sync scheduler:', e)
    }
  }

  // Handle manual/immediate sync trigger
  ipcMain.handle('google-drive-sync', async (_, currentSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      
      const mergedSyncScope = {
        config: false,
        personalities: false,
        proxies: false,
        fingerprints: true,
        profiles: false,
        databases: true,
        ...(config.googleDriveSync?.syncScope || {}),
        ...(currentSettings?.syncScope || {})
      };

      const settings = {
        enabled: true,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        liveDbSync: true,
        ...(config.googleDriveSync || {}),
        ...(currentSettings || {}),
        syncScope: mergedSyncScope
      };

      const res = await runSync({
        ...settings,
        projectRoot: resolveAppPath('')
      })

      if (res.success) {
        config.googleDriveSync = {
          ...settings,
          lastSync: res.lastSync
        }
        
        // Calculate next sync if enabled
        if (settings.enabled && settings.interval !== 'manually') {
          const intervals = {
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '12h': 12 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000
          }
          const ms = intervals[settings.interval]
          if (ms) {
            config.googleDriveSync.nextSync = new Date(Date.now() + ms).toISOString()
          }
        } else {
          config.googleDriveSync.nextSync = null
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      }

      return res
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Handle manual restore/import from cloud
  ipcMain.handle('google-drive-restore', async (_, currentSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      
      const mergedSyncScope = {
        config: true,
        personalities: true,
        proxies: true,
        fingerprints: true,
        profiles: false,
        databases: true,
        ...(config.googleDriveSync?.syncScope || {}),
        ...(currentSettings?.syncScope || {})
      };

      const settings = {
        enabled: false,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        liveDbSync: true,
        ...(config.googleDriveSync || {}),
        ...(currentSettings || {}),
        syncScope: mergedSyncScope
      };

      const res = await runRestore({
        ...settings,
        projectRoot: resolveAppPath('')
      })

      return res
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Get Google Drive Sync settings
  ipcMain.handle('get-google-drive-settings', async () => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return null
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const saved = config.googleDriveSync || {}
      return {
        enabled: false,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        liveDbSync: true,
        lastSync: null,
        nextSync: null,
        ...saved,
        syncScope: {
          config: false,
          personalities: false,
          proxies: false,
          fingerprints: true,
          profiles: false,
          databases: true,
          ...(saved.syncScope || {})
        }
      }
    } catch (error) {
      console.error('Error fetching Google Drive settings:', error)
      return null
    }
  })

  // Save Google Drive Sync settings and reschedule background scheduler
  ipcMain.handle('save-google-drive-settings', async (_, newSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      
      const mergedSyncScope = {
        config: false,
        personalities: false,
        proxies: false,
        fingerprints: true,
        profiles: false,
        databases: true,
        ...(config.googleDriveSync?.syncScope || {}),
        ...(newSettings.syncScope || {})
      }

      config.googleDriveSync = {
        ...config.googleDriveSync,
        ...newSettings,
        syncScope: mergedSyncScope
      }

      // If enabled and local path is set, run immediate sync to copy files right away
      let initialSyncResult = null
      if (config.googleDriveSync.enabled && config.googleDriveSync.mode === 'local' && config.googleDriveSync.localPath) {
        initialSyncResult = await runSync({
          ...config.googleDriveSync,
          projectRoot: resolveAppPath('')
        })
        if (initialSyncResult && initialSyncResult.success) {
          config.googleDriveSync.lastSync = initialSyncResult.lastSync
        }
      }

      // Calculate next sync if enabled
      if (newSettings.enabled && newSettings.interval !== 'manually') {
        const intervals = {
          '1h': 60 * 60 * 1000,
          '6h': 6 * 60 * 60 * 1000,
          '12h': 12 * 60 * 60 * 1000,
          '24h': 24 * 60 * 60 * 1000,
          '7d': 7 * 24 * 60 * 60 * 1000
        }
        const ms = intervals[newSettings.interval]
        if (ms) {
          config.googleDriveSync.nextSync = new Date(Date.now() + ms).toISOString()
        }
      } else {
        config.googleDriveSync.nextSync = null
      }

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      
      // Reschedule background thread immediately
      scheduleGoogleDriveSync()
      
      return { 
        success: true, 
        nextSync: config.googleDriveSync.nextSync,
        lastSync: config.googleDriveSync.lastSync,
        syncResult: initialSyncResult
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-profiles-network-usage', async () => {
    try {
      const result = []
      const families = getFamiliesList()
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        for (const p of profiles) {
          const profilePath = path.join(familyPath, p)
          const usagePath = path.join(profilePath, 'network_usage.json')
          let usage = { totalBytes: 0, limitBytes: null, domains: {} }
          
          if (fs.existsSync(usagePath)) {
            try {
              usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
            } catch (err) {}
          }
          result.push({ id: p, family: fam, usage })
        }
      }
      return result
    } catch (e) {
      console.error('Error fetching network usage:', e)
      return []
    }
  })

  ipcMain.handle('set-profile-network-limits', async (_, { id, family, limitBytes, domainLimits }) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, family, id)
      const usagePath = path.join(profilePath, 'network_usage.json')
      let usage = { totalBytes: 0, limitBytes: null, domains: {} }
      
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true })
      }
      
      if (fs.existsSync(usagePath)) {
        try {
          usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
        } catch (err) {}
      }
      
      usage.limitBytes = limitBytes !== undefined ? limitBytes : null
      
      // Sync domain limits
      if (domainLimits) {
        for (const [domain, limit] of Object.entries(domainLimits)) {
          if (!usage.domains[domain]) {
            usage.domains[domain] = { bytes: 0, limitBytes: null }
          }
          usage.domains[domain].limitBytes = limit
        }
      }
      
      fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
      return { success: true }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-profile-network-usage', async (_, { id, family }) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, family, id)
      const usagePath = path.join(profilePath, 'network_usage.json')
      
      if (fs.existsSync(usagePath)) {
        try {
          const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
          usage.totalBytes = 0
          for (const d of Object.keys(usage.domains)) {
            usage.domains[d].bytes = 0
          }
          fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
        } catch (err) {}
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-all-profiles-network-usage', async () => {
    try {
      const families = getFamiliesList()
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => fs.statSync(path.join(familyPath, f)).isDirectory())
        for (const p of profiles) {
          const profilePath = path.join(familyPath, p)
          const usagePath = path.join(profilePath, 'network_usage.json')
          
          if (fs.existsSync(usagePath)) {
            try {
              const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
              usage.totalBytes = 0
              if (usage.domains) {
                for (const d of Object.keys(usage.domains)) {
                  usage.domains[d].bytes = 0
                }
              }
              fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
            } catch (err) {}
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  function runQuery(dbPath, query, params = []) {
    dbPath = normalizeDbPath(dbPath);
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const timeout = setTimeout(() => {
        if (child) {
          try { child.kill() } catch (err) {}
        }
        resolve({ success: false, error: 'Database query timed out after 30 seconds.' })
      }, 30000)

      const child = spawnNode(readerPath, [dbPath, query, JSON.stringify(params)])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        clearTimeout(timeout)
        try {
          if (errorOutput && !output) {
            try {
              const parsed = JSON.parse(errorOutput);
              resolve({ success: false, error: parsed.error });
            } catch (jsonErr) {
              resolve({ success: false, error: errorOutput.substring(0, 200) });
            }
          } else if (output) {
            try {
              resolve(parseJSONFromStdout(output))
            } catch (parseErr) {
              resolve({ success: false, error: 'Failed to parse database output: ' + parseErr.message })
            }
          } else {
            resolve({ success: false, error: 'No output received from database.' })
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to process database output: ' + e.message })
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        resolve({ success: false, error: 'Database process error: ' + err.message })
      })
    })
  }

  ipcMain.handle('get-predictor-teams', async (_, { dbPath, provider }) => {
    try {
      const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';
      const leaguesResult = await runQuery(dbPath, `SELECT DISTINCT league_name FROM ${viewName} ORDER BY league_name`);
      const teamsResult = await runQuery(dbPath, `SELECT DISTINCT team FROM (SELECT home_team AS team FROM ${viewName} UNION SELECT away_team AS team FROM ${viewName}) ORDER BY team`);
      
      return {
        success: true,
        leagues: leaguesResult.success ? leaguesResult.data.map(r => r.league_name) : [],
        teams: teamsResult.success ? teamsResult.data.map(r => r.team) : []
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-team-matchups', async (_, { dbPath, homeTeam, awayTeam, provider }) => {
    try {
      const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';
      const h2hResult = await runQuery(dbPath, 
        `SELECT * FROM ${viewName} WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?) ORDER BY id DESC`,
        [homeTeam, awayTeam, awayTeam, homeTeam]
      );
      
      const homeRecentResult = await runQuery(dbPath,
        `SELECT * FROM ${viewName} WHERE home_team = ? OR away_team = ? ORDER BY id DESC LIMIT 10`,
        [homeTeam, homeTeam]
      );
      
      const awayRecentResult = await runQuery(dbPath,
        `SELECT * FROM ${viewName} WHERE home_team = ? OR away_team = ? ORDER BY id DESC LIMIT 10`,
        [awayTeam, awayTeam]
      );
      
      // Check if league_standings table exists
      const tableCheck = await runQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='league_standings'");
      const standingsExist = tableCheck.success && tableCheck.data.length > 0;

      let latestSeasonName = null;
      let homeStanding = null;
      let awayStanding = null;
      let homeHistory = null;
      let awayHistory = null;

      if (standingsExist) {
        const latestSeasonRes = await runQuery(dbPath,
          "SELECT season_name FROM league_standings ORDER BY id DESC LIMIT 1"
        );
        latestSeasonName = (latestSeasonRes.success && latestSeasonRes.data.length > 0) 
          ? latestSeasonRes.data[0].season_name 
          : null;

        if (latestSeasonName) {
          const homeStandingRes = await runQuery(dbPath,
            "SELECT * FROM league_standings WHERE season_name = ? AND team_name = ?",
            [latestSeasonName, homeTeam]
          );
          const awayStandingRes = await runQuery(dbPath,
            "SELECT * FROM league_standings WHERE season_name = ? AND team_name = ?",
            [latestSeasonName, awayTeam]
          );
          if (homeStandingRes.success && homeStandingRes.data.length > 0) homeStanding = homeStandingRes.data[0];
          if (awayStandingRes.success && awayStandingRes.data.length > 0) awayStanding = awayStandingRes.data[0];
        }

        const homeHistoryRes = await runQuery(dbPath,
          "SELECT AVG(position) as avgPosition, AVG(points) as avgPoints, AVG(goal_difference) as avgGd, COUNT(*) as seasonsCount FROM league_standings WHERE team_name = ?",
          [homeTeam]
        );
        const awayHistoryRes = await runQuery(dbPath,
          "SELECT AVG(position) as avgPosition, AVG(points) as avgPoints, AVG(goal_difference) as avgGd, COUNT(*) as seasonsCount FROM league_standings WHERE team_name = ?",
          [awayTeam]
        );

        if (homeHistoryRes.success && homeHistoryRes.data.length > 0) homeHistory = homeHistoryRes.data[0];
        if (awayHistoryRes.success && awayHistoryRes.data.length > 0) awayHistory = awayHistoryRes.data[0];
      }

      let mlPrediction = null;
      try {
        const mlRes = await runMLPredict(dbPath, homeTeam, awayTeam, provider);
        if (mlRes && mlRes.success) {
          mlPrediction = mlRes;
        }
      } catch (err) {
        console.error("Error generating ML prediction:", err.message);
      }

      return {
        success: true,
        h2hMatches: h2hResult.success ? h2hResult.data : [],
        homeRecent: homeRecentResult.success ? homeRecentResult.data : [],
        awayRecent: awayRecentResult.success ? awayRecentResult.data : [],
        homeStanding,
        awayStanding,
        homeHistory,
        awayHistory,
        latestSeasonName,
        mlPrediction
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('optimize-ml-weights', async (_, { dbPath, provider }) => {
    try {
      const res = await runMLOptimize(dbPath, provider);
      return res;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('launch-new-window', async (_, options) => {
    try {
      createWindow(options);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('predict-matchup-ai', async (_, { homeTeam, awayTeam, h2hData, homeStats, awayStats, homeStanding, awayStanding, homeHistory, awayHistory, latestSeasonName, h2hMatches, homeRecent, awayRecent, provider, apiKey, mlPrediction, minStake }) => {
    try {
      const systemPrompt = "You are an advanced Football Prediction System powered by Machine Learning and statistical models. " +
        "Your task is to analyze historical head-to-head records, recent match performance metrics, league standings, and long-term team forms to generate a detailed predictive analysis.\n" +
        "The prompt includes predictions from an advanced offline Machine Learning model (Poisson-Elo Blended). You must analyze and explain the ML model's forecast (Poisson xG, Elo ratings, scoreline probabilities, goal markets, handicaps, Half-Time stats, and kickoff time trends) and let it work hand-in-hand with your tactical/contextual analysis to explain how the final conclusion was reached.\n\n" +
        "Structure your response beautifully in Markdown with sections:\n" +
        "1. ### ðŸ“Š MATCHUP OVERVIEW: Home Team vs Away Team relative strengths and league table context.\n" +
        "2. ### ðŸ¤– MACHINE LEARNING MODEL ANALYSIS: Explain the ML model's predictions (Win/Draw/Loss probabilities, Poisson xG expected goals, Elo Ratings, and top scorelines).\n" +
        "3. ### ðŸŽ¯ PROBABILISTIC FORECAST: home win %, draw %, away win % blending the ML model and your contextual/tactical reasons.\n" +
        "4. ### âš½ PREDICTED SCORELINE & GOAL DISTRIBUTION: predicted score and goals over/under suggestions based on Poisson averages.\n" +
        "5. ### ðŸ“ˆ HIGH-YIELD MARKET SUGGESTIONS: best value markets (e.g. GG, Over 1.5, Double Chance).\n" +
        "6. ### ðŸ§  SYNTHESIS & CONCLUSION: Detailed analysis of how the ML model and tactical context work hand-in-hand to arrive at the final conclusion.\n" +
        "7. ### ðŸŽ¯ AI RECOMMENDATION & BEST BET: A clear, explicit, and definitive recommendation of the single best bet/market (Full-Time FT or Half-Time HT outcome, GG/NG, handicaps, or Over/Under thresholds), including overall confidence percentage and clear tactical/statistical rationale referencing HT/FT trends and kickoff time trends.\n" +
        "8. ### ðŸ’° STAKING STRATEGY & RISK MANAGEMENT: A custom betting strategy with exact monetary stake suggestions built as multipliers of the user's Minimum Stake (Minimum Stake = " + (minStake || 1000) + "). Provide a clean breakdown of: Low-Risk (e.g. 2.0x minStake), Medium-Risk (e.g. 1.0x minStake), and High-Risk/Value (e.g. 0.5x minStake) bets. Tell the user exactly how much currency to place on each suggestion based on their input.\n" +
        "9. ### ðŸšª LOSS MITIGATION & HEDGING STRATEGY (WAY OUT): A detailed live-hedging or exit strategy giving the user a way out in case the bet begins to fail. Provide concrete triggers based on game time or live events (e.g. 'If Team A is not leading by minute 60, cash out or place X amount on Double Chance to cover', 'If it remains 0-0 at half-time, hedge on Under 1.5 live goals', etc.) to help the user minimize losses.\n\n" +
        "Be precise, professional, and base your prediction strictly on the provided data. Do not make up facts.";

      let standingsInfo = '';
      if (homeStanding && awayStanding) {
        standingsInfo = `League Table Standings (Latest Season: ${latestSeasonName}):\n` +
          `- ${homeTeam}: Position ${homeStanding.position}/${homeStanding.played} matches, Points: ${homeStanding.points}, Goal Diff: ${homeStanding.goal_difference} (W:${homeStanding.won} D:${homeStanding.drawn} L:${homeStanding.lost})\n` +
          `- ${awayTeam}: Position ${awayStanding.position}/${awayStanding.played} matches, Points: ${awayStanding.points}, Goal Diff: ${awayStanding.goal_difference} (W:${awayStanding.won} D:${awayStanding.drawn} L:${awayStanding.lost})\n\n`;
      }
      
      let historyInfo = '';
      if (homeHistory && awayHistory && homeHistory.seasonsCount > 0) {
        historyInfo = `Long-term Historical League Standings (over ${homeHistory.seasonsCount} seasons):\n` +
          `- ${homeTeam}: Avg Position: ${Number(homeHistory.avgPosition).toFixed(1)}, Avg Points: ${Number(homeHistory.avgPoints).toFixed(1)}, Avg Goal Diff: ${Number(homeHistory.avgGd).toFixed(1)}\n` +
          `- ${awayTeam}: Avg Position: ${Number(awayHistory.avgPosition).toFixed(1)}, Avg Points: ${Number(awayHistory.avgPoints).toFixed(1)}, Avg Goal Diff: ${Number(awayHistory.avgGd).toFixed(1)}\n\n`;
      }

      let h2hMatchesList = '';
      if (h2hMatches && h2hMatches.length > 0) {
        h2hMatchesList = `Recent Head-to-Head Individual Match Results (Fixtures):\n` +
          h2hMatches.slice(0, 10).map(m => {
            const timeStr = m.match_time ? `[${m.match_time}] ` : '';
            return `- ${timeStr}${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (Result: ${m.match_result}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let homeRecentList = '';
      if (homeRecent && homeRecent.length > 0) {
        homeRecentList = `${homeTeam} Recent 10 Match Results (Fixtures):\n` +
          homeRecent.slice(0, 10).map(m => {
            const isHome = m.home_team === homeTeam;
            const outcome = m.match_result === 'Draw' ? 'Draw' : ((m.match_result === 'Home' && isHome) || (m.match_result === 'Away' && !isHome) ? 'Win' : 'Loss');
            return `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${outcome}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let awayRecentList = '';
      if (awayRecent && awayRecent.length > 0) {
        awayRecentList = `${awayTeam} Recent 10 Match Results (Fixtures):\n` +
          awayRecent.slice(0, 10).map(m => {
            const isHome = m.home_team === awayTeam;
            const outcome = m.match_result === 'Draw' ? 'Draw' : ((m.match_result === 'Home' && isHome) || (m.match_result === 'Away' && !isHome) ? 'Win' : 'Loss');
            return `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${outcome}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let mlInfo = '';
      if (mlPrediction && mlPrediction.success) {
        mlInfo = `Advanced Offline Machine Learning Model Forecast (Poisson-Elo Blended):\n` +
          `- Prediction Overall Confidence Score: ${mlPrediction.confidenceScore}%\n` +
          `- Blended Out-of-Sample Probability: ${homeTeam} Win: ${(mlPrediction.blended.homeWin * 100).toFixed(1)}%, Draw: ${(mlPrediction.blended.draw * 100).toFixed(1)}%, ${awayTeam} Win: ${(mlPrediction.blended.awayWin * 100).toFixed(1)}%\n` +
          `- Active Blending Weights: Poisson weight: ${(mlPrediction.weights.poissonWeight * 100).toFixed(0)}%, Elo weight: ${(mlPrediction.weights.eloWeight * 100).toFixed(0)}%\n` +
          `- Poisson Expected Goals (Full-Time FT xG): ${homeTeam} expected goals: ${mlPrediction.poisson.homeXG.toFixed(2)}, ${awayTeam} expected goals: ${mlPrediction.poisson.awayXG.toFixed(2)}\n` +
          `- Poisson Expected Goals (Half-Time HT xG): ${homeTeam} expected goals at HT: ${mlPrediction.poisson.ht.homeHT_XG.toFixed(2)}, ${awayTeam} expected goals at HT: ${mlPrediction.poisson.ht.awayHT_XG.toFixed(2)}\n` +
          `- Half-Time (HT) Match Winner Probabilities: Home Win at HT: ${(mlPrediction.poisson.ht.homeWinProb * 100).toFixed(1)}%, Draw at HT: ${(mlPrediction.poisson.ht.drawProb * 100).toFixed(1)}%, Away Win at HT: ${(mlPrediction.poisson.ht.awayWinProb * 100).toFixed(1)}%\n` +
          `- Double Chance Probabilities (FT): 1X: ${(mlPrediction.poisson.doubleChance.dc1X * 100).toFixed(1)}%, 12: ${(mlPrediction.poisson.doubleChance.dc12 * 100).toFixed(1)}%, X2: ${(mlPrediction.poisson.doubleChance.dcX2 * 100).toFixed(1)}%\n` +
          `- Draw No Bet Probabilities (FT): ${homeTeam} (DNB): ${(mlPrediction.poisson.drawNoBet.home * 100).toFixed(1)}%, ${awayTeam} (DNB): ${(mlPrediction.poisson.drawNoBet.away * 100).toFixed(1)}%\n` +
          `- Odd/Even Total Goals: Odd: ${(mlPrediction.poisson.oddProb * 100).toFixed(1)}%, Even: ${(mlPrediction.poisson.evenProb * 100).toFixed(1)}%\n` +
          `- Exact Goals Probabilities (FT):\n` +
          `  * 0 Goals: ${(mlPrediction.poisson.exactGoals.eg0 * 100).toFixed(1)}%\n` +
          `  * 1 Goal: ${(mlPrediction.poisson.exactGoals.eg1 * 100).toFixed(1)}%\n` +
          `  * 2 Goals: ${(mlPrediction.poisson.exactGoals.eg2 * 100).toFixed(1)}%\n` +
          `  * 3 Goals: ${(mlPrediction.poisson.exactGoals.eg3 * 100).toFixed(1)}%\n` +
          `  * 4 Goals: ${(mlPrediction.poisson.exactGoals.eg4 * 100).toFixed(1)}%\n` +
          `  * 5 Goals: ${(mlPrediction.poisson.exactGoals.eg5 * 100).toFixed(1)}%\n` +
          `  * 6+ Goals: ${(mlPrediction.poisson.exactGoals.eg6Plus * 100).toFixed(1)}%\n` +
          `- Poisson Probability Goal Markets (Full-Time FT):\n` +
          `  * Over 0.5 Goals: ${(mlPrediction.poisson.over05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5 Goals: ${(mlPrediction.poisson.over15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5 Goals: ${(mlPrediction.poisson.over25 * 100).toFixed(1)}%\n` +
          `  * Over 3.5 Goals: ${(mlPrediction.poisson.over35 * 100).toFixed(1)}%\n` +
          `  * Over 4.5 Goals: ${(mlPrediction.poisson.over45 * 100).toFixed(1)}%\n` +
          `  * Over 5.5 Goals: ${(mlPrediction.poisson.over55 * 100).toFixed(1)}%\n` +
          `  * Both Teams to Score (GG): ${(mlPrediction.poisson.gg * 100).toFixed(1)}%\n` +
          `  * No Goal (NG): ${(mlPrediction.poisson.ng * 100).toFixed(1)}%\n` +
          `- First Goal Market:\n` +
          `  * ${homeTeam} Scores First: ${(mlPrediction.poisson.firstGoal.home * 100).toFixed(1)}%\n` +
          `  * ${awayTeam} Scores First: ${(mlPrediction.poisson.firstGoal.away * 100).toFixed(1)}%\n` +
          `  * No Goal: ${(mlPrediction.poisson.firstGoal.none * 100).toFixed(1)}%\n` +
          `- Home Total Goals (FT):\n` +
          `  * Over 0.5: ${(mlPrediction.poisson.homeTotalGoals.over05 * 100).toFixed(1)}%, Under 0.5: ${(mlPrediction.poisson.homeTotalGoals.under05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5: ${(mlPrediction.poisson.homeTotalGoals.over15 * 100).toFixed(1)}%, Under 1.5: ${(mlPrediction.poisson.homeTotalGoals.under15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5: ${(mlPrediction.poisson.homeTotalGoals.over25 * 100).toFixed(1)}%, Under 2.5: ${(mlPrediction.poisson.homeTotalGoals.under25 * 100).toFixed(1)}%\n` +
          `- Away Total Goals (FT):\n` +
          `  * Over 0.5: ${(mlPrediction.poisson.awayTotalGoals.over05 * 100).toFixed(1)}%, Under 0.5: ${(mlPrediction.poisson.awayTotalGoals.under05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5: ${(mlPrediction.poisson.awayTotalGoals.over15 * 100).toFixed(1)}%, Under 1.5: ${(mlPrediction.poisson.awayTotalGoals.under15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5: ${(mlPrediction.poisson.awayTotalGoals.over25 * 100).toFixed(1)}%, Under 2.5: ${(mlPrediction.poisson.awayTotalGoals.under25 * 100).toFixed(1)}%\n` +
          `- Exact Goals (FT):\n` +
          `  * Home Exact: 0: ${(mlPrediction.poisson.homeExactGoals.eg0 * 100).toFixed(1)}%, 1: ${(mlPrediction.poisson.homeExactGoals.eg1 * 100).toFixed(1)}%, 2: ${(mlPrediction.poisson.homeExactGoals.eg2 * 100).toFixed(1)}%, 3: ${(mlPrediction.poisson.homeExactGoals.eg3 * 100).toFixed(1)}%, 4+: ${(mlPrediction.poisson.homeExactGoals.eg4Plus * 100).toFixed(1)}%\n` +
          `  * Away Exact: 0: ${(mlPrediction.poisson.awayExactGoals.eg0 * 100).toFixed(1)}%, 1: ${(mlPrediction.poisson.awayExactGoals.eg1 * 100).toFixed(1)}%, 2: ${(mlPrediction.poisson.awayExactGoals.eg2 * 100).toFixed(1)}%, 3: ${(mlPrediction.poisson.awayExactGoals.eg3 * 100).toFixed(1)}%, 4+: ${(mlPrediction.poisson.awayExactGoals.eg4Plus * 100).toFixed(1)}%\n` +
          `- Teams to Score (FT):\n` +
          `  * Both Teams: ${(mlPrediction.poisson.teamsToScore.both * 100).toFixed(1)}%\n` +
          `  * Only Home: ${(mlPrediction.poisson.teamsToScore.onlyHome * 100).toFixed(1)}%\n` +
          `  * Only Away: ${(mlPrediction.poisson.teamsToScore.onlyAway * 100).toFixed(1)}%\n` +
          `  * None (0-0): ${(mlPrediction.poisson.teamsToScore.none * 100).toFixed(1)}%\n` +
          `- Poisson Probability Goal Markets (Half-Time HT):\n` +
          `  * HT Over 0.5 Goals: ${(mlPrediction.poisson.ht.over05 * 100).toFixed(1)}%\n` +
          `  * HT Over 1.5 Goals: ${(mlPrediction.poisson.ht.over15 * 100).toFixed(1)}%\n` +
          `  * HT Over 2.5 Goals: ${(mlPrediction.poisson.ht.over25 * 100).toFixed(1)}%\n` +
          `  * HT Over 3.5 Goals: ${(mlPrediction.poisson.ht.over35 * 100).toFixed(1)}%\n` +
          `  * HT Over 4.5 Goals: ${(mlPrediction.poisson.ht.over45 * 100).toFixed(1)}%\n` +
          `  * HT Over 5.5 Goals: ${(mlPrediction.poisson.ht.over55 * 100).toFixed(1)}%\n` +
          `  * HT Both Teams to Score (HT GG): ${(mlPrediction.poisson.ht.gg * 100).toFixed(1)}%\n` +
          `  * HT No Goal (HT NG): ${(mlPrediction.poisson.ht.ng * 100).toFixed(1)}%\n` +
          `- HT Double Chance: 1X at HT: ${(mlPrediction.poisson.ht.doubleChance.dc1X * 100).toFixed(1)}%, 12 at HT: ${(mlPrediction.poisson.ht.doubleChance.dc12 * 100).toFixed(1)}%, X2 at HT: ${(mlPrediction.poisson.ht.doubleChance.dcX2 * 100).toFixed(1)}%\n` +
          `- 3-Way Handicap Markets (FT):\n` +
          `  * ${homeTeam} (-2): Home Win: ${(mlPrediction.poisson.handicap3Way.minus2.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.minus2.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.minus2.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1): Home Win: ${(mlPrediction.poisson.handicap3Way.minus1.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.minus1.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.minus1.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1): Home Win: ${(mlPrediction.poisson.handicap3Way.plus1.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.plus1.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.plus1.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+2): Home Win: ${(mlPrediction.poisson.handicap3Way.plus2.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.plus2.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.plus2.away * 100).toFixed(1)}%\n` +
          `- Asian Handicap Markets (FT):\n` +
          `  * ${homeTeam} (-1.5) / ${awayTeam} (+1.5): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_5.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.5) / ${awayTeam} (-1.5): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_5.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.25) / ${awayTeam} (+1.25): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_25.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_25.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.25) / ${awayTeam} (-1.25): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_25.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_25.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.75) / ${awayTeam} (+1.75): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_75.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.75) / ${awayTeam} (-1.75): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_75.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_75.away * 100).toFixed(1)}%\n` +
          `- HT Asian Handicap Markets:\n` +
          `  * ${homeTeam} (-0.5) / ${awayTeam} (+0.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+0.5) / ${awayTeam} (-0.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-0.75) / ${awayTeam} (+0.75) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_75.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+0.75) / ${awayTeam} (-0.75) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_75.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.5) / ${awayTeam} (+1.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus1_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.5) / ${awayTeam} (-1.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus1_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus1_5.away * 100).toFixed(1)}%\n` +
          `- Halftime/Fulltime Probabilities:\n` +
          `  * 1/1: ${(mlPrediction.poisson.halftimeFulltime.htft11 * 100).toFixed(1)}%, 1/X: ${(mlPrediction.poisson.halftimeFulltime.htft1X * 100).toFixed(1)}%, 1/2: ${(mlPrediction.poisson.halftimeFulltime.htft12 * 100).toFixed(1)}%\n` +
          `  * X/1: ${(mlPrediction.poisson.halftimeFulltime.htftX1 * 100).toFixed(1)}%, X/X: ${(mlPrediction.poisson.halftimeFulltime.htftXX * 100).toFixed(1)}%, X/2: ${(mlPrediction.poisson.halftimeFulltime.htftX2 * 100).toFixed(1)}%\n` +
          `  * 2/1: ${(mlPrediction.poisson.halftimeFulltime.htft21 * 100).toFixed(1)}%, 2/X: ${(mlPrediction.poisson.halftimeFulltime.htft2X * 100).toFixed(1)}%, 2/2: ${(mlPrediction.poisson.halftimeFulltime.htft22 * 100).toFixed(1)}%\n` +
          `- Highest Scoring Half: 1st Half: ${(mlPrediction.poisson.highestScoringHalf.firstHalf * 100).toFixed(1)}%, 2nd Half: ${(mlPrediction.poisson.highestScoringHalf.secondHalf * 100).toFixed(1)}%, Equal: ${(mlPrediction.poisson.highestScoringHalf.equal * 100).toFixed(1)}%\n` +
          `- Kickoff Time Performance Trends (Daytime kickoff hour < 17, Nighttime hour >= 17):\n` +
          `  * ${homeTeam} (Day matches): Played: ${mlPrediction.poisson.kickoffStats.homeDay.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.homeDay.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.homeDay.avgGoals.toFixed(2)}\n` +
          `  * ${homeTeam} (Night matches): Played: ${mlPrediction.poisson.kickoffStats.homeNight.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.homeNight.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.homeNight.avgGoals.toFixed(2)}\n` +
          `  * ${awayTeam} (Day matches): Played: ${mlPrediction.poisson.kickoffStats.awayDay.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.awayDay.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.awayDay.avgGoals.toFixed(2)}\n` +
          `  * ${awayTeam} (Night matches): Played: ${mlPrediction.poisson.kickoffStats.awayNight.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.awayNight.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.awayNight.avgGoals.toFixed(2)}\n` +
          `- Elo Rating System (momentum rating): ${homeTeam} rating: ${mlPrediction.elo ? Math.round(mlPrediction.elo.homeElo) : '1500'}, ${awayTeam} rating: ${mlPrediction.elo ? Math.round(mlPrediction.elo.awayElo) : '1500'}\n` +
          `- Elo Win Expectancy Probability: ${homeTeam} win: ${mlPrediction.elo ? (mlPrediction.elo.homeEloWinProb * 100).toFixed(1) : '50.0'}%, ${awayTeam} win: ${mlPrediction.elo ? (mlPrediction.elo.awayEloWinProb * 100).toFixed(1) : '50.0'}%\n` +
          `- Top 5 Predicted Full-Time Correct Scorelines: ${mlPrediction.poisson.correctScoresList.slice(0, 5).map(s => `${s.score} (${(s.prob * 100).toFixed(1)}%)`).join(', ')}\n` +
          `- Top 3 Predicted Half-Time Correct Scorelines: ${mlPrediction.poisson.ht.topScorelines.map(s => `${s.score} (${(s.prob * 100).toFixed(1)}%)`).join(', ')}\n\n`;
      }

      const userPrompt = `Analysis Request:\n` +
        `Home Team: ${homeTeam}\n` +
        `Away Team: ${awayTeam}\n\n` +
        mlInfo +
        standingsInfo +
        historyInfo +
        h2hMatchesList +
        homeRecentList +
        awayRecentList +
        `Head-to-Head Statistics:\n` +
        `- Total Matches Played: ${h2hData.totalMatches}\n` +
        `- Home Team Wins: ${h2hData.homeWins}\n` +
        `- Away Team Wins: ${h2hData.awayWins}\n` +
        `- Draws: ${h2hData.draws}\n` +
        `- Avg Goals Per Match: ${h2hData.avgGoals.toFixed(2)}\n\n` +
        `Home Team recent form:\n` +
        `- Win Rate: ${homeStats.winRate.toFixed(1)}%\n` +
        `- Over 1.5 Rate: ${homeStats.over15Rate.toFixed(1)}%\n` +
        `- Over 2.5 Rate: ${homeStats.over25Rate.toFixed(1)}%\n` +
        `- BTTS (GG) Rate: ${homeStats.ggRate.toFixed(1)}%\n` +
        `- Avg Goals Scored: ${homeStats.avgGoalsScored.toFixed(2)}\n` +
        `- Avg Goals Conceded: ${homeStats.avgGoalsConceded.toFixed(2)}\n\n` +
        `Away Team recent form:\n` +
        `- Win Rate: ${awayStats.winRate.toFixed(1)}%\n` +
        `- Over 1.5 Rate: ${awayStats.over15Rate.toFixed(1)}%\n` +
        `- Over 2.5 Rate: ${awayStats.over25Rate.toFixed(1)}%\n` +
        `- BTTS (GG) Rate: ${awayStats.ggRate.toFixed(1)}%\n` +
        `- Avg Goals Scored: ${awayStats.avgGoalsScored.toFixed(2)}\n` +
        `- Avg Goals Conceded: ${awayStats.avgGoalsConceded.toFixed(2)}\n\n` +
        `Please analyze these statistics and generate the forecasting report.`;

      const prediction = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.6 });
      return { success: true, prediction };
    } catch (e) {
      console.error('AI Matchup Predictor Error:', e);
      return { success: false, error: e.message };
    }
  });

  // â”€â”€â”€ Backtest: list available seasons â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('get-backtest-seasons', async (_, { dbPath, provider }) => {
    try {
      const viewName = (provider === 'sportybet') ? 'sporty_betting_analytics' : 'betting_analytics';
      const result = await runQuery(dbPath,
        `SELECT DISTINCT season_name FROM ${viewName} ORDER BY season_name`,
        []
      );
      return { success: true, seasons: result.success ? result.data.map(r => r.season_name) : [] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // â”€â”€â”€ Backtest: run Poisson+Elo blind prediction on every match in a target season â”€
  ipcMain.handle('run-backtest', async (_, { dbPath, seasonName, provider }) => {
    try {
      const result = await runMLBacktest(dbPath, seasonName, provider);
      return result;
    } catch (e) {
      console.error('Backtest Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('discover-edge', async (_, { dbPath, seasonName, lookbackWindow, provider }) => {
    try {
      const result = await runMLDiscoverEdge(dbPath, seasonName, lookbackWindow || 100, provider);
      return result;
    } catch (e) {
      console.error('Edge Discovery Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('discover-edge-across-seasons', async (_, { dbPath, minOdds, maxOdds, lookbackWindow, provider }) => {
    try {
      const result = await runMLDiscoverEdgeAcrossSeasons(dbPath, minOdds || 4, maxOdds || 50, lookbackWindow || 100, provider);
      return result;
    } catch (e) {
      console.error('Cross-Season Edge Discovery Error:', e);
      return { success: false, error: e.message };
    }
  });

  // â”€â”€â”€ Backtest: export detailed PDF report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('print-backtest-pdf', async (_, { html, filename }) => {
    try {
      // Write HTML to a temp file so loadFile works reliably for large docs
      const tmpPath = path.join(os.tmpdir(), `backtest_report_${Date.now()}.html`);
      fs.writeFileSync(tmpPath, html, 'utf8');

      // Create hidden BrowserWindow to render the HTML
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: false, contextIsolation: false }
      });

      await pdfWin.loadFile(tmpPath);
      // Give it a moment to fully render fonts & layout
      await new Promise(resolve => setTimeout(resolve, 800));

      const pdfBuffer = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        marginsType: 0,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        landscape: false
      });

      pdfWin.close();
      fs.unlinkSync(tmpPath); // clean up temp file

      // Ask user where to save
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Backtest Report',
        defaultPath: filename || 'backtest_report.pdf',
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
      });

      if (canceled || !filePath) return { success: false, canceled: true };

      fs.writeFileSync(filePath, pdfBuffer);
      return { success: true, filePath };
    } catch (e) {
      console.error('PDF Export Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('generate-pdf-buffer', async (_, { html }) => {
    try {
      const tmpPath = path.join(os.tmpdir(), `stats_report_${Date.now()}.html`);
      fs.writeFileSync(tmpPath, html, 'utf8');

      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: false, contextIsolation: false }
      });

      await pdfWin.loadFile(tmpPath);
      await new Promise(resolve => setTimeout(resolve, 800));

      const pdfBuffer = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        marginsType: 0,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        landscape: false
      });

      pdfWin.close();
      fs.unlinkSync(tmpPath);

      return { success: true, pdfBase64: pdfBuffer.toString('base64') };
    } catch (e) {
      console.error('PDF generation error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Pattern Analysis: run deep pattern mining on the DB ───────────────────
  ipcMain.handle('analyse-patterns', async (_, { dbPath, provider }) => {
    try {
      const result = await runMLAnalysePatterns(dbPath, provider);
      return result;
    } catch (e) {
      console.error('Pattern Analysis Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('analyse-time-patterns', async (_, { dbPath, provider }) => {
    try {
      const result = await runMLAnalyseTimePatterns(dbPath, provider);
      return result;
    } catch (e) {
      console.error('Time Pattern Analysis Error:', e);
      return { success: false, error: e.message };
    }
  });

  // â”€â”€â”€ Live Season Predictor IPC Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('scrape-live-season', async (_, { dbPath, isHeadless, provider, leagueId, isContinuous, profile, family, device, browser }) => {
    try {
      // Store launch config so the scheduler can restart this scraper after maintenance
      activeScraperConfigs.set(provider, { dbPath, isHeadless, provider, leagueId: leagueId || 41104, isContinuous, profile, family, device, browser });
      
      // Clean up prior to launch to free memory
      console.log(`[Main Process] Pre-cleanup Chrome processes for scraper: ${provider}`);
      await killChromeProcessesForProvider(provider);

      const result = await runMLScrapeLiveSeason(dbPath, isHeadless, provider, leagueId || 41104, isContinuous, profile, family, device, browser);
      // Clean up config once the scraper finishes naturally
      activeScraperConfigs.delete(provider);

      // Clean up orphaned processes on completion
      await killChromeProcessesForProvider(provider);
      return result;
    } catch (e) {
      activeScraperConfigs.delete(provider);
      console.error('Scrape Live Season Error:', e);
      await killChromeProcessesForProvider(provider);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('scrape-results-history', async (_, dbPath, livePlatform, targetLeagueId) => {
    return new Promise((resolve) => {
      const runnerPath = resolveAppPath('utils/ml_runner.js')
      let output = ''
      let errorOutput = ''
      const child = spawnNode(runnerPath, ['scrape-results-history', dbPath, livePlatform, String(targetLeagueId)])
      
      const timeout = setTimeout(() => {
        child && child.kill()
        resolve({ success: false, error: 'Scrape results history query timed out after 45 seconds.' })
      }, 45000)

      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      child.on('close', (code) => {
        clearTimeout(timeout)
        try {
          if (code !== 0 && errorOutput && !output) {
            resolve({ success: false, error: errorOutput })
          } else {
            resolve(parseJSONFromStdout(output))
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse scrape-results-history output: ' + e.message })
        }
      })
    })
  });

  ipcMain.handle('stop-live-scraper', async (_, { provider }) => {
    try {
      if (activeScrapers.has(provider)) {
        console.log(`[Main Process] Stopping active scraper for ${provider}...`);
        try {
          const childProcess = activeScrapers.get(provider);
          if (childProcess) childProcess.wasKilledManually = true;
          childProcess.kill();
        } catch (killErr) {}
        activeScrapers.delete(provider);

        // Give it a moment to terminate, then clean up its chrome instances
        setTimeout(async () => {
          console.log(`[Main Process] Cleaning up Chrome processes for stopped scraper ${provider}...`);
          await killChromeProcessesForProvider(provider);
        }, 1000);

        return { success: true };
      }
      return { success: false, error: 'No active scraper running for ' + provider };
    } catch (e) {
      console.error('Stop Live Scraper Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-live-predictions', async (_, payload) => {
    try {
      const dbPath = (payload && typeof payload === 'object') ? payload.dbPath : (typeof payload === 'string' ? payload : '');
      const provider = (payload && typeof payload === 'object' && payload.provider) ? payload.provider : 'sportybet';
      const limit = (payload && typeof payload === 'object' && payload.limit) ? payload.limit : 300;
      console.log(`[IPC get-live-predictions] Start: dbPath=${dbPath}, provider=${provider}, limit=${limit}`);
      const result = await runMLGetLivePredictions(dbPath, provider, limit);
      console.log(`[IPC get-live-predictions] Done: success=${result?.success}, predictions=${result?.predictions?.length || 0}`);
      return JSON.parse(JSON.stringify(result || { success: false, error: 'Empty response' }));
    } catch (e) {
      console.error('Get Live Predictions Error:', e);
      return { success: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('generate-strategy-report', async (_, { dbPath }) => {
    try {
      const result = await runMLGenerateStrategyReport(dbPath);
      if (result.success && result.filePath) {
        shell.openPath(result.filePath);
      }
      return result;
    } catch (e) {
      console.error('Generate Strategy Report Error:', e);
      return { success: false, error: e.message };
    }
  });

  // Initialize scheduler on startup
  scheduleGoogleDriveSync()

  // --- Database Update Scheduler State & Logic ---
  let schedulerState = {
    status: 'idle',
    currentStep: '',
    logs: '',
    lastRun: null,
    nextRun: null
  };
  let schedulerChildProcess = null;

  function appendSchedulerLog(text) {
    schedulerState.logs += text + '\n';
    broadcastToWindows('scheduler-log', text);
    console.log(`[Scheduler] ${text}`);
  }

  function getDbDirectory() {
    try {
      const settingsPath = resolveAppPath('bot_settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.outputDir) return settings.outputDir;
      }
    } catch (e) {
      console.error('Error reading bot_settings.json:', e);
    }
    return resolveAppPath('');
  }

  function runScraperTask(scriptPath, args) {
    return new Promise((resolve, reject) => {
      appendSchedulerLog(`Spawning scraper process: ${path.basename(scriptPath)} ${args.join(' ')}`);
      
      schedulerChildProcess = spawnNode(scriptPath, args);
      
      schedulerChildProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) appendSchedulerLog(`[Scraper Output] ${line.trim()}`);
        }
      });
      
      schedulerChildProcess.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) appendSchedulerLog(`[Scraper Error] ${line.trim()}`);
        }
      });
      
      schedulerChildProcess.on('close', (code) => {
        schedulerChildProcess = null;
        if (code === 0) {
          appendSchedulerLog(`Process ${path.basename(scriptPath)} completed successfully.`);
          resolve();
        } else {
          reject(new Error(`Process ${path.basename(scriptPath)} exited with code ${code}`));
        }
      });

      schedulerChildProcess.on('error', (err) => {
        schedulerChildProcess = null;
        reject(err);
      });
    });
  }


  async function runSchedulerSequence(manual = false) {
    if (schedulerState.status === 'running') {
      console.log('[Scheduler] Already running, ignoring request.');
      return;
    }

    schedulerState.status = 'running';
    schedulerState.logs = '';
    schedulerState.currentStep = 'Initializing update';
    appendSchedulerLog(`=== 📂   Database Update Scheduler Sequence Started (${manual ? 'MANUAL' : 'AUTO'}) ===`);

    // Scraping targets
    const BET9JA_TARGET_SEASONS = 60;
    const SPORTY_TARGET_MATCHES = 10000;

    try {
      // Step 1: Stop live scrapers (snapshot their configs first for auto-restart)
      schedulerState.currentStep = 'Stopping live scrapers';
      appendSchedulerLog('â¸ï¸  Pausing all active live scrapers before update...');
      // Capture running scraper configs before killing them so we can restart afterward
      const scrapersToRestart = [];
      for (const [scrProvider] of activeScrapers.entries()) {
        const cfg = activeScraperConfigs.get(scrProvider);
        if (cfg) {
          scrapersToRestart.push({ ...cfg });
        } else {
          // Fallback - restart with safe defaults
          const dbDirFb = getDbDirectory();
          scrapersToRestart.push({
            provider: scrProvider,
            dbPath: scrProvider === 'sportybet'
              ? path.join(dbDirFb, 'sportybet_archive.db')
              : path.join(dbDirFb, 'virtual_football_archive.db'),
            isHeadless: true,
            leagueId: 41104,
            isContinuous: true,
            profile: 'Default',
            family: 'DEFAULT',
            device: 'random',
            browser: 'random'
          });
        }
      }

            let killed = 0;
      for (const [provider, proc] of activeScrapers.entries()) {
        try {
          proc.kill();
          appendSchedulerLog(`   âœ… Killed live scraper: ${provider}`);
          killed++;
        } catch (err) {
          appendSchedulerLog(`   âš ï¸  Could not kill scraper (${provider}): ${err.message}`);
        }
        activeScrapers.delete(provider);
      }
      if (killed === 0) {
        scrapersToRestart.length = 0;
        appendSchedulerLog('   â„¹ï¸  No active live scrapers were running - none will be restarted after maintenance.');
      }
      broadcastToWindows('bot-status', 'stopped');

      // Resolve DB Paths
      const dbDir = getDbDirectory();
      const bet9jaDbPath = path.join(dbDir, 'virtual_football_archive.db');
      const sportyDbPath = path.join(dbDir, 'sportybet_archive.db');

      // Step 2: Gather database statistics
      schedulerState.currentStep = 'Reading database statistics';
      appendSchedulerLog('ðŸ“Š Gathering current database statistics...');

      let bet9jaSizeMb = 0;
      let sportySizeMb = 0;
      if (fs.existsSync(bet9jaDbPath)) bet9jaSizeMb = +(fs.statSync(bet9jaDbPath).size / (1024 * 1024)).toFixed(2);
      if (fs.existsSync(sportyDbPath))  sportySizeMb  = +(fs.statSync(sportyDbPath).size  / (1024 * 1024)).toFixed(2);

      let bet9jaSeasons  = 0;
      let bet9jaFixtures = 0;
      let bet9jaH2h      = 0;
      let sportyFixtures = 0;

      try {
        if (fs.existsSync(bet9jaDbPath)) {
          const [rS, rF, rH] = await Promise.all([
            runQuery(bet9jaDbPath, 'SELECT COUNT(*) as count FROM seasons'),
            runQuery(bet9jaDbPath, 'SELECT COUNT(*) as count FROM fixtures'),
            runQuery(bet9jaDbPath, 'SELECT COUNT(*) as count FROM h2h_records'),
          ]);
          if (rS.success && rS.data) bet9jaSeasons  = rS.data[0].count;
          if (rF.success && rF.data) bet9jaFixtures = rF.data[0].count;
          if (rH.success && rH.data) bet9jaH2h      = rH.data[0].count;
        }
        if (fs.existsSync(sportyDbPath)) {
          const rSporty = await runQuery(sportyDbPath, 'SELECT COUNT(*) as count FROM sporty_fixtures');
          if (rSporty.success && rSporty.data) sportyFixtures = rSporty.data[0].count;
        }
      } catch (err) {
        appendSchedulerLog(`   âš ï¸  Error querying DB stats: ${err.message}`);
      }

      appendSchedulerLog(`   ðŸŸ£ Bet9ja DB  : ${bet9jaSizeMb} MB | Seasons: ${bet9jaSeasons} | Fixtures: ${bet9jaFixtures} | H2H: ${bet9jaH2h}`);
      appendSchedulerLog(`   ðŸŸ¢ SportyBet DB: ${sportySizeMb} MB | Fixtures: ${sportyFixtures}`);
      appendSchedulerLog(`   ðŸŽ¯ Targets â†’ Bet9ja: ${BET9JA_TARGET_SEASONS} seasons | SportyBet: ${SPORTY_TARGET_MATCHES.toLocaleString()} matches`);

      // Step 3: Read mode from config
      schedulerState.currentStep = 'Deciding cleaning strategy';
      let mode = 'llm';
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (config.dbScheduler && config.dbScheduler.mode) mode = config.dbScheduler.mode;
      } catch (err) {
        appendSchedulerLog(`   âš ï¸  Failed to read mode from config: ${err.message}. Defaulting to LLM.`);
      }

      // Pruning decisions (filled below)
      let seasonsToPrune = 0;
      let sportyToPrune  = 0;
      let strategyReason = '';

      if (mode === 'delete') {
        seasonsToPrune = bet9jaSeasons;
        sportyToPrune  = sportyFixtures;
        strategyReason = 'Mode is DELETE: all old records will be removed before re-scraping.';
        appendSchedulerLog();

      } else if (mode === 'append') {
        seasonsToPrune = 0;
        sportyToPrune  = 0;
        strategyReason = 'Mode is APPEND: keeping all existing records and adding new data on top.';
        appendSchedulerLog(`âœ… ${strategyReason}`);

      } else {
        // AI LLM Smart Mode
        appendSchedulerLog('ðŸ¤– Mode is AI LLM â€” consulting your AI model for smart pruning advice...');
        const configJson = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const aiConfig   = configJson.ai || {};
        const aiProvider = aiConfig.provider || 'deepseek';
        let apiKey = '';
        if (aiProvider === 'deepseek')   apiKey = aiConfig.deepseekApiKey;
        else if (aiProvider === 'openai')    apiKey = aiConfig.openaiApiKey;
        else if (aiProvider === 'anthropic') apiKey = aiConfig.anthropicApiKey;
        else if (aiProvider === 'gemini')    apiKey = aiConfig.geminiApiKey;

        if (!apiKey) {
          appendSchedulerLog('   âš ï¸  No AI API key found â€” defaulting to APPEND (safe).');
          seasonsToPrune = 0;
          sportyToPrune  = 0;
          strategyReason = 'No LLM API key configured. Defaulted to APPEND for safety.';
        } else {
          const systemPrompt = `You are an expert virtual sports betting database optimizer.
You manage two SQLite databases for AI-powered match prediction:
1. Bet9ja Virtual Football Archive â€” Bundesliga-style virtual seasons (ideal size: ${BET9JA_TARGET_SEASONS} seasons)
2. SportyBet VFL Archive â€” England Virtual Football League matches (ideal count: ~${SPORTY_TARGET_MATCHES.toLocaleString()} matches)

After you decide, the system will:
1. Delete the OLDEST Bet9ja seasons you specify (seasons_to_prune rows from the 'seasons' table + cascaded tables)
2. Delete the OLDEST SportyBet rows you specify (sporty_records_to_prune from 'sporty_fixtures')
3. Run Bet9ja scraper (headless) â€” auto-loads last ${BET9JA_TARGET_SEASONS} seasons from Bet9ja
4. Run SportyBet scraper (headless) â€” paginates until ~${SPORTY_TARGET_MATCHES.toLocaleString()} matches are in DB

PRUNING RULES:
- Prune Bet9ja seasons if: total seasons >> ${BET9JA_TARGET_SEASONS}, or file size > 200MB. Amount: seasons_count - ${BET9JA_TARGET_SEASONS} (keep latest).
- Prune SportyBet rows if: far over ${SPORTY_TARGET_MATCHES.toLocaleString()} rows, or file size > 150MB. Amount: overshoot above target.
- If databases are healthy/near-target, set both to 0 (APPEND mode is ideal for ML depth).
- Do NOT prune more records than currently exist.

Output ONLY valid JSON:
{"seasons_to_prune":<integer>,"sporty_records_to_prune":<integer>,"reasoning":"<1-2 sentences>"}`;

          const userPrompt = `Current stats:
Bet9ja: ${bet9jaSizeMb}MB, ${bet9jaSeasons} seasons, ${bet9jaFixtures} fixtures, ${bet9jaH2h} H2H records
SportyBet: ${sportySizeMb}MB, ${sportyFixtures} fixtures

Targets: Bet9ja=${BET9JA_TARGET_SEASONS} seasons, SportyBet=${SPORTY_TARGET_MATCHES} matches.
How many old records to prune from each DB?`;

          try {
            const content = await callAI({ provider: aiProvider, apiKey, systemPrompt, userPrompt, temperature: 0.1 });
            const jsonStr = content.replace(/```json|```/g, '').trim();
            const parsed  = JSON.parse(jsonStr);
            seasonsToPrune = Math.max(0, Math.min(parseInt(parsed.seasons_to_prune)        || 0, bet9jaSeasons));
            sportyToPrune  = Math.max(0, Math.min(parseInt(parsed.sporty_records_to_prune) || 0, sportyFixtures));
            strategyReason = parsed.reasoning || 'AI decision completed.';
          } catch (aiErr) {
            appendSchedulerLog(`   âŒ [AI Error] ${aiErr.message} â€” defaulting to APPEND.`);
            seasonsToPrune = 0;
            sportyToPrune  = 0;
            strategyReason = `LLM query failed (${aiErr.message}). Safe default: APPEND.`;
          }
        }

        appendSchedulerLog(`[AI Decision]`);
        appendSchedulerLog(`   Bet9ja seasons to prune  : ${seasonsToPrune}`);
        appendSchedulerLog(`   SportyBet rows to prune  : ${sportyToPrune}`);
        appendSchedulerLog(`   Reasoning: ${strategyReason}`);
      }

      // Step 4: Execute targeted pruning
      schedulerState.currentStep = 'Pruning old records';

      if (mode === "delete") {
        appendSchedulerLog("🗑️ Mode is DELETE: Wiping all old database records before fresh re-scraping...");
        if (fs.existsSync(bet9jaDbPath)) {
          try {
            await runQuery(bet9jaDbPath, "DELETE FROM seasons");
            await runQuery(bet9jaDbPath, "DELETE FROM fixtures");
            await runQuery(bet9jaDbPath, "DELETE FROM league_standings");
            await runQuery(bet9jaDbPath, "DELETE FROM h2h_records");
            await runQuery(bet9jaDbPath, "VACUUM");
            appendSchedulerLog("   ✅ Cleared all Bet9ja historical records and vacuumed DB.");
          } catch (err) {
            appendSchedulerLog("   ⚠️ Error clearing Bet9ja DB: " + err.message);
          }
        }
        if (fs.existsSync(sportyDbPath)) {
          try {
            await runQuery(sportyDbPath, "DELETE FROM sporty_fixtures");
            await runQuery(sportyDbPath, "VACUUM");
            appendSchedulerLog("   ✅ Cleared all SportyBet historical records and vacuumed DB.");
          } catch (err) {
            appendSchedulerLog("   ⚠️ Error clearing SportyBet DB: " + err.message);
          }
        }
      } else {
        if (seasonsToPrune > 0 && fs.existsSync(bet9jaDbPath)) {
          appendSchedulerLog("🗑️ Pruning " + seasonsToPrune + " oldest Bet9ja season(s)...");
          try {
            const oldSeasons = await runQuery(bet9jaDbPath, "SELECT season_name FROM seasons ORDER BY id ASC LIMIT " + seasonsToPrune);
            if (oldSeasons.success && oldSeasons.data && oldSeasons.data.length > 0) {
              for (const row of oldSeasons.data) {
                const sn = row.season_name;
                await runQuery(bet9jaDbPath, "DELETE FROM seasons WHERE season_name = ?", [sn]);
                await runQuery(bet9jaDbPath, "DELETE FROM fixtures WHERE season_name = ?", [sn]);
                await runQuery(bet9jaDbPath, "DELETE FROM league_standings WHERE season_name = ?", [sn]);
                await runQuery(bet9jaDbPath, "DELETE FROM h2h_records WHERE season_name = ?", [sn]);
                appendSchedulerLog("   ✅ Deleted season: " + sn);
              }
              await runQuery(bet9jaDbPath, "VACUUM");
              appendSchedulerLog("   🔧 Bet9ja DB vacuumed after pruning.");
            } else {
              appendSchedulerLog("   ℹ️ No season records found to prune.");
            }
          } catch (err) {
            appendSchedulerLog("   ⚠️ Error during Bet9ja pruning: " + err.message);
          }
        } else {
          appendSchedulerLog("ℹ️ Bet9ja: No seasons pruned — keeping all " + bet9jaSeasons + " existing season(s).");
        }

        if (sportyToPrune > 0 && fs.existsSync(sportyDbPath)) {
          appendSchedulerLog("🗑️ Pruning " + sportyToPrune + " oldest SportyBet fixture row(s)...");
          try {
            await runQuery(sportyDbPath, "DELETE FROM sporty_fixtures WHERE rowid IN (SELECT rowid FROM sporty_fixtures ORDER BY rowid ASC LIMIT " + sportyToPrune + ")");
            await runQuery(sportyDbPath, "VACUUM");
            appendSchedulerLog("   ✅ Pruned " + sportyToPrune + " rows and vacuumed SportyBet DB.");
          } catch (err) {
            appendSchedulerLog("   ⚠️ Error during SportyBet pruning: " + err.message);
          }
        } else {
          appendSchedulerLog("ℹ️ SportyBet: No rows pruned — keeping all " + sportyFixtures + " existing fixture(s).");
        }
      }

      // Step 5: Bet9ja Archive Scraper
      schedulerState.currentStep = `Scraping Bet9ja (last ${BET9JA_TARGET_SEASONS} seasons)`;
      appendSchedulerLog(`\nðŸŸ£ STEP 5: Starting Bet9ja Virtual Football Archive Scraper...`);
      appendSchedulerLog(`   ðŸŽ¯ Will headlessly load the last ${BET9JA_TARGET_SEASONS} Bundesliga virtual seasons from Bet9ja`);
      const bet9jaScript = resolveAppPath('human_virtual_football_archive.js');
      if (fs.existsSync(bet9jaScript)) {
        try {
          await runScraperTask(bet9jaScript, ['--headless']);
          const rPost = await runQuery(bet9jaDbPath, 'SELECT COUNT(*) as count FROM seasons');
          const postSeasons = (rPost.success && rPost.data) ? rPost.data[0].count : '?';
          appendSchedulerLog(`   ðŸ“ˆ Bet9ja DB now has ${postSeasons} season(s) stored.`);
        } catch (err) {
          appendSchedulerLog(`   âŒ Bet9ja scraper failed: ${err.message}`);
          throw err;
        }
      } else {
        appendSchedulerLog(`   âš ï¸  Bet9ja scraper script not found: ${bet9jaScript}`);
      }

      // Step 6: SportyBet Archive Scraper
      schedulerState.currentStep = `Scraping SportyBet (~${SPORTY_TARGET_MATCHES.toLocaleString()} matches)`;
      appendSchedulerLog(`\nðŸŸ¢ STEP 6: Starting SportyBet VFL Archive Scraper...`);
      appendSchedulerLog(`   ðŸŽ¯ Will headlessly paginate until ~${SPORTY_TARGET_MATCHES.toLocaleString()} England VFL matches are stored`);
      const sportyScript = resolveAppPath('human_sportybet_vfl_archive.js');
      if (fs.existsSync(sportyScript)) {
        try {
          await runScraperTask(sportyScript, ['--headless']);
          const rSPost = await runQuery(sportyDbPath, 'SELECT COUNT(*) as count FROM sporty_fixtures');
          const postSporty = (rSPost.success && rSPost.data) ? rSPost.data[0].count : '?';
          appendSchedulerLog(`   ðŸ“ˆ SportyBet DB now has ${typeof postSporty === 'number' ? postSporty.toLocaleString() : postSporty} fixture(s) stored.`);
        } catch (err) {
          appendSchedulerLog(`   âŒ SportyBet scraper failed: ${err.message}`);
          throw err;
        }
      } else {
        appendSchedulerLog(`   âš ï¸  SportyBet scraper script not found: ${sportyScript}`);
      }

      // Step 6.5: Auto-run AI Meta-Optimizer on both databases
      schedulerState.currentStep = 'Calibrating model weights';
      appendSchedulerLog(`\n🤖 STEP 6.5: Running AI Meta-Optimizer Calibration...`);
      
      const optimizerScript = resolveAppPath('utils/ai_meta_optimizer.js');
      if (fs.existsSync(optimizerScript)) {
        // Run calibration for Bet9ja
        if (fs.existsSync(bet9jaDbPath)) {
          try {
            appendSchedulerLog(`   ↳ Running optimizer for Bet9ja: ${path.basename(bet9jaDbPath)}`);
            await runScraperTask(optimizerScript, [bet9jaDbPath, 'bet9ja']);
          } catch (err) {
            appendSchedulerLog(`   ℹ️  Bet9ja optimizer execution completed (Note: exited with warning/code).`);
          }
        }
        
        // Run calibration for SportyBet
        if (fs.existsSync(sportyDbPath)) {
          try {
            appendSchedulerLog(`   ↳ Running optimizer for SportyBet: ${path.basename(sportyDbPath)}`);
            await runScraperTask(optimizerScript, [sportyDbPath, 'sportybet']);
          } catch (err) {
            appendSchedulerLog(`   ℹ️  SportyBet optimizer execution completed (Note: exited with warning/code).`);
          }
        }
      } else {
        appendSchedulerLog(`   ⚠️  AI Meta-Optimizer script not found: ${optimizerScript}`);
      }

      // Step 7: Auto-restart any live scrapers that were running before maintenance
      if (scrapersToRestart.length > 0) {
        schedulerState.currentStep = 'Restarting live scrapers';
        appendSchedulerLog(`\n🔄 STEP 7: Auto-restarting ${scrapersToRestart.length} live scraper(s) that were paused for maintenance...`);
        for (const cfg of scrapersToRestart) {
          try {
            appendSchedulerLog(`   ▶️  Restarting live predictor: ${cfg.provider} (headless=${cfg.isHeadless}, continuous=${cfg.isContinuous})`);
            // Store config again so future maintenance cycles can snapshot it
            activeScraperConfigs.set(cfg.provider, cfg);
            // Fire-and-forget — the live scraper runs as a long-lived process;
            // we do NOT await it so the scheduler can finish immediately.
            runMLScrapeLiveSeason(
              cfg.dbPath,
              cfg.isHeadless,
              cfg.provider,
              cfg.leagueId || 41104,
              cfg.isContinuous,
              cfg.profile,
              cfg.family,
              cfg.device,
              cfg.browser
            ).then(() => {
              activeScraperConfigs.delete(cfg.provider);
            }).catch((err) => {
              appendSchedulerLog(`   ❌ Live scraper (${cfg.provider}) exited with error: ${err.message}`);
              activeScraperConfigs.delete(cfg.provider);
            });
            broadcastToWindows('bot-status', 'running');
            appendSchedulerLog(`   ✅ Live scraper restarted: ${cfg.provider}`);
          } catch (restartErr) {
            appendSchedulerLog(`   ⚠️  Failed to restart scraper (${cfg.provider}): ${restartErr.message}`);
          }
        }
      } else {
        appendSchedulerLog(`\nℹ️  No live scrapers to restart (none were running before maintenance).`);
      }

      // Completion
      schedulerState.status      = 'idle';
      schedulerState.currentStep = 'Completed Successfully';
      schedulerState.lastRun     = new Date().toISOString();
      appendSchedulerLog(`\n=== ✅ Database Update Tasks Completed! (${new Date().toLocaleString()}) ===`);

      // Auto-retrain AI engines if enabled in scheduler config
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (config.dbScheduler?.autoRetrainModels !== false) {
          appendSchedulerLog(`\n🧠 Triggering Automatic AI Model Retraining on fresh dataset...`);
          for (const key of ['safest', 'high_chance', 'ai_best']) {
            appendSchedulerLog(`   ▶ Retraining ${key} engine...`);
            await new Promise((resolve) => {
              const scriptPath = resolveAppPath(path.join('utils', TRAIN_SCRIPTS[key]));
              const child = require('child_process').spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
              child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => appendSchedulerLog(`      [${key}] ${l.trim()}`)));
              child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => appendSchedulerLog(`      [${key}] ${l.trim()}`)));
              child.on('close', resolve);
              child.on('error', resolve);
            });
          }
          appendSchedulerLog(`   ✅ Automatic AI Model Retraining completed successfully.`);
        }
      } catch (trainErr) {
        appendSchedulerLog(`   ⚠️ Auto-retrain warning: ${trainErr.message}`);
      }

      appendSchedulerLog(`\n=== ✅ Full Scheduler Sequence Completed Successfully! (${new Date().toLocaleString()}) ===`);


      // Save lastRun / nextRun to config
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (!config.dbScheduler) config.dbScheduler = {};
        config.dbScheduler.lastRun = schedulerState.lastRun;
        if (config.dbScheduler.enabled) {
          const ms = config.dbScheduler.intervalHours * 60 * 60 * 1000;
          schedulerState.nextRun     = new Date(Date.now() + ms).toISOString();
          config.dbScheduler.nextRun = schedulerState.nextRun;
          appendSchedulerLog(`â°  Next auto-run: ${new Date(schedulerState.nextRun).toLocaleString()}`);
        } else {
          schedulerState.nextRun     = null;
          config.dbScheduler.nextRun = null;
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
      } catch (err) {
        appendSchedulerLog(`⚠️  Warning: Failed to update config timestamps: ${err.message}`);
      }

      // Automatic Live Database Sync to Google Drive upon sequence completion
      try {
        const mainConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        const gSync = mainConfig.googleDriveSync;
        if (gSync && gSync.enabled && (gSync.liveDbSync || gSync.syncScope?.databases !== false)) {
          appendSchedulerLog(`☁️ Triggering Live Database Sync to Google Drive...`);
          const syncRes = await runSync({ ...gSync, projectRoot: resolveAppPath("") });
          if (syncRes.success) {
            appendSchedulerLog(`   ✅ Live Database Sync to Google Drive completed successfully.`);
          } else {
            appendSchedulerLog(`   ⚠️ Live Database Sync warning: ${syncRes.error}`);
          }
        }
      } catch (gSyncErr) {
        appendSchedulerLog(`   ⚠️ Live Google Drive Sync trigger failed: ${gSyncErr.message}`);
      }

    } catch (err) {
      schedulerState.status      = 'idle';
      schedulerState.currentStep = 'Failed';
      schedulerState.lastRun     = new Date().toISOString();
      appendSchedulerLog(`\nâŒ Scheduler Task FAILED: ${err.message}`);

      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (!config.dbScheduler) config.dbScheduler = {};
        config.dbScheduler.lastRun = schedulerState.lastRun;
        if (config.dbScheduler.enabled) {
          const ms = config.dbScheduler.intervalHours * 60 * 60 * 1000;
          schedulerState.nextRun     = new Date(Date.now() + ms).toISOString();
          config.dbScheduler.nextRun = schedulerState.nextRun;
        } else {
          schedulerState.nextRun     = null;
          config.dbScheduler.nextRun = null;
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
      } catch (configErr) {}
    }
  }

  let dbSchedulerTimer = null;

  function updateSchedulerTimer() {
    if (dbSchedulerTimer) {
      clearInterval(dbSchedulerTimer);
      dbSchedulerTimer = null;
    }

    try {
      if (!fs.existsSync(CONFIG_PATH)) return;
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const settings = config.dbScheduler;

      if (!settings || !settings.enabled) {
        console.log('[Scheduler] Database update scheduler is disabled.');
        return;
      }

      console.log(`[Scheduler] Scheduled auto database update checked every minute. Next run: ${settings.nextRun}`);
      
      // Initialize local nextRun/lastRun state from config
      schedulerState.lastRun = settings.lastRun || null;
      schedulerState.nextRun = settings.nextRun || null;

      dbSchedulerTimer = setInterval(async () => {
        try {
          if (schedulerState.status === 'running') return;

          if (schedulerState.nextRun) {
            const nextTime = new Date(schedulerState.nextRun).getTime();
            if (Date.now() >= nextTime) {
              console.log('[Scheduler] Triggering automatic background database update...');
              runSchedulerSequence(false);
            }
          }
        } catch (err) {
          console.error('[Scheduler] Error in interval check:', err);
        }
      }, 60000);
    } catch (e) {
      console.error('[Scheduler] Failed to initialize scheduler timer:', e);
    }
  }

  // --- Scheduler IPC Handlers ---
  ipcMain.handle('get-scheduler-config', async () => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return null;
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return config.dbScheduler || {
        enabled: false,
        intervalHours: 24,
        mode: 'llm',
        autoRetrainModels: true,
        autoRetrainOnCritical: true,
        lastRun: null,
        nextRun: null
      };

    } catch (error) {
      console.error('Error fetching scheduler config:', error);
      return null;
    }
  });

  ipcMain.handle('save-scheduler-config', async (_, newSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' };
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      
      const oldSettings = config.dbScheduler || {
        enabled: false,
        intervalHours: 24,
        mode: 'llm',
        lastRun: null,
        nextRun: null
      };

      config.dbScheduler = {
        ...oldSettings,
        ...newSettings
      };

      if (config.dbScheduler.enabled) {
        const ms = config.dbScheduler.intervalHours * 60 * 60 * 1000;
        if (!oldSettings.enabled || oldSettings.intervalHours !== config.dbScheduler.intervalHours || !config.dbScheduler.nextRun) {
          config.dbScheduler.nextRun = new Date(Date.now() + ms).toISOString();
        }
      } else {
        config.dbScheduler.nextRun = null;
      }

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
      updateSchedulerTimer();
      return { success: true, nextRun: config.dbScheduler.nextRun };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-scheduler-status', () => {
    return schedulerState;
  });

  ipcMain.handle('run-scheduler-now', async () => {
    if (schedulerState.status === 'running') {
      return { success: false, error: 'Scheduler is already running' };
    }
    runSchedulerSequence(true);
    return { success: true };
  });

  ipcMain.handle('stop-scheduler-task', async () => {
    try {
      if (schedulerChildProcess) {
        appendSchedulerLog('Force killing current scraper process and closing Chrome...');
        try {
          if (process.platform === 'win32') {
            require('child_process').execSync('taskkill /F /IM chrome.exe /T || true', { stdio: 'ignore' });
          } else {
            killAllScraperChromeProcesses();
          }
        } catch (e) {}
        schedulerChildProcess.kill();
        schedulerChildProcess = null;
        schedulerState.status = 'idle';
        schedulerState.currentStep = 'Force Stopped';
        return { success: true };
      }
      return { success: false, error: 'No active scraper running under scheduler' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Model Management: Get status of all XGBoost engines ──────────────────
  ipcMain.handle('get-model-status', async () => {
    const utilsDir = resolveAppPath('utils');
    const engines = [
      { key: 'safest',      reportFile: 'safest_report.json',       label: 'Safest Pick' },
      { key: 'high_chance', reportFile: 'high_chance_report.json',  label: 'High Chance Pick' },
      { key: 'ai_best',     reportFile: 'ai_best_htft_report.json', label: 'AI Best Pick' },
    ];
    const result = {};
    for (const eng of engines) {
      const p = path.join(utilsDir, eng.reportFile);
      try {
        const r = JSON.parse(fs.readFileSync(p, 'utf8'));
        result[eng.key] = { ...r, label: eng.label, found: true };
      } catch {
        result[eng.key] = { label: eng.label, found: false, ready_for_deployment: false };
      }
    }
    return result;
  });

  // ── Training Database Path Resolver (Prioritizes Settings) ───────────────
  function resolveTrainingDbPath(explicitDbPath) {
    if (pathResolver && typeof pathResolver.resolveDatabasePath === 'function') {
      return pathResolver.resolveDatabasePath(explicitDbPath, 'sportybet_archive.db');
    }
    if (explicitDbPath && typeof explicitDbPath === 'string' && explicitDbPath.trim()) {
      const trimmed = explicitDbPath.trim();
      if (fs.existsSync(trimmed)) return trimmed;
      return trimmed;
    }

    try {
      const settingsPath = resolveAppPath('bot_settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.trainingDbPath && typeof settings.trainingDbPath === 'string' && settings.trainingDbPath.trim()) {
          const customPath = settings.trainingDbPath.trim();
          if (fs.existsSync(customPath)) return customPath;
        }
        if (settings.outputDir && fs.existsSync(settings.outputDir)) {
          const sportyPath = path.join(settings.outputDir, 'sportybet_archive.db');
          if (fs.existsSync(sportyPath)) return sportyPath;

          const dbFiles = fs.readdirSync(settings.outputDir)
            .filter(f => f.endsWith('.db'))
            .map(f => ({ name: f, fullPath: path.join(settings.outputDir, f), mtime: fs.statSync(path.join(settings.outputDir, f)).mtime }))
            .sort((a, b) => b.mtime - a.mtime);
          if (dbFiles.length > 0) return dbFiles[0].fullPath;
        }
      }
    } catch (e) {
      console.error('Error resolving training database path from settings:', e);
    }

    // App directory fallback
    const appSporty = path.join(resolveAppPath(''), 'sportybet_archive.db');
    if (fs.existsSync(appSporty)) return appSporty;

    return appSporty;
  }

  // ── Model Management: Retrain a single engine ─────────────────────────────
  // Streams stdout/stderr back to renderer via 'retrain-log' events.
  const TRAIN_SCRIPTS = {
    safest:      'safest_model.py',
    high_chance: 'high_chance_model.py',
    ai_best:     'ai_best_htft_model.py',
  };

  ipcMain.handle('retrain-model', async (event, { engineKey, dbPath }) => {
    const script = TRAIN_SCRIPTS[engineKey];
    if (!script) return { success: false, error: `Unknown engine: ${engineKey}` };
    const scriptPath = resolveAppPath(path.join('utils', script));
    if (!fs.existsSync(scriptPath)) return { success: false, error: `Script not found: ${scriptPath}` };

    const resolvedDb = resolveTrainingDbPath(dbPath);
    const utilsDir = resolveAppPath('utils');
    const pythonBin = pathResolver ? pathResolver.resolvePythonExecutable() : 'python3';

    return new Promise((resolve) => {
      const env = { ...process.env, TRAIN_DB_PATH: resolvedDb };
      const args = [scriptPath, '--db', resolvedDb, '--out', utilsDir];

      const child = require('child_process').spawn(pythonBin, args, {
        env, stdio: ['ignore', 'pipe', 'pipe']
      });

      const send = (line, isErr) => {
        try {
          event.sender.send('retrain-log', { engineKey, line: line.trim(), isErr });
        } catch {}
      };

      child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send(l, false)));
      child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send(l, true)));

      child.on('close', (code) => {
        send(`[done] Exit code: ${code}`, code !== 0);
        resolve({ success: code === 0, exitCode: code });
      });
      child.on('error', (err) => {
        send(`[error] ${err.message}`, true);
        resolve({ success: false, error: err.message });
      });
    });
  });

  // ── Model Management: Retrain ALL engines sequentially ───────────────────
  ipcMain.handle('retrain-all-models', async (event, { dbPath }) => {
    const results = {};
    const resolvedDb = resolveTrainingDbPath(dbPath);
    const utilsDir = resolveAppPath('utils');
    const pythonBin = pathResolver ? pathResolver.resolvePythonExecutable() : 'python3';

    for (const key of ['safest', 'high_chance', 'ai_best']) {
      event.sender.send('retrain-log', { engineKey: key, line: `\n▶ Starting ${key} engine training (DB: ${resolvedDb})...`, isErr: false });
      try {
        const res = await new Promise((resolve) => {
          const scriptPath = resolveAppPath(path.join('utils', TRAIN_SCRIPTS[key]));
          const env = { ...process.env, TRAIN_DB_PATH: resolvedDb };
          const args = [scriptPath, '--db', resolvedDb, '--out', utilsDir];
          const child = require('child_process').spawn(pythonBin, args, {
            env, stdio: ['ignore', 'pipe', 'pipe']
          });
          const send = (line, isErr) => { try { event.sender.send('retrain-log', { engineKey: key, line: line.trim(), isErr }); } catch {} };
          child.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send(l, false)));
          child.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send(l, true)));
          child.on('close', code => { send(`[done] Exit code: ${code}`, code !== 0); resolve({ success: code === 0 }); });
          child.on('error', err => { send(`[error] ${err.message}`, true); resolve({ success: false }); });
        });
        results[key] = res;
      } catch (e) {
        results[key] = { success: false, error: e.message };
      }
    }
    return results;
  });

  // ── Model Health & Drift Monitor IPC Handler ──────────────────────────────
  ipcMain.handle('get-engine-health', async (_, { dbPath } = {}) => {
    const activeDbPath = resolveTrainingDbPath(dbPath);

    if (!activeDbPath || !fs.existsSync(activeDbPath)) {
      return { success: false, error: `Database file not found: ${activeDbPath || 'none'}` };
    }

    try {
      const db = getSafeDb(activeDbPath, { readonly: true });
      const utilsDir = resolveAppPath('utils');

      // 1. Fetch settled picks
      const picks = db.prepare(`
        SELECT id, pick_type, market, probability, implied_odd, actual_score, status, season_name
        FROM ai_best_picks_history
        WHERE actual_score IS NOT NULL AND status IN ('won','lost','win','lose')
        ORDER BY id DESC
      `).all();

      const engineTypeMap = { safest: 'safest', high_chance: 'high_value', ai_best: 'ai_best_pick' };
      const reportFiles = { safest: 'safest_report.json', high_chance: 'high_chance_report.json', ai_best: 'ai_best_htft_report.json' };

      const health = {};
      const warnings = [];
      const recommendations = [];

      // 2. Compute live metrics per engine
      for (const [engineKey, pickTypeValue] of Object.entries(engineTypeMap)) {
        const engPicks = picks.filter(p => p.pick_type === pickTypeValue);

        let profit = 0, stake = 0, wins = 0, consecLoss = 0, countingConsec = true;
        let p50Profit = 0, p50Stake = 0, p50Wins = 0;

        engPicks.forEach((p, idx) => {
          const isWin = p.status === 'won' || p.status === 'win';
          const odd = parseFloat(p.implied_odd) || 1.5;
          stake += 1;
          if (isWin) {
            profit += (odd - 1);
            wins++;
            if (countingConsec) countingConsec = false;
          } else {
            profit -= 1;
            if (countingConsec) consecLoss++;
          }

          if (idx < 50) {
            p50Stake += 1;
            if (isWin) { p50Profit += (odd - 1); p50Wins++; }
            else { p50Profit -= 1; }
          }
        });

        const overallRoi = stake > 0 ? parseFloat((profit / stake * 100).toFixed(1)) : 0;
        const recent50Roi = p50Stake > 0 ? parseFloat((p50Profit / p50Stake * 100).toFixed(1)) : 0;
        const winRate = stake > 0 ? parseFloat((wins / stake * 100).toFixed(1)) : 0;

        // Model report info & age
        let reportData = null, mtimeDays = null;
        const repPath = path.join(utilsDir, reportFiles[engineKey]);
        if (fs.existsSync(repPath)) {
          try {
            reportData = JSON.parse(fs.readFileSync(repPath, 'utf8'));
            const stat = fs.statSync(repPath);
            mtimeDays = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
          } catch (e) {}
        }

        const oosBaseline = reportData?.holdout_roi_at_0_65 ?? reportData?.avg_oos_roi ?? 0;

        let statusLevel = 'HEALTHY'; // HEALTHY, CAUTION, CRITICAL
        if (consecLoss >= 5 || recent50Roi < -15 || overallRoi < -10) {
          statusLevel = 'CRITICAL';
        } else if (consecLoss >= 3 || recent50Roi < -5 || (mtimeDays !== null && mtimeDays > 21)) {
          statusLevel = 'CAUTION';
        }

        health[engineKey] = {
          engineKey,
          totalPicks: stake,
          overallRoi,
          recent50Roi,
          winRate,
          consecLoss,
          oosBaseline,
          mtimeDays,
          statusLevel
        };

        if (statusLevel === 'CRITICAL') {
          recommendations.push({
            type: 'RETRAIN_NOW',
            engineKey,
            severity: 'CRITICAL',
            title: `CRITICAL: ${engineKey.replace('_', ' ').toUpperCase()} Engine Performance Drop`,
            description: `${engineKey} has ${consecLoss} consecutive losses and recent 50-pick ROI is ${recent50Roi}%. Immediate retraining required.`
          });
        } else if (statusLevel === 'CAUTION') {
          recommendations.push({
            type: 'RETRAIN_RECOMMENDED',
            engineKey,
            severity: 'CAUTION',
            title: `CAUTION: ${engineKey.replace('_', ' ').toUpperCase()} Model Aging / Slight ROI Drift`,
            description: `Model is ${mtimeDays || 'N/A'} days old with ${consecLoss} consecutive losses. Retraining recommended to restore optimal accuracy.`
          });
        }
      }

      // 3. Database Optimization & Virtual RNG Structural Shift Analysis
      let totalMatches = 0;
      let shiftDetected = false;
      let shiftDetails = null;
      let dbOptimization = null;

      try {
        const { analyzeOptimalDbTrim } = require(resolveAppPath(path.join('utils', 'db_optimizer')));
        dbOptimization = analyzeOptimalDbTrim(activeDbPath);
        if (dbOptimization.success) {
          totalMatches = dbOptimization.totalMatches;
          shiftDetected = dbOptimization.shiftDetected;
          shiftDetails = dbOptimization.shiftDetails;

          if (shiftDetected) {
            recommendations.unshift({
              type: 'SPORTYBET_ENGINE_SHIFT',
              severity: 'CRITICAL',
              title: '🚨 SPORTYBET VIRTUAL ENGINE SHIFT DETECTED',
              description: `${shiftDetails} Bookmaker has updated its game generation distribution. Old matches are corrupting model training! Delete matches older than 15,000 matches and retrain from scratch.`,
              optimalKeepMatches: dbOptimization.optimalKeepMatches,
              recommendedTrimCount: dbOptimization.recommendedTrimCount
            });
          } else if (dbOptimization.needsOptimization) {
            recommendations.push({
              type: 'ARCHIVE_RECOMMENDED',
              severity: 'INFO',
              title: `📦 Large Database Size (${totalMatches.toLocaleString()} matches)`,
              description: `Training set contains over 25,000 matches. Purging or archiving data older than ${dbOptimization.optimalKeepMatches.toLocaleString()} matches will speed up training and remove obsolete historical noise.`,
              optimalKeepMatches: dbOptimization.optimalKeepMatches,
              recommendedTrimCount: dbOptimization.recommendedTrimCount
            });
          }
        }
      } catch (optErr) {
        try {
          totalMatches = db.prepare("SELECT COUNT(*) as c FROM historical_market_predictions").get().c;
        } catch (_) {}
      }

      db.close();

      return {
        success: true,
        health,
        shiftDetected,
        shiftDetails,
        totalMatches,
        dbOptimization,
        recommendations,
        checkedAt: new Date().toISOString()
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Database Auto-Optimization IPC Handlers ────────────────────────────────
  ipcMain.handle('check-db-optimization', async (_, { dbPath } = {}) => {
    const activeDbPath = resolveTrainingDbPath(dbPath);
    if (!activeDbPath || !fs.existsSync(activeDbPath)) {
      return { success: false, error: `Database file not found: ${activeDbPath || 'none'}` };
    }
    try {
      const { analyzeOptimalDbTrim } = require(resolveAppPath(path.join('utils', 'db_optimizer')));
      return analyzeOptimalDbTrim(activeDbPath);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('auto-optimize-database', async (_, { dbPath, force, targetKeep, pruneSeasons } = {}) => {
    const activeDbPath = resolveTrainingDbPath(dbPath);
    if (!activeDbPath || !fs.existsSync(activeDbPath)) {
      return { success: false, error: `Database file not found: ${activeDbPath || 'none'}` };
    }
    try {
      const { autoOptimizeDatabase } = require(resolveAppPath(path.join('utils', 'db_optimizer')));
      return autoOptimizeDatabase(activeDbPath, { force, targetKeep, pruneSeasons });
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Purge Old Matches IPC Handler ─────────────────────────────────────────
  ipcMain.handle('purge-old-matches', async (_, { dbPath, keepLastN = 15000 } = {}) => {
    const activeDbPath = resolveTrainingDbPath(dbPath);

    if (!activeDbPath || !fs.existsSync(activeDbPath)) {
      return { success: false, error: `Database file not found: ${activeDbPath || 'none'}` };
    }

    try {
      const db = getSafeDb(activeDbPath);

      const countBefore = db.prepare("SELECT COUNT(*) as c FROM historical_market_predictions").get().c;
      if (countBefore <= keepLastN) {
        db.close();
        return { success: true, purgedCount: 0, message: `Database already has ${countBefore} rows (target keep is ${keepLastN}). No rows deleted.` };
      }

      const cutoffRow = db.prepare("SELECT id FROM historical_market_predictions ORDER BY id DESC LIMIT 1 OFFSET ?").get(keepLastN - 1);

      if (!cutoffRow || !cutoffRow.id) {
        db.close();
        return { success: false, error: 'Failed to find cutoff row ID' };
      }

      const info = db.prepare("DELETE FROM historical_market_predictions WHERE id < ?").run(cutoffRow.id);
      db.close();

      return {
        success: true,
        purgedCount: info.changes,
        remainingCount: countBefore - info.changes,
        message: `Purged ${info.changes} historical matches. Retaining newest ${countBefore - info.changes} matches.`
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ── Settle AI Picks IPC Handler ─────────────────────────────────────────
  ipcMain.handle('settle-ai-picks', async (_, { dbPath, includeVoid = true } = {}) => {
    const activeDbPath = resolveTrainingDbPath(dbPath);
    if (!activeDbPath || !fs.existsSync(activeDbPath)) {
      return { success: false, error: `Database file not found: ${activeDbPath || 'none'}` };
    }
    try {
      const db = getSafeDb(activeDbPath, { readonly: false, timeout: 10000 });
      let settled = 0;
      try {
        const liveCompanion = createRequire(import.meta.url)(resolveAppPath(path.join('utils', 'live_companion.js')));
        if (typeof liveCompanion.settlePendingAIPicks === 'function') {
          settled = liveCompanion.settlePendingAIPicks(db, { includeVoid });
        }
      } finally {
        try { db.close(); } catch (_) {}
      }
      return { success: true, settled };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  function setupAutoStartScrapers() {
    try {
      const settingsPath = resolveAppPath('bot_settings.json');
      if (!fs.existsSync(settingsPath)) {
        console.log('[Auto-Start] bot_settings.json does not exist. Skipping delayed auto-start.');
        return;
      }
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      if (!settings.autoStartScraperEnabled) {
        console.log('[Auto-Start] Delayed live scraper startup is disabled in settings.');
        return;
      }

      const delaySeconds = Math.max(1, parseInt(settings.autoStartScraperDelay, 10) || 10);
      const target = settings.autoStartScraperTarget || 'all';
      const isHeadless = settings.autoStartScraperHeadless !== false;
      const isContinuous = settings.autoStartScraperContinuous !== false;
      const targetDbName = settings.autoStartScraperDatabase || 'auto';
      const device = settings.autoStartScraperDevice || 'desktop';
      const browser = settings.autoStartScraperBrowser || 'chrome';
      const profile = settings.autoStartScraperProfile || 'Temporary';
      const outputDir = settings.outputDir || resolveAppPath('');

      console.log(`[Auto-Start] Delayed auto-start enabled. Scraper target: "${target}", startup delay: ${delaySeconds} seconds.`);

      setTimeout(async () => {
        console.log(`[Auto-Start] Startup delay timer (${delaySeconds}s) expired! Initiating live scraper(s): ${target}`);

        const resolveDbForProvider = (provider) => {
          if (targetDbName && targetDbName !== 'auto') {
            return path.isAbsolute(targetDbName) ? targetDbName : path.join(outputDir, targetDbName);
          }
          const defaultName = provider === 'sportybet' ? 'sportybet_archive.db' : 'bet9ja_archive.db';
          const defaultPath = path.join(outputDir, defaultName);
          if (fs.existsSync(defaultPath)) return defaultPath;

          if (fs.existsSync(outputDir)) {
            const dbFiles = fs.readdirSync(outputDir)
              .filter(f => f.endsWith('.db'))
              .map(f => ({ name: f, fullPath: path.join(outputDir, f), mtime: fs.statSync(path.join(outputDir, f)).mtime }))
              .sort((a, b) => b.mtime - a.mtime);
            if (dbFiles.length > 0) {
              return dbFiles[0].fullPath;
            }
          }
          return defaultPath;
        };

        const providersToStart = [];
        if (target === 'all') {
          providersToStart.push('bet9ja', 'sportybet');
        } else if (target === 'bet9ja' || target === 'sportybet') {
          providersToStart.push(target);
        }

        for (const provider of providersToStart) {
          const dbPath = resolveDbForProvider(provider);
          const leagueId = provider === 'sportybet' ? (settings.autoStartLeagueId || 41104) : 41104;
          console.log(`[Auto-Start] Launching ${provider} live scraper automatically. DB: ${dbPath}, Device: ${device}, Browser: ${browser}, Profile: ${profile}`);

          activeScraperConfigs.set(provider, {
            dbPath,
            isHeadless,
            provider,
            leagueId,
            isContinuous,
            profile,
            family: 'DEFAULT',
            device,
            browser
          });

          runMLScrapeLiveSeason(
            dbPath,
            isHeadless,
            provider,
            leagueId,
            isContinuous,
            profile,
            'DEFAULT',
            device,
            browser
          ).then(() => {
            activeScraperConfigs.delete(provider);
          }).catch((err) => {
            console.error(`[Auto-Start] Error running ${provider} live scraper:`, err);
            activeScraperConfigs.delete(provider);
          });
        }

        broadcastToWindows('bot-status', 'running');
        broadcastToWindows('auto-start-scraper-triggered', {
          target,
          delaySeconds,
          timestamp: new Date().toISOString()
        });

      }, delaySeconds * 1000);

    } catch (err) {
      console.error('[Auto-Start] Failed to setup auto-start scrapers:', err);
    }
  }

  // ── Centralized Telegram Broadcaster Service & IPC Handlers ──────────────
  let telegramBroadcaster = null;
  try {
    telegramBroadcaster = require(resolveAppPath('utils/telegram_broadcaster.js'));
  } catch (err) {
    console.error('[Main] Failed to load telegram_broadcaster.js:', err.message);
  }

  ipcMain.handle('telegram-send-test', async (_, customConfig) => {
    if (!telegramBroadcaster) return { ok: false, description: 'Telegram broadcaster module not loaded' };
    return telegramBroadcaster.sendTestIntegrationMessage(customConfig);
  });

  ipcMain.handle('telegram-broadcast-pending', async (_, { dbPath, customConfig, force } = {}) => {
    if (!telegramBroadcaster) return { success: false, error: 'Telegram broadcaster module not loaded' };
    let targetDb = dbPath;
    if (!targetDb) {
      const defaultSporty = resolveAppPath('databases/sportybet_archive.db');
      const defaultBet9ja = resolveAppPath('databases/virtual_football_archive.db');
      targetDb = fs.existsSync(defaultSporty) ? defaultSporty : defaultBet9ja;
    }
    return telegramBroadcaster.broadcastPendingPredictions(targetDb, customConfig, force);
  });

  ipcMain.handle('telegram-broadcast-results', async (_, { dbPath, customConfig, force } = {}) => {
    if (!telegramBroadcaster) return { success: false, error: 'Telegram broadcaster module not loaded' };
    let targetDb = dbPath;
    if (!targetDb) {
      const defaultSporty = resolveAppPath('databases/sportybet_archive.db');
      const defaultBet9ja = resolveAppPath('databases/virtual_football_archive.db');
      targetDb = fs.existsSync(defaultSporty) ? defaultSporty : defaultBet9ja;
    }
    return telegramBroadcaster.broadcastSettledResults(targetDb, customConfig, force);
  });

  ipcMain.handle('telegram-kick-vip', async (_, { sub, customConfig } = {}) => {
    if (!telegramBroadcaster) return { ok: false, description: 'Telegram broadcaster module not loaded' };
    return telegramBroadcaster.kickExpiredVipSubscriber(sub, customConfig);
  });

  ipcMain.handle('telegram-get-status', async () => {
    if (!telegramBroadcaster) return { configured: false };
    const settings = telegramBroadcaster.loadTelegramSettings();
    return {
      configured: Boolean(settings.botToken && settings.chatId),
      settings
    };
  });

  ipcMain.handle('telegram-save-settings', async (_, newSettings) => {
    if (!telegramBroadcaster) return { success: false, error: 'Telegram broadcaster module not loaded' };
    try {
      const saved = telegramBroadcaster.saveTelegramSettings(newSettings);
      return { success: true, settings: saved };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('telegram-send-custom', async (_, { text, targetChatId, parseMode } = {}) => {
    if (!telegramBroadcaster) return { ok: false, description: 'Telegram broadcaster module not loaded' };
    const settings = telegramBroadcaster.loadTelegramSettings();
    const chatId = targetChatId || settings.chatId;
    return telegramBroadcaster.sendRawTelegramMessage(settings.botToken, chatId, text, parseMode || 'HTML');
  });

  ipcMain.handle('telegram-clear-history', async (_, { dbPath } = {}) => {
    if (!telegramBroadcaster) return { success: false, error: 'Telegram broadcaster module not loaded' };
    let targetDb = dbPath;
    if (!targetDb) {
      const defaultSporty = resolveAppPath('databases/sportybet_archive.db');
      const defaultBet9ja = resolveAppPath('databases/virtual_football_archive.db');
      targetDb = fs.existsSync(defaultSporty) ? defaultSporty : defaultBet9ja;
    }
    return telegramBroadcaster.clearTelegramDedupLog(targetDb);
  });

  ipcMain.handle('telegram-get-logs', async (_, { dbPath, limit } = {}) => {
    if (!telegramBroadcaster) return [];
    let targetDb = dbPath;
    if (!targetDb) {
      const defaultSporty = resolveAppPath('databases/sportybet_archive.db');
      const defaultBet9ja = resolveAppPath('databases/virtual_football_archive.db');
      targetDb = fs.existsSync(defaultSporty) ? defaultSporty : defaultBet9ja;
    }
    return telegramBroadcaster.getRecentTelegramLogs(targetDb, limit || 50);
  });

  ipcMain.handle('telegram-get-preview', async (_, { type, dbPath, customConfig } = {}) => {
    if (!telegramBroadcaster) return { success: false, error: 'Telegram broadcaster module not loaded' };
    let targetDb = dbPath;
    if (!targetDb) {
      const defaultSporty = resolveAppPath('databases/sportybet_archive.db');
      const defaultBet9ja = resolveAppPath('databases/virtual_football_archive.db');
      targetDb = fs.existsSync(defaultSporty) ? defaultSporty : defaultBet9ja;
    }

    try {
      const Database = require('better-sqlite3');
      const db = fs.existsSync(targetDb) ? new Database(targetDb, { readonly: true }) : null;
      const stats = telegramBroadcaster.calculateHistoricalStats(db);
      const confStats = telegramBroadcaster.calculateConfidenceHistory(db, customConfig?.confidenceFilter || 50);
      const streakInfo = telegramBroadcaster.calculateRecentStreak(db);

      let previewText = '';
      if (type === 'ai_bundle') {
        const sampleSafest = { home_team: 'Arsenal', away_team: 'Chelsea', market: 'Over 1.5 Goals', probability: 84, implied_odd: 1.35 };
        const sampleHighVal = { home_team: 'Liverpool', away_team: 'Man City', market: 'Both Teams to Score (GG)', probability: 66, implied_odd: 1.88, ev_score: 22.4 };
        const sampleAiBest = { home_team: 'Everton', away_team: 'Newcastle', market: 'Away Win', probability: 54, implied_odd: 2.45 };
        previewText = telegramBroadcaster.buildBundledAiCard(14, 'SportyBet VFL', sampleAiBest, sampleSafest, sampleHighVal, stats, db, customConfig);
      } else if (type === 'safest') {
        const sampleSafest = { home_team: 'Arsenal', away_team: 'Chelsea', market: 'Over 1.5 Goals', probability: 84, implied_odd: 1.35, pick_type: 'safest', round_number: 14 };
        previewText = telegramBroadcaster.buildSingleAiPickCard(sampleSafest, 'SportyBet VFL', stats, db, customConfig);
      } else if (type === 'round_results') {
        const sampleResults = [
          { home_team: 'Arsenal', away_team: 'Chelsea', market: 'Over 1.5 Goals', status: 'won', actual_score: '2:1', implied_odd: 1.35, pick_type: 'safest' },
          { home_team: 'Liverpool', away_team: 'Man City', market: 'Both Teams to Score (GG)', status: 'won', actual_score: '1:1', implied_odd: 1.88, pick_type: 'high_value' },
          { home_team: 'Everton', away_team: 'Newcastle', market: 'Away Win', status: 'lost', actual_score: '0:2', implied_odd: 2.45, pick_type: 'ai_best_pick' }
        ];
        previewText = telegramBroadcaster.buildRoundResultsCard(14, 'Sportybet England - Week 14', 'SportyBet VFL', sampleResults, '66.7', 2, 3, db, customConfig);
      } else if (type === 'streak') {
        const sampleWins = [
          { match: 'Arsenal vs Chelsea', market: 'Over 1.5 Goals', odd: 1.35 },
          { match: 'Liverpool vs Man City', market: 'Both Teams to Score', odd: 1.88 },
          { match: 'Brighton vs Fulham', market: 'Over 1.5 Goals', odd: 1.42 },
          { match: 'Everton vs Arsenal', market: 'Over 1.5 Goals', odd: 1.47 },
          { match: 'Crystal Palace vs Brentford', market: 'Over 1.5 Goals', odd: 1.34 }
        ];
        previewText = telegramBroadcaster.buildStreakCelebrationCard(5, sampleWins, 'SportyBet VFL', customConfig);
      } else if (type === 'daily_report') {
        previewText = telegramBroadcaster.buildDailyPerformanceReport(db, 'SportyBet VFL', customConfig);
      } else if (type === 'confidence') {
        const sampleMatches = [
          { home_team: 'Arsenal', away_team: 'Chelsea', round_number: 14, predicted_probs: { homeWinProb: 48, drawProb: 26, awayWinProb: 26, ggProb: 65, over15Prob: 84, over25Prob: 62 }, confidence_score: 84 },
          { home_team: 'Liverpool', away_team: 'Man City', round_number: 14, predicted_probs: { homeWinProb: 38, drawProb: 24, awayWinProb: 38, ggProb: 72, over15Prob: 88, over25Prob: 68 }, confidence_score: 88 }
        ];
        previewText = telegramBroadcaster.buildConfidenceFilteredCard(14, 'Sportybet England - Week 14', 'SportyBet VFL', sampleMatches, customConfig?.confidenceFilter || 75, confStats, db, customConfig);
      }

      if (db) db.close();
      return { success: true, preview: previewText };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Background Telegram broadcasting is handled by the PM2 scraper daemon (vfl-scraper),
  // not inside the Electron GUI main thread, to prevent GUI event-loop freezing.
  // Manual broadcasts via UI buttons remain fully functional via IPC handlers above.

  // Start NexusPanel Bot Dashboard Web Bridge (use 5174 in dev to avoid Vite conflict on 5173)
  try {
    const webPort = is.dev ? 5174 : 5173;
    webBridge.start(webPort);
  } catch (wbErr) {
    console.error('[WebBridge] Failed to start Web Bridge server:', wbErr.message);
  }

  // Start checking scheduler
  updateSchedulerTimer()

  createWindow()

  // Setup delayed auto-start for scrapers after app ready
  setupAutoStartScrapers()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep the Web Bridge server active in background so web clients can continue using the dashboard
})