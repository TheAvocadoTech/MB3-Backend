const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const listEndpoints = require("express-list-endpoints");
require("dotenv").config();

// ===== Import Asset Tracker =====
const assetTracker = require("./services/mistAssetTracker");

const app = express();

/* =======================
   Database
======================= */
const connectDB = require("./config/db");

/* =======================
   Routes
======================= */
const UserRoutes = require("./routes/Users.routes");
const CompanyRoutes = require("./routes/Company.route");
const IDManagementRoutes = require("./routes/IDManagment.routes");
const IDvisitorRoutes = require("./routes/IDVisitor.routes");
const CabinetRoutes = require("./routes/Cabinet.route");

/* =======================
   Middleware
======================= */
app.use(helmet());
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* =======================
   Health Check
======================= */
app.get("/", (req, res) => {
  res.send("You are connected to Printsy server");
});

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

/* =======================
   API Routes
======================= */
app.use("/api/auth", UserRoutes);
app.use("/api/Company", CompanyRoutes);
app.use("/api/IDManage", IDManagementRoutes);
app.use("/api/IDVisitor", IDvisitorRoutes);
app.use("/api/Cabinet", CabinetRoutes);

/* =======================
   🔥 Asset Tracking Routes (ENHANCED)
======================= */

// Helper function to get map config (same as in mistAssetTracker.js)
function getMapConfig(mapId) {
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
    "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
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
  return MAP_CONFIGS[mapId] || null;
}

// GET all tracked assets with full diagnostics (pixel + meter coords, AP info)
app.get("/api/assets", (req, res) => {
  try {
    const states = assetTracker.getAssetStates();

    const enhancedAssets = {};
    for (const [mac, state] of Object.entries(states)) {
      const mapConfig = state.map_id ? getMapConfig(state.map_id) : null;

      let position_px = null;
      if (state.position && mapConfig) {
        position_px = {
          x: state.position.x_m * mapConfig.ppm + mapConfig.origin_x,
          y: mapConfig.origin_y - state.position.y_m * mapConfig.ppm,
        };
      }

      enhancedAssets[mac] = {
        ...state,
        position_px: position_px,
        ap_mac: state.ap_mac || null,
        beam: state.beam || null,
        rssi: state.rssi || state.best_rssi || null,
        raw_rssi: state.raw_rssi || null,
      };
    }

    res.json({
      success: true,
      timestamp: Date.now(),
      assets: enhancedAssets,
      count: Object.keys(enhancedAssets).length,
    });
  } catch (error) {
    console.error("Error fetching asset states:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// GET a specific asset by MAC address
app.get("/api/assets/:mac", (req, res) => {
  try {
    const mac = req.params.mac.toUpperCase();
    const states = assetTracker.getAssetStates();

    if (states[mac]) {
      const state = states[mac];
      const mapConfig = state.map_id ? getMapConfig(state.map_id) : null;

      let position_px = null;
      if (state.position && mapConfig) {
        position_px = {
          x: state.position.x_m * mapConfig.ppm + mapConfig.origin_x,
          y: mapConfig.origin_y - state.position.y_m * mapConfig.ppm,
        };
      }

      res.json({
        success: true,
        asset: {
          ...state,
          position_px: position_px,
          ap_mac: state.ap_mac || null,
          beam: state.beam || null,
          rssi: state.rssi || state.best_rssi || null,
          raw_rssi: state.raw_rssi || null,
        },
      });
    } else {
      res.status(404).json({ success: false, error: "Asset not found" });
    }
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Force a manual poll of the Mist API
app.post("/api/assets/poll", async (req, res) => {
  try {
    const results = await assetTracker.getAssets();
    res.json({
      success: true,
      message: "Poll completed",
      count: results.length,
    });
  } catch (error) {
    console.error("Manual poll failed:", error);
    res.status(500).json({ success: false, error: "Poll failed" });
  }
});

/* =======================
   Route Listing (DEV)
======================= */
if (process.env.NODE_ENV !== "production") {
  app.get("/api/routes", (req, res) => {
    res.json(listEndpoints(app));
  });
}

/* =======================
   Database Connection
======================= */
connectDB();

/* =======================
   🔥 Asset Tracker – START POLLING (UPDATED)
======================= */

// New base interval: 30 seconds (safe for Mist rate limits)
const ASSET_BASE_INTERVAL = 30000; // 30 seconds

let pollInterval = null;

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    // Check if tracker is currently in backoff (rate-limited)
    if (assetTracker.backoffUntil && assetTracker.backoffUntil > Date.now()) {
      // Skip this poll; we'll try again later
      return;
    }
    try {
      await assetTracker.getAssets();
    } catch (err) {
      console.error("Asset poll error:", err);
    }
  }, ASSET_BASE_INTERVAL);
}

// Listen for rate‑limit events (optional logging / adjustments)
assetTracker.on("rateLimited", ({ retryAfter, backoffMultiplier }) => {
  console.log(
    `📡 Rate‑limit event – will retry after ${retryAfter}s (backoff multiplier: ${backoffMultiplier})`,
  );
  // You could optionally increase the interval here, but assetTracker already handles backoff internally.
});

// Initial poll
assetTracker
  .getAssets()
  .catch((err) => console.error("Initial asset poll error:", err));

// Start the interval
startPolling();

// Listen for real‑time updates (log or forward via WebSocket)
assetTracker.on("assetUpdate", (update) => {
  console.log(
    `📍 ${update.mac} → (${update.position.x_m?.toFixed(2)}, ${update.position.y_m?.toFixed(2)})  |  RSSI: ${update.best_rssi} dBm  |  Stability: ${update.stability.toFixed(2)}`,
  );
});

/* =======================
   Graceful Shutdown
======================= */
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  clearInterval(pollInterval);
  // Close database connections, etc.
  process.exit(0);
});

/* =======================
   Server Start
======================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Base URL: http://localhost:${PORT}`);
  console.log(`📡 Asset polling interval: ${ASSET_BASE_INTERVAL}ms`);

  if (process.env.NODE_ENV !== "production") {
    console.log("\n📂 ========== AVAILABLE ROUTES ==========\n");
    const routes = listEndpoints(app);
    routes.forEach((route, index) => {
      console.log(
        `${index + 1}. ${route.methods.join(", ").padEnd(8)} ${route.path}`,
      );
    });
    console.log(`\n✅ Total Routes: ${routes.length}`);
    console.log("\n========================================\n");
  }
});
