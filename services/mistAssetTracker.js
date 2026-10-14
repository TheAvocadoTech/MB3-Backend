// services/mistAssetTracker.js
// RAW SIGNAL MODE — no filtering, no smoothing, no trail.
//
//   - Mist API hit only on cache miss / stale (with 429 backoff)
//   - Redis cache layer (single-flight lock, TTL, stale-fallback)
//   - Local AP list from ap_list.json (derives x_m/y_m from pixels)
//   - Simple RSSI-weighted centroid of current detections only
//   - Emits raw position + raw RSSI + primary AP + top APs
//
// Exports a singleton EventEmitter.

const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

// ============================================================
// ENV
// ============================================================
const SITE_ID = process.env.MIST_SITE_ID;
if (!SITE_ID) throw new Error("MIST_SITE_ID environment variable required");

const API_TOKEN = process.env.MIST_API_TOKEN;
if (!API_TOKEN) throw new Error("MIST_API_TOKEN environment variable required");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const ASSET_TTL_SEC = parseInt(process.env.ASSET_TTL_SEC || "300", 10);

const FRESH_WINDOW_MS = parseInt(
  process.env.ASSET_FRESH_WINDOW_MS || "1500",
  10,
);

const FETCH_LOCK_TTL_MS = parseInt(
  process.env.ASSET_FETCH_LOCK_MS || "10000",
  10,
);

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
  "cb424deb-7d15-4c86-93fb-688116b713ee": {
    name: "MB3-F04",
    width: 6400,
    height: 5120,
    width_m: 100,
    height_m: 100,
    origin_x: 0,
    origin_y: 0,
    ppm: 50,
    offset_x: 0,
    offset_y: 0,
  },
  "fb2f9216-02a7-423d-ab04-856fc2d1edb4": {
    name: "MB3-F02",
    width: 6400,
    height: 5120,
    width_m: 100,
    height_m: 100,
    origin_x: 0,
    origin_y: 0,
    ppm: 50,
    offset_x: 0,
    offset_y: 0,
  },
  "1cd59ea1-3478-4bd0-b4b9-5e78a002331e": {
    name: "MB3-F03",
    width: 6400,
    height: 5120,
    width_m: 100,
    height_m: 100,
    origin_x: 0,
    origin_y: 0,
    ppm: 50,
    offset_x: 0,
    offset_y: 0,
  },
  "efeca217-1f71-49cd-87b5-7023b40494f2": {
    name: "MB3-F05",
    width: 6400,
    height: 5120,
    width_m: 100,
    height_m: 100,
    origin_x: 0,
    origin_y: 0,
    ppm: 50,
    offset_x: 0,
    offset_y: 0,
  },
  "7e5341c9-f9ce-4aad-ae6a-8234c3a3866e": {
    name: "MB3-M1",
    width: 6400,
    height: 5120,
    width_m: 100,
    height_m: 100,
    origin_x: 0,
    origin_y: 0,
    ppm: 50,
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
// AP CORRECTIONS (kept for optional rotation / RSSI offsets)
// ============================================================
const AP_CORRECTIONS = {};

// ============================================================
// REDIS CLIENT
// ============================================================
const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("❌ Redis error:", e.message));

const K = {
  asset: (mac) => `mist:asset:${mac}`,
  index: "mist:assets:index",
  meta: "mist:assets:meta",
  lock: "mist:assets:fetch_lock",
};

