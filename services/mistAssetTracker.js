const axios = require("axios");
const EventEmitter = require("events");

// ENV
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

class AssetTracker extends EventEmitter {
  constructor() {
    super();

    this.backoffUntil = 0;
    this.backoffMultiplier = 1;
    this.cachedProcessedAssets = [];
  }

  getCachedAssets() {
    return this.cachedProcessedAssets;
  }

  // Return raw asset detections from Mist without calculations.
  async getAssets() {
    const now = Date.now();

    if (this.backoffUntil > now) {
      return this.cachedProcessedAssets;
    }

    try {
      const response = await mist.get(`/sites/${SITE_ID}/stats/assets`);

      this.backoffMultiplier = 1;
      this.backoffUntil = 0;

      if (Array.isArray(response.data)) {
        this.cachedProcessedAssets = response.data;
        return response.data;
      }

      return this.cachedProcessedAssets;
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter =
          parseInt(err.response.headers["retry-after"], 10) || 60;

        const waitMs = retryAfter * 1000 * this.backoffMultiplier;

        this.backoffUntil = Date.now() + waitMs;
        this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);

        this.emit("rateLimited", {
          retryAfter: Math.ceil(waitMs / 1000),
        });

        return this.cachedProcessedAssets;
      }

      console.error("Mist API Error:", err.message);
      return this.cachedProcessedAssets;
    }
  }

  async getAssetsCached(opts = {}) {
    return this.getAssets();
  }

  async getAssetCached(mac, opts = {}) {
    const assets = await this.getAssets();
    const target = (mac || "").toUpperCase();

    return (
      assets.find((asset) => (asset.mac || "").toUpperCase() === target) || null
    );
  }

  // Legacy compatibility methods
  getAssetStates() {
    const states = {};

    for (const asset of this.cachedProcessedAssets) {
      if (!asset.mac) continue;
      states[asset.mac] = { ...asset };
    }

    return states;
  }

  getAssetTrail() {
    return [];
  }

  clearAssetTrail() {}
  resetAsset() {}
  setWayfindingData() {}
}

module.exports = new AssetTracker();
