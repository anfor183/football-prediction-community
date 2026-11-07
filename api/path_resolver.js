'use strict';

/**
 * utils/path_resolver.js
 * 
 * Centralized, cross-platform path resolver for the entire application.
 * Ensures the app can be easily copied and moved from one PC to another (Linux, Windows, macOS)
 * without broken hardcoded machine paths.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Get the root directory of the application
 */
function getAppRoot() {
  if (__dirname.endsWith('utils') || __dirname.endsWith('dashboard')) {
    return path.resolve(__dirname, '..');
  }
  return path.resolve(__dirname);
}

/**
 * Safely load bot_settings.json
 */
function getBotSettings() {
  try {
    const settingsPath = path.join(getAppRoot(), 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (e) {
    console.error('[PathResolver] Error reading bot_settings.json:', e.message);
  }
  return {};
}

/**
 * Safely load browser-config.json
 */
function getBrowserConfig() {
  try {
    const configPath = path.join(getAppRoot(), 'browser-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('[PathResolver] Error reading browser-config.json:', e.message);
  }
  return {};
}

/**
 * Resolve Database / Output directory
 */
function resolveOutputDir(customDir) {
  if (customDir && typeof customDir === 'string' && customDir.trim()) {
    const trimmed = path.resolve(customDir.trim());
    if (fs.existsSync(trimmed)) return trimmed;
    return trimmed;
  }

  const settings = getBotSettings();
  if (settings.outputDir && typeof settings.outputDir === 'string' && settings.outputDir.trim()) {
    const out = path.resolve(settings.outputDir.trim());
    if (fs.existsSync(out)) return out;
  }

  const appRoot = getAppRoot();
  const subDatabases = path.join(appRoot, 'databases');
  if (fs.existsSync(subDatabases)) return subDatabases;

  const parentDatabase = path.join(appRoot, '..', 'database');
  if (fs.existsSync(parentDatabase)) return parentDatabase;

  // Default to application root directory
  return appRoot;
}

/**
 * Helper to verify file exists and is not an empty 0-byte file
 */
function isValidDbFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 1024; // Must be at least 1KB valid SQLite file
  } catch (e) {
    return false;
  }
}

/**
 * Resolve Database file path
 * Checks:
 * 1. Explicitly provided path or CLI arg (if valid)
 * 2. process.env.TRAIN_DB_PATH (if valid)
 * 3. bot_settings.json -> trainingDbPath (if valid)
 * 4. outputDir + defaultDbName (e.g. sportybet_archive.db)
 * 5. appRoot/databases + defaultDbName
 * 6. appRoot + defaultDbName
 * 7. parent/database + defaultDbName
 * 8. Any other non-empty .db file in outputDir / appRoot / databases
 */
function resolveDatabasePath(customPath, defaultDbName = 'sportybet_archive.db') {
  if (customPath && typeof customPath === 'string' && customPath.trim()) {
    const p = path.resolve(customPath.trim());
    if (isValidDbFile(p)) return p;
  }

  if (process.env.TRAIN_DB_PATH && isValidDbFile(process.env.TRAIN_DB_PATH)) {
    return path.resolve(process.env.TRAIN_DB_PATH);
  }

  const settings = getBotSettings();
  if (defaultDbName.includes('sporty') && settings.trainingDbPath && typeof settings.trainingDbPath === 'string' && settings.trainingDbPath.trim()) {
    const tp = path.resolve(settings.trainingDbPath.trim());
    if (isValidDbFile(tp)) return tp;
  }

  const appRoot = getAppRoot();
  const outputDir = resolveOutputDir();

  const candidates = [
    path.join(outputDir, defaultDbName),
    path.join(appRoot, 'databases', defaultDbName),
    path.join(appRoot, defaultDbName),
    path.join(appRoot, '..', 'database', defaultDbName)
  ];

  for (const cand of candidates) {
    if (isValidDbFile(cand)) return cand;
  }

  // Search outputDir, appRoot/databases, and appRoot for any non-empty .db files
  const searchDirs = [outputDir, path.join(appRoot, 'databases'), appRoot];
  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      try {
        const dbFiles = fs.readdirSync(dir)
          .filter(f => f.endsWith('.db'))
          .map(f => ({ path: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
          .filter(f => f.stat.isFile() && f.stat.size > 1024)
          .sort((a, b) => b.stat.mtime - a.stat.mtime);
        if (dbFiles.length > 0) return dbFiles[0].path;
      } catch (e) {}
    }
  }

  return candidates[0];
}

/**
 * Dynamically resolve Python executable across OS
 * Supports Windows, Linux, macOS, and custom virtual environments
 */
function resolvePythonExecutable() {
  const isWin = process.platform === 'win32';
  const settings = getBotSettings();
  const config = getBrowserConfig();

  // 1. Check user configured python path in settings or browser-config
  const customPython = settings.pythonPath || config.paths?.python;
  if (customPython && typeof customPython === 'string' && customPython.trim()) {
    const cp = customPython.trim();
    if (fs.existsSync(cp)) return cp;
    try {
      execFileSync(cp, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return cp;
    } catch (e) {}
  }

  // 2. Check local virtual environment in app root
  const root = getAppRoot();
  const venvCandidates = isWin ? [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'env', 'Scripts', 'python.exe'),
  ] : [
    path.join(root, '.venv', 'bin', 'python3'),
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, 'venv', 'bin', 'python3'),
    path.join(root, 'venv', 'bin', 'python'),
    path.join(root, 'env', 'bin', 'python3'),
  ];

  for (const venvPath of venvCandidates) {
    if (fs.existsSync(venvPath)) {
      try {
        execFileSync(venvPath, ['--version'], { stdio: 'ignore', timeout: 2000 });
        return venvPath;
      } catch (e) {}
    }
  }

  // 3. Check system PATH binaries
  const systemCandidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const bin of systemCandidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return bin;
    } catch (e) {}
  }

  return isWin ? 'python' : 'python3';
}

