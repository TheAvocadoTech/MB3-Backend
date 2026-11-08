// services/mistAssetTracker.js
const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const Redis = require("ioredis");

const SITE_ID = process.env.MIST_SITE_ID;
if (!SITE_ID) throw new Error("MIST_SITE_ID environment variable required");

const API_TOKEN = process.env.MIST_API_TOKEN;
if (!API_TOKEN) throw new Error("MIST_API_TOKEN environment variable required");

// Config
const DEFAULT_ASSET_RADIUS_M = parseInt(process.env.ASSET_RADIUS_M, 10) || 5;
const STALE_THRESHOLD_MS = 120_000; // 2 minutes
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const CACHE_KEY = `mist:assets:${SITE_ID}`;
const BACKOFF_KEY = `mist:backoff:${SITE_ID}`;
const CACHE_TTL_SEC = parseInt(process.env.MIST_CACHE_TTL_SEC, 10) || 30;
const MIN_REFRESH_MS = parseInt(process.env.MIST_MIN_REFRESH_MS, 10) || 5000;

// Path-loss model parameters (RSSI to Distance)
const PATH_LOSS_EXPONENT = parseFloat(process.env.PATH_LOSS_EXPONENT) || 2.5;
const RSSI_AT_1M = parseFloat(process.env.RSSI_AT_1M) || -45;

// Smoothing / Jump prevention
const POSITION_ALPHA = parseFloat(process.env.POSITION_ALPHA) || 0.35;
const MAX_JUMP_M = parseFloat(process.env.MAX_JUMP_M) || 15;

// ============================================================
// MAP CONFIGS
// ⚠️ YOU MUST ADD THE UUID FOR THE FLOOR IN YOUR SCREENSHOT HERE
// ============================================================
const MAP_CONFIGS = {
  "30141417-44ea-4982-993c-6225c9f08315": {
    name: "MB3-F00",
    ppm: 50.07391564392213,
    origin_x: 306.45106507695385,
    origin_y: 3856.483584010582,
    offset_x: 0,
    offset_y: 0,
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    name: "MB3-F01",
    ppm: 57.275559331634064,
    origin_x: 6.786923314266026,
    origin_y: 4134.933029216576,
    offset_x: 0,
    offset_y: 0,
  },
  // 👇 REPLACE THIS WITH YOUR ACTUAL MAP UUID
  "YOUR-MAP-UUID-HERE": {
    name: "Ground Floor",
    ppm: 50.0, // Pixels per meter (find in map settings)
    origin_x: 0, // X pixel of meter (0,0)
    origin_y: 0, // Y pixel of meter (0,0)
    offset_x: 0,
    offset_y: 0,
  },
};

const mist = axios.create({
  baseURL: "https://api.mist.com/api/v1",
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 10000,
});

const safeJson = (obj) => {
  try {
    return JSON.stringify(obj, (k, v) =>
      typeof v === "bigint" ? v.toString() : Number.isNaN(v) ? null : v,
    );
  } catch (err) {
    console.warn("⚠️ JSON serialize failed:", err.message);
    return null;
  }
};

function rssiToDistance(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  const d = Math.pow(10, (RSSI_AT_1M - rssi) / (10 * PATH_LOSS_EXPONENT));
  return Math.min(Math.max(d, 0.3), 100);
}

function rssiWeight(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return 0;
  const clamped = Math.max(rssi, -100);
  return Math.pow(10, clamped / 10);
}

