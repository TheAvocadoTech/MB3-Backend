/**
 * Real-Time Low-Latency Mist Asset Tracker
 * Optimized for ~1.2s Poll Intervals (Zero Algorithmic Inertia)
 */

const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const SITE_ID = process.env.MIST_SITE_ID;
const API_TOKEN = process.env.MIST_API_TOKEN;

// Axois instance configured with quick timeouts to prevent hung requests
const mist = axios.create({
  baseURL: "https://api.mist.com/api/v1",
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 3000,
});

class AssetTracker extends EventEmitter {
  constructor() {
    super();
    this.assetStates = new Map();
    this.apMap = new Map();
    this.backoffUntil = 0;
    this.cachedProcessedAssets = [];
    
    this._loadStaticAPs();
  }

  /**
   * Load AP positions for weighted coordinate calculation
   */
  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (fs.existsSync(filePath)) {
        const apList = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Array.isArray(apList)) {
          for (const ap of apList) {
            if (ap.mac) {
              this.apMap.set(ap.mac.toLowerCase(), { x_m: ap.x_m, y_m: ap.y_m });
            }
          }
          console.log(`✅ Loaded ${this.apMap.size} AP coordinates from ap_list.json`);
        }
      }
    } catch (err) {
      console.warn("⚠️ Warning loading ap_list.json:", err.message);
    }
  }

  /**
   * Main fetch call triggered by your 1200ms interval
   */
  async getAssets() {
    const now = Date.now();

    // Rate-limit check guard
    if (this.backoffUntil > now) {
      const remainingSec = Math.ceil((this.backoffUntil - now) / 1000);
      console.warn(`⛔ [RATE LIMITED] Backing off. Resuming in ${remainingSec}s...`);
      return this.cachedProcessedAssets;
    }

    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);

      if (Array.isArray(response.data) && response.data.length > 0) {
        const processed = this._processDirect(response.data);
        this.cachedProcessedAssets = processed;
        return processed;
      }
      
      return this.cachedProcessedAssets;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        const retryAfter = parseInt(err.response.headers["retry-after"], 10) || 60;
        this.backoffUntil = Date.now() + (retryAfter * 1000);
        console.error(`🚨 HTTP 429 RATE LIMIT. Backing off for ${retryAfter}s.`);
      } else {
        console.error("API Fetch Error:", err.message);
      }
      return this.cachedProcessedAssets;
    }
  }

  /**
   * Fast Low-Latency Algorithmic Processor
   */
  _processDirect(assets) {
    const now = Date.now();
    const processed = [];

    // Group detections by Asset MAC address
    const groups = new Map();
    for (const a of assets) {
      if (!a.mac) continue;
      const macKey = a.mac.toLowerCase();
      if (!groups.has(macKey)) groups.set(macKey, []);
      groups.get(macKey).push(a);
    }

    for (const [mac, detections] of groups) {
      // Sort detections by strongest RSSI first
      detections.sort((a, b) => b.rssi - a.rssi);
      const topDet = detections[0];

      // Default raw coordinates directly from Mist API
      let rawX = topDet.x;
      let rawY = topDet.y;

      // Fast Centroid Calculation using linear signal weights (if AP locations exist)
      let sumX = 0, sumY = 0, sumW = 0;
      for (const d of detections) {
        if (!d.ap_mac) continue;
        const ap = this.apMap.get(d.ap_mac.toLowerCase());
        if (ap) {
          // Convert RSSI (dBm) to linear scale weight
          const weight = Math.pow(10, d.rssi / 10);
          sumX += ap.x_m * weight;
          sumY += ap.y_m * weight;
          sumW += weight;
        }
      }

      if (sumW > 0) {
        rawX = sumX / sumW;
        rawY = sumY / sumW;
      }

      // Instant-Response Coordinate State Management
      let state = this.assetStates.get(mac);

      if (!state || !state.pos) {
        // First detection: Immediately lock onto the coordinate
        state = { pos: { x_m: rawX, y_m: rawY } };
      } else {
        // 80/20 EMA Update: Applies 80% of movement instantly on every 1.2s poll
        state.pos.x_m = 0.80 * rawX + 0.20 * state.pos.x_m;
        state.pos.y_m = 0.80 * rawY + 0.20 * state.pos.y_m;
      }

      this.assetStates.set(mac, state);

      // Create lightweight output payload
      const payload = {
        mac,
        device_name: topDet.device_name || "Asset Tag",
        position: {
          x_m: Number(state.pos.x_m.toFixed(2)),
          y_m: Number(state.pos.y_m.toFixed(2)),
        },
        rssi: topDet.rssi,
        ap_mac: topDet.ap_mac,
        timestamp: now,
      };

      // Emit event for real-time listeners (WebSockets / Socket.io)
      this.emit("assetUpdate", payload);
      processed.push(payload);
    }

    return processed;
  }
}

module.exports = new AssetTracker();