/**
 * Dynamically resolve Chrome binary across OS
 */
function resolveChromeExecutable() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const config = getBrowserConfig();

  if (config.paths?.chrome && fs.existsSync(config.paths.chrome)) {
    try {
      execFileSync(config.paths.chrome, ['--version'], { stdio: 'ignore', timeout: 2000 });
      return config.paths.chrome;
    } catch (e) {}
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = isWin ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
  ].filter(Boolean) : isMac ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ] : [
    path.join(home, '.local/opt/google/chrome/google-chrome'),
    path.join(home, '.local/bin/google-chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/local/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 2000 });
        return c;
      } catch (e) {}
    }
  }

  // Check bundled chrome/ directory
  const localChrome = path.join(getAppRoot(), 'chrome', isWin ? 'chrome.exe' : 'chrome');
  if (fs.existsSync(localChrome)) return localChrome;

  return config.paths?.chrome || (isWin ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
}

/**
 * Resolve User Data Directory for browser profiles
 */
function resolveUserDataDir(customDir) {
  if (customDir && typeof customDir === 'string' && customDir.trim()) {
    return path.resolve(customDir.trim());
  }

  const config = getBrowserConfig();
  if (config.paths?.userDataDir && typeof config.paths.userDataDir === 'string' && config.paths.userDataDir.trim()) {
    const ud = path.resolve(config.paths.userDataDir.trim());
    if (fs.existsSync(ud)) return ud;
  }

  const settings = getBotSettings();
  if (settings.userDataDir && typeof settings.userDataDir === 'string' && settings.userDataDir.trim()) {
    const ud = path.resolve(settings.userDataDir.trim());
    if (fs.existsSync(ud)) return ud;
  }

  // Default to profiles directory inside app root
  const defaultDir = path.join(getAppRoot(), 'profiles');
  if (!fs.existsSync(defaultDir)) {
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (e) {}
  }
  return defaultDir;
}

/**
 * Resolve PDF Reports directory
 */
function resolveReportsDir(customDir) {
  if (customDir && typeof customDir === 'string' && customDir.trim()) {
    return path.resolve(customDir.trim());
  }
  const settings = getBotSettings();
  if (settings.reportsDir && typeof settings.reportsDir === 'string' && settings.reportsDir.trim()) {
    return path.resolve(settings.reportsDir.trim());
  }
  const defaultDir = path.join(getAppRoot(), 'reports');
  if (!fs.existsSync(defaultDir)) {
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch (e) {}
  }
  return defaultDir;
}

/**
 * Return all system paths together for dashboard overview & portability check
 */
function getAllSystemPaths() {
  const appRoot = getAppRoot();
  const botSettings = getBotSettings();
  const browserConfig = getBrowserConfig();

  const outputDir = resolveOutputDir();
  const trainingDbPath = resolveDatabasePath(botSettings.trainingDbPath, 'sportybet_archive.db');
  const chromePath = resolveChromeExecutable();
  const pythonPath = resolvePythonExecutable();
  const userDataDir = resolveUserDataDir();
  const reportsDir = resolveReportsDir();
  const cursorPath = browserConfig.paths?.cursorPath || path.join('puppeteer-app', 'gold_mouse.png');
  const keywordsPath = browserConfig.paths?.keywordsPath || path.join(appRoot, 'keywords.txt');
  const googleDriveLocalPath = browserConfig.googleDriveSync?.localPath || path.join(appRoot, 'backups');

  return {
    appRoot,
    outputDir: {
      path: outputDir,
      exists: fs.existsSync(outputDir),
      isConfigured: !!botSettings.outputDir
    },
    trainingDbPath: {
      path: trainingDbPath,
      exists: fs.existsSync(trainingDbPath),
      isConfigured: !!botSettings.trainingDbPath
    },
    chrome: {
      path: chromePath,
      exists: fs.existsSync(chromePath),
      isConfigured: !!browserConfig.paths?.chrome
    },
    python: {
      path: pythonPath,
      exists: fs.existsSync(pythonPath) || ['python', 'python3', 'py'].includes(pythonPath),
      isConfigured: !!botSettings.pythonPath
    },
    userDataDir: {
      path: userDataDir,
      exists: fs.existsSync(userDataDir),
      isConfigured: !!browserConfig.paths?.userDataDir
    },
    reportsDir: {
      path: reportsDir,
      exists: fs.existsSync(reportsDir),
      isConfigured: !!botSettings.reportsDir
    },
    cursorPath: {
      path: cursorPath,
      exists: fs.existsSync(path.isAbsolute(cursorPath) ? cursorPath : path.join(appRoot, cursorPath)),
      isConfigured: !!browserConfig.paths?.cursorPath
    },
    keywordsPath: {
      path: keywordsPath,
      exists: fs.existsSync(keywordsPath),
      isConfigured: !!browserConfig.paths?.keywordsPath
    },
    googleDriveLocalPath: {
      path: googleDriveLocalPath,
      exists: fs.existsSync(googleDriveLocalPath),
      isConfigured: !!browserConfig.googleDriveSync?.localPath
    }
  };
}

module.exports = {
  getAppRoot,
  getBotSettings,
  getBrowserConfig,
  resolveOutputDir,
  resolveDatabasePath,
  resolvePythonExecutable,
  resolveChromeExecutable,
  resolveUserDataDir,
  resolveReportsDir,
  getAllSystemPaths
};
