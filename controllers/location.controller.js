// controllers/location.controller.js
const QRModel = require("../models/User/IdVisitorQR.model");
const axios = require("axios");
const mongoose = require("mongoose");
const AssetTracker = require("../services/mistAssetTracker");
const path = require("path");
const fs = require("fs");

// ============================
// MIST API CONFIGURATION
// ============================

const MIST_API_TOKEN =
  process.env.MIST_API_TOKEN ||
  "li1iDhxqOaPiJyYwcEuIznaUcLqajVsVTnTS6eKtzFDh4N2ZPbInk8sodqYAFhjYqOOeB3LFIClQ2deNJUXDgIVWsJ6SCjlT";
const MIST_SITE_ID =
  process.env.MIST_SITE_ID || "8ddd401e-edb4-4b24-beb1-6298afdd0bd1";
const MIST_API_BASE = "https://api.mist.com/api/v1";

// ============================
// MAP CONFIGURATIONS
// ============================

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

// ============================
// TARGET PER MAP
// ============================

const TARGETS_BY_MAP = {
  // Ground Floor — MB3-F00
  "30141417-44ea-4982-993c-6225c9f08315": {
    x: 5625.298750495607,
    y: 2200.837930104785,
    label: "AP36 Zone",
  },
  // First Floor — MB3-F01
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    x: 5525.298750495607,
    y: 1000.837930104785,
    label: "Cabinet",
  },
};

// Beam angles for the diagnostics panel
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

// ============================
// LOAD AP DATA (For Centroid Calc)
// ============================
const AP_MAP = new Map();
try {
  const apListPath = path.join(__dirname, "../services/ap_list.json");
  if (fs.existsSync(apListPath)) {
    const apList = JSON.parse(fs.readFileSync(apListPath, "utf8"));
    if (Array.isArray(apList)) {
      for (const ap of apList) {
        if (ap.mac) {
          AP_MAP.set(ap.mac.toLowerCase().trim(), ap);
        }
      }
    }
  }
} catch (err) {
  console.warn("⚠️ Could not load ap_list.json in controller:", err.message);
}

// ============================
// MIST API HELPERS
// ============================

const getMistHeaders = () => ({
  Authorization: `Token ${MIST_API_TOKEN}`,
  "Content-Type": "application/json",
});

const fetchAssetLocations = async () => {
  try {
    return await AssetTracker.getAssets();
  } catch (error) {
    console.error(
      "❌ Mist API Error (fallback):",
      error.response?.data || error.message,
    );
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/assets`;
    const response = await axios.get(url, { headers: getMistHeaders() });
    return response.data;
  }
};

const fetchMapDetails = async (mapId) => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/maps/${mapId}`;
    const response = await axios.get(url, { headers: getMistHeaders() });
    const data = response.data;
    return {
      id: data.id,
      name: data.name,
      width: data.width,
      height: data.height,
      ppm: data.ppm,
      origin_x: data.origin_x,
      origin_y: data.origin_y,
      orientation: data.orientation,
      width_m: data.width_m,
      height_m: data.height_m,
      site_id: data.site_id,
      org_id: data.org_id,
      url: data.url,
      thumbnail_url: data.thumbnail_url,
    };
  } catch (error) {
    console.error("❌ Map API Error:", error.response?.data || error.message);
    return null;
  }
};

// ============================
// COORDINATE HELPERS
// ============================

const convertMistToWorld = (pixelX, pixelY, mapData) => {
  if (!mapData || !mapData.ppm || mapData.origin_x === undefined) return null;
  const { origin_x, origin_y, ppm } = mapData;
  return {
    x: (pixelX - origin_x) / ppm,
    z: -(pixelY - origin_y) / ppm,
    y: 0.1,
  };
};

// ============================
// ROUTE BUILDER
// ============================

function buildRoute(fromPx, toPx, ppm = 50.07391564392213) {
  if (!fromPx || !toPx) return null;

  const dx = toPx.x - fromPx.x;
  const dy = toPx.y - fromPx.y;
  const distPx = Math.hypot(dx, dy);
  const distM = distPx / ppm;

  return {
    nodes: [
      { name: "TAG", position: { x: fromPx.x, y: fromPx.y } },
      { name: "TARGET", position: { x: toPx.x, y: toPx.y } },
    ],
    path: ["TAG", "TARGET"],
    segments: 1,
    distance: {
      pixels: distPx,
      meters: distM,
    },
    start: { x: fromPx.x, y: fromPx.y },
    end: { x: toPx.x, y: toPx.y },
  };
}

