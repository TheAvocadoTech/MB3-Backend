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

const DEFAULT_ASSET_RADIUS_M = parseInt(process.env.ASSET_RADIUS_M, 10) || 5;
const STALE_THRESHOLD_MS = 120_000; // 2 minutes

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const CACHE_KEY = `mist:assets:${SITE_ID}`;
const BACKOFF_KEY = `mist:backoff:${SITE_ID}`;
const CACHE_TTL_SEC = parseInt(process.env.MIST_CACHE_TTL_SEC, 10) || 30;
const MIN_REFRESH_MS = parseInt(process.env.MIST_MIN_REFRESH_MS, 10) || 5000;

// Path-loss exponent for RSSI → distance conversion (indoor ~2.0–3.0)
const PATH_LOSS_EXPONENT = parseFloat(process.env.PATH_LOSS_EXPONENT) || 2.5;
// RSSI at 1 meter reference (dBm)
const RSSI_AT_1M = parseFloat(process.env.RSSI_AT_1M) || -45;

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

/**
 * Convert RSSI (dBm) to estimated distance in meters using log-distance path loss model.
 * d = 10 ^ ((RSSI_1m - RSSI) / (10 * n))
 */
function rssiToDistance(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return null;
  const d = Math.pow(10, (RSSI_AT_1M - rssi) / (10 * PATH_LOSS_EXPONENT));
  // Clamp to sane indoor range
  return Math.min(Math.max(d, 0.3), 100);
}

/**
 * Weight for RSSI-based fusion. Stronger signal = higher weight.
 * Uses linear power ratio so a 10 dB difference ≈ 10× weight.
 */
function rssiWeight(rssi) {
  if (rssi == null || !Number.isFinite(rssi)) return 0;
  // Convert dBm to linear power relative to a floor of -100 dBm
  const clamped = Math.max(rssi, -100);
  return Math.pow(10, clamped / 10); // 10^(rssi/10)
}

