// services/mistAssetTracker.js
// Full Mist asset tracker with dynamic position trail (breadcrumb path).
//
//   - ON-DEMAND Redis middle-layer (no polling, no setInterval)
//   - Mist API hit only on cache miss / stale (with 429 backoff)
//   - Local AP list from ap_list.json + AP_CORRECTIONS
//   - Per-AP RSSI offset + AoA vector rotation + static-anchor pinning
//   - RSSI-weighted AP centroid
//   - Particle filter (or EMA fallback)
//   - Median outlier rejection
//   - Heatmap density smoothing
//   - Velocity limiting + jump guard
//   - Stationary Drift Guard (dead-zone lock + adaptive alpha)
//   - Dynamic position trail (breadcrumb, replaces wayfinding-path snapping)
//
// Exports a singleton EventEmitter.
//
// Request flow:
//   Client → getAssetsCached() → Redis fresh? → HIT return
//                              → MISS/STALE → Mist → process → Redis save → return

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

// Freshness window — data younger than this is served from Redis as-is
const FRESH_WINDOW_MS = parseInt(
  process.env.ASSET_FRESH_WINDOW_MS || "1500",
  10
);

// Single-flight lock TTL (concurrent requests share one Mist fetch)
const FETCH_LOCK_TTL_MS = parseInt(
  process.env.ASSET_FETCH_LOCK_MS || "10000",
  10
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
    width: 6400, height: 5120,
    width_m: 127.81105527098556,
    height_m: 102.24884421678846,
    origin_x: 306.45106507695385,
    origin_y: 3856.483584010582,
    ppm: 50.07391564392213,
    offset_x: 0, offset_y: 0,
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    name: "MB3-F01",
    width: 6400, height: 5120,
    width_m: 111.74050632911398,
    height_m: 89.39240506329119,
    origin_x: 6.786923314266026,
    origin_y: 4134.933029216576,
    ppm: 57.275559331634064,
    offset_x: 0, offset_y: 0,
  },
  default: {
    name: "default",
    width: 6400, height: 5120,
    width_m: 50, height_m: 50,
    origin_x: 0, origin_y: 0, ppm: 10,
    offset_x: 0, offset_y: 0,
  },
};

// ============================================================
// AP CORRECTIONS
// ============================================================
const AP_CORRECTIONS = {
  c878678aa2ab: {
    rotationOffsetDeg: 180,
    rssiOffsetDb: +4,
    isStaticZoneAnchor: true,
    zoneBounds: { minX: 100, maxX: 115, minY: 25, maxY: 35 },
  },
};

// ============================================================
// Particle Filter
// ============================================================
class ParticleFilter {
  constructor(numParticles = 100, processNoise = 0.5, measurementNoise = 1.0) {
    this.numParticles = numParticles;
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;
    this.particles = [];
    this.weights = [];
    this.initialized = false;
  }
  init(x, y) {
    this.particles = [];
    this.weights = [];
    for (let i = 0; i < this.numParticles; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * this.processNoise * 2,
        y: y + (Math.random() - 0.5) * this.processNoise * 2,
      });
      this.weights.push(1 / this.numParticles);
    }
    this.initialized = true;
  }
  predict(dt) {
    const noise = this.processNoise * Math.sqrt(dt || 1);
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i].x += (Math.random() - 0.5) * noise * 2;
      this.particles[i].y += (Math.random() - 0.5) * noise * 2;
    }
  }
  update(mx, my) {
    let totalWeight = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const dx = this.particles[i].x - mx;
      const dy = this.particles[i].y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const weight = Math.exp(
        -(dist * dist) / (2 * this.measurementNoise * this.measurementNoise)
      );
      this.weights[i] = weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) {
      for (let i = 0; i < this.weights.length; i++) {
        this.weights[i] /= totalWeight;
      }
    }
  }
  resample() {
    const newParticles = [];
    const cumulative = [];
    let sum = 0;
    for (let i = 0; i < this.weights.length; i++) {
      sum += this.weights[i];
      cumulative.push(sum);
    }
    const step = 1 / this.numParticles;
    let r = Math.random() * step;
    let idx = 0;
    for (let i = 0; i < this.numParticles; i++) {
      while (r > cumulative[idx]) idx++;
      newParticles.push({ ...this.particles[idx] });
      r += step;
    }
    this.particles = newParticles;
    this.weights.fill(1 / this.numParticles);
  }
  getEstimate() {
    if (!this.initialized || this.particles.length === 0) return null;
    let avgX = 0, avgY = 0, totalW = 0;
    for (let i = 0; i < this.particles.length; i++) {
      avgX += this.particles[i].x * this.weights[i];
      avgY += this.particles[i].y * this.weights[i];
      totalW += this.weights[i];
    }
    if (totalW === 0) return null;
    return { x: avgX / totalW, y: avgY / totalW };
  }
}