// ============================
// RESOLVE "current" → active visitor ID
// ============================

async function resolveVisitorId(idOrCurrent, req) {
  if (idOrCurrent !== "current") return idOrCurrent;

  // Option A — JWT (if verifyVisitorToken middleware ran)
  if (req.user?.visitorId) return req.user.visitorId;

  // Option B — most recently checked-in visitor
  const recent = await QRModel.findOne({
    isOnVisit: true,
    checkedIn: true,
  })
    .sort({ checkedInAt: -1 })
    .lean();

  return recent ? recent._id.toString() : null;
}

// ============================
// GET VISITOR LOCATION WITH ROUTE
// ============================

exports.getVisitorRoute = async (req, res) => {
  try {
    let { id } = req.params;

    // ---------- Resolve "current" ----------
    id = await resolveVisitorId(id, req);
    if (!id) {
      return res.status(404).json({
        success: false,
        message: "No active visitor found for 'current'",
      });
    }

    console.log("📍 Fetching location for visitor ID:", id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID format",
      });
    }

    const visitor = await QRModel.findById(id);
    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    console.log("👤 Visitor found:", visitor.visitorName);
    console.log("🆔 ID Number:", visitor.idNumber || "(empty)");

    if (!visitor.idNumber || visitor.idNumber.trim() === "") {
      return res.status(404).json({
        success: false,
        message: "No ID/asset assigned to this visitor.",
        visitor: {
          id: visitor._id,
          name: visitor.visitorName,
          company: visitor.company,
          currentIdNumber: visitor.idNumber || "Not assigned",
        },
      });
    }

    // ---------- Fetch all assets ----------
    let assets;
    try {
      assets = await fetchAssetLocations();
    } catch (error) {
      console.error("❌ Mist API Error:", error.message);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch asset locations from Mist API",
        error: error.message,
      });
    }

    // ---------- Match visitor's tag ----------
    const targetMac = (visitor.tagMac || visitor.mistMacAddress || "")
      .toLowerCase()
      .trim();
    const targetIdNumber = (visitor.idNumber || "").toLowerCase().trim();
    const targetNickname = (visitor.tagNickname || "").toLowerCase().trim();

    const matchedAsset = assets.find((asset) => {
      const aMac = (asset.mac || "").toLowerCase().trim();
      const aName = (asset.device_name || asset.name || "")
        .toLowerCase()
        .trim();
      return (
        (targetMac && aMac === targetMac) ||
        (targetIdNumber &&
          (aName === targetIdNumber || aMac === targetIdNumber)) ||
        (targetNickname && aName === targetNickname)
      );
    });

    if (!matchedAsset) {
      return res.status(404).json({
        success: false,
        message: `Asset "${visitor.tagMac || visitor.idNumber}" not found in Mist system`,
        available_assets: assets
          .map((a) => a.device_name || a.mac)
          .filter(Boolean),
      });
    }

    // ---------- Calculate Location (Centroid in Controller) ----------
    const currentMapId =
      matchedAsset.map_id || "30141417-44ea-4982-993c-6225c9f08315";
    const cfg = MAP_CONFIGS[currentMapId];
    const ppm = cfg?.ppm || 50.07391564392213;

    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    let primaryDetection = null;

    // Loop over the raw detections passed by the tracker
    for (const det of matchedAsset.detections || []) {
      // Find strongest signal for diagnostics
      if (
        det.ap_mac &&
        (primaryDetection === null || det.rssi > primaryDetection.rssi)
      ) {
        primaryDetection = det;
      }

      const apInfo = AP_MAP.get((det.ap_mac || "").toLowerCase().trim());
      if (!apInfo) continue;

      // Convert AP pixel/meter coords to pixels
      let apX = null;
      let apY = null;
      if (
        Number.isFinite(apInfo.x) &&
        Number.isFinite(apInfo.y) &&
        apInfo.x !== 0
      ) {
        apX = apInfo.x;
        apY = apInfo.y;
      } else if (Number.isFinite(apInfo.x_m) && Number.isFinite(apInfo.y_m)) {
        apX = apInfo.x_m * ppm + cfg.origin_x;
        apY = cfg.origin_y - apInfo.y_m * ppm;
      }

      if (apX !== null && apY !== null) {
        // RSSI weighting (e.g. -55 dBm becomes weight 45)
        const weight = Math.max(1, (det.rssi ?? -100) + 100);
        sumX += apX * weight;
        sumY += apY * weight;
        sumW += weight;
      }
    }

    let assetX = null;
    let assetY = null;

    if (sumW > 0) {
      assetX = sumX / sumW;
      assetY = sumY / sumW;
    } else {
      // Fallback if no AP coordinates matched (use primary AP)
      const primaryAp = AP_MAP.get(
        (primaryDetection?.ap_mac || "").toLowerCase().trim(),
      );
      if (primaryAp) {
        assetX = Number.isFinite(primaryAp.x)
          ? primaryAp.x
          : primaryAp.x_m * ppm + cfg.origin_x;
        assetY = Number.isFinite(primaryAp.y)
          ? primaryAp.y
          : cfg.origin_y - primaryAp.y_m * ppm;
      }
    }

    if (assetX === null || assetY === null) {
      return res.status(404).json({
        success: false,
        message: `Asset "${matchedAsset.mac}" has no location data yet (AP coordinates missing)`,
      });
    }

    console.log(
      `✅ Tag position resolved: (${Math.round(assetX)}, ${Math.round(assetY)}) from ${currentMapId}`,
    );

    // ---------- Map details ----------
    let mapDetails = null;
    try {
      mapDetails = await fetchMapDetails(currentMapId);
    } catch (error) {
      console.warn("⚠️ Could not fetch map details:", error.message);
    }

    // ---------- Target for this map ----------
    const target = TARGETS_BY_MAP[currentMapId] || {
      x: 5625.298750495607,
      y: 2200.837930104785,
      label: "Target",
    };

    // ---------- Build route (tag → target) ----------
    const route = buildRoute(
      { x: assetX, y: assetY },
      { x: target.x, y: target.y },
      ppm,
    );

    // ---------- World coords ----------
    const worldCoords = mapDetails
      ? convertMistToWorld(assetX, assetY, mapDetails)
      : null;

    // ---------- Build response ----------
    const locationData = {
      visitor: {
        id: visitor._id,
        name: visitor.visitorName,
        phone: visitor.phoneNumber,
        email: visitor.email,
        company: visitor.company,
        idNumber: visitor.idNumber,
        purpose: visitor.purpose,
        checkedIn: visitor.checkedIn,
        checkedInAt: visitor.checkedInAt,
        qrExpiresAt: visitor.qrExpiresAt,
      },
      location: {
        x: assetX,
        y: assetY,
        mac: matchedAsset.mac,
        map_id: currentMapId,
        ap_mac: primaryDetection?.ap_mac || matchedAsset.ap_mac,
        rssi: primaryDetection?.rssi || matchedAsset.rssi,
        beam: primaryDetection?.beam ?? null,
        beam_angle:
          primaryDetection?.beam !== undefined
            ? BEAM_ANGLES[primaryDetection.beam]
            : null,
        device_name: matchedAsset.device_name,
        pixel_coordinates: { x: assetX, y: assetY },
        world_coordinates: worldCoords,
      },
      map: mapDetails
        ? {
            id: mapDetails.id,
            name: mapDetails.name,
            width: mapDetails.width,
            height: mapDetails.height,
            ppm: mapDetails.ppm,
            origin_x: mapDetails.origin_x,
            origin_y: mapDetails.origin_y,
            width_m: mapDetails.width_m,
            height_m: mapDetails.height_m,
          }
        : null,
      target_coordinates: {
        x: target.x,
        y: target.y,
        label: target.label,
      },
      route,
      distance: route
        ? { pixels: route.distance.pixels, meters: route.distance.meters }
        : null,
      proximity: route
        ? route.distance.meters < 2
          ? "Very Close"
          : route.distance.meters < 5
            ? "Close"
            : route.distance.meters < 10
              ? "Moderate"
              : route.distance.meters < 20
                ? "Medium"
                : "Far"
        : "Unknown",
      timestamp: new Date().toISOString(),
    };

    res.status(200).json({
      success: true,
      message: "Visitor location retrieved successfully",
      data: locationData,
    });
  } catch (error) {
    console.error("❌ Error fetching visitor location:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching visitor location",
      error: error.message,
    });
  }
};

