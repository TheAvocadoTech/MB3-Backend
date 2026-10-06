// routes/assets.js
const router = require("express").Router();
const tracker = require("../services/mistAssetTracker");

// All assets — first request hits Mist, subsequent requests served from Redis
router.get("/assets", async (req, res) => {
  try {
    const force = req.query.force === "1"; // manual refresh
    const assets = await tracker.getAssetsCached({ force });
    res.json({
      count: assets.length,
      fetched_at: Date.now(),
      assets,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single asset
router.get("/assets/:mac", async (req, res) => {
  try {
    const a = await tracker.getAssetCached(req.params.mac);
    if (!a) return res.status(404).json({ error: "not found" });
    res.json(a);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;