// ============================================================
// Stationary Drift Guard
// ============================================================
class StationaryDriftGuard {
  static applyStationaryLock(state, candidateX, candidateY, cfg = {}) {
    const cur = state.currentPosition || state.currentPos;
    const threshold = cfg.threshold ?? cfg.lockDistanceThreshold ?? 0.80;
    const fastThreshold = cfg.fastThreshold ?? 1.5;
    const stationaryAlpha = cfg.stationaryAlpha ?? 0.02;
    const movingAlpha = cfg.movingAlpha ?? 0.45;

    if (!cur) return { x: candidateX, y: candidateY, isMoving: true };

    const cx = cur.x_m;
    const cy = cur.y_m;
    const distFromCurrent = Math.sqrt(
      (candidateX - cx) ** 2 + (candidateY - cy) ** 2
    );

    if (distFromCurrent < threshold) {
      return { x: cx, y: cy, isMoving: false };
    }

    const alpha =
      distFromCurrent > fastThreshold ? movingAlpha : stationaryAlpha;
    return {
      x: alpha * candidateX + (1 - alpha) * cx,
      y: alpha * candidateY + (1 - alpha) * cy,
      isMoving: true,
    };
  }
}

// ============================================================
// REDIS CLIENT (middle-layer storage)
// ============================================================
const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("❌ Redis error:", e.message));

// Key schema
const K = {
  asset: (mac) => `mist:asset:${mac}`,          // HASH  — latest snapshot
  trail: (mac) => `mist:asset:${mac}:trail`,    // LIST  — breadcrumb points
  index: "mist:assets:index",                   // SET   — all known macs
  meta: "mist:assets:meta",                     // HASH  — last_fetch_at, last_error
  lock: "mist:assets:fetch_lock",               // STRING — single-flight lock
};

