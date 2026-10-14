// services/mistAssetTracker.js
// RAW SIGNAL MODE — no filters, no smoothing, no trail, no corrections.
//
// Pipeline:
//   1. Fetch /sites/{site}/stats/assets from Mist
//   2. Group detections by asset MAC
//   3. RSSI-weighted centroid of the AP positions in ap_list.json
//   4. Return { mac, device_name, map_id, position, ap_mac, rssi, beam, ppm }
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
// AssetTracker (raw mode)
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
  // Load AP list — pixel coords preferred, falls back to x_m/y_m
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
      let skipped = 0;

      for (const ap of apList) {
        if (!ap.mac) continue;

        const cfg = MAP_CONFIGS[ap.map_id];
        let x_m, y_m;

        if (
          cfg &&
          Number.isFinite(ap.x) &&
          Number.isFinite(ap.y) &&
          ap.x !== 0 &&
          ap.y !== 0
        ) {
          // Derive meters from pixel coords using our config
          x_m = (ap.x - cfg.origin_x) / cfg.ppm;
          y_m = (cfg.origin_y - ap.y) / cfg.ppm;
        } else if (Number.isFinite(ap.x_m) && Number.isFinite(ap.y_m)) {
          x_m = ap.x_m;
          y_m = ap.y_m;
        } else {
          skipped++;
          continue;
        }

        this.apMap.set(ap.mac, {
          x_m,
          y_m,
          name: ap.name || ap.mac,
          map_id: ap.map_id || null,
        });
        loaded++;
      }

      console.log(
        `✅ Loaded ${loaded} APs from ap_list.json (skipped ${skipped})`,
      );
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  // ------------------------------------------------------------
  // Public: cached assets (raw list from last successful poll)
  // ------------------------------------------------------------
  getCachedAssets() {
    return this.cachedProcessedAssets;
  }

  // ------------------------------------------------------------
  // Public: fetch from Mist and return raw centroids
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
  // Public: legacy stubs so old callers don't crash
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
  // Raw centroid — no smoothing, no outlier rejection
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

        // ----------------------------------------------
        // Simple RSSI-weighted centroid
        // ----------------------------------------------
        let sumX = 0;
        let sumY = 0;
        let sumW = 0;

        for (const det of detections) {
          const apInfo = this.apMap.get(det.ap_mac);
          if (!apInfo) continue;

          // Linear weight from dBm — keep it simple and deterministic
          const w = Math.max(1, (det.rssi ?? -100) + 100);
          sumX += apInfo.x_m * w;
          sumY += apInfo.y_m * w;
          sumW += w;
        }

        let measurementX = null;
        let measurementY = null;
        if (sumW > 0) {
          measurementX = sumX / sumW;
          measurementY = sumY / sumW;
        } else {
          // No known APs — fall back to primary AP's own position
          const primaryApInfo = this.apMap.get(primaryDet.ap_mac);
          if (primaryApInfo) {
            measurementX = primaryApInfo.x_m;
            measurementY = primaryApInfo.y_m;
          }
        }

        const cfg = MAP_CONFIGS[firstDet.map_id];
        const ppm = cfg?.ppm ?? 50.07391564392213;

        const position =
          measurementX !== null
            ? { x_m: measurementX, y_m: measurementY, ppm }
            : null;

        const position_px =
          position && cfg
            ? {
                x: position.x_m * cfg.ppm + cfg.origin_x,
                y: cfg.origin_y - position.y_m * cfg.ppm,
              }
            : null;

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          position,
          position_px,
          ap_mac: primaryDet.ap_mac,
          ap_name: this.apMap.get(primaryDet.ap_mac)?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam: primaryDet.beam ?? null,
          anchor_count: detections.length,
          ppm,
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
