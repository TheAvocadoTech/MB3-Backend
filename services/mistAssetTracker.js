// services/mistAssetTracker.js – with fixed error handling and array validation

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
};

const WAYFINDING_DATA = new Map();

// ============================================================
// Particle Filter (same as before)
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

  update(measurementX, measurementY) {
    let totalWeight = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const dx = this.particles[i].x - measurementX;
      const dy = this.particles[i].y - measurementY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const weight = Math.exp(-(dist * dist) / (2 * this.measurementNoise * this.measurementNoise));
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
// AssetTracker
// ============================================================
class AssetTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.assetStates = new Map();
    this.apRssiFilters = new Map();
    this.hysteresisCounters = new Map();
    this.positionHistory = new Map();

    this.EMA_ALPHA = options.emaAlpha ?? 0.15;
    this.POSITION_ALPHA = options.positionAlpha ?? 0.25;
    this.HYSTERESIS_DB = options.hysteresisDb ?? 15;
    this.HYSTERESIS_COUNT = options.hysteresisCount ?? 5;
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
    this.BEAM_CONSISTENCY_THRESHOLD = options.beamConsistencyThreshold ?? 90;
    this.USE_PARTICLE_FILTER = options.useParticleFilter ?? true;
    this.USE_HEATMAP = options.useHeatmap ?? true;
    this.USE_MAP_MATCHING = options.useMapMatching ?? true;
    this.MAP_MATCH_THRESHOLD = options.mapMatchThreshold ?? 3.0;

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
      const filePath = path.join(__dirname, 'ap_list.json');
      const raw = fs.readFileSync(filePath, 'utf8');
      const apList = JSON.parse(raw);
      if (Array.isArray(apList) && apList.length > 0) {
        for (const ap of apList) {
          if (ap.mac && ap.x_m !== undefined && ap.y_m !== undefined) {
            this.apMap.set(ap.mac, {
              x_m: ap.x_m,
              y_m: ap.y_m,
              name: ap.name || ap.mac,
              orientation: ap.orientation || 0,
            });
          }
        }
        this.apListFetched = true;
        console.log(`✅ Loaded ${this.apMap.size} APs from static file (ap_list.json)`);
      } else {
        console.warn("⚠️ ap_list.json is empty – AP‑centroid will fallback to Mist coords.");
      }
    } catch (err) {
      console.warn("⚠️ Could not load ap_list.json – AP‑centroid will fallback.", err.message);
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
        best_position: state.bestPosition,
        best_rssi: state.bestRSSI,
        stability: state.stabilityScore,
        is_stable: state.positionStable,
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

  resetAsset(mac) {
    this.assetStates.delete(mac);
    this.apRssiFilters.delete(mac);
    this.hysteresisCounters.delete(mac);
    this.positionHistory.delete(mac);
  }

  async getAssets() {
    const now = Date.now();

    if (this.backoffUntil > now) {
      const remaining = Math.ceil((this.backoffUntil - now) / 1000);
      console.log(`⏳ Rate‑limited – returning cached data (${remaining}s remaining)`);
      return this.cachedProcessedAssets;
    }

    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);
      this.backoffMultiplier = 1;
      this.backoffUntil = 0;

      if (response.data && Array.isArray(response.data) && response.data.length > 0) {
        const processed = this._processAssetData(response.data);
        this.cachedProcessedAssets = processed;
        return processed;
      } else {
        // Mist returned empty or non-array – keep cached data
        console.log("⚠️ Mist returned empty or invalid asset list – returning cached data");
        return this.cachedProcessedAssets;
      }
    } catch (err) {
      // Handle rate-limit
      if (err.response && err.response.status === 429) {
        const retryAfter = parseInt(err.response.headers['retry-after'], 10) || 60;
        const waitMs = retryAfter * 1000 * this.backoffMultiplier;
        this.backoffUntil = Date.now() + waitMs;
        this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
        console.error(`🚫 429 – retry after ${Math.ceil(waitMs/1000)}s (multiplier ${this.backoffMultiplier})`);
        this.emit('rateLimited', { retryAfter: Math.ceil(waitMs/1000) });
        return this.cachedProcessedAssets.length > 0 ? this.cachedProcessedAssets : [];
      }
      
      // Other errors – log and return cached data if available
      console.error("Mist API Error:", err.message);
      if (err.response) {
        console.error("Status:", err.response.status);
        console.error("Data:", err.response.data);
      }
      if (this.cachedProcessedAssets.length > 0) {
        console.log("↩️ Returning cached data due to API error");
        return this.cachedProcessedAssets;
      }
      // No cache – rethrow
      throw err;
    }
  }

  setWayfindingData(mapId, nodes, edges) {
    if (!nodes || !edges) return;
    WAYFINDING_DATA.set(mapId, { nodes, edges });
    console.log(`🗺️ Wayfinding data loaded for map ${mapId} (${nodes.length} nodes)`);
  }

  // ============================================================
  // PROCESSING – full method (with relaxed confidence)
  // ============================================================
  _processAssetData(assets) {
    // Safety: ensure assets is an array
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
          };
          if (this.USE_PARTICLE_FILTER) {
            state.particleFilter = new ParticleFilter(this.PARTICLE_COUNT, this.PARTICLE_NOISE, this.MEASUREMENT_NOISE);
          }
          this.assetStates.set(mac, state);
        }
        state.lastRawRssi = firstDet.rssi;

        // EMA on RSSI per AP
        const apRssiMap = this.apRssiFilters.get(mac) || new Map();
        for (const det of detections) {
          const apMac = det.ap_mac;
          let filter = apRssiMap.get(apMac);
          if (!filter) {
            filter = { ema: det.rssi, count: 1 };
          } else {
            filter.ema = this.EMA_ALPHA * det.rssi + (1 - this.EMA_ALPHA) * filter.ema;
            filter.count += 1;
          }
          apRssiMap.set(apMac, filter);
        }
        this.apRssiFilters.set(mac, apRssiMap);

        const sortedAPs = Array.from(apRssiMap.entries())
          .map(([apMac, filter]) => ({ apMac, smoothedRssi: filter.ema }))
          .sort((a, b) => b.smoothedRssi - a.smoothedRssi);

        if (sortedAPs.length === 0) continue;

        // Hysteresis
        const bestAP = sortedAPs[0];
        const currentPrimary = this.hysteresisCounters.get(mac)?.currentAP || null;
        let primaryAP = bestAP;

        if (currentPrimary) {
          const currentFilter = apRssiMap.get(currentPrimary);
          if (currentFilter) {
            const diff = bestAP.smoothedRssi - currentFilter.ema;
            let counter = this.hysteresisCounters.get(mac)?.consecutiveBetter || 0;
            if (diff >= this.HYSTERESIS_DB) {
              counter += 1;
              if (counter >= this.HYSTERESIS_COUNT) {
                primaryAP = bestAP;
                counter = 0;
              } else {
                primaryAP = { apMac: currentPrimary, smoothedRssi: currentFilter.ema };
              }
            } else {
              counter = 0;
            }
            this.hysteresisCounters.set(mac, { currentAP: primaryAP.apMac, consecutiveBetter: counter });
          } else {
            this.hysteresisCounters.set(mac, { currentAP: bestAP.apMac, consecutiveBetter: 0 });
            primaryAP = bestAP;
          }
        } else {
          this.hysteresisCounters.set(mac, { currentAP: bestAP.apMac, consecutiveBetter: 0 });
          primaryAP = bestAP;
        }

        const detectionsMap = new Map(detections.map(d => [d.ap_mac, d]));
        const primaryDet = detectionsMap.get(primaryAP.apMac);

        // ---- CONFIDENCE FILTER (RELAXED) ----
        if (!primaryAP || !primaryAP.apMac) {
          console.log(`⚠️ No valid AP for ${mac} – keeping previous`);
          state.apHistory.push({
            ap_mac: null,
            rssi: null,
            beam: null,
            timestamp: Date.now(),
            is_most_accurate: false,
          });
          if (state.apHistory.length > 10) state.apHistory.shift();
          state.currentAP = null;
          continue;
        }

        // RSSI Floor
        if (primaryDet && primaryDet.rssi < this.MIN_RSSI) {
          console.log(`📉 RSSI too weak (${primaryDet.rssi} dBm) – retaining last position for ${mac}`);
          state.apHistory.push({
            ap_mac: primaryAP.apMac,
            rssi: primaryAP.smoothedRssi,
            beam: primaryDet?.beam || null,
            timestamp: Date.now(),
            is_most_accurate: false,
          });
          if (state.apHistory.length > 10) state.apHistory.shift();
          state.currentAP = { ap_mac: primaryAP.apMac, rssi: primaryAP.smoothedRssi, beam: primaryDet?.beam || null };

          const pos = state.currentPosition || state.bestPosition;
          if (pos) {
            processedAssets.push({
              mac,
              device_name: state.device_name,
              position: pos,
              ap_mac: primaryAP.apMac,
              rssi: primaryAP.smoothedRssi,
              beam: primaryDet?.beam || null,
              stability: state.stabilityScore,
              map_id: state.map_id,
              is_most_accurate: false,
              best_rssi: state.bestRSSI,
              ppm: pos.ppm || 50.0739,
            });
          }
          continue;
        }

        // ---- AP‑Centroid ----
        let measurementX = null, measurementY = null;
        const apPositions = [];

        for (const det of detections) {
          const apMac = det.ap_mac;
          const apInfo = this.apMap.get(apMac);
          if (!apInfo) {
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (coords && isFinite(coords.x_m) && isFinite(coords.y_m)) {
              apPositions.push({
                x_m: coords.x_m,
                y_m: coords.y_m,
                weight: Math.pow(10, det.rssi / 10),
              });
            }
            continue;
          }
          const weight = Math.pow(10, det.rssi / 10);
          apPositions.push({
            x_m: apInfo.x_m,
            y_m: apInfo.y_m,
            weight: weight,
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
          // fallback to Mist's centroid from top APs
          const topAps = sortedAPs.slice(0, this.TOP_APS);
          let mX = 0, mY = 0, mW = 0;
          for (const { apMac, smoothedRssi } of topAps) {
            const det = detectionsMap.get(apMac);
            if (!det) continue;
            const coords = this._convertCoordinates(det.x, det.y, det.map_id);
            if (!coords || !isFinite(coords.x_m) || !isFinite(coords.y_m)) continue;
            const w = Math.pow(10, smoothedRssi / 10);
            mX += coords.x_m * w;
            mY += coords.y_m * w;
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

        // Record AP history
        state.apHistory.push({
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet?.beam || null,
          timestamp: Date.now(),
          is_most_accurate: false,
        });
        if (state.apHistory.length > 10) state.apHistory.shift();
        state.currentAP = { ap_mac: primaryAP.apMac, rssi: primaryAP.smoothedRssi, beam: primaryDet?.beam || null };

        // Particle filter / EMA
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
            state.smoothedPos.x_m = this.POSITION_ALPHA * measurementX + (1 - this.POSITION_ALPHA) * state.smoothedPos.x_m;
            state.smoothedPos.y_m = this.POSITION_ALPHA * measurementY + (1 - this.POSITION_ALPHA) * state.smoothedPos.y_m;
          }
          filteredX = state.smoothedPos.x_m;
          filteredY = state.smoothedPos.y_m;
        }

        // Outlier rejection
        if (!this.positionHistory.has(mac)) this.positionHistory.set(mac, []);
        const history = this.positionHistory.get(mac);
        if (history.length >= 3) {
          const xs = history.map(p => p.x_m);
          const ys = history.map(p => p.y_m);
          const medX = this._median(xs);
          const medY = this._median(ys);
          const dist = this._distance(medX, medY, filteredX, filteredY);
          if (dist > this.OUTLIER_THRESHOLD) {
            console.log(`🛑 Outlier rejected for ${mac}: ${dist.toFixed(2)}m from median – keeping previous`);
            const pos = state.currentPosition || state.bestPosition;
            if (pos) {
              processedAssets.push({
                mac,
                device_name: state.device_name,
                position: pos,
                ap_mac: primaryAP.apMac,
                rssi: primaryAP.smoothedRssi,
                beam: primaryDet?.beam || null,
                stability: state.stabilityScore,
                map_id: state.map_id,
                is_most_accurate: state.positionStable,
                best_rssi: state.bestRSSI,
                ppm: pos.ppm || 50.0739,
              });
            }
            continue;
          }
        }
        history.push({ x_m: filteredX, y_m: filteredY, timestamp: Date.now() });
        if (history.length > this.MAX_HISTORY) history.shift();

        // Heatmap
        let finalX = filteredX, finalY = filteredY;
        if (this.USE_HEATMAP) {
          state.heatmapPositions.push({ x: filteredX, y: filteredY, t: Date.now() });
          if (state.heatmapPositions.length > this.HEATMAP_WINDOW) {
            state.heatmapPositions.shift();
          }
          const points = state.heatmapPositions;
          if (points.length > 5) {
            let maxDensity = 0;
            let bestX = filteredX, bestY = filteredY;
            for (let i = 0; i < points.length; i++) {
              let count = 0;
              let sumX = 0, sumY = 0;
              for (let j = 0; j < points.length; j++) {
                const dist = this._distance(points[i].x, points[i].y, points[j].x, points[j].y);
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

        // Map matching
        if (this.USE_MAP_MATCHING && state.map_id) {
          const wayfinding = WAYFINDING_DATA.get(state.map_id);
          if (wayfinding && wayfinding.edges) {
            const { nodes, edges } = wayfinding;
            let bestDist = Infinity;
            let bestPoint = { x: finalX, y: finalY };
            const edgeList = [];
            for (const [src, targets] of Object.entries(edges)) {
              const srcNode = nodes.find(n => n.name === src);
              if (!srcNode) continue;
              for (const [tgt] of Object.entries(targets)) {
                const tgtNode = nodes.find(n => n.name === tgt);
                if (!tgtNode) continue;
                edgeList.push({
                  x1: srcNode.position.x_m,
                  y1: srcNode.position.y_m,
                  x2: tgtNode.position.x_m,
                  y2: tgtNode.position.y_m,
                });
              }
            }
            for (const edge of edgeList) {
              const dx = edge.x2 - edge.x1;
              const dy = edge.y2 - edge.y1;
              const lenSq = dx * dx + dy * dy;
              if (lenSq === 0) continue;
              let t = ((finalX - edge.x1) * dx + (finalY - edge.y1) * dy) / lenSq;
              t = Math.max(0, Math.min(1, t));
              const projX = edge.x1 + t * dx;
              const projY = edge.y1 + t * dy;
              const dist = this._distance(finalX, finalY, projX, projY);
              if (dist < bestDist && dist < this.MAP_MATCH_THRESHOLD) {
                bestDist = dist;
                bestPoint = { x: projX, y: projY };
              }
            }
            if (bestDist < this.MAP_MATCH_THRESHOLD) {
              finalX = bestPoint.x;
              finalY = bestPoint.y;
            }
          }
        }

        // Velocity limiting
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
            console.log(`⏱️ Speed limited for ${mac}: ${dist.toFixed(2)}m → ${maxDist.toFixed(2)}m`);
          }
        }

        const ppm = 50.0739;
        let newPos = { x_m: finalX, y_m: finalY, ppm };

        // Best position
        if (primaryDet) {
          const rssi = primaryDet.rssi;
          if (rssi > state.bestRSSI) {
            state.bestPosition = { ...newPos };
            state.bestRSSI = rssi;
            state.positionStable = true;
            console.log(`📍 ${mac}: Best position updated (RSSI ${rssi} dBm)`);
          }
        }

        // Jump guard
        if (state.currentPosition) {
          const prevPos = state.currentPosition;
          const dist = this._distance(prevPos.x_m, prevPos.y_m, newPos.x_m, newPos.y_m);
          if (dist > this.STABILITY_THRESHOLD) {
            if (state.bestPosition) {
              console.log(`⚠️ Large jump (${dist.toFixed(2)}m) – using best position`);
              newPos = { ...state.bestPosition };
            } else {
              const blend = this.STABILITY_THRESHOLD / dist;
              newPos.x_m = prevPos.x_m + (newPos.x_m - prevPos.x_m) * blend;
              newPos.y_m = prevPos.y_m + (newPos.y_m - prevPos.y_m) * blend;
              newPos.ppm = prevPos.ppm || newPos.ppm;
            }
          }
        }

        state.currentPosition = newPos;
        state.lastUpdate = now;
        state.lastUpdateTime = now;
        state.stabilityScore = this._calculateStability(state, apRssiMap);

        // Dead‑zone emit
        const lastEmit = state.lastEmittedPos;
        if (!lastEmit || this._distance(lastEmit.x_m, lastEmit.y_m, newPos.x_m, newPos.y_m) >= this.MIN_MOVE_METERS) {
          this.emit("assetUpdate", {
            mac,
            device_name: state.device_name,
            position: state.currentPosition,
            raw: primaryDet,
            stability: state.stabilityScore,
            is_most_accurate: state.positionStable,
            best_rssi: state.bestRSSI,
            timestamp: now,
            topAps: Array.from(detectionsMap.values()).map(d => ({ ap: d.ap_mac, rssi: d.rssi })),
          });
          state.lastEmittedPos = { x_m: newPos.x_m, y_m: newPos.y_m };
        }

        processedAssets.push({
          mac,
          device_name: state.device_name,
          position: state.currentPosition,
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet?.beam || null,
          stability: state.stabilityScore,
          map_id: state.map_id,
          is_most_accurate: state.positionStable,
          best_rssi: state.bestRSSI,
          ppm,
        });

        if (state.apHistory.length > 0) {
          state.apHistory[state.apHistory.length - 1].is_most_accurate = state.positionStable;
        }
      } catch (err) {
        console.error(`Error processing ${mac}:`, err);
      }
    }
    this._cleanupOldStates();
    return processedAssets;
  }

  // ============================================================
  // UTILITIES (unchanged)
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
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  _calculateStability(state, apRssiMap) {
    if (!state.apHistory || state.apHistory.length < 3) return 1.0;
    if (state.positionStable && state.bestPosition) return 1.0;
    const recent = state.apHistory.slice(-5);
    const unique = new Set(recent.map(h => h.ap_mac));
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
// EXPORT
// ============================================================
const options = {
  emaAlpha: 0.15,
  positionAlpha: 0.25,
  hysteresisDb: 15,
  hysteresisCount: 5,
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
  beamConsistencyThreshold: 90,
  useParticleFilter: true,
  useHeatmap: true,
  useMapMatching: true,
  mapMatchThreshold: 3.0,
};

const assetTracker = new AssetTracker(options);
console.log("✅ AssetTracker loaded with relaxed confidence & robust caching");
module.exports = assetTracker;