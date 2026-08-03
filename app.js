const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const listEndpoints = require("express-list-endpoints");
require("dotenv").config();

// ===== Import Asset Tracker =====
const assetTracker = require("./services/mistAssetTracker"); // adjust path if needed

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
   🔥 Asset Tracking Routes
======================= */

// GET all tracked assets (current positions, stability, etc.)
app.get("/api/assets", (req, res) => {
  try {
    const states = assetTracker.getAssetStates();
    res.json({
      timestamp: Date.now(),
      assets: states,
    });
  } catch (error) {
    console.error("Error fetching asset states:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET a specific asset by MAC address
app.get("/api/assets/:mac", (req, res) => {
  try {
    const mac = req.params.mac.toUpperCase();
    const states = assetTracker.getAssetStates();
    if (states[mac]) {
      res.json(states[mac]);
    } else {
      res.status(404).json({ error: "Asset not found" });
    }
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// (Optional) Force a manual poll of the Mist API
app.post("/api/assets/poll", async (req, res) => {
  try {
    const results = await assetTracker.getAssets();
    res.json({ message: "Poll completed", count: results.length });
  } catch (error) {
    console.error("Manual poll failed:", error);
    res.status(500).json({ error: "Poll failed" });
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
   Asset Tracker – Start Polling
======================= */
const ASSET_POLL_INTERVAL =
  parseInt(process.env.ASSET_POLL_INTERVAL, 10) || 5000; // default 5s

// Initial poll (with error handling)
assetTracker
  .getAssets()
  .catch((err) => console.error("Initial asset poll error:", err));

// Regular interval
const pollInterval = setInterval(() => {
  assetTracker
    .getAssets()
    .catch((err) => console.error("Asset poll error:", err));
}, ASSET_POLL_INTERVAL);

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
  console.log(`📡 Asset polling interval: ${ASSET_POLL_INTERVAL}ms`);

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