// ============================
// GET ALL ASSET LOCATIONS
// ============================

exports.getAllAssetLocations = async (req, res) => {
  try {
    const assets = await fetchAssetLocations();
    res.status(200).json({
      success: true,
      total: assets.length,
      data: assets,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching asset locations",
      error: error.message,
    });
  }
};

// ============================
// GET MAP DETAILS
// ============================

exports.getMapDetails = async (req, res) => {
  try {
    const { mapId } = req.params;
    if (!mapId) {
      return res
        .status(400)
        .json({ success: false, message: "Map ID is required" });
    }
    const mapDetails = await fetchMapDetails(mapId);
    if (!mapDetails) {
      return res.status(404).json({ success: false, message: "Map not found" });
    }
    res.status(200).json({ success: true, data: mapDetails });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching map details",
      error: error.message,
    });
  }
};

// ============================
// GET VISITOR CABINET
// ============================

exports.getVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;
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

    if (!visitor.idNumber || visitor.idNumber.trim() === "") {
      return res.status(404).json({
        success: false,
        message: "No cabinet/asset assigned to this visitor",
      });
    }

    const assets = await fetchAssetLocations();
    const cabinet = assets.find((asset) => {
      const aName = (asset.device_name || asset.name || "").toLowerCase();
      const aMac = (asset.mac || "").toLowerCase();
      const key = visitor.idNumber.toLowerCase();
      return aName === key || aMac === key;
    });

    if (!cabinet) {
      return res.status(404).json({
        success: false,
        message: `Cabinet/asset "${visitor.idNumber}" not found in Mist system`,
      });
    }

    res.status(200).json({
      success: true,
      data: {
        visitor: {
          id: visitor._id,
          name: visitor.visitorName,
          company: visitor.company,
        },
        cabinet: {
          name: cabinet.device_name || cabinet.mac,
          mac: cabinet.mac,
          x: cabinet.position_px?.x ?? null,
          y: cabinet.position_px?.y ?? null,
          map_id: cabinet.map_id,
          rssi: cabinet.rssi,
          ap_mac: cabinet.ap_mac,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching visitor cabinet",
      error: error.message,
    });
  }
};

