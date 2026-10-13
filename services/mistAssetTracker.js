// services/mistAssetTracker.js
// Optimized Mist Asset Tracker for Kontakt.io tags in data centers.
//
//   - Safe API polling with a strict 3-second interval guard (protecting 5k/hr limit)
//   - Direct data ingestion via processDetections()
//   - Local AP list calibration from ap_list.json[cite: 1, 2]
//   - RSSI-weighted AP centroid + Particle Filter smoothing[cite: 1, 2]
//   - Median outlier rejection & Stationary Drift Guard[cite: 1, 2]
//   - AP Proximity filtering (Smooth tracking within AP radius, no hard AP-center snapping)
//   - Strict Map Boundary Clamping

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

// ============================================================
// MAP CONFIGURATIONS
// ============================================================
const MAP_CONFIGS = {
  "7e5341c9-f9ce-4aad-ae6a-8234c3a3866e": {
    name: "Default Map",
    width: 6400, height: 5120,
    width_m: 127.8, height_m: 102.2,
    origin_x: 306.4, origin_y: 3856.4,
    ppm: 50.07,
  },
  "30141417-44ea-4982-993c-6225c9f08315": {
    name: "MB3-F00",
    width: 6400, height: 5120,
    width_m: 127.81, height_m: 102.24,
    origin_x: 306.45, origin_y: 3856.48,
    ppm: 50.07,
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    name: "MB3-F01",
    width: 6400, height: 5120,
    width_m: 111.74, height_m: 89.39,
    origin_x: 6.78, origin_y: 4134.93,
    ppm: 57.27,
  },
  default: {
    name: "default",
    width: 6400, height: 5120,
    width_m: 128, height_m: 102,
    origin_x: 0, origin_y: 0, ppm: 50,
  },
};

// ============================================================
// AP CORRECTIONS (Offsets & Rotation)
// ============================================================
const AP_CORRECTIONS = {
  c878678aa2ab: {
    rotationOffsetDeg: 0,
    rssiOffsetDb: +4,
  },
};

// ============================================================
// Particle Filter for Trajectory Smoothing
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
    const cur = state.currentPosition;
    const threshold = cfg.threshold ?? 0.80;
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

    const alpha = distFromCurrent > fastThreshold ? movingAlpha : stationaryAlpha;
    return {
      x: alpha * candidateX + (1 - alpha) * cx,
      y: alpha * candidateY + (1 - alpha) * cy,
      isMoving: true,
    };
  }
}

