// services/mistAssetTracker.js
const axios = require("axios");
const EventEmitter = require("events");

const SITE_ID =
  process.env.MIST_SITE_ID || "8ddd401e-edb4-4b24-beb1-6298afdd0bd1";

const mist = axios.create({
  baseURL: "https://api.mist.com/api/v1",
  headers: {
    Authorization: `Token ${process.env.MIST_API_TOKEN || "li1iDhxqOaPiJyYwcEuIznaUcLqajVsVTnTS6eKtzFDh4N2ZPbInk8sodqYAFhjYqOOeB3LFIClQ2deNJUXDgIVWsJ6SCjlT"}`,
    "Content-Type": "application/json",
  },
});

// Map configuration for coordinate conversion
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
  "8ddd401e-edb4-4b24-beb1-6298afdd0bd1": {
    name: "MB3-F01",
    width: 6400,
    height: 5120,
    width_m: 111.74050632911398,
    height_m: 89.39240506329119,
    origin_x: 6.786923314266026,
    origin_y: 4134.933029216576,
    ppm: 57.275559331634064,
  },
};

// Beam angles (approximate center of each beam sector)
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
  constructor() {
    super();
    this.assetStates = new Map();
    this.updateHistory = new Map();
    this.filterWindows = new Map();
    this.WINDOW_SIZE = 5;
    this.STABILITY_THRESHOLD = 2.0;
  }

  async getAssets() {
    try {
      console.log("SITE_ID:", SITE_ID);
      const url = `/sites/${SITE_ID}/stats/assets`;
      console.log("Calling:", url);

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

  processAssetData(assets) {
    const processedAssets = [];
    const assetGroups = this.groupDetectionsByAsset(assets);

    for (const [mac, detections] of assetGroups) {
      try {
        const bestDetection = this.selectBestAP(detections, mac);

        if (!bestDetection) continue;

        const convertedCoords = this.convertCoordinates(
          bestDetection.x,
          bestDetection.y,
          bestDetection.map_id,
        );

        let assetState = this.assetStates.get(mac);
        if (!assetState) {
          assetState = {
            mac,
            device_name: bestDetection.device_name,
            map_id: bestDetection.map_id,
            currentPosition: convertedCoords,
            previousPositions: [],
            lastUpdate: Date.now(),
            apHistory: [],
            stabilityScore: 1.0,
          };
          this.assetStates.set(mac, assetState);
        }

        const smoothedPosition = this.smoothPosition(
          convertedCoords,
          bestDetection.rssi,
          bestDetection.ap_mac,
          mac,
          bestDetection.beam,
        );

        assetState.currentPosition = smoothedPosition;
        assetState.lastUpdate = Date.now();
        assetState.apHistory.push({
          ap_mac: bestDetection.ap_mac,
          rssi: bestDetection.rssi,
          beam: bestDetection.beam,
          timestamp: Date.now(),
        });

        if (assetState.apHistory.length > 10) {
          assetState.apHistory.shift();
        }

        assetState.stabilityScore = this.calculateStability(assetState);

        this.emit("assetUpdate", {
          mac,
          device_name: assetState.device_name,
          position: smoothedPosition,
          raw: bestDetection,
          stability: assetState.stabilityScore,
          timestamp: Date.now(),
        });

        processedAssets.push({
          mac,
          device_name: assetState.device_name,
          position: smoothedPosition,
          ap_mac: bestDetection.ap_mac,
          rssi: bestDetection.rssi,
          beam: bestDetection.beam,
          stability: assetState.stabilityScore,
          map_id: bestDetection.map_id,
          raw: bestDetection,
          apHistory: assetState.apHistory.slice(-3),
        });
      } catch (error) {
        console.error(`Error processing asset ${mac}:`, error);
      }
    }

    this.cleanupOldStates();
    return processedAssets;
  }

  groupDetectionsByAsset(assets) {
    const groups = new Map();

    for (const asset of assets) {
      if (!asset.mac) continue;

      if (!groups.has(asset.mac)) {
        groups.set(asset.mac, []);
      }
      groups.get(asset.mac).push(asset);
    }

    return groups;
  }

  selectBestAP(detections, mac) {
    if (!detections || detections.length === 0) return null;

    if (detections.length === 1) return detections[0];

    const assetState = this.assetStates.get(mac);
    const previousPosition = assetState ? assetState.currentPosition : null;
    const previousAP =
      assetState && assetState.apHistory.length > 0
        ? assetState.apHistory[assetState.apHistory.length - 1].ap_mac
        : null;

    const scoredDetections = detections.map((detection) => {
      let score = 0;

      // 1. RSSI Score
      const rssiScore = Math.max(0, (detection.rssi + 100) / 50);
      score += rssiScore * 0.4;

      // 2. AP Stability Score
      if (detection.ap_mac === previousAP) {
        score += 0.3;
      }

      // 3. Position Continuity Score
      if (previousPosition) {
        const convertedCoords = this.convertCoordinates(
          detection.x,
          detection.y,
          detection.map_id,
        );

        const distance = this.calculateDistance(
          previousPosition.x_m,
          previousPosition.y_m,
          convertedCoords.x_m,
          convertedCoords.y_m,
        );

        const continuityScore = Math.max(
          0,
          0.3 * (1 - Math.min(1, distance / 10)),
        );
        score += continuityScore;
      }

      // 4. Beam Direction Score
      if (previousPosition && detection.beam !== undefined) {
        const beamAngle = BEAM_ANGLES[detection.beam] || 0;
        const apLocation = this.convertCoordinates(
          detection.x,
          detection.y,
          detection.map_id,
        );

        const expectedAngle =
          Math.atan2(
            previousPosition.y_m - apLocation.y_m,
            previousPosition.x_m - apLocation.x_m,
          ) *
          (180 / Math.PI);

        const normalizedExpected = ((expectedAngle % 360) + 360) % 360;

        let angleDiff = Math.abs(beamAngle - normalizedExpected);
        angleDiff = Math.min(angleDiff, 360 - angleDiff);

        const beamScore = Math.max(0, 0.3 * (1 - Math.min(1, angleDiff / 90)));
        score += beamScore;
      }

      return { detection, score };
    });

    scoredDetections.sort((a, b) => b.score - a.score);

    if (scoredDetections.length > 1) {
      console.log(
        `Asset ${mac}: Selected AP ${scoredDetections[0].detection.ap_mac} with score ${scoredDetections[0].score.toFixed(3)}`,
      );
    }

    return scoredDetections[0].detection;
  }

  convertCoordinates(x, y, mapId) {
    const mapConfig = MAP_CONFIGS[mapId];

    if (!mapConfig) {
      console.warn(`Unknown map_id: ${mapId}, using raw coordinates`);
      return { x_m: x, y_m: y, ppm: 1 };
    }

    const x_m = (x - mapConfig.origin_x) / mapConfig.ppm;
    const y_m = (mapConfig.origin_y - y) / mapConfig.ppm;

    return {
      x_m,
      y_m,
      ppm: mapConfig.ppm,
      mapId: mapId,
    };
  }

  smoothPosition(coords, rssi, apMac, mac, beam) {
    if (!this.filterWindows.has(mac)) {
      this.filterWindows.set(mac, []);
    }

    const window = this.filterWindows.get(mac);

    window.push({
      coords,
      rssi,
      apMac,
      beam,
      timestamp: Date.now(),
    });

    while (window.length > this.WINDOW_SIZE) {
      window.shift();
    }

    if (window.length === 1) {
      return coords;
    }

    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;

    const weights = window.map((sample, index) => {
      const rssiWeight = Math.max(0, (sample.rssi + 100) / 40);
      const recencyWeight = (index + 1) / window.length;
      return rssiWeight * 0.7 + recencyWeight * 0.3;
    });

    window.forEach((sample, index) => {
      const weight = weights[index];
      weightedX += sample.coords.x_m * weight;
      weightedY += sample.coords.y_m * weight;
      totalWeight += weight;
    });

    if (totalWeight === 0) {
      return coords;
    }

    const smoothedX = weightedX / totalWeight;
    const smoothedY = weightedY / totalWeight;

    const lastPosition = window[window.length - 2];
    if (lastPosition) {
      const distance = this.calculateDistance(
        lastPosition.coords.x_m,
        lastPosition.coords.y_m,
        smoothedX,
        smoothedY,
      );

      if (distance > this.STABILITY_THRESHOLD) {
        console.log(
          `Large jump detected for ${mac}: ${distance.toFixed(2)}m, applying extra smoothing`,
        );

        const blendedX = (lastPosition.coords.x_m + smoothedX) / 2;
        const blendedY = (lastPosition.coords.y_m + smoothedY) / 2;

        return { x_m: blendedX, y_m: blendedY };
      }
    }

    return { x_m: smoothedX, y_m: smoothedY };
  }

  calculateDistance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  }

  calculateStability(assetState) {
    if (!assetState.apHistory || assetState.apHistory.length < 3) {
      return 1.0;
    }

    const recentAPs = assetState.apHistory.slice(-5);
    const uniqueAPs = new Set(recentAPs.map((h) => h.ap_mac));
    const apConsistency = 1 - (uniqueAPs.size - 1) / 4;

    let positionStability = 1.0;
    if (
      assetState.previousPositions &&
      assetState.previousPositions.length > 2
    ) {
      const recentPositions = assetState.previousPositions.slice(-3);
      let totalDistance = 0;
      for (let i = 1; i < recentPositions.length; i++) {
        totalDistance += this.calculateDistance(
          recentPositions[i - 1].x_m,
          recentPositions[i - 1].y_m,
          recentPositions[i].x_m,
          recentPositions[i].y_m,
        );
      }
      const avgMovement = totalDistance / (recentPositions.length - 1);
      positionStability = Math.max(0, 1 - avgMovement / 5);
    }

    return apConsistency * 0.6 + positionStability * 0.4;
  }

  cleanupOldStates() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;

    for (const [mac, state] of this.assetStates) {
      if (now - state.lastUpdate > timeout) {
        this.assetStates.delete(mac);
        this.filterWindows.delete(mac);
        this.updateHistory.delete(mac);
      }
    }
  }

  getAssetStates() {
    const states = {};
    for (const [mac, state] of this.assetStates) {
      states[mac] = {
        device_name: state.device_name,
        position: state.currentPosition,
        stability: state.stabilityScore,
        lastUpdate: state.lastUpdate,
        apHistory: state.apHistory.slice(-3),
      };
    }
    return states;
  }

  resetAsset(mac) {
    this.assetStates.delete(mac);
    this.filterWindows.delete(mac);
    this.updateHistory.delete(mac);
  }
}

module.exports = new AssetTracker();
