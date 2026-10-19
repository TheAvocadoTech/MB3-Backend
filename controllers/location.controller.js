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
  "30141417-44ea-4982-993c-6225c9f08315": {
    x: 5625.298750495607,
    y: 2200.837930104785,
    label: "AP36 Zone",
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    x: 5525.298750495607,
    y: 1000.837930104785,
    label: "Cabinet",
  },
};

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
// LOAD AP DATA (For direct anchoring)
// ============================
const AP_MAP = new Map();
try {
  const apListPath = path.join(__dirname, "../services/ap_list.json");
  if (fs.existsSync(apListPath)) {
    const apList = JSON.parse(fs.readFileSync(apListPath, "utf8"));
    if (Array.isArray(apList)) {
      for (const ap of apList) {
        if (ap.mac) AP_MAP.set(ap.mac.toLowerCase().trim(), ap);
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
    console.error("❌ Mist API Error:", error.message);
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
    console.error("❌ Map API Error:", error.message);
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
    distance: { pixels: distPx, meters: distM },
    start: { x: fromPx.x, y: fromPx.y },
    end: { x: toPx.x, y: toPx.y },
  };
}

async function resolveVisitorId(idOrCurrent, req) {
  if (idOrCurrent !== "current") return idOrCurrent;
  if (req.user?.visitorId) return req.user.visitorId;
  const recent = await QRModel.findOne({ isOnVisit: true, checkedIn: true })
    .sort({ checkedInAt: -1 })
    .lean();
  return recent ? recent._id.toString() : null;
}

// ============================
// GET VISITOR LOCATION (Direct AP Anchor)
// ============================

exports.getVisitorRoute = async (req, res) => {
  try {
    let { id } = req.params;
    id = await resolveVisitorId(id, req);
    if (!id)
      return res
        .status(404)
        .json({ success: false, message: "No active visitor found" });
    if (!mongoose.Types.ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid visitor ID" });

    const visitor = await QRModel.findById(id);
    if (!visitor)
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });
    if (!visitor.idNumber || visitor.idNumber.trim() === "")
      return res
        .status(404)
        .json({ success: false, message: "No ID assigned" });

    const assets = await fetchAssetLocations();
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
        message: `Asset "${visitor.tagMac || visitor.idNumber}" not found`,
      });
    }

    // ---------- DIRECT AP ANCHOR CALCULATION ----------
    const currentMapId =
      matchedAsset.map_id || "30141417-44ea-4982-993c-6225c9f08315";
    const cfg = MAP_CONFIGS[currentMapId];
    const ppm = cfg?.ppm || 50.07391564392213;

    let assetX = null;
    let assetY = null;
    let primaryDetection = null;

    // The tracker sorts detections by strongest RSSI, so we just loop
    // until we find the strongest one that actually has map coordinates.
    for (const det of matchedAsset.detections || []) {
      if (!primaryDetection) primaryDetection = det; // Keep highest RSSI for telemetry

      const apInfo = AP_MAP.get((det.ap_mac || "").toLowerCase().trim());
      if (!apInfo) continue;

      let apX = null,
        apY = null;
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
        // Use this AP's exact coordinates and stop looping
        assetX = apX;
        assetY = apY;
        break;
      }
    }

    if (assetX === null || assetY === null) {
      return res.status(404).json({
        success: false,
        message: `Asset "${matchedAsset.mac}" has no location data (AP coords missing)`,
      });
    }

    // ---------- FETCH MAP & BUILD ROUTE ----------
    const mapDetails = await fetchMapDetails(currentMapId).catch(() => null);
    const target = TARGETS_BY_MAP[currentMapId] || {
      x: 5625,
      y: 2200,
      label: "Target",
    };

    const route = buildRoute(
      { x: assetX, y: assetY },
      { x: target.x, y: target.y },
      ppm,
    );
    const worldCoords = mapDetails
      ? convertMistToWorld(assetX, assetY, mapDetails)
      : null;

    // ---------- RESPONSE ----------
    res.status(200).json({
      success: true,
      data: {
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
        target_coordinates: { x: target.x, y: target.y, label: target.label },
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
      },
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching location",
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
    res.status(200).json({ success: true, total: assets.length, data: assets });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error", error: error.message });
  }
};