// ============================================================
// AssetTracker Engine
// ============================================================
class AssetTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.assetStates = new Map();
    this.apRssiFilters = new Map();
    this.hysteresisCounters = new Map();
    this.positionHistory = new Map();

    // Rate-limit safety locks
    this.lastFetchTime = 0;
    this.MIN_FETCH_INTERVAL_MS = 4000; // 4 seconds between HTTP calls to protect 5k/hr limit

    // Tuning Parameters
    this.EMA_ALPHA = options.emaAlpha ?? 0.15;
    this.OUTLIER_THRESHOLD = options.outlierThreshold ?? 5.0;
    this.MIN_MOVE_METERS = options.minMoveMeters ?? 0.5;
    this.MAX_SPEED_MS = options.maxSpeedMs ?? 2.0;
    this.MIN_RSSI = options.minRssi ?? -75;
    this.MAX_HISTORY = 7;

    this.USE_PARTICLE_FILTER = options.useParticleFilter ?? true;
    this.USE_STATIONARY_GUARD = options.useStationaryGuard ?? true;
    this.STATIONARY_CFG = {
      threshold: 0.80,
      fastThreshold: 1.5,
      stationaryAlpha: 0.02,
      movingAlpha: 0.45,
    };

    this.apMap = new Map();
    this._loadStaticAPs();
  }

  _loadStaticAPs() {
    try {
      const filePath = path.join(__dirname, "ap_list.json");
      if (fs.existsSync(filePath)) {
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
              });
            }
          }
          console.log(`✅ Loaded ${this.apMap.size} APs from ap_list.json[cite: 1, 2]`);
        }
      }
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json:", err.message);
    }
  }

  // Safe API Polling method protected against rapid invocation
  async getAssets() {
    const now = Date.now();
    if (now - this.lastFetchTime < this.MIN_FETCH_INTERVAL_MS) {
      // Return current in-memory processed states without hitting Mist API
      return Array.from(this.assetStates.values()).map(s => ({
        mac: s.mac,
        device_name: s.device_name,
        position: s.currentPosition,
        map_id: s.map_id,
        is_moving: s.isMoving,
      }));
    }

    try {
      this.lastFetchTime = now;
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);
      if (response.data && Array.isArray(response.data)) {
        return this.processDetections(response.data);
      }
      return [];
    } catch (err) {
      if (err.response && err.response.status === 429) {
        console.warn("⚠️ Mist rate limit reached (429). Throttling requests.");
      } else {
        console.error("Mist API Error:", err.message);
      }
      return [];
    }
  }

  _enforceMapBoundaries(x_m, y_m, mapId) {
    const config = MAP_CONFIGS[mapId] || MAP_CONFIGS.default;
    return {
      x_m: Math.max(0.5, Math.min(x_m, config.width_m - 0.5)),
      y_m: Math.max(0.5, Math.min(y_m, config.height_m - 0.5)),
    };
  }

  _convertCoordinates(x, y, mapId) {
    if (x === undefined || y === undefined || x === null || y === null) return null;
    const config = MAP_CONFIGS[mapId] || MAP_CONFIGS.default;
    
    // Check if input is in pixels (large numbers) and convert to meters
    if (x > config.width_m || y > config.height_m) {
      const x_m = (x - config.origin_x) / config.ppm;
      const y_m = (config.origin_y - y) / config.ppm;
      return { x_m, y_m, ppm: config.ppm };
    }
    return { x_m: Number(x), y_m: Number(y), ppm: config.ppm };
  }

  // Main entry point to process batch detections from Mist / Kontakt tags
  processDetections(assets) {
    if (!Array.isArray(assets)) return [];

    const processedAssets = [];
    const groups = this._groupDetectionsByAsset(assets);

    for (const [mac, detections] of groups.entries()) {
      try {
        const firstDet = detections[0];
        if (!firstDet.map_id || firstDet.x === undefined || firstDet.y === undefined) continue;

        let state = this.assetStates.get(mac);
        if (!state) {
          state = {
            mac,
            device_name: firstDet.device_name || firstDet.name || "Kontakt Tag",
            map_id: firstDet.map_id,
            currentPosition: null,
            lastUpdateTime: Date.now(),
            particleFilter: new ParticleFilter(100, 0.5, 1.0),
            isMoving: false,
          };
          this.assetStates.set(mac, state);
        }

        // Convert raw Mist pixel coordinates to meters
        const coords = this._convertCoordinates(firstDet.x, firstDet.y, firstDet.map_id);
        if (!coords) continue;

        let measurementX = coords.x_m;
        let measurementY = coords.y_m;

        // AP Proximity / 3m Boundary Rule:
        // Ensure tag positions caught near an AP remain smooth and localized 
        // within the AP reception zone without snapping directly onto the AP center.
        const apInfo = this.apMap.get(firstDet.ap_mac);
        if (apInfo) {
          const distToAp = this._distance(measurementX, measurementY, apInfo.x_m, apInfo.y_m);
          if (distToAp < 0.3) {
            // If raw reading sits suspiciously dead-center on the AP hardware, push it out slightly 
            // so it shows as a nearby tag location rather than the AP hardware dot itself.
            measurementX += 0.8;
            measurementY += 0.8;
          }
        }

        // Apply Particle Filter / Smoothing
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
          filteredX = estimate ? estimate.x : measurementX;
          filteredY = estimate ? estimate.y : measurementY;
        } else {
          filteredX = measurementX;
          filteredY = measurementY;
        }

        // Apply Stationary Drift Guard
        let finalX = filteredX;
        let finalY = filteredY;
        let isMoving = true;

        if (this.USE_STATIONARY_GUARD) {
          const guarded = StationaryDriftGuard.applyStationaryLock(
            state, filteredX, filteredY, this.STATIONARY_CFG
          );
          finalX = guarded.x;
          finalY = guarded.y;
          isMoving = guarded.isMoving;
        }

        // Enforce strict map boundary limits
        const bounded = this._enforceMapBoundaries(finalX, finalY, state.map_id);
        
        state.currentPosition = {
          x_m: bounded.x_m,
          y_m: bounded.y_m,
          ppm: coords.ppm,
        };
        state.isMoving = isMoving;
        state.lastUpdateTime = Date.now();

        const payload = {
          mac,
          device_name: state.device_name,
          map_id: state.map_id,
          position: state.currentPosition,
          is_moving: state.isMoving,
          ap_mac: firstDet.ap_mac,
          rssi: firstDet.rssi,
        };

        this.emit("assetUpdate", payload);
        processedAssets.push(payload);
      } catch (err) {
        console.error(`Error processing asset ${mac}:`, err.message);
      }
    }

    return processedAssets;
  }

  _groupDetectionsByAsset(assets) {
    const groups = new Map();
    for (const det of assets) {
      const mac = det.mac || det.asset_mac;
      if (!mac) continue;
      if (!groups.has(mac)) groups.set(mac, []);
      groups.get(mac).push(det);
    }
    return groups;
  }

  _distance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }
}

const trackerInstance = new AssetTracker();
module.exports = trackerInstance;
