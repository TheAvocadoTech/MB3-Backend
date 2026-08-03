// services/mistAssetTracker.js – Final with caching, outlier rejection, tuned smoothing
const axios = require("axios");
const EventEmitter = require("events");

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
  },
};

const BEAM_ANGLES = {
  0: 0,
  1: 20,
  2: 40,
  3: 60,
  4: 80,
  5: 100,
  6: 120,
  7: 140,
  8: 160,
  9: 180,
  10: 200,
  11: 220,
  12: 240,
  13: 260,
  14: 280,
  15: 300,
  16: 320,
  17: 340,
};

class AssetTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.assetStates = new Map();
    this.apRssiFilters = new Map();
    this.hysteresisCounters = new Map();
    this.positionHistory = new Map(); // mac -> [{x_m, y_m, timestamp}]

    this.EMA_ALPHA = options.emaAlpha ?? 0.15;
    this.HYSTERESIS_DB = options.hysteresisDb ?? 10;
    this.HYSTERESIS_COUNT = options.hysteresisCount ?? 4;
    this.TOP_APS = options.topAps ?? 3;
    this.STABILITY_THRESHOLD = options.stabilityThreshold ?? 5.0;
    this.OUTLIER_THRESHOLD = options.outlierThreshold ?? 5.0;
    this.MAX_HISTORY = 7;
    this.unmappedLogged = new Set();
  }

  // ---- Return cached assets (no API call) ----
  getCachedAssets() {
    const states = this.getAssetStates();
    const assets = [];
    for (const [mac, state] of Object.entries(states)) {
      const raw = {
        mac,
        name: state.device_name || mac,
        x: state.position
          ? state.position.x_m * (state.position.ppm || 50.07391564392213)
          : null,
        y: state.position
          ? state.position.y_m * (state.position.ppm || 50.07391564392213)
          : null,
        map_id: state.map_id || null,
        rssi: state.best_rssi || null,
        last_seen: state.lastUpdate
          ? Math.floor(state.lastUpdate / 1000)
          : null,
      };
      assets.push({
        mac,
        device_name: state.device_name,
        position: state.position,
        stability: state.stability,
        raw,
        apHistory: state.apHistory || [],
      });
    }
    return assets;
  }

  // ---- Fetch fresh data from Mist API ----
  async getAssets() {
    try {
      const url = `/sites/${SITE_ID}/stats/assets`;
      const response = await mist.get(url);
      if (response.data && response.data.length > 0) {
        return this.processAssetData(response.data);
      }
      return response.data;
    } catch (err) {
      console.error("Mist API Error");
      console.error("Status:", err.response?.status);
      console.error("Data:", err.response?.data);
      console.error("URL:", err.config?.url);
      throw err;
    }
  }

  // ---- Process raw assets, apply smoothing, outlier rejection ----
  processAssetData(assets) {
    const processedAssets = [];
    const assetGroups = this.groupDetectionsByAsset(assets);

    for (const [mac, detections] of assetGroups) {
      try {
        const firstDet = detections[0];
        const hasMap = firstDet.map_id != null;
        const hasCoords =
          typeof firstDet.x === "number" && typeof firstDet.y === "number";

        if (!hasMap || !hasCoords) {
          if (!this.unmappedLogged.has(mac)) {
            console.warn(
              `⚠️ Asset ${mac} has no map_id or coordinates – skipping`,
            );
            this.unmappedLogged.add(mac);
          }
          continue;
        }

        let assetState = this.assetStates.get(mac);
        if (!assetState) {
          assetState = {
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
          };
          this.assetStates.set(mac, assetState);
        }

        // EMA per AP
        const apRssiMap = this.apRssiFilters.get(mac) || new Map();
        for (const det of detections) {
          const apMac = det.ap_mac;
          let filter = apRssiMap.get(apMac);
          if (!filter) {
            filter = { ema: det.rssi, count: 1 };
          } else {
            filter.ema =
              this.EMA_ALPHA * det.rssi + (1 - this.EMA_ALPHA) * filter.ema;
            filter.count += 1;
          }
          apRssiMap.set(apMac, filter);
        }
        this.apRssiFilters.set(mac, apRssiMap);

        // Sort by smoothed RSSI
        const sortedAPs = Array.from(apRssiMap.entries())
          .map(([apMac, filter]) => ({ apMac, smoothedRssi: filter.ema }))
          .sort((a, b) => b.smoothedRssi - a.smoothedRssi);

        if (sortedAPs.length === 0) continue;

        // Hysteresis
        const bestAP = sortedAPs[0];
        const currentPrimary =
          this.hysteresisCounters.get(mac)?.currentAP || null;
        let primaryAP = bestAP;

        if (currentPrimary) {
          const currentPrimaryFilter = apRssiMap.get(currentPrimary);
          if (currentPrimaryFilter) {
            const currentRssi = currentPrimaryFilter.ema;
            const newRssi = bestAP.smoothedRssi;
            const diff = newRssi - currentRssi;

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
                  smoothedRssi: currentRssi,
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

        // Weighted position from top APs
        const topAps = sortedAPs.slice(0, this.TOP_APS);
        const detectionsMap = new Map(detections.map((d) => [d.ap_mac, d]));

        const positions = topAps
          .map(({ apMac, smoothedRssi }) => {
            const det = detectionsMap.get(apMac);
            if (!det) return null;
            const x = typeof det.x === "number" ? det.x : 0;
            const y = typeof det.y === "number" ? det.y : 0;
            const coords = this.convertCoordinates(x, y, det.map_id);
            if (!isFinite(coords.x_m) || !isFinite(coords.y_m)) return null;
            const weight = Math.pow(10, smoothedRssi / 10);
            return { coords, weight, rssi: smoothedRssi, apMac };
          })
          .filter((p) => p !== null);

        if (positions.length === 0) continue;

        let totalWeight = 0,
          avgX = 0,
          avgY = 0;
        for (const p of positions) {
          avgX += p.coords.x_m * p.weight;
          avgY += p.coords.y_m * p.weight;
          totalWeight += p.weight;
        }
        if (totalWeight === 0) continue;

        let smoothedX = avgX / totalWeight;
        let smoothedY = avgY / totalWeight;

        if (!isFinite(smoothedX) || !isFinite(smoothedY)) {
          console.warn(`Invalid position for ${mac}, skipping update`);
          continue;
        }

        // ---- OUTLIER REJECTION ----
        if (!this.positionHistory.has(mac)) {
          this.positionHistory.set(mac, []);
        }
        const history = this.positionHistory.get(mac);

        const getMedian = (arr) => {
          const sorted = [...arr].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        if (history.length >= 3) {
          const xs = history.map((p) => p.x_m);
          const ys = history.map((p) => p.y_m);
          const medX = getMedian(xs);
          const medY = getMedian(ys);
          const distFromMedian = this.calculateDistance(
            medX,
            medY,
            smoothedX,
            smoothedY,
          );
          if (distFromMedian > this.OUTLIER_THRESHOLD) {
            console.log(
              `🛑 Outlier rejected for ${mac}: distance ${distFromMedian.toFixed(2)}m from median, keeping previous`,
            );
            continue; // skip update
          }
        }

        history.push({ x_m: smoothedX, y_m: smoothedY, timestamp: Date.now() });
        if (history.length > this.MAX_HISTORY) history.shift();

        const ppm = positions[0]?.coords?.ppm ?? null;
        let newPos = { x_m: smoothedX, y_m: smoothedY, ppm };

        // Best position
        const primaryDet = detectionsMap.get(primaryAP.apMac);
        if (primaryDet) {
          const rssi = primaryDet.rssi;
          if (rssi > assetState.bestRSSI) {
            assetState.bestPosition = { ...newPos };
            assetState.bestRSSI = rssi;
            assetState.positionStable = true;
            console.log(
              `📍 Asset ${mac}: Best position updated (RSSI ${rssi} dBm)`,
            );
          }
        }

        // Jump guard
        if (assetState.currentPosition) {
          const prevPos = assetState.currentPosition;
          const dist = this.calculateDistance(
            prevPos.x_m,
            prevPos.y_m,
            newPos.x_m,
            newPos.y_m,
          );
          if (dist > this.STABILITY_THRESHOLD) {
            if (
              assetState.bestPosition &&
              (assetState.bestPosition.x_m !== newPos.x_m ||
                assetState.bestPosition.y_m !== newPos.y_m)
            ) {
              console.log(
                `⚠️ Large jump (${dist.toFixed(2)}m) for ${mac}, using best position`,
              );
              newPos = { ...assetState.bestPosition };
            } else {
              console.log(
                `⚠️ Large jump (${dist.toFixed(2)}m) for ${mac}, blending`,
              );
              const blendFactor = this.STABILITY_THRESHOLD / dist;
              newPos.x_m =
                prevPos.x_m + (newPos.x_m - prevPos.x_m) * blendFactor;
              newPos.y_m =
                prevPos.y_m + (newPos.y_m - prevPos.y_m) * blendFactor;
              newPos.ppm = prevPos.ppm || newPos.ppm;
            }
          }
        }

        assetState.currentPosition = newPos;
        assetState.lastUpdate = Date.now();
        assetState.stabilityScore = this.calculateStability(
          assetState,
          apRssiMap,
        );

        this.emit("assetUpdate", {
          mac,
          device_name: assetState.device_name,
          position: assetState.currentPosition,
          raw: primaryDet,
          stability: assetState.stabilityScore,
          is_most_accurate: assetState.positionStable,
          best_rssi: assetState.bestRSSI,
          timestamp: Date.now(),
          topAps: positions.map((p) => ({ ap: p.apMac, rssi: p.rssi })),
        });

        processedAssets.push({
          mac,
          device_name: assetState.device_name,
          position: assetState.currentPosition,
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet ? primaryDet.beam : null,
          stability: assetState.stabilityScore,
          map_id: assetState.map_id,
          raw: primaryDet,
          apHistory: assetState.apHistory.slice(-3),
          is_most_accurate: assetState.positionStable,
          best_rssi: assetState.bestRSSI,
          ppm: assetState.bestPosition ? assetState.bestPosition.ppm : null,
        });

        assetState.apHistory.push({
          ap_mac: primaryAP.apMac,
          rssi: primaryAP.smoothedRssi,
          beam: primaryDet ? primaryDet.beam : null,
          timestamp: Date.now(),
          is_most_accurate: assetState.positionStable,
        });
        if (assetState.apHistory.length > 10) assetState.apHistory.shift();
      } catch (error) {
        console.error(`Error processing asset ${mac}:`, error);
      }
    }

    this.cleanupOldStates();
    return processedAssets;
  }

  // ---- Helpers ----
  groupDetectionsByAsset(assets) {
    const groups = new Map();
    for (const asset of assets) {
      if (!asset.mac) continue;
      if (!groups.has(asset.mac)) groups.set(asset.mac, []);
      groups.get(asset.mac).push(asset);
    }
    return groups;
  }

  convertCoordinates(x, y, mapId) {
    if (!mapId) return { x_m: x, y_m: y, ppm: 1 };
    const mapConfig = MAP_CONFIGS[mapId];
    if (!mapConfig) return { x_m: x, y_m: y, ppm: 1 };
    return {
      x_m: (x - mapConfig.origin_x) / mapConfig.ppm,
      y_m: (mapConfig.origin_y - y) / mapConfig.ppm,
      ppm: mapConfig.ppm,
      mapId,
    };
  }

  calculateDistance(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  calculateStability(assetState, apRssiMap) {
    if (!assetState.apHistory || assetState.apHistory.length < 3) return 1.0;
    if (assetState.positionStable && assetState.bestPosition) return 1.0;
    const recentAPs = assetState.apHistory.slice(-5);
    const uniqueAPs = new Set(recentAPs.map((h) => h.ap_mac));
    const apConsistency = 1 - (uniqueAPs.size - 1) / 4;
    return apConsistency * 0.6 + 0.4;
  }

  cleanupOldStates() {
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

  getAssetStates() {
    const states = {};
    for (const [mac, state] of this.assetStates) {
      states[mac] = {
        device_name: state.device_name,
        position: state.currentPosition,
        best_position: state.bestPosition,
        best_rssi: state.bestRSSI,
        stability: state.stabilityScore,
        is_stable: state.positionStable,
        lastUpdate: state.lastUpdate,
        apHistory: state.apHistory.slice(-3),
        map_id: state.map_id,
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
}

const options = {
  emaAlpha: 0.15,
  hysteresisDb: 15,
  hysteresisCount: 5,
  topAps: 3,
  stabilityThreshold: 10.0,
  outlierThreshold: 10.0,
};

const assetTracker = new AssetTracker(options);
console.log(
  "✅ AssetTracker loaded with enhanced stability (outlier rejection)",
);
module.exports = assetTracker;
