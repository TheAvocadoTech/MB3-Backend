// app.js

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const listEndpoints = require("express-list-endpoints");
require("dotenv").config();

// Import Asset Tracker (on-demand Redis cache, no polling)
const assetTracker = require("./services/mistAssetTracker");
const { initMidnightCron } = require("./services/cronService");

const app = express();

// Database
const connectDB = require("./config/db");

// Routes
const UserRoutes = require("./routes/Users.routes");
const CompanyRoutes = require("./routes/Company.route");
const IDManagementRoutes = require("./routes/IDManagment.routes");
const IDvisitorRoutes = require("./routes/IDVisitor.routes");
const CabinetRoutes = require("./routes/Cabinet.route");

// Middleware
app.use(helmet());
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => {
  res.send("You are connected to Printsy server");
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// API routes
app.use("/api/auth", UserRoutes);
app.use("/api/Company", CompanyRoutes);
app.use("/api/company", CompanyRoutes);
app.use("/api/IDManage", IDManagementRoutes);
app.use("/api/IDVisitor", IDvisitorRoutes);
app.use("/api/Cabinet", CabinetRoutes);
app.use("/api/cabinets", CabinetRoutes);

/* =========================================================
   Asset Tracking Routes (ON-DEMAND Redis cache, no polling)
   ========================================================= */

// GET all tracked assets — reads from Redis (fresh) or fetches Mist once
app.get("/api/assets", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const assets = await assetTracker.getAssetsCached({ force });

    // Keep response shape compatible with the old format:
    // { success, timestamp, assets: {mac: state}, count }
    const asObject = {};
    for (const a of assets) {
      asObject[a.mac] = a;
    }

    res.json({
      success: true,
      timestamp: Date.now(),
      assets: asObject,
      count: assets.length,
    });
  } catch (error) {
    console.error("Error fetching assets:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET one asset by MAC
app.get("/api/assets/:mac", async (req, res) => {
  try {
    const mac = req.params.mac.toUpperCase();
    const asset = await assetTracker.getAssetCached(mac);
    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }
    res.json({ success: true, asset });
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Force refresh — bypass Redis freshness
app.post("/api/assets/poll", async (req, res) => {
  try {
    const results = await assetTracker.getAssetsCached({ force: true });
    res.json({ success: true, message: "Refreshed", count: results.length });
  } catch (error) {
    console.error("Manual refresh failed:", error);
    res.status(500).json({ success: false, error: "Refresh failed" });
  }
});

// Route listing (dev)
if (process.env.NODE_ENV !== "production") {
  app.get("/api/routes", (req, res) => res.json(listEndpoints(app)));
}

// DB + Cron
connectDB().then(() => {
  initMidnightCron();
});

/* =========================================================
   NO POLLING. NO setInterval. On-demand only.
   ========================================================= */

// Optional: warm the cache once at startup (no timer)
assetTracker.getAssetsCached().catch(err =>
  console.error("Initial cache warm failed:", err.message)
);

// Log live updates (optional — comes from process cycle, not a poller)
assetTracker.on("assetUpdate", (update) => {
  console.log(
    `📍 ${update.mac} → (${update.position.x_m?.toFixed(2)}, ${update.position.y_m?.toFixed(2)})  |  RSSI: ${update.best_rssi}`
  );
});

assetTracker.on("rateLimited", ({ retryAfter }) => {
  console.log(`📡 Mist rate-limited — retry after ${retryAfter}s (serving cache)`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  try {
    await assetTracker.closeRedis();
  } catch (e) {
    console.error("Redis close error:", e.message);
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Base URL: http://localhost:${PORT}`);
  console.log(`📡 Asset cache: on-demand (no polling)`);
});
