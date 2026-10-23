// services/mistAssetTracker.js
// RAW DATA MODE — zero coordinate calculations.
// Redis-backed caching to prevent API hammering and server crashes.

const axios = require("axios");
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const Redis = require("ioredis");

const SITE_ID = process.env.MIST_SITE_ID;
if (!SITE_ID) throw new Error("MIST_SITE_ID environment variable required");

const API_TOKEN = process.env.MIST_API_TOKEN;
if (!API_TOKEN) throw new Error("MIST_API_TOKEN environment variable required");

// Fallback radius if Mist doesn't provide one
const DEFAULT_ASSET_RADIUS_M = parseInt(process.env.ASSET_RADIUS_M, 10) || 5;

// Redis config
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const CACHE_KEY = `mist:assets:${SITE_ID}`;
const BACKOFF_KEY = `mist:backoff:${SITE_ID}`;
const CACHE_TTL_SEC = parseInt(process.env.MIST_CACHE_TTL_SEC, 10) || 30;
const MIN_REFRESH_MS = parseInt(process.env.MIST_MIN_REFRESH_MS, 10) || 5000;

const mist = axios.create({
  baseURL: "https://api.mist.com/api/v1",
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 10000,
});

class AssetTracker extends EventEmitter {
  constructor() {
    super();
    this.cachedProcessedAssets = [];
    this.apMap = new Map();
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
    // Return cached value immediately if within min refresh window.
    if (Date.now() - this.lastFetchAt < MIN_REFRESH_MS) {
      return this.cachedProcessedAssets;
    }

    if (await this._isBackedOff()) {
      return this.cachedProcessedAssets;
    }

    // Dedupe concurrent requests.
    if (this.inflight) return this.inflight;

    this.inflight = this._fetchAndCache().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async _fetchAndCache() {
    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);
      this.lastFetchAt = Date.now();

      if (Array.isArray(response.data) && response.data.length > 0) {
        const processed = this._processAssetData(response.data);
        this.cachedProcessedAssets = processed;

        // Persist to Redis (fire-and-forget).
        this.redis
          .set(CACHE_KEY, JSON.stringify(processed), "EX", CACHE_TTL_SEC)
          .catch((err) => console.warn("⚠️ Redis set failed:", err.message));

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
        console.warn(
          `⏸️ Mist 429 — backing off ${retryAfter}s (Redis-persisted)`,
        );
        return this.cachedProcessedAssets;
      }

      console.error("Mist API Error:", err.message);
      return this.cachedProcessedAssets;
    }
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

        // Sort by RSSI to find the strongest detection
        detections.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
        const primaryDet = detections[0];

        // Determine location confidence based on how many APs heard the tag
        const detectionsCount = detections.length;
        let locationConfidence = "Low (Single AP)";
        if (detectionsCount >= 3) {
          locationConfidence = "High (Triangulated)";
        } else if (detectionsCount === 2) {
          locationConfidence = "Medium (2 APs)";
        }

        // Mist's calculated location (or fallback to the strongest AP's known location)
        const apInfo = this.apMap.get(
          (primaryDet.ap_mac || "").toLowerCase().trim(),
        );

        processedAssets.push({
          mac,
          device_name: firstDet.device_name || "Unknown",
          map_id: firstDet.map_id,
          detections, // raw detections passed through

          // Location Data
          x: primaryDet.x ?? apInfo?.x ?? null,
          y: primaryDet.y ?? apInfo?.y ?? null,
          x_m: primaryDet.x_m ?? apInfo?.x_m ?? null,
          y_m: primaryDet.y_m ?? apInfo?.y_m ?? null,

          // AP Data
          ap_mac: primaryDet.ap_mac,
          ap_name: apInfo?.name || primaryDet.ap_mac,
          rssi: primaryDet.rssi,
          beam:
            Number.isInteger(primaryDet.beam) &&
            primaryDet.beam >= 0 &&
            primaryDet.beam <= 7
              ? primaryDet.beam
              : null,

          // Accuracy & Confidence
          radius: primaryDet.radius || DEFAULT_ASSET_RADIUS_M,
          detections_count: detectionsCount,
          location_confidence: locationConfidence,

          // Tag Identity (iBeacon / Eddystone)
          service_uuid: firstDet.service_uuid ?? firstDet.service_uuids ?? null,
          ibeacon_uuid: firstDet.ibeacon_uuid ?? null,
          ibeacon_major: firstDet.ibeacon_major ?? null,
          ibeacon_minor: firstDet.ibeacon_minor ?? null,
          eddystone_namespace: firstDet.eddystone_namespace ?? null,
          eddystone_instance: firstDet.eddystone_instance ?? null,

          // Freshness
          last_seen: primaryDet.last_seen ?? primaryDet.timestamp ?? null,
          updated_at: new Date().toISOString(),
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