// ============================
// GET MAP DETAILS
// ============================

exports.getMapDetails = async (req, res) => {
  try {
    const { mapId } = req.params;
    if (!mapId)
      return res
        .status(400)
        .json({ success: false, message: "Map ID is required" });
    const mapDetails = await fetchMapDetails(mapId);
    if (!mapDetails)
      return res.status(404).json({ success: false, message: "Map not found" });
    res.status(200).json({ success: true, data: mapDetails });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error", error: error.message });
  }
};

// ============================
// GET VISITOR CABINET
// ============================

exports.getVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid visitor ID" });
    const visitor = await QRModel.findById(id);
    if (!visitor)
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });
    if (!visitor.idNumber || visitor.idNumber.trim() === "")
      return res
        .status(404)
        .json({ success: false, message: "No cabinet assigned" });

    const assets = await fetchAssetLocations();
    const cabinet = assets.find((asset) => {
      const aName = (asset.device_name || asset.name || "").toLowerCase();
      const aMac = (asset.mac || "").toLowerCase();
      return (
        aName === visitor.idNumber.toLowerCase() ||
        aMac === visitor.idNumber.toLowerCase()
      );
    });

    if (!cabinet)
      return res.status(404).json({
        success: false,
        message: `Cabinet "${visitor.idNumber}" not found`,
      });

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
    res
      .status(500)
      .json({ success: false, message: "Error", error: error.message });
  }
};

// ============================
// UPDATE VISITOR CABINET
// ============================

exports.updateVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;
    const { idNumber, assetName } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid visitor ID" });

    const newIdNumber = idNumber || assetName;
    if (!newIdNumber)
      return res
        .status(400)
        .json({ success: false, message: "idNumber or assetName is required" });

    const visitor = await QRModel.findById(id);
    if (!visitor)
      return res
        .status(404)
        .json({ success: false, message: "Visitor not found" });

    visitor.idNumber = newIdNumber;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Cabinet updated successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        idNumber: visitor.idNumber,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error", error: error.message });
  }
};

// ============================================================
// LEGACY STUBS
// ============================================================

exports.getWayfindingPath = async (req, res) => {
  res.status(200).json({
    success: true,
    message: "Wayfinding disabled",
    data: { map_id: req.params.mapId, nodes: [], edges: {} },
  });
};

exports.getNavigationRoute = async (req, res) => {
  res
    .status(200)
    .json({ success: true, message: "Route disabled", data: null });
};

exports.testCoordinateConversion = async (req, res) => {
  res.status(200).json({
    success: true,
    message: "Coordinate conversion disabled",
    data: null,
  });
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
    res
      .status(200)
      .json({ success: true, total: Object.keys(states).length, data: states });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.resetAssetTracking = async (req, res) => {
  try {
    const { mac } = req.params;
    if (mac && typeof AssetTracker.resetAsset === "function")
      AssetTracker.resetAsset(mac);
    res.status(200).json({ success: true, message: `Reset requested` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================
// EXPORTS
// ============================

module.exports = {
  getVisitorRoute: exports.getVisitorRoute,
  getAllAssetLocations: exports.getAllAssetLocations,
  getMapDetails: exports.getMapDetails,
  getVisitorCabinet: exports.getVisitorCabinet,
  updateVisitorCabinet: exports.updateVisitorCabinet,
  getWayfindingPath: exports.getWayfindingPath,
  getNavigationRoute: exports.getNavigationRoute,
  testCoordinateConversion: exports.testCoordinateConversion,
  getAssetTrackingState: exports.getAssetTrackingState,
  resetAssetTracking: exports.resetAssetTracking,
};
c;
