import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  listDatabases: (dirPath) => ipcRenderer.invoke('list-databases', dirPath),
  queryDb: (dbPath, query, params) => ipcRenderer.invoke('query-db', dbPath, query, params),
  parseBettingStats: (dbPath) => ipcRenderer.invoke('parse-betting-stats', dbPath),
  getDbTables: (dbPath) => ipcRenderer.invoke('get-db-tables', dbPath),
  getDbInfo: (dbPath) => ipcRenderer.invoke('get-db-info', dbPath),
  askDbAiSql: (data) => ipcRenderer.invoke('ask-db-ai-sql', data),
  askDbAiExplain: (data) => ipcRenderer.invoke('ask-db-ai-explain', data),
  deleteDatabase: (dbPath) => ipcRenderer.invoke('delete-database', dbPath),
  dropTable: (dbPath, tableName) => ipcRenderer.invoke('drop-table', dbPath, tableName),
  clearTable: (dbPath, tableName) => ipcRenderer.invoke('clear-table', dbPath, tableName),
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),
  readKeywords: (platform) => ipcRenderer.invoke('read-keywords', platform),
  writeKeywords: (data) => ipcRenderer.invoke('write-keywords', data),
  selectKeywordsFile: () => ipcRenderer.invoke('select-keywords-file'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectDatabaseFile: () => ipcRenderer.invoke('select-database-file'),
  selectChromeFile: () => ipcRenderer.invoke('select-chrome-file'),
  selectPythonFile: () => ipcRenderer.invoke('select-python-file'),
  testPythonExecutable: (customPath) => ipcRenderer.invoke('test-python-executable', customPath),
  autoDetectAllPaths: () => ipcRenderer.invoke('auto-detect-all-paths'),
  getSystemPaths: () => ipcRenderer.invoke('get-system-paths'),
  selectCursorFile: () => ipcRenderer.invoke('select-cursor-file'),
  createNewUserDataDir: () => ipcRenderer.invoke('create-new-user-data-dir'),
  downloadChrome: () => ipcRenderer.invoke('download-chrome'),
  onChromeDownloadProgress: (callback) => {
    const subscription = (_, data) => callback(data)
    ipcRenderer.on('chrome-download-progress', subscription)
    return () => ipcRenderer.removeListener('chrome-download-progress', subscription)
  },
  startBot: (scriptName, options) => ipcRenderer.invoke('start-bot', scriptName, options),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  clearBrowserData: () => ipcRenderer.invoke('clear-browser-data'),
  clearOsTempProfiles: () => ipcRenderer.invoke('clear-os-temp-profiles'),
  fullOsTempWipe: () => ipcRenderer.invoke('full-os-temp-wipe'),
  smartClearData: () => ipcRenderer.invoke('smart-clear-data'),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  deleteProfile: (name, family) => ipcRenderer.invoke('delete-profile', name, family),
  deleteAllProfiles: () => ipcRenderer.invoke('delete-all-profiles'),
  getFamilies: () => ipcRenderer.invoke('get-families'),
  createFamily: (name) => ipcRenderer.invoke('create-family', name),
  renameFamily: (oldName, newName) => ipcRenderer.invoke('rename-family', oldName, newName),
  deleteFamily: (name) => ipcRenderer.invoke('delete-family', name),
  moveProfile: (profileId, oldFamily, newFamily) => ipcRenderer.invoke('move-profile', profileId, oldFamily, newFamily),
  createProfile: (profileName, familyName) => ipcRenderer.invoke('create-profile', profileName, familyName),
  exportProfile: (profileName, familyName) => ipcRenderer.invoke('export-profile', profileName, familyName),
  exportFamily: (familyName) => ipcRenderer.invoke('export-family', familyName),
  importProfile: (familyName) => ipcRenderer.invoke('import-profile', familyName),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  stopSpecificBot: (profilePath) => ipcRenderer.invoke('stop-specific-bot', profilePath),
  renameProfile: (oldName, newName, family) => ipcRenderer.invoke('rename-profile', oldName, newName, family),
  getProxies: () => ipcRenderer.invoke('get-proxies'),
  saveProxies: (proxies) => ipcRenderer.invoke('save-proxies', proxies),
  assignProxy: (data) => ipcRenderer.invoke('assign-proxy', data),
  getProfileProxy: (data) => ipcRenderer.invoke('get-profile-proxy', data),
  selectProxiesFile: () => ipcRenderer.invoke('select-proxies-file'),
  autoAssignProxies: () => ipcRenderer.invoke('auto-assign-proxies'),
  removeAllProxies: () => ipcRenderer.invoke('remove-all-proxies'),
  getProfileHistory: (data) => ipcRenderer.invoke('get-profile-history', data),
  clearProfileHistory: (data) => ipcRenderer.invoke('clear-profile-history', data),
  clearFamilyHistory: (familyName) => ipcRenderer.invoke('clear-family-history', familyName),
  clearAllHistories: () => ipcRenderer.invoke('clear-all-histories'),
  readPersonalities: () => ipcRenderer.invoke('read-personalities'),
  writePersonalities: (data) => ipcRenderer.invoke('write-personalities', data),
  askAiPersonality: (data) => ipcRenderer.invoke('ask-ai-personality', data),
  askAiSchedule: (data) => ipcRenderer.invoke('ask-ai-schedule', data),
  askAiRandomWeights: (data) => ipcRenderer.invoke('ask-ai-random-weights', data),
  askAiAdjustSettings: (data) => ipcRenderer.invoke('ask-ai-adjust-settings', data),
  getMarketReport: (dbPath) => ipcRenderer.invoke('get-market-report', dbPath),
  googleDriveSync: (settings) => ipcRenderer.invoke('google-drive-sync', settings),
  googleDriveRestore: (settings) => ipcRenderer.invoke('google-drive-restore', settings),
  getGoogleDriveSettings: () => ipcRenderer.invoke('get-google-drive-settings'),
  saveGoogleDriveSettings: (settings) => ipcRenderer.invoke('save-google-drive-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  onBotLog: (callback) => ipcRenderer.on('bot-log', (_, data) => callback(data)),
  onBotStatus: (callback) => ipcRenderer.on('bot-status', (_, status) => callback(status)),
  removeLogListener: () => ipcRenderer.removeAllListeners('bot-log'),
  fetchWebshareProfile: (data) => ipcRenderer.invoke('fetch-webshare-profile', data),
  fetchWebshareStats: (data) => ipcRenderer.invoke('fetch-webshare-stats', data),
  fetchWebshareProxies: (data) => ipcRenderer.invoke('fetch-webshare-proxies', data),
  fetchDataimpulseBalance: (data) => ipcRenderer.invoke('fetch-dataimpulse-balance', data),
  generateDataimpulseProxies: (data) => ipcRenderer.invoke('generate-dataimpulse-proxies', data),
  getProfilesNetworkUsage: () => ipcRenderer.invoke('get-profiles-network-usage'),
  setProfileNetworkLimits: (data) => ipcRenderer.invoke('set-profile-network-limits', data),
  clearProfileNetworkUsage: (data) => ipcRenderer.invoke('clear-profile-network-usage', data),
  clearAllProfilesNetworkUsage: () => ipcRenderer.invoke('clear-all-profiles-network-usage'),
  getBotSettings: () => ipcRenderer.invoke('get-bot-settings'),
  saveBotSettings: (data) => ipcRenderer.invoke('save-bot-settings', data),
  getPredictorTeams: (data) => ipcRenderer.invoke('get-predictor-teams', data),
  getTeamMatchups: (data) => ipcRenderer.invoke('get-team-matchups', data),
  predictMatchupAi: (data) => ipcRenderer.invoke('predict-matchup-ai', data),
  optimizeMlWeights: (data) => ipcRenderer.invoke('optimize-ml-weights', data),
  checkAiBalance: (data) => ipcRenderer.invoke('check-ai-balance', data),
  getBacktestSeasons: (data) => ipcRenderer.invoke('get-backtest-seasons', data),
  runBacktest: (data) => ipcRenderer.invoke('run-backtest', data),
  discoverEdge: (data) => ipcRenderer.invoke('discover-edge', data),
  discoverEdgeAcrossSeasons: (data) => ipcRenderer.invoke('discover-edge-across-seasons', data),
  printBacktestPdf: (data) => ipcRenderer.invoke('print-backtest-pdf', data),
  generatePdfBuffer: (data) => ipcRenderer.invoke('generate-pdf-buffer', data),
  analysePatterns: (data) => ipcRenderer.invoke('analyse-patterns', data),
  analyseTimePatterns: (data) => ipcRenderer.invoke('analyse-time-patterns', data),
  launchNewWindow: (data) => ipcRenderer.invoke('launch-new-window', data),
  scrapeLiveSeason: (data) => ipcRenderer.invoke('scrape-live-season', data),
  stopLiveScraper: (data) => ipcRenderer.invoke('stop-live-scraper', data),
  getLivePredictions: (data) => ipcRenderer.invoke('get-live-predictions', data),
  generateStrategyReport: (data) => ipcRenderer.invoke('generate-strategy-report', data),
  scrapeResultsHistory: (dbPath, livePlatform, targetLeagueId) => ipcRenderer.invoke('scrape-results-history', dbPath, livePlatform, targetLeagueId),
  testAiConnection: (data) => ipcRenderer.invoke('test-ai-connection', data),
  getPM2Status: () => ipcRenderer.invoke('get-pm2-status'),
  togglePM2Scraper: (action) => ipcRenderer.invoke('toggle-pm2-scraper', { action }),
  getResidentialStatus: () => ipcRenderer.invoke('get-residential-status'),
  getResidentialClientCode: () => ipcRenderer.invoke('get-residential-client-code'),
  testResidentialProxy: () => ipcRenderer.invoke('test-residential-proxy'),
  getSchedulerConfig: () => ipcRenderer.invoke('get-scheduler-config'),
  saveSchedulerConfig: (config) => ipcRenderer.invoke('save-scheduler-config', config),
  getSchedulerStatus: () => ipcRenderer.invoke('get-scheduler-status'),
  runSchedulerNow: () => ipcRenderer.invoke('run-scheduler-now'),
  stopSchedulerTask: () => ipcRenderer.invoke('stop-scheduler-task'),
  onSchedulerLog: (callback) => {
    const subscription = (_, data) => callback(data)
    ipcRenderer.on('scheduler-log', subscription)
    return () => ipcRenderer.removeListener('scheduler-log', subscription)
  },
  onAutoStartScraperTriggered: (callback) => {
    const subscription = (_, data) => callback(data)
    ipcRenderer.on('auto-start-scraper-triggered', subscription)
    return () => ipcRenderer.removeListener('auto-start-scraper-triggered', subscription)
  },
  logRendererError: (data) => ipcRenderer.invoke('log-renderer-error', data),
  // ── Model Management ─────────────────────────────────────────────────────
  getModelStatus: () => ipcRenderer.invoke('get-model-status'),
  retrainModel: (data) => ipcRenderer.invoke('retrain-model', data),
  retrainAllModels: (data) => ipcRenderer.invoke('retrain-all-models', data),
  getEngineHealth: (data) => ipcRenderer.invoke('get-engine-health', data),
  purgeOldMatches: (data) => ipcRenderer.invoke('purge-old-matches', data),
  settleAiPicks: (data) => ipcRenderer.invoke('settle-ai-picks', data),
  checkDbOptimization: (data) => ipcRenderer.invoke('check-db-optimization', data),
  autoOptimizeDatabase: (data) => ipcRenderer.invoke('auto-optimize-database', data),
  onRetrainLog: (callback) => {
    const subscription = (_, data) => callback(data)
    ipcRenderer.on('retrain-log', subscription)
    return () => ipcRenderer.removeListener('retrain-log', subscription)
  },
  // ── Telegram Broadcaster ──────────────────────────────────────────────────
  telegramSendTest: (customConfig) => ipcRenderer.invoke('telegram-send-test', customConfig),
  telegramBroadcastPending: (data) => ipcRenderer.invoke('telegram-broadcast-pending', data),
  telegramBroadcastResults: (data) => ipcRenderer.invoke('telegram-broadcast-results', data),
  telegramKickVip: (data) => ipcRenderer.invoke('telegram-kick-vip', data),
  telegramGetStatus: () => ipcRenderer.invoke('telegram-get-status'),
  telegramSaveSettings: (settings) => ipcRenderer.invoke('telegram-save-settings', settings),
  telegramSendCustom: (data) => ipcRenderer.invoke('telegram-send-custom', data),
  telegramClearHistory: (data) => ipcRenderer.invoke('telegram-clear-history', data),
  telegramGetLogs: (data) => ipcRenderer.invoke('telegram-get-logs', data),
  telegramGetPreview: (data) => ipcRenderer.invoke('telegram-get-preview', data),
}


// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
