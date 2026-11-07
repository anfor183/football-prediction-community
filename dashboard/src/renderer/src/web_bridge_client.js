// Web Browser Bridge Client for NexusPanel Dashboard
// Connects browser window.api to backend Web Bridge HTTP/WebSocket server

if (typeof window !== 'undefined' && !window.api) {
  console.log('[WebBridge] Initializing browser fallback bridge for window.api and window.electron...');

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

  let ws = null;
  const listeners = new Map();

  function connectWs() {
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        console.log('[WebBridge WS] Connected to live log & status stream');
      };
      ws.onmessage = (event) => {
        try {
          const { channel, data } = JSON.parse(event.data);
          const cbs = listeners.get(channel);
          if (cbs) {
            cbs.forEach((cb) => {
              try { cb(data); } catch (err) { console.error(`[WebBridge WS Callback Error: ${channel}]`, err); }
            });
          }
        } catch (e) {
          console.error('[WebBridge WS Parse Error]', e);
        }
      };
      ws.onclose = () => {
        setTimeout(connectWs, 3000);
      };
      ws.onerror = () => {
        try { ws.close(); } catch (_) {}
      };
    } catch (e) {
      setTimeout(connectWs, 3000);
    }
  }

  connectWs();

  // Method names to IPC channels mapping
  const methodChannelMap = {
    listDatabases: 'list-databases',
    queryDb: 'query-db',
    parseBettingStats: 'parse-betting-stats',
    getDbTables: 'get-db-tables',
    getDbInfo: 'get-db-info',
    askDbAiSql: 'ask-db-ai-sql',
    askDbAiExplain: 'ask-db-ai-explain',
    deleteDatabase: 'delete-database',
    dropTable: 'drop-table',
    clearTable: 'clear-table',
    readConfig: 'read-config',
    writeConfig: 'write-config',
    readKeywords: 'read-keywords',
    writeKeywords: 'write-keywords',
    selectKeywordsFile: 'select-keywords-file',
    selectDirectory: 'select-directory',
    selectDatabaseFile: 'select-database-file',
    selectChromeFile: 'select-chrome-file',
    selectPythonFile: 'select-python-file',
    testPythonExecutable: 'test-python-executable',
    autoDetectAllPaths: 'auto-detect-all-paths',
    getSystemPaths: 'get-system-paths',
    selectCursorFile: 'select-cursor-file',
    createNewUserDataDir: 'create-new-user-data-dir',
    downloadChrome: 'download-chrome',
    startBot: 'start-bot',
    stopBot: 'stop-bot',
    getBotStatus: 'get-bot-status',
    clearBrowserData: 'clear-browser-data',
    clearOsTempProfiles: 'clear-os-temp-profiles',
    fullOsTempWipe: 'full-os-temp-wipe',
    smartClearData: 'smart-clear-data',
    getProfiles: 'get-profiles',
    deleteProfile: 'delete-profile',
    deleteAllProfiles: 'delete-all-profiles',
    getFamilies: 'get-families',
    createFamily: 'create-family',
    renameFamily: 'rename-family',
    deleteFamily: 'delete-family',
    moveProfile: 'move-profile',
    createProfile: 'create-profile',
    exportProfile: 'export-profile',
    exportFamily: 'export-family',
    importProfile: 'import-profile',
    getSystemStats: 'get-system-stats',
    stopSpecificBot: 'stop-specific-bot',
    renameProfile: 'rename-profile',
    getProxies: 'get-proxies',
    saveProxies: 'save-proxies',
    assignProxy: 'assign-proxy',
    getProfileProxy: 'get-profile-proxy',
    selectProxiesFile: 'select-proxies-file',
    autoAssignProxies: 'auto-assign-proxies',
    removeAllProxies: 'remove-all-proxies',
    getProfileHistory: 'get-profile-history',
    clearProfileHistory: 'clear-profile-history',
    clearFamilyHistory: 'clear-family-history',
    clearAllHistories: 'clear-all-histories',
    readPersonalities: 'read-personalities',
    writePersonalities: 'write-personalities',
    askAiPersonality: 'ask-ai-personality',
    askAiSchedule: 'ask-ai-schedule',
    askAiRandomWeights: 'ask-ai-random-weights',
    askAiAdjustSettings: 'ask-ai-adjust-settings',
    getMarketReport: 'get-market-report',
    googleDriveSync: 'google-drive-sync',
    googleDriveRestore: 'google-drive-restore',
    getGoogleDriveSettings: 'get-google-drive-settings',
    saveGoogleDriveSettings: 'save-google-drive-settings',
    fetchWebshareProfile: 'fetch-webshare-profile',
    fetchWebshareStats: 'fetch-webshare-stats',
    fetchWebshareProxies: 'fetch-webshare-proxies',
    fetchDataimpulseBalance: 'fetch-dataimpulse-balance',
    generateDataimpulseProxies: 'generate-dataimpulse-proxies',
    getProfilesNetworkUsage: 'get-profiles-network-usage',
    setProfileNetworkLimits: 'set-profile-network-limits',
    clearProfileNetworkUsage: 'clear-profile-network-usage',
    clearAllProfilesNetworkUsage: 'clear-all-profiles-network-usage',
    getBotSettings: 'get-bot-settings',
    saveBotSettings: 'save-bot-settings',
    getPredictorTeams: 'get-predictor-teams',
    getTeamMatchups: 'get-team-matchups',
    predictMatchupAi: 'predict-matchup-ai',
    optimizeMlWeights: 'optimize-ml-weights',
    checkAiBalance: 'check-ai-balance',
    getBacktestSeasons: 'get-backtest-seasons',
    runBacktest: 'run-backtest',
    discoverEdge: 'discover-edge',
    discoverEdgeAcrossSeasons: 'discover-edge-across-seasons',
    printBacktestPdf: 'print-backtest-pdf',
    generatePdfBuffer: 'generate-pdf-buffer',
    analysePatterns: 'analyse-patterns',
    analyseTimePatterns: 'analyse-time-patterns',
    launchNewWindow: 'launch-new-window',
    scrapeLiveSeason: 'scrape-live-season',
    stopLiveScraper: 'stop-live-scraper',
    getLivePredictions: 'get-live-predictions',
    generateStrategyReport: 'generate-strategy-report',
    scrapeResultsHistory: 'scrape-results-history',
    testAiConnection: 'test-ai-connection',
    getPM2Status: 'get-pm2-status',
    togglePM2Scraper: 'toggle-pm2-scraper',
    getResidentialStatus: 'get-residential-status',
    getResidentialClientCode: 'get-residential-client-code',
    testResidentialProxy: 'test-residential-proxy',
    getSchedulerConfig: 'get-scheduler-config',
    saveSchedulerConfig: 'save-scheduler-config',
    getSchedulerStatus: 'get-scheduler-status',
    runSchedulerNow: 'run-scheduler-now',
    stopSchedulerTask: 'stop-scheduler-task',
    logRendererError: 'log-renderer-error',
    getModelStatus: 'get-model-status',
    retrainModel: 'retrain-model',
    retrainAllModels: 'retrain-all-models',
    getEngineHealth: 'get-engine-health',
    purgeOldMatches: 'purge-old-matches',
    checkDbOptimization: 'check-db-optimization',
    autoOptimizeDatabase: 'auto-optimize-database',
    telegramSendTest: 'telegram-send-test',
    telegramBroadcastPending: 'telegram-broadcast-pending',
    telegramBroadcastResults: 'telegram-broadcast-results',
    telegramKickVip: 'telegram-kick-vip',
    telegramGetStatus: 'telegram-get-status',
    telegramSaveSettings: 'telegram-save-settings',
    telegramSendCustom: 'telegram-send-custom',
    telegramClearHistory: 'telegram-clear-history',
    telegramGetLogs: 'telegram-get-logs',
    telegramGetPreview: 'telegram-get-preview'
  };

  const listenerMethods = {
    onChromeDownloadProgress: 'chrome-download-progress',
    onBotLog: 'bot-log',
    onBotStatus: 'bot-status',
    onSchedulerLog: 'scheduler-log',
    onAutoStartScraperTriggered: 'auto-start-scraper-triggered',
    onRetrainLog: 'retrain-log'
  };

  window.api = new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return target[prop];

      if (listenerMethods[prop]) {
        const channel = listenerMethods[prop];
        return (callback) => {
          if (!listeners.has(channel)) listeners.set(channel, new Set());
          listeners.get(channel).add(callback);
          return () => {
            const set = listeners.get(channel);
            if (set) set.delete(callback);
          };
        };
      }

      if (prop.startsWith('remove') && prop.endsWith('Listener')) {
        return (channel) => {
          if (listeners.has(channel)) listeners.delete(channel);
        };
      }

      return async (...args) => {
        const channel = methodChannelMap[prop] || prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        try {
          const res = await fetch('/api/ipc/' + channel, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args })
          });
          const json = await res.json();
          if (!json.success && json.error) {
            console.error(`[WebBridge API] Error on ${channel}:`, json.error);
          }
          return json.result;
        } catch (e) {
          console.error(`[WebBridge API] Failed calling ${channel}:`, e);
          return { success: false, error: e.message };
        }
      };
    }
  });

  window.electron = {
    ipcRenderer: {
      on: (channel, callback) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel).add((data) => callback({}, data));
      },
      removeListener: (channel, callback) => {
        const set = listeners.get(channel);
        if (set) set.delete(callback);
      },
      removeAllListeners: (channel) => {
        listeners.delete(channel);
      },
      invoke: async (channel, ...args) => {
        const res = await fetch('/api/ipc/' + channel, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args })
        });
        const json = await res.json();
        return json.result;
      }
    }
  };
}
