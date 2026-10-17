const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const listEndpoints = require("express-list-endpoints");
require("dotenv").config();

// ===== Import Asset Tracker & Cron Service =====
const assetTracker = require("./services/mistAssetTracker");
const { initMidnightCron } = require("./services/cronService");

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
   Controllers
======================= */
const locationController = require("./controllers/location.controller");

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
app.use("/api/company", CompanyRoutes);
app.use("/api/IDManage", IDManagementRoutes);
app.use("/api/IDVisitor", IDvisitorRoutes);
app.use("/api/Cabinet", CabinetRoutes);
app.use("/api/cabinets", CabinetRoutes);

/* =======================
   🔥 Asset Tracking Routes
   (Redis-cached, on-demand — no polling)
======================= */

// GET all tracked assets with full diagnostics
// Query params:
//   ?force=1   → skip Redis freshness window, hit Mist
app.get("/api/assets", async (req, res) => {
  try {
    const force = req.query.force === "1";

    const assets = await assetTracker.getAssetsCached({
      force,
      allowStale: true,
    });

    // Build MAC-keyed map (matches old response shape used by frontend)
    const enhancedAssets = {};
    for (const a of assets) {
      enhancedAssets[a.mac] = {
        ...a,
        position_px: a.position_px || null,
        ap_mac: a.ap_mac || null,
        beam: a.beam ?? null,
        rssi: a.rssi ?? a.best_rssi ?? null,
        raw_rssi: a.raw_rssi ?? null,
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
app.get("/api/assets/:mac", async (req, res) => {
  try {
    const mac = req.params.mac.toUpperCase();

    const asset = await assetTracker.getAssetCached(mac, {
      force: req.query.force === "1",
    });

    if (!asset) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }

    res.json({
      success: true,
      asset: {
        ...asset,
        position_px: asset.position_px || null,
        ap_mac: asset.ap_mac || null,
        beam: asset.beam ?? null,
        rssi: asset.rssi ?? asset.best_rssi ?? null,
        raw_rssi: asset.raw_rssi ?? null,
      },
    });
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// Force a manual poll of the Mist API
// (bypasses Redis freshness, still respects 429 backoff)
app.post("/api/assets/poll", async (req, res) => {
  try {
    const results = await assetTracker.getAssetsCached({ force: true });
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
   🔥 VISITOR LIVE ROUTE
   Frontend calls this once per second.
   Response contains EVERYTHING the map needs:
     - location.x, location.y                 (tag pixel position)
     - target_coordinates.x, .y               (target pixel position)
     - route.nodes[], route.start, route.end  (line to draw)
     - distance, proximity
======================= */

// GET visitor's live location + full route
// :id can be a Mongo ObjectId  OR  the literal string "current"
// (the controller resolves "current" via the requesting session)
app.get("/api/visitor/:id/route", (req, res, next) => {
  // Delegate to the controller — it already handles "current" and ObjectId
  return locationController.getVisitorRoute(req, res, next);
});

// GET visitor's live location ONLY (no route computation)
// Useful for polling when the frontend just needs the dot position.
app.get("/api/visitor/:id/location", async (req, res) => {
  try {
    const { id } = req.params;
    const force = req.query.force === "1";

    // If "current" → look up by session/token (falls through to controller)
    if (id === "current") {
      return locationController.getVisitorRoute(req, res);
    }

    // Otherwise, fetch the visitor's asset directly from the tracker
    const QRModel = require("./models/User/IdVisitorQR.model");
    const mongoose = require("mongoose");

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid visitor ID" });
    }

    const visitor = await QRModel.findById(id);
    if (!visitor) {
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });
    }

    const mac = (visitor.tagMac || visitor.mistMacAddress || "").toUpperCase();
    if (!mac) {
      return res.status(404).json({
        success: false,
        message: "Visitor has no tag assigned",
      });
    }

    const asset = await assetTracker.getAssetCached(mac, { force });
    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Tag not found in Mist",
      });
    }

    res.json({
      success: true,
      data: {
        visitor: {
          id: visitor._id,
          name: visitor.visitorName,
          idNumber: visitor.idNumber,
        },
        location: {
          x: asset.position_px?.x ?? null,
          y: asset.position_px?.y ?? null,
          mac: asset.mac,
          map_id: asset.map_id,
          ap_mac: asset.ap_mac,
          rssi: asset.rssi,
          beam: asset.beam,
          pixel_coordinates: asset.position_px ?? null,
          smoothed_position: asset.position ?? null,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error fetching visitor location:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching visitor location",
      error: error.message,
    });
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
   Database Connection & Cron
======================= */
connectDB().then(() => {
  initMidnightCron();
});

/* =======================
   🔥 Asset Tracker — Event Listeners Only
   (No polling; tracker fetches on-demand when /api/assets is hit)
======================= */
assetTracker.on("rateLimited", ({ retryAfter, backoffMultiplier }) => {
  console.log(
    `📡 Rate-limit event – will retry after ${retryAfter}s (backoff multiplier: ${backoffMultiplier})`,
  );
});

assetTracker.on("assetUpdate", (update) => {
  const p = update.position || {};
  console.log(
    `📍 ${update.mac} → (${p.x_m?.toFixed(2)}, ${p.y_m?.toFixed(2)})  |  RSSI: ${update.best_rssi} dBm  |  Stability: ${update.stability?.toFixed(2)}`,
  );
});

/* =======================
   Server Start
======================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Base URL: http://localhost:${PORT}`);
  console.log(`📡 Asset mode: on-demand Redis cache (no polling)`);

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