class AssetTracker extends EventEmitter {
  constructor() {
    super();
    this.cachedProcessedAssets = [];
    this.apMap = new Map();
    this.mapMap = new Map();
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
      if (!fs.existsSync(filePath)) return;

      const raw = fs.readFileSync(filePath, "utf8");
      const apList = JSON.parse(raw);
      if (!Array.isArray(apList)) return;

      for (const ap of apList) {
        if (!ap.mac) continue;
        this.apMap.set(ap.mac.toLowerCase().trim(), {
          name: ap.name || ap.mac,
          map_id: ap.map_id || null,
          x: ap.x,
          y: ap.y,
          x_m: ap.x_m,
          y_m: ap.y_m,
        });

        if (ap.map_id && ap.map_name) {
          this.mapMap.set(ap.map_id, ap.map_name);
        }
      }
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
    if (Date.now() - this.lastFetchAt < MIN_REFRESH_MS) {
      return this.cachedProcessedAssets;
    }

    if (await this._isBackedOff()) {
      return this.cachedProcessedAssets;
    }

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

  /**
   * Weighted fusion of AP detections to estimate asset location.
   * Each detection is weighted by its linear RSSI power.
   *
   * Strategy:
   *  - For each detection, resolve the AP's absolute map position (x_m/y_m preferred,
   *    fallback to x/y pixel coords or AP static position from ap_list.json).
   *  - If a detection has its own coordinates (x/y or x_m/y_m) we use them directly
   *    (Mist may already give refined per-detection position).
   *  - Otherwise, we project from the AP using its beam direction (0–7) and the
   *    RSSI-estimated distance.
   *  - Finally we do a weighted average of all projected points.
   */
  _computeFusedLocation(mac, detections, apInfoForPrimary) {
    const validDets = detections.filter(
      (d) => d.x != null || d.y != null || d.x_m != null || d.y_m != null,
    );

    // Check if Mist already gave absolute coordinates per detection
    const hasAbsolute = validDets.some((d) => d.x_m != null && d.y_m != null);

    const weightedPoints = [];

    for (const det of detections) {
      const apMacKey = (det.ap_mac || "").toLowerCase().trim();
      const apStatic = this.apMap.get(apMacKey);

      let px = null;
      let py = null;
      let pxs = null; // metric coords
      let pys = null;

      // 1) Prefer Mist-provided absolute metric coords for this detection
      if (det.x_m != null && det.y_m != null) {
        pxs = det.x_m;
        pys = det.y_m;
        px = det.x;
        py = det.y;
      }
      // 2) Then Mist-provided pixel coords
      else if (det.x != null && det.y != null) {
        px = det.x;
        py = det.y;
        pxs = det.x_m ?? null;
        pys = det.y_m ?? null;
      }
      // 3) Fall back to the AP's own location + beam/distance projection
      else if (apStatic) {
        const baseX = apStatic.x_m ?? apStatic.x ?? null;
        const baseY = apStatic.y_m ?? apStatic.y ?? null;
        const isMetric = apStatic.x_m != null;

        if (baseX == null || baseY == null) continue;

        const dist = rssiToDistance(det.rssi);
        const beam = det.beam;

        if (dist != null && Number.isInteger(beam) && beam >= 0 && beam <= 7) {
          // Beam 0 points "up"/north in Mist convention; rotate 45° per index.
          // Beam angle: 0→0°, 1→45°, 2→90°, ... 7→315° measured clockwise from north.
          const angleDeg = beam * 45;
          const angleRad = (angleDeg * Math.PI) / 180;
          const dx = dist * Math.sin(angleRad);
          const dy = -dist * Math.cos(angleRad); // negative because y grows downward in pixel space

          px = baseX + dx;
          py = baseY + dy;
          if (isMetric) {
            pxs = px;
            pys = py;
          }
        } else {
          // No beam info — just use AP location
          px = baseX;
          py = baseY;
          pxs = isMetric ? baseX : null;
          pys = isMetric ? baseY : null;
        }
      } else {
        continue;
      }

      const w = rssiWeight(det.rssi);
      if (w <= 0) continue;

      weightedPoints.push({
        x: px,
        y: py,
        x_m: pxs,
        y_m: pys,
        weight: w,
        rssi: det.rssi,
        ap_mac: det.ap_mac,
        beam: det.beam,
      });
    }

    // If Mist already gave absolute coords, and one detection has them, just
    // return that (avoid mixing coordinate systems).
    if (hasAbsolute) {
      // Pick strongest detection with absolute coords
      const withAbs = weightedPoints.filter(
        (p) => p.x_m != null && p.y_m != null,
      );
      if (withAbs.length > 0) {
        withAbs.sort((a, b) => b.weight - a.weight);
        const best = withAbs[0];
        return {
          x: best.x ?? best.x_m,
          y: best.y ?? best.y_m,
          x_m: best.x_m,
          y_m: best.y_m,
          method: "mist_absolute",
          contributing: withAbs.length,
        };
      }
    }

    if (weightedPoints.length === 0) {
      return null;
    }

    // Weighted average in whichever coordinate system we have.
    const useMetric = weightedPoints.some((p) => p.x_m != null);
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let countContrib = 0;

    for (const p of weightedPoints) {
      const x = useMetric ? p.x_m : p.x;
      const y = useMetric ? p.y_m : p.y;
      if (x == null || y == null) continue;
      sumW += p.weight;
      sumX += p.weight * x;
      sumY += p.weight * y;
      countContrib++;
    }

    if (sumW <= 0 || countContrib === 0) return null;

    return {
      x: sumX / sumW,
      y: sumY / sumW,
      x_m: useMetric ? sumX / sumW : null,
      y_m: useMetric ? sumY / sumW : null,
      method: useMetric ? "weighted_metric" : "weighted_pixel",
      contributing: countContrib,
    };
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
        if (!firstDet.map_id) {
          console.warn(`Asset ${mac} has no map_id — skipping`);
          continue;
        }

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
            beam:
              Number.isInteger(d.beam) && d.beam >= 0 && d.beam <= 7
                ? d.beam
                : null,
            map_id: d.map_id ?? null,
            x: d.x ?? null,
            y: d.y ?? null,
            x_m: d.x_m ?? null,
            y_m: d.y_m ?? null,
            last_seen: d.last_seen ?? null,
            // Helpful for debugging the fusion:
            distance_m: rssiToDistance(d.rssi),
            weight: rssiWeight(d.rssi),
          };
        });

        const detectionsCount = slimDetections.length;
        let locationConfidence = "Low (Single AP)";
        if (detectionsCount >= 3) {
          locationConfidence = "High (Triangulated)";
        } else if (detectionsCount === 2) {
          locationConfidence = "Medium (2 APs)";
        }

        const apInfo = this.apMap.get(
          (primaryDet.ap_mac || "").toLowerCase().trim(),
        );

        const lastSeenSec =
          primaryDet.last_seen ?? primaryDet.timestamp ?? null;
        const lastSeenMs = lastSeenSec ? lastSeenSec * 1000 : null;
        const ageMs = lastSeenMs ? Date.now() - lastSeenMs : null;
        const isStale = ageMs != null ? ageMs > STALE_THRESHOLD_MS : true;

        // 🔑 Fuse all detections (RSSI-weighted) for the real location
        const fused = this._computeFusedLocation(mac, sortedDetections, apInfo);

        // If fusion failed, fall back to primary detection coordinates
        const finalX = fused?.x ?? primaryDet.x ?? apInfo?.x ?? null;
        const finalY = fused?.y ?? primaryDet.y ?? apInfo?.y ?? null;
        const finalXm = fused?.x_m ?? primaryDet.x_m ?? apInfo?.x_m ?? null;
        const finalYm = fused?.y_m ?? primaryDet.y_m ?? apInfo?.y_m ?? null;

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          map_name: this.mapMap.get(firstDet.map_id) || null,

          // ✅ FUSED (RSSI-weighted) COORDINATES — this is what should be plotted
          x: finalX,
          y: finalY,
          x_m: finalXm,
          y_m: finalYm,
          location_method: fused?.method || "primary_fallback",
          location_contributing_aps: fused?.contributing ?? detectionsCount,

          // Primary AP (strongest RSSI) for context
          ap_mac: primaryDet.ap_mac,
          ap_name: apInfo?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam:
            Number.isInteger(primaryDet.beam) &&
            primaryDet.beam >= 0 &&
            primaryDet.beam <= 7
              ? primaryDet.beam
              : null,

          radius: primaryDet.radius || DEFAULT_ASSET_RADIUS_M,
          detections_count: detectionsCount,
          location_confidence: locationConfidence,

          service_uuid: firstDet.service_uuid ?? firstDet.service_uuids ?? null,
          ibeacon_uuid: firstDet.ibeacon_uuid ?? null,
          ibeacon_major: firstDet.ibeacon_major ?? null,
          ibeacon_minor: firstDet.ibeacon_minor ?? null,
          eddystone_namespace: firstDet.eddystone_namespace ?? null,
          eddystone_instance: firstDet.eddystone_instance ?? null,

          last_seen: lastSeenMs,
          age_ms: ageMs,
          is_stale: isStale,
          updated_at: new Date().toISOString(),

          // Per-AP raw data with resolved rssi / beam / distance / weight
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