// ============================================================
// AssetTracker
// ============================================================
class AssetTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.assetStates = new Map();
    this.apRssiFilters = new Map();
    this.hysteresisCounters = new Map();
    this.positionHistory = new Map();

    // --- Tuning ---
    this.EMA_ALPHA = options.emaAlpha ?? 0.15;
    this.POSITION_ALPHA = options.positionAlpha ?? 0.25;
    this.HYSTERESIS_DB = options.hysteresisDb ?? 12;
    this.HYSTERESIS_COUNT = options.hysteresisCount ?? 4;
    this.TOP_APS = options.topAps ?? 3;
    this.STABILITY_THRESHOLD = options.stabilityThreshold ?? 3.0;
    this.OUTLIER_THRESHOLD = options.outlierThreshold ?? 5.0;
    this.MIN_MOVE_METERS = options.minMoveMeters ?? 0.5;
    this.MAX_SPEED_MS = options.maxSpeedMs ?? 2.0;
    this.MIN_RSSI = options.minRssi ?? -75;
    this.MAX_HISTORY = 7;

    this.HEATMAP_WINDOW = options.heatmapWindow ?? 30;
    this.HEATMAP_RADIUS = options.heatmapRadius ?? 2.0;
    this.PARTICLE_COUNT = options.particleCount ?? 100;
    this.PARTICLE_NOISE = options.particleNoise ?? 0.5;
    this.MEASUREMENT_NOISE = options.measurementNoise ?? 1.0;
    this.USE_PARTICLE_FILTER = options.useParticleFilter ?? true;
    this.USE_HEATMAP = options.useHeatmap ?? true;

    // --- AP correction / static-anchor pinning ---
    this.STRONG_RSSI_PIN_DB = options.strongRssiPinDb ?? -62;
    this.PIN_DISTANCE_THRESHOLD_M = options.pinDistanceThresholdM ?? 5.0;

    // --- Stationary Drift Guard ---
    this.USE_STATIONARY_GUARD = options.useStationaryGuard ?? true;
    this.STATIONARY_CFG = {
      threshold: options.stationaryThresholdM ?? 0.80,
      fastThreshold: options.stationaryFastThresholdM ?? 1.5,
      stationaryAlpha: options.stationaryAlpha ?? 0.02,
      movingAlpha: options.movingAlpha ?? 0.45,
      ...(options.stationaryCfg || {}),
    };

    // --- Dynamic path (breadcrumb trail) ---
    this.USE_TRAIL = options.useTrail ?? true;
    this.TRAIL_MAX_POINTS = options.trailMaxPoints ?? 300;
    this.TRAIL_MIN_MOVE_M = options.trailMinMoveM ?? 0.25;
    this.TRAIL_MAX_AGE_MS = options.trailMaxAgeMs ?? 5 * 60 * 1000;
    this.TRAIL_EMIT_POINTS = options.trailEmitPoints ?? 100;

    // --- Backoff ---
    this.backoffUntil = 0;
    this.backoffMultiplier = 1;

    // --- AP map ---
    this.apMap = new Map();
    this.apListFetched = false;
    this.unmappedLogged = new Set();

    // --- Redis state ---
    this._redisReady = false;
    this._inflightFetch = null;

    this._loadStaticAPs();
  }

  // ============================================================
  // ap_list.json loading + AP_CORRECTIONS merge
  // ============================================================
  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);

      if (Array.isArray(apList) && apList.length > 0) {
        for (const ap of apList) {
          if (ap.mac && ap.x_m !== undefined && ap.y_m !== undefined) {
            const correction = AP_CORRECTIONS[ap.mac] || {};
            this.apMap.set(ap.mac, {
              x_m: ap.x_m,
              y_m: ap.y_m,
              name: ap.name || ap.mac,
              orientation:
                (ap.orientation || 0) + (correction.rotationOffsetDeg || 0),
              rssiOffset: correction.rssiOffsetDb || 0,
              isStaticAnchor: correction.isStaticZoneAnchor || false,
              zoneBounds: correction.zoneBounds || null,
              rotationOffsetDeg: correction.rotationOffsetDeg || 0,
            });
          }
        }
        this.apListFetched = true;
        console.log(
          `✅ Loaded ${this.apMap.size} APs from ap_list.json (with corrections)`
        );
      } else {
        console.warn(
          "⚠️ ap_list.json is empty – AP-centroid will fallback to Mist coords."
        );
      }
    } catch (err) {
      console.warn(
        "⚠️ Could not load ap_list.json – AP-centroid will fallback.",
        err.message
      );
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
  // PUBLIC API — callers use THESE (never call Mist directly)
  // ============================================================

  /**
   * Get all assets (cache-aside).
   * @param {Object} opts
   * @param {boolean} opts.force       - skip Redis freshness, hit Mist
   * @param {boolean} opts.allowStale  - serve stale Redis data if Mist fails
   */
  async getAssetsCached(opts = {}) {
    const { force = false, allowStale = true } = opts;

    if (!this._redisReady) {
      return this._fetchAndStore();
    }

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
      if (hit && Date.now() - hit.updated_at <= FRESH_WINDOW_MS) {
        return hit;
      }
    }
    const all = await this.getAssetsCached({ force: true, allowStale: true });
    return all.find((a) => a.mac === mac) || null;
  }

  async clearRedis() {
    if (!this._redisReady) return;
    const macs = await redis.sMembers(K.index);
    const pipeline = redis.multi();
    for (const mac of macs) {
      pipeline.del(K.asset(mac));
      pipeline.del(K.trail(mac));
    }
    pipeline.del(K.index);
    pipeline.del(K.meta);
    await pipeline.exec();
  }

  // ============================================================
  // Internal — single-flight fetch + persist
  // ============================================================
  async _fetchAndStore() {
    // In-process lock: same Node process me duplicate fetch rokta hai
    if (this._inflightFetch) return this._inflightFetch;

    // Cross-process lock: multi-instance deployments me dedupe
    if (this._redisReady) {
      const gotLock = await redis.set(K.lock, String(Date.now()), {
        NX: true,
        PX: FETCH_LOCK_TTL_MS,
      });
      if (!gotLock) {
        // Koi aur fetch kar raha hai — wait karke Redis se padho
        await new Promise((r) => setTimeout(r, 250));
        const cached = await this._readAllFromRedis();
        if (cached.length > 0) return cached;
        // warna khud fetch karo (fallback)
      }
    }

    this._inflightFetch = (async () => {
      try {
        // Backoff check
        if (this.backoffUntil > Date.now()) {
          const remaining = Math.ceil(
            (this.backoffUntil - Date.now()) / 1000
          );
          console.log(
            `⏳ Rate-limited – serving cache (${remaining}s remaining)`
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

        // Empty response — stale serve karo
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
            `🚫 429 – retry after ${Math.ceil(
              waitMs / 1000
            )}s (multiplier ${this.backoffMultiplier})`
          );
          if (this._redisReady) {
            await redis.hSet(K.meta, { last_error: `429:${retryAfter}` });
          }
          this.emit("rateLimited", { retryAfter: Math.ceil(waitMs / 1000) });
          return await this._readAllFromRedis();
        }

        console.error("Mist API Error:", err.message);
        if (err.response) {
          console.error("Status:", err.response.status);
        }
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
    for (const mac of macs) {
      pipeline.hGetAll(K.asset(mac));
      pipeline.lRange(K.trail(mac), 0, -1);
    }
    const results = await pipeline.exec();

    const assets = [];
    for (let i = 0; i < macs.length; i++) {
      const hash = results[i * 2];
      const trailRaw = results[i * 2 + 1];
      if (!hash || Object.keys(hash).length === 0) continue;

      const trail = (trailRaw || [])
        .map((s) => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter(Boolean);

      assets.push(this._hashToAsset(hash, trail));
    }
    return assets;
  }

  async _readOneFromRedis(mac) {
    if (!this._redisReady) return null;
    const pipeline = redis.multi();
    pipeline.hGetAll(K.asset(mac));
    pipeline.lRange(K.trail(mac), 0, -1);
    const [hash, trailRaw] = await pipeline.exec();
    if (!hash || Object.keys(hash).length === 0) return null;

    const trail = (trailRaw || [])
      .map((s) => {
        try { return JSON.parse(s); } catch { return null; }
      })
      .filter(Boolean);
    return this._hashToAsset(hash, trail);
  }

  _hashToAsset(hash, trail) {
    const mapId = hash.map_id;
    const cfg = MAP_CONFIGS[mapId];
    const x_m = parseFloat(hash.x_m);
    const y_m = parseFloat(hash.y_m);
    const hasPos = Number.isFinite(x_m) && Number.isFinite(y_m);

    const trail_px = cfg
      ? trail.map((p) => ({
          x: p.x_m * cfg.ppm + cfg.origin_x,
          y: cfg.origin_y - p.y_m * cfg.ppm,
          t: p.t,
        }))
      : trail.map((p) => ({ x: p.x_m, y: p.y_m, t: p.t }));

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
      trail,
      trail_px,
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

  // ============================================================
  // Redis write helper (called ONLY after a Mist fetch)
  // ============================================================
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

      const trail = a.trail || [];
      if (trail.length > 0) {
        const last = trail[trail.length - 1];
        pipeline.rPush(
          K.trail(mac),
          JSON.stringify({ x_m: last.x_m, y_m: last.y_m, t: last.t || now })
        );
        pipeline.lTrim(K.trail(mac), -this.TRAIL_MAX_POINTS, -1);
        pipeline.expire(K.trail(mac), ASSET_TTL_SEC);
      }
    }

    try {
      await pipeline.exec();
    } catch (e) {
      console.error("❌ Redis write failed:", e.message);
    }
  }

  // ============================================================
  // Public getters (legacy — Redis-backed)
  // ============================================================
  getCachedAssets() {
    // Backward-compat: sync accessor returns last processed in-memory list.
    // Prefer getAssetsCached() for correctness.
    return this.cachedProcessedAssets || [];
  }

  getAssetStates() {
    const states = {};
    for (const [mac, state] of this.assetStates) {
      let positionPx = null;
      if (state.currentPosition && state.currentPosition.ppm && state.map_id) {
        const mapConfig = MAP_CONFIGS[state.map_id];
        if (mapConfig) {
          positionPx = {
            x: state.currentPosition.x_m * mapConfig.ppm + mapConfig.origin_x,
            y: mapConfig.origin_y - state.currentPosition.y_m * mapConfig.ppm,
          };
        }
      }
      states[mac] = {
        device_name: state.device_name,
        position: state.currentPosition,
        position_px: positionPx,
        trail: state.positionTrail ? [...state.positionTrail] : [],
        trail_px: this._trailToPixels(state.positionTrail, state.map_id),
        best_position: state.bestPosition,
        best_rssi: state.bestRSSI,
        stability: state.stabilityScore,
        is_stable: state.positionStable,
        is_moving: state.isMoving ?? false,
        lastUpdate: state.lastUpdate,
        map_id: state.map_id,
        ap_mac: state.currentAP?.ap_mac || null,
        beam: state.currentAP?.beam || null,
        rssi: state.currentAP?.rssi || state.bestRSSI || null,
        raw_rssi: state.lastRawRssi || null,
        apHistory: state.apHistory?.slice(-5) || [],
      };
    }
    return states;
  }

  getAssetTrail(mac) {
    const state = this.assetStates.get(mac);
    if (!state || !state.positionTrail) return [];
    return [...state.positionTrail];
  }

  clearAssetTrail(mac) {
    const state = this.assetStates.get(mac);
    if (state) state.positionTrail = [];
  }

  resetAsset(mac) {
    this.assetStates.delete(mac);
    this.apRssiFilters.delete(mac);
    this.hysteresisCounters.delete(mac);
    this.positionHistory.delete(mac);
  }

  setWayfindingData() {
    console.warn(
      "⚠️ setWayfindingData() is deprecated — the tracker now builds the path dynamically from the tag's own trail."
    );
  }

  // ============================================================
  // Preprocess a single AP detection (AoA correction only)
  // ============================================================
  _preprocessDetection(apMac, rawX, rawY, rawRssi) {
    const ap = this.apMap.get(apMac);
    if (!ap) return { x_m: rawX, y_m: rawY, correctedRssi: rawRssi };

    let x = rawX;
    let y = rawY;
    const correctedRssi = rawRssi + (ap.rssiOffset || 0);

    if (ap.rotationOffsetDeg) {
      const rad = (ap.rotationOffsetDeg * Math.PI) / 180;
      const dx = rawX - ap.x_m;
      const dy = rawY - ap.y_m;
      x = ap.x_m + (dx * Math.cos(rad) - dy * Math.sin(rad));
      y = ap.y_m + (dx * Math.sin(rad) + dy * Math.cos(rad));
    }
    return { x_m: x, y_m: y, correctedRssi };
  }

  // ============================================================
  // Static-anchor pin (reception AP only)
  // ============================================================
  _applyStaticAnchorPin(primaryApMac, correctedRssi, x, y) {
    const ap = this.apMap.get(primaryApMac);
    if (!ap || !ap.isStaticAnchor) return { x, y };
    if (correctedRssi <= this.STRONG_RSSI_PIN_DB) return { x, y };

    const dist = this._distance(x, y, ap.x_m, ap.y_m);
    if (dist > this.PIN_DISTANCE_THRESHOLD_M) {
      return { x: ap.x_m, y: ap.y_m };
    }
    return { x, y };
  }

  // ============================================================
  // Trail helpers
  // ============================================================
  _appendToTrail(state, x_m, y_m, now) {
    if (!this.USE_TRAIL) return;
    if (!state.positionTrail) state.positionTrail = [];

    const trail = state.positionTrail;
    const last = trail[trail.length - 1];

    if (
      last &&
      this._distance(last.x_m, last.y_m, x_m, y_m) < this.TRAIL_MIN_MOVE_M
    ) {
      // Skip — jitter
    } else {
      trail.push({ x_m, y_m, t: now });
    }

    while (trail.length > this.TRAIL_MAX_POINTS) trail.shift();

    const cutoff = now - this.TRAIL_MAX_AGE_MS;
    while (trail.length > 0 && trail[0].t < cutoff) trail.shift();
  }

  _trailToPixels(trail, mapId) {
    if (!trail || trail.length === 0) return [];
    const cfg = MAP_CONFIGS[mapId];
    if (!cfg) return trail.map((p) => ({ x: p.x_m, y: p.y_m, t: p.t }));
    return trail.map((p) => ({
      x: p.x_m * cfg.ppm + cfg.origin_x,
      y: cfg.origin_y - p.y_m * cfg.ppm,
      t: p.t,
    }));
  }

  // ============================================================
  // Main pipeline for a batch of Mist detections
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

        // ---- State init ----
        let state = this.assetStates.get(mac);
        if (!state) {
          state = {
            mac,
            device_name: firstDet.device_name || "Unknown",
            map_id: firstDet.map_id,
            currentPosition: null,
            bestPosition: null,
            bestRSSI: -Infinity,
            lastUpdate: Date.now(),
            apHistory: [],
            stabilityScore: 1.0,
            positionStable: false,
            smoothedPos: null,
            lastEmittedPos: null,
            lastRawRssi: null,
            currentAP: null,
            lastUpdateTime: Date.now(),
            heatmapPositions: [],
            particleFilter: null,
            isMoving: false,
            positionTrail: [],
          };
          if (this.USE_PARTICLE_FILTER) {
            state.particleFilter = new ParticleFilter(
              this.PARTICLE_COUNT,
              this.PARTICLE_NOISE,
              this.MEASUREMENT_NOISE
            );
          }
          this.assetStates.set(mac, state);
        }
        state.lastRawRssi = firstDet.rssi;

        // ---- Per-AP EMA of RSSI ----
        const apRssiMap = this.apRssiFilters.get(mac) || new Map();
        for (const det of detections) {
          const apMac = det.ap_mac;
          const apInfo = this.apMap.get(apMac);
          const correctedRssi =
            det.rssi + (apInfo ? apInfo.rssiOffset || 0 : 0);

          let filter = apRssiMap.get(apMac);
          if (!filter) {
            filter = { ema: correctedRssi, count: 1 };
          } else {
            filter.ema =
              this.EMA_ALPHA * correctedRssi +
              (1 - this.EMA_ALPHA) * filter.ema;
            filter.count += 1;
          }
          apRssiMap.set(apMac, filter);
        }
        this.apRssiFilters.set(mac, apRssiMap);

        const sortedAPs = Array.from(apRssiMap.entries())
          .map(([apMac, filter]) => ({ apMac, smoothedRssi: filter.ema }))
          .sort((a, b) => b.smoothedRssi - a.smoothedRssi);

        if (sortedAPs.length === 0) continue;

        // ---- Hysteresis on primary AP ----
        const bestAP = sortedAPs[0];
        const currentPrimary =
          this.hysteresisCounters.get(mac)?.currentAP || null;
        let primaryAP = bestAP;

        if (currentPrimary) {
          const currentFilter = apRssiMap.get(currentPrimary);
          if (currentFilter) {
            const diff = bestAP.smoothedRssi - currentFilter.ema;
            let counter =
              this.hysteresisCounters.get(mac)?.consecutiveBetter || 0;

            if (diff >= this.HYSTERESIS_DB) {
              counter += 1;
              if (counter >= this.HYSTERESIS_COUNT) {
                primaryAP = bestAP;
                counter = 0;
              } else {
                primaryAP = {
                  apMac: currentPrimary,
                  smoothedRssi: currentFilter.ema,
                };
              }
            } else {
              counter = 0;
            }
            this.hysteresisCounters.set(mac, {
              currentAP: primaryAP.apMac,
              consecutiveBetter: counter,
            });
          } else {
            this.hysteresisCounters.set(mac, {
              currentAP: bestAP.apMac,
              consecutiveBetter: 0,
            });
            primaryAP = bestAP;
          }
        } else {
          this.hysteresisCounters.set(mac, {
            currentAP: bestAP.apMac,
            consecutiveBetter: 0,
          });
          primaryAP = bestAP;
        }

        const detectionsMap = new Map(detections.map((d) => [d.ap_mac, d]));
        const primaryDet = detectionsMap.get(primaryAP.apMac);

        if (!primaryAP || !primaryAP.apMac) {
          state.apHistory.push({
            ap_mac: null, rssi: null, beam: null,
            timestamp: Date.now(), is_most_accurate: false,
          });
          if (state.apHistory.length > 10) state.apHistory.shift();
          state.currentAP = null;
          continue;
        }

        // ---- RSSI floor ----
        if (primaryDet && primaryDet.rssi < this.MIN_RSSI) {
          state.apHistory.push({
            ap_mac: primaryAP.apMac,
            rssi: primaryAP.smoothedRssi,
            beam: primaryDet?.beam || null,
            timestamp: Date.now(),
            is_most_accurate: false,
          });
          if (state.apHistory.length > 10) state.apHistory.shift();
          state.currentAP = {
            ap_mac: primaryAP.apMac,
            rssi: primaryAP.smoothedRssi,
            beam: primaryDet?.beam || null,
          };
          continue;
        }

        // ---- AP centroid ----
        let measurementX = null;
        let measurementY = null;
        const apPositions = [];

        for (const det of detections) {
          const apMac = det.ap_mac;
          const apInfo = this.apMap.get(apMac);

          if (!apInfo) {
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (coords && isFinite(coords.x_m) && isFinite(coords.y_m)) {
              const pre = this._preprocessDetection(
                apMac, coords.x_m, coords.y_m, det.rssi
              );
              apPositions.push({
                x_m: pre.x_m, y_m: pre.y_m,
                weight: Math.pow(10, pre.correctedRssi / 10),
              });
            }
            continue;
          }

          const correctedRssi = det.rssi + (apInfo.rssiOffset || 0);
          apPositions.push({
            x_m: apInfo.x_m, y_m: apInfo.y_m,
            weight: Math.pow(10, correctedRssi / 10),
          });
        }

        if (apPositions.length > 0) {
          let sumX = 0, sumY = 0, sumW = 0;
          for (const p of apPositions) {
            sumX += p.x_m * p.weight;
            sumY += p.y_m * p.weight;
            sumW += p.weight;
          }
          if (sumW > 0) {
            measurementX = sumX / sumW;
            measurementY = sumY / sumW;
          }
        }

        if (measurementX === null || measurementY === null) {
          const topAps = sortedAPs.slice(0, this.TOP_APS);
          let mX = 0, mY = 0, mW = 0;
          for (const { apMac, smoothedRssi } of topAps) {
            const det = detectionsMap.get(apMac);
            if (!det) continue;
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (!coords || !isFinite(coords.x_m) || !isFinite(coords.y_m))
              continue;
            const pre = this._preprocessDetection(
              apMac, coords.x_m, coords.y_m, smoothedRssi
            );
            const w = Math.pow(10, pre.correctedRssi / 10);
            mX += pre.x_m * w;
            mY += pre.y_m * w;
            mW += w;
          }
          if (mW > 0) {
            measurementX = mX / mW;
            measurementY = mY / mW;
          } else {
            const primaryInfo = this.apMap.get(primaryAP.apMac);
            if (primaryInfo) {
              measurementX = primaryInfo.x_m;
              measurementY = primaryInfo.y_m;
            } else {
              continue;
            }
          }
        }

        // ---- Static-anchor pin ----
        {
          const pinned = this._applyStaticAnchorPin(
            primaryAP.apMac,
            primaryAP.smoothedRssi,
            measurementX,
            measurementY
          );
          measurementX = pinned.x;
          measurementY = pinned.y;
        }

        // ---- AP history ----
        state.apHistory.push({
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet?.beam || null,
          timestamp: Date.now(),
          is_most_accurate: false,
        });
        if (state.apHistory.length > 10) state.apHistory.shift();
        state.currentAP = {
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet?.beam || null,
        };

        // ---- Particle filter / EMA ----
        let filteredX, filteredY;
        if (this.USE_PARTICLE_FILTER) {
          if (!state.particleFilter.initialized) {
            state.particleFilter.init(measurementX, measurementY);
          }
          const now = Date.now();
          const dt = (now - state.lastUpdateTime) / 1000;
          state.particleFilter.predict(dt);
          state.particleFilter.update(measurementX, measurementY);
          state.particleFilter.resample();
          const estimate = state.particleFilter.getEstimate();
          if (estimate) {
            filteredX = estimate.x;
            filteredY = estimate.y;
          } else {
            filteredX = measurementX;
            filteredY = measurementY;
          }
        } else {
          if (!state.smoothedPos) {
            state.smoothedPos = { x_m: measurementX, y_m: measurementY };
          } else {
            state.smoothedPos.x_m =
              this.POSITION_ALPHA * measurementX +
              (1 - this.POSITION_ALPHA) * state.smoothedPos.x_m;
            state.smoothedPos.y_m =
              this.POSITION_ALPHA * measurementY +
              (1 - this.POSITION_ALPHA) * state.smoothedPos.y_m;
          }
          filteredX = state.smoothedPos.x_m;
          filteredY = state.smoothedPos.y_m;
        }

        // ---- Outlier rejection ----
        if (!this.positionHistory.has(mac)) this.positionHistory.set(mac, []);
        const history = this.positionHistory.get(mac);

        if (history.length >= 3) {
          const xs = history.map((p) => p.x_m);
          const ys = history.map((p) => p.y_m);
          const medX = this._median(xs);
          const medY = this._median(ys);
          const dist = this._distance(medX, medY, filteredX, filteredY);
          if (dist > this.OUTLIER_THRESHOLD) {
            console.log(
              `🛑 Outlier rejected for ${mac}: ${dist.toFixed(
                2
              )}m from median – keeping previous`
            );
            continue;
          }
        }
        history.push({ x_m: filteredX, y_m: filteredY, timestamp: Date.now() });
        if (history.length > this.MAX_HISTORY) history.shift();

        // ---- Heatmap density ----
        let finalX = filteredX;
        let finalY = filteredY;

        if (this.USE_HEATMAP) {
          state.heatmapPositions.push({
            x: filteredX, y: filteredY, t: Date.now(),
          });
          if (state.heatmapPositions.length > this.HEATMAP_WINDOW) {
            state.heatmapPositions.shift();
          }
          const points = state.heatmapPositions;

          if (points.length > 5) {
            let maxDensity = 0;
            let bestX = filteredX;
            let bestY = filteredY;

            for (let i = 0; i < points.length; i++) {
              let count = 0;
              let sumX = 0, sumY = 0;
              for (let j = 0; j < points.length; j++) {
                const dist = this._distance(
                  points[i].x, points[i].y, points[j].x, points[j].y
                );
                if (dist < this.HEATMAP_RADIUS) {
                  count++;
                  sumX += points[j].x;
                  sumY += points[j].y;
                }
              }
              if (count > maxDensity && count > 2) {
                maxDensity = count;
                bestX = sumX / count;
                bestY = sumY / count;
              }
            }
            if (maxDensity > 0) {
              finalX = bestX;
              finalY = bestY;
            }
          }
        }

        // ---- Velocity limiting ----
        const now = Date.now();
        const dt = (now - state.lastUpdateTime) / 1000;
        if (state.currentPosition && dt > 0) {
          const prevPos = state.currentPosition;
          const dist = this._distance(prevPos.x_m, prevPos.y_m, finalX, finalY);
          const maxDist = this.MAX_SPEED_MS * dt;
          if (dist > maxDist && maxDist > 0) {
            const ratio = maxDist / dist;
            finalX = prevPos.x_m + (finalX - prevPos.x_m) * ratio;
            finalY = prevPos.y_m + (finalY - prevPos.y_m) * ratio;
          }
        }

        // ---- Build candidate ----
        const ppm = MAP_CONFIGS[state.map_id]?.ppm ?? 50.0739;
        let newPos = { x_m: finalX, y_m: finalY, ppm };

        // ---- Best position ----
        if (primaryDet) {
          const rssi = primaryDet.rssi;
          if (rssi > state.bestRSSI) {
            state.bestPosition = { ...newPos };
            state.bestRSSI = rssi;
            state.positionStable = true;
          }
        }

        // ---- Jump guard ----
        if (state.currentPosition) {
          const prevPos = state.currentPosition;
          const dist = this._distance(
            prevPos.x_m, prevPos.y_m, newPos.x_m, newPos.y_m
          );
          if (dist > this.STABILITY_THRESHOLD) {
            if (state.bestPosition) {
              newPos = { ...state.bestPosition };
            } else {
              const blend = this.STABILITY_THRESHOLD / dist;
              newPos.x_m = prevPos.x_m + (newPos.x_m - prevPos.x_m) * blend;
              newPos.y_m = prevPos.y_m + (newPos.y_m - prevPos.y_m) * blend;
              newPos.ppm = prevPos.ppm || newPos.ppm;
            }
          }
        }

        // ---- Stationary Drift Guard ----
        if (this.USE_STATIONARY_GUARD) {
          const guarded = StationaryDriftGuard.applyStationaryLock(
            state, newPos.x_m, newPos.y_m, this.STATIONARY_CFG
          );
          newPos.x_m = guarded.x;
          newPos.y_m = guarded.y;
          state.isMoving = guarded.isMoving;
        } else {
          state.isMoving = true;
        }

        // ---- Commit ----
        state.currentPosition = newPos;
        state.lastUpdate = now;
        state.lastUpdateTime = now;
        state.stabilityScore = this._calculateStability(state, apRssiMap);

        // ---- Append to dynamic trail ----
        this._appendToTrail(state, newPos.x_m, newPos.y_m, now);

        // ---- Emit (dead-zone gated) ----
        const lastEmit = state.lastEmittedPos;
        if (
          !lastEmit ||
          this._distance(
            lastEmit.x_m, lastEmit.y_m, newPos.x_m, newPos.y_m
          ) >= this.MIN_MOVE_METERS
        ) {
          const trail = state.positionTrail || [];
          const trailTail = trail.slice(-this.TRAIL_EMIT_POINTS);
          const trailTailPx = this._trailToPixels(trailTail, state.map_id);

          this.emit("assetUpdate", {
            mac,
            device_name: state.device_name,
            position: state.currentPosition,
            trail: trailTail,
            trail_px: trailTailPx,
            raw: primaryDet,
            stability: state.stabilityScore,
            is_most_accurate: state.positionStable,
            is_moving: state.isMoving,
            best_rssi: state.bestRSSI,
            timestamp: now,
            topAps: Array.from(detectionsMap.values()).map((d) => ({
              ap: d.ap_mac,
              rssi: d.rssi,
            })),
          });
          state.lastEmittedPos = { x_m: newPos.x_m, y_m: newPos.y_m };
        }

        processedAssets.push({
          mac,
          device_name: state.device_name,
          position: state.currentPosition,
          trail: [...(state.positionTrail || [])],
          trail_px: this._trailToPixels(state.positionTrail, state.map_id),
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet?.beam || null,
          stability: state.stabilityScore,
          map_id: state.map_id,
          is_most_accurate: state.positionStable,
          is_moving: state.isMoving,
          best_rssi: state.bestRSSI,
          ppm,
        });

        if (state.apHistory.length > 0) {
          state.apHistory[state.apHistory.length - 1].is_most_accurate =
            state.positionStable;
        }
      } catch (err) {
        console.error(`Error processing ${mac}:`, err);
      }
    }

    this._cleanupOldStates();
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

  _distance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  _median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  _calculateStability(state, apRssiMap) {
    if (!state.apHistory || state.apHistory.length < 3) return 1.0;
    if (state.positionStable && state.bestPosition) return 1.0;
    const recent = state.apHistory.slice(-5);
    const unique = new Set(recent.map((h) => h.ap_mac));
    const consistency = 1 - (unique.size - 1) / 4;
    return consistency * 0.6 + 0.4;
  }

  _cleanupOldStates() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    for (const [mac, state] of this.assetStates) {
      if (now - state.lastUpdate > timeout) {
        this.assetStates.delete(mac);
        this.apRssiFilters.delete(mac);
        this.hysteresisCounters.delete(mac);
        this.positionHistory.delete(mac);
      }
    }
  }
}

