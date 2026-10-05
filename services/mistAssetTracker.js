// services/mistAssetTracker.js
// High-performance Mist asset tracker with dynamic position trail (breadcrumb path).
//
//   - Mist API polling (with 429 backoff) + caching
//   - Local AP list from ap_list.json + AP_CORRECTIONS
//   - Per-AP RSSI offset + AoA vector rotation + static-anchor pinning
//   - RSSI-weighted AP centroid
//   - Particle filter (or EMA fallback)
//   - Median outlier rejection
//   - Heatmap density smoothing
//   - Velocity limiting + jump guard
//   - Stationary Drift Guard (dead-zone lock + adaptive alpha)
//   - Dynamic position trail (replaces wayfinding-path snapping)
//
// Exports a singleton EventEmitter.

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
// Particle Filter (Optimized)
// ============================================================
class ParticleFilter {
  constructor(numParticles = 100, processNoise = 0.5, measurementNoise = 1.0) {
    this.numParticles = numParticles;
    this.processNoise = processNoise;
    this.measurementNoise2Var = 2 * measurementNoise * measurementNoise;
    this.particles = new Array(numParticles);
    this.weights = new Float64Array(numParticles);
    this.initialized = false;
  }

  init(x, y) {
    const invInitW = 1 / this.numParticles;
    for (let i = 0; i < this.numParticles; i++) {
      this.particles[i] = {
        x: x + (Math.random() - 0.5) * this.processNoise * 2,
        y: y + (Math.random() - 0.5) * this.processNoise * 2,
      };
      this.weights[i] = invInitW;
    }
    this.initialized = true;
  }

  predict(dt) {
    const noise = this.processNoise * Math.sqrt(dt || 1);
    for (let i = 0; i < this.numParticles; i++) {
      this.particles[i].x += (Math.random() - 0.5) * noise * 2;
      this.particles[i].y += (Math.random() - 0.5) * noise * 2;
    }
  }

  update(mx, my) {
    let totalWeight = 0;
    for (let i = 0; i < this.numParticles; i++) {
      const dx = this.particles[i].x - mx;
      const dy = this.particles[i].y - my;
      const weight = Math.exp(-(dx * dx + dy * dy) / this.measurementNoise2Var);
      this.weights[i] = weight;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      const invTotal = 1 / totalWeight;
      for (let i = 0; i < this.numParticles; i++) {
        this.weights[i] *= invTotal;
      }
    } else {
      this.weights.fill(1 / this.numParticles);
    }
  }

  resample() {
    const newParticles = new Array(this.numParticles);
    const cumulative = new Float64Array(this.numParticles);
    let sum = 0;
    
    for (let i = 0; i < this.numParticles; i++) {
      sum += this.weights[i];
      cumulative[i] = sum;
    }

    const step = 1 / this.numParticles;
    let r = Math.random() * step;
    let idx = 0;

    for (let i = 0; i < this.numParticles; i++) {
      while (r > cumulative[idx] && idx < this.numParticles - 1) idx++;
      newParticles[i] = { x: this.particles[idx].x, y: this.particles[idx].y };
      r += step;
    }
    this.particles = newParticles;
    this.weights.fill(1 / this.numParticles);
  }

  getEstimate() {
    if (!this.initialized || this.particles.length === 0) return null;
    let avgX = 0, avgY = 0, totalW = 0;
    for (let i = 0; i < this.numParticles; i++) {
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
    const threshold = cfg.threshold ?? 0.80;
    const fastThreshold = cfg.fastThreshold ?? 1.5;
    const stationaryAlpha = cfg.stationaryAlpha ?? 0.02;
    const movingAlpha = cfg.movingAlpha ?? 0.45;

    if (!cur) return { x: candidateX, y: candidateY, isMoving: true };

    const distFromCurrent = Math.sqrt((candidateX - cur.x_m) ** 2 + (candidateY - cur.y_m) ** 2);

    if (distFromCurrent < threshold) {
      return { x: cur.x_m, y: cur.y_m, isMoving: false };
    }

    const alpha = distFromCurrent > fastThreshold ? movingAlpha : stationaryAlpha;
    return {
      x: alpha * candidateX + (1 - alpha) * cur.x_m,
      y: alpha * candidateY + (1 - alpha) * cur.y_m,
      isMoving: true,
    };
  }
}

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

    // --- Tuning Configurations ---
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

