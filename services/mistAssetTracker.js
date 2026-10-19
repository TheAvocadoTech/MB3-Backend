// services/mistAssetTracker.js
// RAW SIGNAL MODE — no filters, no smoothing, no trail, no corrections.
// Position is AP-anchored: the strongest-detection AP's own coordinates are
// used as the tag position. No centroid, no weighting, no outlier rejection.
//
// Pipeline:
//   1. Fetch /sites/{site}/stats/assets from Mist
//   2. Group detections by asset MAC
//   3. Pick strongest detection as primary AP
//   4. Position = primary AP's coordinates (meters + pixels)
//   5. Return { mac, device_name, map_id, position, position_px, detections,
//               ap_mac, ap_name, rssi, beam, ppm }
//
// Nothing else. If a value is missing, it is not invented.

const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");

// ============================================================
// ENV
// ============================================================
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

// ============================================================
// MAP CONFIGURATIONS
// ============================================================
const MAP_CONFIGS = {
  "30141417-44ea-4982-993c-6225c9f08315": {
    name: "MB3-F00",
    width: 6400,
    height: 5120,
    width_m: 127.81105527098556,
    height_m: 102.24884421678846,
    origin_x: 306.45106507695385,
    origin_y: 3856.483584010582,
    ppm: 50.07391564392213,
    offset_x: 0,
    offset_y: 0,
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    name: "MB3-F01",
    width: 6400,
    height: 5120,
    width_m: 111.74050632911398,
    height_m: 89.39240506329119,
    origin_x: 6.786923314266026,
    origin_y: 4134.933029216576,
    ppm: 57.275559331634064,
    offset_x: 0,
    offset_y: 0,
  },
  default: {
    name: "default",
    width: 6400,
    height: 5120,
    width_m: 50,
    height_m: 50,
    origin_x: 0,
    origin_y: 0,
    ppm: 10,
    offset_x: 0,
    offset_y: 0,
  },
};

// ============================================================
// AssetTracker (raw AP-anchored mode)
// ============================================================
class AssetTracker extends EventEmitter {
  constructor() {
    super();

    // Backoff (still needed — Mist rate limit)
    this.backoffUntil = 0;
    this.backoffMultiplier = 1;

    // Last successful response — served on 429 / network failure
    this.cachedProcessedAssets = [];

    // AP dictionary loaded from ap_list.json
    this.apMap = new Map();

    this._loadStaticAPs();
  }

  // ------------------------------------------------------------
  // Load AP list — keep raw pixel + meter coords, derive neither
  // ------------------------------------------------------------
  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (!fs.existsSync(filePath)) {
        console.warn("⚠️ ap_list.json not found — AP positions unavailable");
        return;
      }

      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);
      if (!Array.isArray(apList)) return;

      let loaded = 0;

      for (const ap of apList) {
        if (!ap.mac) continue;

        this.apMap.set(ap.mac, {
          name: ap.name || ap.mac,
          map_id: ap.map_id || null,
          x: ap.x,
          y: ap.y,
          x_m: ap.x_m,
          y_m: ap.y_m,
        });
        loaded++;
      }

      console.log(`✅ Loaded ${loaded} APs from ap_list.json`);
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  // ------------------------------------------------------------
  // Public: cached assets
  // ------------------------------------------------------------
  getCachedAssets() {
    return this.cachedProcessedAssets;
  }

  // ------------------------------------------------------------
  // Public: fetch from Mist and return grouped assets
  // ------------------------------------------------------------
  async getAssets() {
    const now = Date.now();
    if (this.backoffUntil > now) {
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

  // ------------------------------------------------------------
  // Legacy stubs so old callers don't crash
  // ------------------------------------------------------------
  getAssetStates() {
    const states = {};
    for (const asset of this.cachedProcessedAssets) {
      states[asset.mac] = {
        device_name: asset.device_name,
        position: asset.position,
        position_px: asset.position_px,
        map_id: asset.map_id,
        ap_mac: asset.ap_mac,
        rssi: asset.rssi,
        beam: asset.beam,
        ppm: asset.ppm,
      };
    }
    return states;
  }
  getAssetTrail() {
    return [];
  }
  clearAssetTrail() {}
  resetAsset() {}
  setWayfindingData() {}

  // ------------------------------------------------------------
  // Group by asset MAC, pick strongest detection, anchor to AP
  // ------------------------------------------------------------
  _processAssetData(assets) {
    const processedAssets = [];
    const assetGroups = new Map();

    // Group detections by asset MAC
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

        // Pick strongest detection as the primary AP (raw RSSI)
        let primaryDet = detections[0];
        for (const d of detections) {
          if ((d.rssi ?? -999) > (primaryDet.rssi ?? -999)) primaryDet = d;
        }

        const cfg = MAP_CONFIGS[firstDet.map_id];
        const primaryAp = this.apMap.get(primaryDet.ap_mac);

        // ----------------------------------------------
        // AP-anchored position — no centroid, no weights
        // ----------------------------------------------
        let position = null;
        let position_px = null;

        if (primaryAp && cfg) {
          if (Number.isFinite(primaryAp.x) && Number.isFinite(primaryAp.y)) {
            position_px = { x: primaryAp.x, y: primaryAp.y };
            position = {
              x_m: (primaryAp.x - cfg.origin_x) / cfg.ppm,
              y_m: (cfg.origin_y - primaryAp.y) / cfg.ppm,
              ppm: cfg.ppm,
            };
          } else if (
            Number.isFinite(primaryAp.x_m) &&
            Number.isFinite(primaryAp.y_m)
          ) {
            position = {
              x_m: primaryAp.x_m,
              y_m: primaryAp.y_m,
              ppm: cfg.ppm,
            };
            position_px = {
              x: primaryAp.x_m * cfg.ppm + cfg.origin_x,
              y: cfg.origin_y - primaryAp.y_m * cfg.ppm,
            };
          }
        }

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          position,
          position_px,
          detections,
          ap_mac: primaryDet.ap_mac,
          ap_name: primaryAp?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam: primaryDet.beam ?? null,
          ppm: cfg?.ppm ?? null,
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
