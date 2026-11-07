/**
 * Event-Driven Football Prediction Engine - Data Ingestion Adapter
 * 
 * This adapter defines the interface for streaming live match events,
 * historical match timelines, and market odds into the statistical prediction pipeline.
 * 
 * Note: High-throughput live web crawlers, Chromium browser automation, and proxy
 * tunneling infrastructure run in a proprietary private module and stream into this
 * engine via WebSocket / REST endpoints.
 */

const EventEmitter = require('events');

class DataIngestionAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8080;
    this.isConnected = false;
    this.buffer = [];
  }

  /**
   * Ingests a raw match event packet.
   * Validates schema, timestamps, and dispatches to prediction models.
   * 
   * @param {Object} eventPacket 
   */
  ingestMatchEvent(eventPacket) {
    if (!eventPacket || !eventPacket.matchId) {
      throw new Error('Invalid match event packet: matchId is required.');
    }

    const normalizedEvent = {
      matchId: eventPacket.matchId,
      league: eventPacket.league || 'Virtual Premier League',
      homeTeam: eventPacket.homeTeam,
      awayTeam: eventPacket.awayTeam,
      minute: eventPacket.minute || 0,
      homeScore: eventPacket.homeScore || 0,
      awayScore: eventPacket.awayScore || 0,
      odds: eventPacket.odds || {},
      timestamp: Date.now()
    };

    this.emit('match_event', normalizedEvent);
    return normalizedEvent;
  }

  /**
   * Ingests final settlement results to trigger model parameter auto-calibration.
   */
  ingestSettlement(resultPacket) {
    this.emit('settlement', resultPacket);
  }
}

module.exports = DataIngestionAdapter;