function coerceBeam(b) {
  const n = Number(b);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

class AssetTracker extends EventEmitter {
  constructor() {
    super();
    this.cachedProcessedAssets = [];
    this.apMap = new Map();
    this.mapMap = new Map();
    this.smoothedByMac = new Map();
    this.lastFetchAt = 0;
    this.inflight = null;

    this.redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    this.redis.on("error", (err) => console.error("Redis error:", err.message));
    this.redis.on("connect", () =>
      console.log("✅ Redis connected for Mist asset cache"),
    );

    this._loadStaticAPs();
    this._hydrateFromRedis();
  }

  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (!fs.existsSync(filePath)) {
        console.warn("⚠️ ap_list.json not found.");
        return;
      }

      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);
      if (!Array.isArray(apList)) return;

      let missingMeters = 0;

      for (const ap of apList) {
        if (!ap.mac) continue;

        let x_m = ap.x_m;
        let y_m = ap.y_m;

        if (
          (x_m == null || y_m == null) &&
          ap.map_id &&
          ap.x != null &&
          ap.y != null &&
          MAP_CONFIGS[ap.map_id]
        ) {
          const cfg = MAP_CONFIGS[ap.map_id];
          x_m = (ap.x - cfg.origin_x) / cfg.ppm + (cfg.offset_x || 0);
          y_m = (cfg.origin_y - ap.y) / cfg.ppm + (cfg.offset_y || 0);
        }

        if (x_m == null || y_m == null) missingMeters++;

        this.apMap.set(ap.mac.toLowerCase().trim(), {
          name: ap.name || ap.mac,
          map_id: ap.map_id || null,
          x: ap.x,
          y: ap.y,
          x_m,
          y_m,
        });

        if (ap.map_id && ap.map_name) {
          this.mapMap.set(ap.map_id, ap.map_name);
        }
      }

      console.log(
        `✅ Loaded ${this.apMap.size} APs from ap_list.json` +
          (missingMeters
            ? ` (${missingMeters} missing x_m/y_m — check MAP_CONFIGS)`
            : ""),
      );
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  async _hydrateFromRedis() {
    try {
      const cached = await this.redis.get(CACHE_KEY);
      if (cached) {
        this.cachedProcessedAssets = JSON.parse(cached);
        console.log(
          `♻️ Hydrated ${this.cachedProcessedAssets.length} assets from Redis`,
        );
        this.emit("assets", this.cachedProcessedAssets);
      }
    } catch (err) {
      console.warn("⚠️ Redis hydrate failed:", err.message);
    }
  }

  getCachedAssets() {
    return this.cachedProcessedAssets;
  }

  async _isBackedOff() {
    try {
      const until = await this.redis.get(BACKOFF_KEY);
      if (!until) return false;
      return parseInt(until, 10) > Date.now();
    } catch {
      return false;
    }
  }

  async _setBackoff(waitMs) {
    try {
      await this.redis.set(
        BACKOFF_KEY,
        String(Date.now() + waitMs),
        "PX",
        waitMs + 5000,
      );
    } catch (err) {
      console.warn("⚠️ Could not set Redis backoff:", err.message);
    }
  }

  async getAssets() {
    if (Date.now() - this.lastFetchAt < MIN_REFRESH_MS)
      return this.cachedProcessedAssets;
    if (await this._isBackedOff()) return this.cachedProcessedAssets;
    if (this.inflight) return this.inflight;

    this.inflight = this._fetchAndCache().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async _fetchAndCache() {
    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);

      if (Array.isArray(response.data) && response.data.length > 0) {
        const processed = this._processAssetData(response.data);
        this.cachedProcessedAssets = processed;
        this.lastFetchAt = Date.now();

        const json = safeJson(processed);
        if (json) {
          this.redis
            .set(CACHE_KEY, json, "EX", CACHE_TTL_SEC)
            .catch((err) => console.warn("⚠️ Redis set failed:", err.message));
        }

        this.emit("assets", processed);
        return processed;
      }
      return this.cachedProcessedAssets;
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        const retryAfter =
          parseInt(err.response.headers["retry-after"], 10) || 60;
        const waitMs = retryAfter * 1000;
        await this._setBackoff(waitMs);
        this.emit("rateLimited", { retryAfter });
        console.warn(`⏸️ Mist 429 — backing off ${retryAfter}s`);
        return this.cachedProcessedAssets;
      }

      console.error("Mist API Error:", err.message);
      return this.cachedProcessedAssets;
    }
  }

  _pixelToMeters(x, y, mapId) {
    if (x == null || y == null) return null;
    const cfg = MAP_CONFIGS[mapId];
    if (!cfg) return null;
    return {
      x_m: (x - cfg.origin_x) / cfg.ppm + (cfg.offset_x || 0),
      y_m: (cfg.origin_y - y) / cfg.ppm + (cfg.offset_y || 0),
    };
  }

  _metersToPixel(x_m, y_m, mapId) {
    if (x_m == null || y_m == null) return null;
    const cfg = MAP_CONFIGS[mapId];
    if (!cfg) return null;
    return {
      x: (x_m - (cfg.offset_x || 0)) * cfg.ppm + cfg.origin_x,
      y: cfg.origin_y - (y_m - (cfg.offset_y || 0)) * cfg.ppm,
    };
  }

  _computeFusedLocation(mac, detections, mapId) {
    const weightedPoints = [];

    for (const det of detections) {
      const apMacKey = (det.ap_mac || "").toLowerCase().trim();
      const apStatic = this.apMap.get(apMacKey);

      let x_m = null;
      let y_m = null;
      let source = null;

      if (det.x_m != null && det.y_m != null) {
        x_m = det.x_m;
        y_m = det.y_m;
        source = "det_metric";
      } else if (det.x != null && det.y != null) {
        const m = this._pixelToMeters(det.x, det.y, mapId);
        if (m) {
          x_m = m.x_m;
          y_m = m.y_m;
          source = "det_pixel";
        }
      }

      if (x_m == null && apStatic) {
        let baseX = apStatic.x_m;
        let baseY = apStatic.y_m;

        if (
          baseX == null &&
          apStatic.x != null &&
          apStatic.y != null &&
          apStatic.map_id
        ) {
          const m = this._pixelToMeters(
            apStatic.x,
            apStatic.y,
            apStatic.map_id,
          );
          if (m) {
            baseX = m.x_m;
            baseY = m.y_m;
          }
        }

        if (baseX != null && baseY != null) {
          const dist = rssiToDistance(det.rssi);
          const beam = coerceBeam(det.beam);

          if (dist != null && beam != null) {
            const angleRad = (beam * 45 * Math.PI) / 180;
            x_m = baseX + dist * Math.sin(angleRad);
            y_m = baseY + dist * Math.cos(angleRad);
            source = "ap_beam_projection";
          } else {
            x_m = baseX;
            y_m = baseY;
            source = "ap_position";
          }
        }
      }

      if (x_m == null || y_m == null) continue;

      const w = rssiWeight(det.rssi);
      if (w <= 0) continue;

      weightedPoints.push({
        x_m,
        y_m,
        weight: w,
        rssi: det.rssi,
        ap_mac: det.ap_mac,
        beam: det.beam,
        source,
      });
    }

    if (weightedPoints.length === 0) return null;

    let sumW = 0,
      sumX = 0,
      sumY = 0;
    for (const p of weightedPoints) {
      sumW += p.weight;
      sumX += p.weight * p.x_m;
      sumY += p.weight * p.y_m;
    }
    if (sumW <= 0) return null;

    return {
      x_m: sumX / sumW,
      y_m: sumY / sumW,
      method: `weighted_metric(${weightedPoints.length} APs)`,
      contributing: weightedPoints.length,
    };
  }

  _smoothPosition(mac, x_m, y_m) {
    const prev = this.smoothedByMac.get(mac);
    if (!prev) {
      this.smoothedByMac.set(mac, { x_m, y_m, ts: Date.now() });
      return { x_m, y_m };
    }

    const dx = x_m - prev.x_m;
    const dy = y_m - prev.y_m;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let alpha = POSITION_ALPHA;
    if (dist > MAX_JUMP_M) alpha = POSITION_ALPHA * (MAX_JUMP_M / dist);

    const sx = prev.x_m + alpha * dx;
    const sy = prev.y_m + alpha * dy;
    this.smoothedByMac.set(mac, { x_m: sx, y_m: sy, ts: Date.now() });
    return { x_m: sx, y_m: sy };
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

        const sortedDetections = [...detections].sort(
          (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
        );
        const primaryDet = sortedDetections[0];

        const slimDetections = sortedDetections.map((d) => {
          const apKey = (d.ap_mac || "").toLowerCase().trim();
          const apStatic = this.apMap.get(apKey);
          return {
            ap_mac: d.ap_mac,
            ap_name: apStatic?.name || d.ap_mac,
            rssi: d.rssi ?? null,
            beam: coerceBeam(d.beam),
            map_id: d.map_id ?? null,
            x: d.x ?? null,
            y: d.y ?? null,
            x_m: d.x_m ?? null,
            y_m: d.y_m ?? null,
            last_seen: d.last_seen ?? null,
            distance_m: rssiToDistance(d.rssi),
            weight: rssiWeight(d.rssi),
          };
        });

        const detectionsCount = slimDetections.length;
        let locationConfidence = "Low (Single AP)";
        if (detectionsCount >= 3) locationConfidence = "High (Triangulated)";
        else if (detectionsCount === 2) locationConfidence = "Medium (2 APs)";

        const apInfo = this.apMap.get(
          (primaryDet.ap_mac || "").toLowerCase().trim(),
        );

        const lastSeenSec =
          primaryDet.last_seen ?? primaryDet.timestamp ?? null;
        const lastSeenMs = lastSeenSec ? lastSeenSec * 1000 : null;
        const ageMs = lastSeenMs ? Date.now() - lastSeenMs : null;
        const isStale = ageMs != null ? ageMs > STALE_THRESHOLD_MS : true;

        // 🛑 STALE TAG FILTER
        // If the tag was last seen over 2 minutes ago, don't send it to the frontend!
        if (isStale) {
          console.log(
            `🧹 Discarding stale tag ${mac} (last seen ${Math.round(ageMs / 1000)}s ago)`,
          );
          continue;
        }

        const fused = this._computeFusedLocation(
          mac,
          sortedDetections,
          firstDet.map_id,
        );

        let x_m = fused?.x_m ?? null;
        let y_m = fused?.y_m ?? null;

        if (x_m == null && primaryDet.x != null && primaryDet.y != null) {
          const m = this._pixelToMeters(
            primaryDet.x,
            primaryDet.y,
            firstDet.map_id,
          );
          if (m) {
            x_m = m.x_m;
            y_m = m.y_m;
          }
        }

        if (x_m == null && apInfo) {
          if (apInfo.x_m != null) {
            x_m = apInfo.x_m;
            y_m = apInfo.y_m;
          } else if (apInfo.x != null) {
            const m = this._pixelToMeters(apInfo.x, apInfo.y, firstDet.map_id);
            if (m) {
              x_m = m.x_m;
              y_m = m.y_m;
            }
          }
        }

        let smoothed = null;
        if (x_m != null && y_m != null) {
          smoothed = this._smoothPosition(mac, x_m, y_m);
          x_m = smoothed.x_m;
          y_m = smoothed.y_m;
        }

        let x_px = null;
        let y_px = null;
        if (x_m != null && y_m != null) {
          const px = this._metersToPixel(x_m, y_m, firstDet.map_id);
          if (px) {
            x_px = px.x;
            y_px = px.y;
          }
        }

        if (x_px == null && primaryDet.x != null) {
          x_px = primaryDet.x;
          y_px = primaryDet.y;
        }

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown Tag",
          map_id: firstDet.map_id,
          map_name: this.mapMap.get(firstDet.map_id) || null,
          x_m,
          y_m,
          x: x_px,
          y: y_px,
          location_method: fused?.method || "fallback",
          location_contributing_aps: fused?.contributing ?? detectionsCount,
          ap_mac: primaryDet.ap_mac,
          ap_name: apInfo?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam: coerceBeam(primaryDet.beam),
          radius: primaryDet.radius || DEFAULT_ASSET_RADIUS_M,
          detections_count: detectionsCount,
          location_confidence: locationConfidence,
          last_seen: lastSeenMs,
          age_ms: ageMs,
          is_stale: false, // It's always false here since we discard stale tags above
          updated_at: new Date().toISOString(),
          detections: slimDetections,
        });
      } catch (err) {
        console.error(`Error processing asset ${mac}:`, err);
      }
    }

    return processedAssets;
  }

  async close() {
    await this.redis.quit().catch(() => {});
  }
}

const assetTracker = new AssetTracker();
module.exports = assetTracker;
