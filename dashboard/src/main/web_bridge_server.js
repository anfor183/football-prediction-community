import express from 'express'
import cors from 'cors'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { WebSocketServer } from 'ws'

class WebBridgeServer {
  constructor() {
    this.handlers = new Map();
    this.wss = null;
    this.httpServer = null;
    this.port = 5173;
    this.isRunning = false;
  }

  registerHandler(channel, handler) {
    this.handlers.set(channel, handler);
  }

  broadcast(channel, data) {
    if (!this.wss) return;
    const payload = JSON.stringify({ channel, data });
    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) { // 1 = OPEN
        try {
          client.send(payload);
        } catch (e) {
          console.error(`[WebBridge WS] Send error:`, e.message);
        }
      }
    });
  }

  start(port = 5173, rendererPath = null) {
    if (this.isRunning) {
      console.log(`[WebBridge Server] Already running on port ${this.port}`);
      return;
    }

    this.port = port;
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));

    const staticPath = rendererPath || path.join(__dirname, '../renderer');
    if (fs.existsSync(staticPath)) {
      console.log(`[WebBridge Server] Serving static web UI from: ${staticPath}`);
      app.use(express.static(staticPath));
    } else {
      console.warn(`[WebBridge Server] Warning: Renderer static path not found at: ${staticPath}`);
    }

    // Health check endpoint
    app.get('/api/health', (req, res) => {
      res.json({
        status: 'online',
        name: 'NexusPanel Bot Dashboard Web Bridge',
        version: '1.1.1',
        registeredChannels: this.handlers.size,
        timestamp: new Date().toISOString()
      });
    });

    // REST API Endpoint for all IPC channels
    app.post('/api/ipc/:channel', async (req, res) => {
      const { channel } = req.params;
      const args = req.body && Array.isArray(req.body.args) ? req.body.args : [];
      const handler = this.handlers.get(channel);

      if (!handler) {
        console.warn(`[WebBridge Server] No handler registered for channel: "${channel}"`);
        return res.status(404).json({
          success: false,
          error: `No handler registered for IPC channel "${channel}"`
        });
      }

      try {
        const mockEvent = {
          sender: {
            send: (ch, data) => this.broadcast(ch, data)
          }
        };

        const result = await handler(mockEvent, ...args);
        return res.json({ success: true, result });
      } catch (err) {
        console.error(`[WebBridge Server] Error executing "${channel}":`, err);
        return res.status(500).json({
          success: false,
          error: err.message || String(err)
        });
      }
    });

    // SPA Fallback: send index.html for any unhandled non-API GET route
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return next();
      }
      const indexPath = path.join(staticPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
      }
      res.status(404).send('Bot Dashboard UI build not found. Please run npm run build.');
    });

    this.httpServer = http.createServer(app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`[WebBridge WS] Client connected from ${clientIp} (Active: ${this.wss.clients.size})`);

      ws.on('close', () => {
        console.log(`[WebBridge WS] Client disconnected (Active: ${this.wss.clients.size})`);
      });

      ws.on('error', (err) => {
        console.error(`[WebBridge WS] Client error:`, err.message);
      });
    });

    this.httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[WebBridge Server] Port ${this.port} is already in use. Retrying on ${this.port + 1}...`);
        try { this.httpServer.close(); } catch (_) {}
        this.isRunning = false;
        this.start(this.port + 1, rendererPath);
      } else {
        console.error(`[WebBridge Server] Server error:`, err);
      }
    });

    this.httpServer.listen(this.port, '0.0.0.0', () => {
      this.isRunning = true;
      console.log(`\n=======================================================`);
      console.log(`🚀 NEXUSPANEL BOT DASHBOARD WEB BRIDGE IS ONLINE!`);
      console.log(`👉 Access URL: http://0.0.0.0:${this.port}/`);
      console.log(`👉 WebSocket Stream: ws://0.0.0.0:${this.port}/ws`);
      console.log(`=======================================================\n`);
    });
  }
}

export const webBridge = new WebBridgeServer();
export default webBridge;