    this.STRONG_RSSI_PIN_DB = options.strongRssiPinDb ?? -62;
    this.PIN_DISTANCE_THRESHOLD_M = options.pinDistanceThresholdM ?? 5.0;

    this.USE_STATIONARY_GUARD = options.useStationaryGuard ?? true;
    this.STATIONARY_CFG = {
      threshold: options.stationaryThresholdM ?? 0.80,
      fastThreshold: options.stationaryFastThresholdM ?? 1.5,
      stationaryAlpha: options.stationaryAlpha ?? 0.02,
      movingAlpha: options.movingAlpha ?? 0.45,
      ...(options.stationaryCfg || {}),
    };

    this.USE_TRAIL = options.useTrail ?? true;
    this.TRAIL_MAX_POINTS = options.trailMaxPoints ?? 300;
    this.TRAIL_MIN_MOVE_M = options.trailMinMoveM ?? 0.25;
    this.TRAIL_MAX_AGE_MS = options.trailMaxAgeMs ?? 5 * 60 * 1000;
    this.TRAIL_EMIT_POINTS = options.trailEmitPoints ?? 100;

    this.backoffUntil = 0;
    this.backoffMultiplier = 1;
    this.cachedProcessedAssets = [];

    this.apMap = new Map();
    this.apListFetched = false;
    this.unmappedLogged = new Set();