// ============================================================
// Export singleton
// ============================================================
const options = {
  emaAlpha: 0.15,
  positionAlpha: 0.25,
  hysteresisDb: 12,
  hysteresisCount: 4,
  topAps: 3,
  stabilityThreshold: 3.0,
  outlierThreshold: 5.0,
  minMoveMeters: 0.5,
  maxSpeedMs: 2.0,
  minRssi: -75,
  heatmapWindow: 30,
  heatmapRadius: 2.0,
  particleCount: 100,
  particleNoise: 0.5,
  measurementNoise: 1.0,
  useParticleFilter: true,
  useHeatmap: true,
  strongRssiPinDb: -62,
  pinDistanceThresholdM: 5.0,
  useStationaryGuard: true,
  stationaryThresholdM: 0.80,
  stationaryFastThresholdM: 1.5,
  stationaryAlpha: 0.02,
  movingAlpha: 0.45,

  // ---- Dynamic trail ----
  useTrail: true,
  trailMaxPoints: 300,
  trailMinMoveM: 0.25,
  trailMaxAgeMs: 5 * 60 * 1000,
  trailEmitPoints: 100,
};

const assetTracker = new AssetTracker(options);

// Boot — Redis connect only. NO poller. NO setInterval.
(async () => {
  try {
    await assetTracker.initRedis();
    console.log(
      "✅ mistAssetTracker loaded: on-demand Redis cache (no polling) + dynamic trail mode"
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