// ============================================================
// AssetTracker (raw mode)
// ============================================================
class AssetTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.MIN_RSSI = options.minRssi ?? -100; // effectively "no floor"
    this.TOP_APS_REPORT = options.topAps ?? 5;

    // Backoff
    this.backoffUntil = 0;
    this.backoffMultiplier = 1;

    // AP map
    this.apMap = new Map();
    this.unmappedLogged = new Set();

    // Redis state
    this._redisReady = false;
    this._inflightFetch = null;

    this._loadStaticAPs();
  }

  // ============================================================
  // ap_list.json loading
  // ============================================================
  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);

      if (!Array.isArray(apList) || apList.length === 0) {
        console.warn("⚠️ ap_list.json is empty.");
        return;
      }

      let loaded = 0;
      let skippedNoMap = 0;
      let skippedNoCoords = 0;

      for (const ap of apList) {
        if (!ap.mac) continue;

        const cfg = MAP_CONFIGS[ap.map_id];
        if (!cfg) {
          skippedNoMap++;
          continue;
        }

        let x_m, y_m;
        const hasPixels =
          Number.isFinite(ap.x) &&
          Number.isFinite(ap.y) &&
          ap.x !== 0 &&
          ap.y !== 0;

        if (hasPixels) {
          x_m = (ap.x - cfg.origin_x) / cfg.ppm;
          y_m = (cfg.origin_y - ap.y) / cfg.ppm;
        } else if (Number.isFinite(ap.x_m) && Number.isFinite(ap.y_m)) {
          x_m = ap.x_m;
          y_m = ap.y_m;
        } else {
          skippedNoCoords++;
          continue;
        }

        const correction = AP_CORRECTIONS[ap.mac] || {};
        this.apMap.set(ap.mac, {
          x_m,
          y_m,
          name: ap.name || ap.mac,
          orientation:
            (ap.orientation || 0) + (correction.rotationOffsetDeg || 0),
          rssiOffset: correction.rssiOffsetDb || 0,
          rotationOffsetDeg: correction.rotationOffsetDeg || 0,
          map_id: ap.map_id,
        });
        loaded++;
      }

      console.log(
        `✅ Loaded ${loaded} APs from ap_list.json ` +
          `(skipped ${skippedNoMap} unknown-map, ${skippedNoCoords} no-coords)`,
      );
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  // ============================================================
  // Redis lifecycle
  // ============================================================
  async initRedis() {
    if (!redis.isOpen) await redis.connect();
    this._redisReady = true;
    console.log(`✅ Redis connected: ${REDIS_URL}`);
    return this;
  }
  async closeRedis() {
    if (redis.isOpen) await redis.quit();
    this._redisReady = false;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  async getAssetsCached(opts = {}) {
    const { force = false, allowStale = true } = opts;

    if (!this._redisReady) return this._fetchAndStore();

    if (!force) {
      const meta = await redis.hGetAll(K.meta);
      const lastFetch = parseInt(meta.last_fetch_at || "0", 10);
      const age = Date.now() - lastFetch;
      if (lastFetch > 0 && age <= FRESH_WINDOW_MS) {
        const cached = await this._readAllFromRedis();
        if (cached.length > 0) return cached;
      }
    }

    try {
      return await this._fetchAndStore();
    } catch (err) {
      if (allowStale) {
        const stale = await this._readAllFromRedis();
        if (stale.length > 0) {
          console.log("↩️ Mist failed — serving stale Redis data");
          return stale;
        }
      }
      throw err;
    }
  }

  async getAssetCached(mac, opts = {}) {
    if (this._redisReady && !opts.force) {
      const hit = await this._readOneFromRedis(mac);
      if (hit && Date.now() - hit.updated_at <= FRESH_WINDOW_MS) return hit;
    }
    const all = await this.getAssetsCached({ force: true, allowStale: true });
    return all.find((a) => a.mac === mac) || null;
  }

  async clearRedis() {
    if (!this._redisReady) return;
    const macs = await redis.sMembers(K.index);
    const pipeline = redis.multi();
    for (const mac of macs) pipeline.del(K.asset(mac));
    pipeline.del(K.index);
    pipeline.del(K.meta);
    await pipeline.exec();
  }

  // ============================================================
  // Single-flight fetch + persist
  // ============================================================
  async _fetchAndStore() {
    if (this._inflightFetch) return this._inflightFetch;

    if (this._redisReady) {
      const gotLock = await redis.set(K.lock, String(Date.now()), {
        NX: true,
        PX: FETCH_LOCK_TTL_MS,
      });
      if (!gotLock) {
        await new Promise((r) => setTimeout(r, 250));
        const cached = await this._readAllFromRedis();
        if (cached.length > 0) return cached;
      }
    }

    this._inflightFetch = (async () => {
      try {
        if (this.backoffUntil > Date.now()) {
          const remaining = Math.ceil((this.backoffUntil - Date.now()) / 1000);
          console.log(
            `⏳ Rate-limited – serving cache (${remaining}s remaining)`,
          );
          return await this._readAllFromRedis();
        }

        const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);
        this.backoffMultiplier = 1;
        this.backoffUntil = 0;

        if (
          response.data &&
          Array.isArray(response.data) &&
          response.data.length > 0
        ) {
          const processed = this._processAssetData(response.data);
          await this._writeBatchToRedis(processed);
          if (this._redisReady) {
            await redis.hSet(K.meta, {
              last_fetch_at: String(Date.now()),
              last_error: "",
            });
            await redis.expire(K.meta, ASSET_TTL_SEC);
          }
          return processed;
        }

        return await this._readAllFromRedis();
      } catch (err) {
        const status = err.response?.status;

        if (status === 429) {
          const retryAfter =
            parseInt(err.response.headers["retry-after"], 10) || 30;
          const waitMs = retryAfter * 1000 * this.backoffMultiplier;
          this.backoffUntil = Date.now() + waitMs;
          this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
          console.error(
            `🚫 429 – retry after ${Math.ceil(waitMs / 1000)}s ` +
              `(multiplier ${this.backoffMultiplier})`,
          );
          if (this._redisReady) {
            await redis.hSet(K.meta, { last_error: `429:${retryAfter}` });
          }
          this.emit("rateLimited", { retryAfter: Math.ceil(waitMs / 1000) });
          return await this._readAllFromRedis();
        }

        console.error("Mist API Error:", err.message);
        if (err.response) console.error("Status:", err.response.status);
        if (this._redisReady) {
          await redis.hSet(K.meta, { last_error: err.message });
        }
        throw err;
      } finally {
        if (this._redisReady) await redis.del(K.lock);
        this._inflightFetch = null;
      }
    })();

    return this._inflightFetch;
  }

  // ============================================================
  // Redis read helpers
  // ============================================================
  async _readAllFromRedis() {
    if (!this._redisReady) return [];
    const macs = await redis.sMembers(K.index);
    if (!macs || macs.length === 0) return [];

    const pipeline = redis.multi();
    for (const mac of macs) pipeline.hGetAll(K.asset(mac));
    const results = await pipeline.exec();

    const assets = [];
    for (let i = 0; i < macs.length; i++) {
      const hash = results[i];
      if (!hash || Object.keys(hash).length === 0) continue;
      assets.push(this._hashToAsset(hash));
    }
    return assets;
  }

  async _readOneFromRedis(mac) {
    if (!this._redisReady) return null;
    const hash = await redis.hGetAll(K.asset(mac));
    if (!hash || Object.keys(hash).length === 0) return null;
    return this._hashToAsset(hash);
  }

  _hashToAsset(hash) {
    const mapId = hash.map_id;
    const cfg = MAP_CONFIGS[mapId];
    const x_m = parseFloat(hash.x_m);
    const y_m = parseFloat(hash.y_m);
    const hasPos = Number.isFinite(x_m) && Number.isFinite(y_m);

    return {
      mac: hash.mac,
      device_name: hash.device_name,
      map_id: mapId || null,
      position: hasPos
        ? { x_m, y_m, ppm: parseFloat(hash.ppm) || (cfg?.ppm ?? 50) }
        : null,
      position_px:
        cfg && hasPos
          ? { x: x_m * cfg.ppm + cfg.origin_x, y: cfg.origin_y - y_m * cfg.ppm }
          : null,
      ap_mac: hash.ap_mac || null,
      rssi: hash.rssi !== "" ? parseFloat(hash.rssi) : null,
      best_rssi: hash.best_rssi !== "" ? parseFloat(hash.best_rssi) : null,
      beam: hash.beam !== "" ? parseFloat(hash.beam) : null,
      stability: hash.stability !== "" ? parseFloat(hash.stability) : null,
      is_moving: hash.is_moving === "1",
      is_most_accurate: hash.is_most_accurate === "1",
      updated_at: parseInt(hash.updated_at, 10) || 0,
    };
  }

  async _writeBatchToRedis(assets) {
    if (!this._redisReady || !assets || assets.length === 0) return;
    const now = Date.now();
    const pipeline = redis.multi();

    for (const a of assets) {
      const mac = a.mac;
      const cfg = MAP_CONFIGS[a.map_id];
      const posPx =
        cfg && a.position
          ? {
              x: a.position.x_m * cfg.ppm + cfg.origin_x,
              y: cfg.origin_y - a.position.y_m * cfg.ppm,
            }
          : null;

      pipeline.hSet(K.asset(mac), {
        mac,
        device_name: a.device_name || "Unknown",
        map_id: a.map_id || "",
        x_m: String(a.position?.x_m ?? ""),
        y_m: String(a.position?.y_m ?? ""),
        ppm: String(a.ppm ?? ""),
        px_x: String(posPx?.x ?? ""),
        px_y: String(posPx?.y ?? ""),
        ap_mac: a.ap_mac || "",
        rssi: String(a.rssi ?? ""),
        best_rssi: String(a.best_rssi ?? ""),
        beam: a.beam != null ? String(a.beam) : "",
        stability: String(a.stability ?? ""),
        is_moving: a.is_moving ? "1" : "0",
        is_most_accurate: a.is_most_accurate ? "1" : "0",
        updated_at: String(now),
      });
      pipeline.expire(K.asset(mac), ASSET_TTL_SEC);
      pipeline.sAdd(K.index, mac);
    }

    try {
      await pipeline.exec();
    } catch (e) {
      console.error("❌ Redis write failed:", e.message);
    }
  }

  // ============================================================
  // Legacy getters
  // ============================================================
  getCachedAssets() {
    return this.cachedProcessedAssets || [];
  }

  getAssetStates() {
    // Raw mode: nothing cached in memory — read from Redis instead.
    return {};
  }

  getAssetTrail() {
    return [];
  }
  clearAssetTrail() {}
  resetAsset() {}
  setWayfindingData() {}

  // ============================================================
  // Main pipeline (RAW — one centroid per batch, no smoothing)
  // ============================================================
  _processAssetData(assets) {
    if (!Array.isArray(assets)) {
      console.warn("⚠️ _processAssetData called with non-array, skipping");
      return [];
    }

    const processedAssets = [];
    const assetGroups = this._groupDetectionsByAsset(assets);

    for (const [mac, detections] of assetGroups) {
      try {
        const firstDet = detections[0];
        if (!firstDet.map_id) {
          if (!this.unmappedLogged.has(mac)) {
            console.warn(`⚠️ Asset ${mac} has no map_id – skipping`);
            this.unmappedLogged.add(mac);
          }
          continue;
        }

        // ---- Pick the strongest detection (raw RSSI, no EMA) ----
        let primaryDet = detections[0];
        for (const d of detections) {
          if ((d.rssi ?? -999) > (primaryDet.rssi ?? -999)) primaryDet = d;
        }

        // ---- Simple RSSI-weighted centroid (only computation kept) ----
        let sumX = 0,
          sumY = 0,
          sumW = 0;
        let anchorCount = 0;
        const topAps = [];

        for (const det of detections) {
          if (det.rssi < this.MIN_RSSI) continue;

          const apInfo = this.apMap.get(det.ap_mac);
          let x_m, y_m;

          if (apInfo) {
            x_m = apInfo.x_m;
            y_m = apInfo.y_m;
          } else if (
            Number.isFinite(det.x) &&
            Number.isFinite(det.y) &&
            det.map_id
          ) {
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (!coords || !isFinite(coords.x_m) || !isFinite(coords.y_m)) {
              continue;
            }
            x_m = coords.x_m;
            y_m = coords.y_m;
          } else {
            continue;
          }

          // linear weight (simplest possible)
          const w = Math.max(1, det.rssi + 100); // dBm → 0..100
          sumX += x_m * w;
          sumY += y_m * w;
          sumW += w;
          anchorCount++;

          topAps.push({
            ap: det.ap_mac,
            rssi: det.rssi,
            beam: det.beam ?? null,
          });
        }

        topAps.sort((a, b) => b.rssi - a.rssi);
        const topApsSliced = topAps.slice(0, this.TOP_APS_REPORT);

        if (sumW === 0) {
          // No usable anchors this round — skip update
          continue;
        }

        const measurementX = sumX / sumW;
        const measurementY = sumY / sumW;

        const ppm = MAP_CONFIGS[firstDet.map_id]?.ppm ?? 50.0739;
        const position = { x_m: measurementX, y_m: measurementY, ppm };

        const apInfo = this.apMap.get(primaryDet.ap_mac);

        const out = {
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          position,
          ap_mac: primaryDet.ap_mac,
          ap_name: apInfo?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          best_rssi: primaryDet.rssi, // raw mode: same as rssi
          beam: primaryDet.beam ?? null,
          anchor_count: anchorCount,
          topAps: topApsSliced,
          stability: null,
          is_moving: null,
          is_most_accurate: null,
          ppm,
        };

        processedAssets.push(out);

        // ---- Emit raw update ----
        this.emit("assetUpdate", {
          mac,
          device_name: out.device_name,
          position,
          raw_position_px: {
            x:
              measurementX * ppm +
              (MAP_CONFIGS[firstDet.map_id]?.origin_x ?? 0),
            y:
              (MAP_CONFIGS[firstDet.map_id]?.origin_y ?? 0) -
              measurementY * ppm,
          },
          primary_ap_mac: primaryDet.ap_mac,
          primary_ap_name: apInfo?.name || primaryDet.ap_mac,
          ap_count: anchorCount,
          raw: primaryDet,
          rssi: primaryDet.rssi,
          best_rssi: primaryDet.rssi,
          beam: primaryDet.beam ?? null,
          timestamp: Date.now(),
          topAps: topApsSliced,
        });
      } catch (err) {
        console.error(`Error processing ${mac}:`, err);
      }
    }

    return processedAssets;
  }

  // ============================================================
  // Utilities
  // ============================================================
  _groupDetectionsByAsset(assets) {
    const groups = new Map();
    for (const a of assets) {
      if (!a.mac) continue;
      if (!groups.has(a.mac)) groups.set(a.mac, []);
      groups.get(a.mac).push(a);
    }
    return groups;
  }

  _convertCoordinates(x, y, mapId) {
    if (!mapId) return { x_m: x, y_m: y, ppm: 1 };
    const config = MAP_CONFIGS[mapId];
    if (!config) return { x_m: x, y_m: y, ppm: 1 };
    let x_m = (x - config.origin_x) / config.ppm;
    let y_m = (config.origin_y - y) / config.ppm;
    if (config.offset_x) x_m += config.offset_x;
    if (config.offset_y) y_m += config.offset_y;
    return { x_m, y_m, ppm: config.ppm };
  }
}

// ============================================================
// Export singleton — RAW MODE
// ============================================================
const options = {
  minRssi: -100, // accept everything from Mist
  topAps: 5, // how many APs to include in the emit payload
};

const assetTracker = new AssetTracker(options);

(async () => {
  try {
    await assetTracker.initRedis();
    console.log(
      "✅ mistAssetTracker loaded — RAW MODE (no filters, no smoothing, no trail)",
    );
  } catch (e) {
    console.error("❌ Redis init failed:", e.message);
  }
})();

process.on("SIGINT", async () => {
  await assetTracker.closeRedis();
  process.exit(0);
});

module.exports = assetTracker;
