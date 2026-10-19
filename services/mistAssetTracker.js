// services/mistAssetTracker.js
// RAW DATA MODE — zero coordinate calculations.
// Just groups detections by MAC and passes them to the controller.

const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

const SITE_ID = process.env.MIST_SITE_ID;
if (!SITE_ID) throw new Error("MIST_SITE_ID environment variable required");

const API_TOKEN = process.env.MIST_API_TOKEN;
if (!API_TOKEN) throw new Error("MIST_API_TOKEN environment variable required");

const mist = axios.create({
  baseURL: "https://api.mist.com/api/v1",
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

class AssetTracker extends EventEmitter {
  constructor() {
    super();
    this.backoffUntil = 0;
    this.backoffMultiplier = 1;
    this.cachedProcessedAssets = [];
    this.apMap = new Map();

    this._loadStaticAPs();
  }

  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (!fs.existsSync(filePath)) return;

      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);
      if (!Array.isArray(apList)) return;

      for (const ap of apList) {
        if (!ap.mac) continue;
        // Store raw AP data. No coordinate derivation.
        this.apMap.set(ap.mac.toLowerCase().trim(), {
          name: ap.name || ap.mac,
          map_id: ap.map_id || null,
          x: ap.x,
          y: ap.y,
          x_m: ap.x_m,
          y_m: ap.y_m,
        });
      }
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  getCachedAssets() {
    return this.cachedProcessedAssets;
  }

  async getAssets() {
    if (this.backoffUntil > Date.now()) {
      return this.cachedProcessedAssets;
    }

    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);
      this.backoffMultiplier = 1;
      this.backoffUntil = 0;

      if (Array.isArray(response.data) && response.data.length > 0) {
        const processed = this._processAssetData(response.data);
        this.cachedProcessedAssets = processed;
        return processed;
      }
      return this.cachedProcessedAssets;
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter =
          parseInt(err.response.headers["retry-after"], 10) || 60;
        const waitMs = retryAfter * 1000 * this.backoffMultiplier;
        this.backoffUntil = Date.now() + waitMs;
        this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
        this.emit("rateLimited", { retryAfter: Math.ceil(waitMs / 1000) });
        return this.cachedProcessedAssets;
      }
      console.error("Mist API Error:", err.message);
      return this.cachedProcessedAssets;
    }
  }

  _processAssetData(assets) {
    const processedAssets = [];
    const assetGroups = new Map();

    for (const a of assets) {
      if (!a.mac) continue;
      let group = assetGroups.get(a.mac);
      if (!group) {
        group = [];
        assetGroups.set(a.mac, group);
      }
      group.push(a);
    }

    for (const [mac, detections] of assetGroups) {
      try {
        const firstDet = detections[0];
        if (!firstDet.map_id) continue;

        // Sort detections by strongest RSSI first
        detections.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
        const primaryDet = detections[0];

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          detections, // Pass raw detections
          ap_mac: primaryDet.ap_mac,
          ap_name:
            this.apMap.get((primaryDet.ap_mac || "").toLowerCase().trim())
              ?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam: primaryDet.beam ?? null,
        });
      } catch (err) {
        console.error(`Error processing asset ${mac}:`, err);
      }
    }

    return processedAssets;
  }
}

const assetTracker = new AssetTracker();
module.exports = assetTracker;