    this._loadStaticAPs();
  }

  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);

      if (Array.isArray(apList)) {
        for (const ap of apList) {
          if (ap.mac && ap.x_m !== undefined && ap.y_m !== undefined) {
            const correction = AP_CORRECTIONS[ap.mac] || {};
            this.apMap.set(ap.mac, {
              x_m: ap.x_m,
              y_m: ap.y_m,
              name: ap.name || ap.mac,
              rssiOffset: correction.rssiOffsetDb || 0,
              isStaticAnchor: correction.isStaticZoneAnchor || false,
              rotationOffsetDeg: correction.rotationOffsetDeg || 0,
            });
          }
        }
        this.apListFetched = true;
        console.log(`✅ Loaded ${this.apMap.size} APs from ap_list.json`);
      }
    } catch (err) {
      console.warn("⚠️️ Could not load ap_list.json – fallback enabled.", err.message);
    }
  }

  getCachedAssets() {
    return this.cachedProcessedAssets;
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
        rssi: state.currentAP?.rssi || state.bestRSSI || null,
      };
    }
    return states;
  }

  getAssetTrail(mac) {
    const state = this.assetStates.get(mac);
    return state && state.positionTrail ? [...state.positionTrail] : [];
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

  async getAssets() {
    const now = Date.now();
    if (this.backoffUntil > now) return this.cachedProcessedAssets;

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
        const retryAfter = parseInt(err.response.headers["retry-after"], 10) || 60;
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

  _applyStaticAnchorPin(primaryApMac, correctedRssi, x, y) {
    const ap = this.apMap.get(primaryApMac);
    if (!ap?.isStaticAnchor || correctedRssi <= this.STRONG_RSSI_PIN_DB) return { x, y };

    const dist = Math.sqrt((x - ap.x_m) ** 2 + (y - ap.y_m) ** 2);
    return dist > this.PIN_DISTANCE_THRESHOLD_M ? { x: ap.x_m, y: ap.y_m } : { x, y };
  }

  _appendToTrail(state, x_m, y_m, now) {
    if (!this.USE_TRAIL) return;
    if (!state.positionTrail) state.positionTrail = [];

    const trail = state.positionTrail;
    const last = trail[trail.length - 1];

    if (!last || Math.sqrt((last.x_m - x_m) ** 2 + (last.y_m - y_m) ** 2) >= this.TRAIL_MIN_MOVE_M) {
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
            particleFilter: this.USE_PARTICLE_FILTER ? new ParticleFilter(this.PARTICLE_COUNT, this.PARTICLE_NOISE, this.MEASUREMENT_NOISE) : null,
            isMoving: false,
            positionTrail: [],
          };
          this.assetStates.set(mac, state);
        }

        let apRssiMap = this.apRssiFilters.get(mac);
        if (!apRssiMap) {
          apRssiMap = new Map();
          this.apRssiFilters.set(mac, apRssiMap);
        }

        for (const det of detections) {
          const apInfo = this.apMap.get(det.ap_mac);
          const correctedRssi = det.rssi + (apInfo?.rssiOffset || 0);

          let filter = apRssiMap.get(det.ap_mac);
          if (!filter) {
            apRssiMap.set(det.ap_mac, { ema: correctedRssi, count: 1 });
          } else {
            filter.ema = this.EMA_ALPHA * correctedRssi + (1 - this.EMA_ALPHA) * filter.ema;
            filter.count++;
          }
        }

        const sortedAPs = Array.from(apRssiMap.entries())
          .map(([apMac, filter]) => ({ apMac, smoothedRssi: filter.ema }))
          .sort((a, b) => b.smoothedRssi - a.smoothedRssi);

        if (sortedAPs.length === 0) continue;

        const bestAP = sortedAPs[0];
        let primaryAP = bestAP;
        const detectionsMap = new Map(detections.map((d) => [d.ap_mac, d]));
        const primaryDet = detectionsMap.get(primaryAP.apMac);

        if (!primaryDet || primaryDet.rssi < this.MIN_RSSI) continue;

        // Centroid Calculation
        let sumX = 0, sumY = 0, sumW = 0;
        for (const det of detections) {
          const apInfo = this.apMap.get(det.ap_mac);
          let x_m = det.x, y_m = det.y, rssi = det.rssi;
          if (apInfo) {
            x_m = apInfo.x_m;
            y_m = apInfo.y_m;
            rssi += apInfo.rssiOffset || 0;
          } else {
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (coords) {
              x_m = coords.x_m;
              y_m = coords.y_m;
            }
          }
          const w = Math.pow(10, rssi / 10);
          sumX += x_m * w;
          sumY += y_m * w;
          sumW += w;
        }

        let measurementX = sumW > 0 ? sumX / sumW : sortedAPs[0].smoothedRssi;
        let measurementY = sumW > 0 ? sumY / sumW : sortedAPs[0].smoothedRssi;

        const pinned = this._applyStaticAnchorPin(primaryAP.apMac, primaryAP.smoothedRssi, measurementX, measurementY);
        measurementX = pinned.x;
        measurementY = pinned.y;

        let filteredX, filteredY;
        if (this.USE_PARTICLE_FILTER && state.particleFilter) {
          if (!state.particleFilter.initialized) {
            state.particleFilter.init(measurementX, measurementY);
          }
          const dt = (Date.now() - state.lastUpdateTime) / 1000;
          state.particleFilter.predict(dt);
          state.particleFilter.update(measurementX, measurementY);
          state.particleFilter.resample();
          const estimate = state.particleFilter.getEstimate();
          filteredX = estimate ? estimate.x : measurementX;
          filteredY = estimate ? estimate.y : measurementY;
        } else {
          filteredX = measurementX;
          filteredY = measurementY;
        }

        const ppm = MAP_CONFIGS[state.map_id]?.ppm ?? 50.0739;
        let newPos = { x_m: filteredX, y_m: filteredY, ppm };

        if (this.USE_STATIONARY_GUARD) {
          const guarded = StationaryDriftGuard.applyStationaryLock(state, newPos.x_m, newPos.y_m, this.STATIONARY_CFG);
          newPos.x_m = guarded.x;
          newPos.y_m = guarded.y;
          state.isMoving = guarded.isMoving;
        }

        state.currentPosition = newPos;
        state.lastUpdate = Date.now();
        state.lastUpdateTime = Date.now();

        this._appendToTrail(state, newPos.x_m, newPos.y_m, state.lastUpdate);

        processedAssets.push({
          mac,
          device_name: state.device_name,
          position: state.currentPosition,
          trail: [...state.positionTrail],
          trail_px: this._trailToPixels(state.positionTrail, state.map_id),
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          stability: state.stabilityScore,
          map_id: state.map_id,
          is_moving: state.isMoving,
          ppm,
        });
      } catch (err) {
        console.error(`Error processing asset ${mac}:`, err);
      }
    }

    return processedAssets;
  }

  _convertCoordinates(x, y, mapId) {
    const config = MAP_CONFIGS[mapId];
    if (!config) return { x_m: x, y_m: y, ppm: 1 };
    return {
      x_m: (x - config.origin_x) / config.ppm + (config.offset_x || 0),
      y_m: (config.origin_y - y) / config.ppm + (config.offset_y || 0),
      ppm: config.ppm,
    };
  }
}

const assetTracker = new AssetTracker();
module.exports = assetTracker;