// ============================
// UPDATE VISITOR CABINET
// ============================

exports.updateVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;
    const { idNumber, assetName } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid visitor ID" });
    }

    const newIdNumber = idNumber || assetName;
    if (!newIdNumber) {
      return res
        .status(400)
        .json({ success: false, message: "idNumber or assetName is required" });
    }

    const visitor = await QRModel.findById(id);
    if (!visitor) {
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });
    }

    visitor.idNumber = newIdNumber;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Visitor cabinet updated successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        idNumber: visitor.idNumber,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating visitor cabinet",
      error: error.message,
    });
  }
};

// ============================================================
// LEGACY STUBS
// ============================================================

exports.getWayfindingPath = async (req, res) => {
  try {
    const { mapId } = req.params;
    res.status(200).json({
      success: true,
      message:
        "Wayfinding graph disabled — use /visitors/:id/route for the direct line.",
      data: { map_id: mapId, nodes: [], edges: {} },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getNavigationRoute = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message:
        "Route endpoint disabled — use /visitors/:id/route for live navigation.",
      data: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.testCoordinateConversion = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: "Coordinate conversion helper is disabled.",
      data: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAssetTrackingState = async (req, res) => {
  try {
    const assets = await fetchAssetLocations();
    const states = {};
    for (const a of assets) {
      states[a.mac] = {
        device_name: a.device_name,
        position: a.position,
        position_px: a.position_px,
        map_id: a.map_id,
        ap_mac: a.ap_mac,
        rssi: a.rssi,
        beam: a.beam,
        lastUpdate: Date.now(),
      };
    }
    res.status(200).json({
      success: true,
      total: Object.keys(states).length,
      data: states,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.resetAssetTracking = async (req, res) => {
  try {
    const { mac } = req.params;
    if (mac && typeof AssetTracker.resetAsset === "function") {
      AssetTracker.resetAsset(mac);
    }
    res.status(200).json({
      success: true,
      message: `Reset requested${mac ? ` for ${mac}` : ""}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================
// EXPORTS
// ============================

module.exports = {
  // Live tracking
  getVisitorRoute: exports.getVisitorRoute,
  getAllAssetLocations: exports.getAllAssetLocations,
  getMapDetails: exports.getMapDetails,
  getVisitorCabinet: exports.getVisitorCabinet,
  updateVisitorCabinet: exports.updateVisitorCabinet,

  // Legacy stubs
  getWayfindingPath: exports.getWayfindingPath,
  getNavigationRoute: exports.getNavigationRoute,
  testCoordinateConversion: exports.testCoordinateConversion,
  getAssetTrackingState: exports.getAssetTrackingState,
  resetAssetTracking: exports.resetAssetTracking,
};
