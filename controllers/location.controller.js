// controllers/location.controller.js
const QRModel = require("../models/User/IdVisitorQR.model");
const axios = require("axios");
const mongoose = require("mongoose");
const AssetTracker = require("../services/mistAssetTracker");

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
    origin_x: 306.45106507695385,
    origin_y: 3856.483584010582,
    ppm: 50.07391564392213,
  },
  "cfa55e13-794f-4081-b1b7-e35f1ea67325": {
    name: "MB3-F01",
    width: 6400,
    height: 5120,
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
// MIST API HELPERS
// ============================

const getMistHeaders = () => ({
  Authorization: `Token ${MIST_API_TOKEN}`,
  "Content-Type": "application/json",
});

// SAFE FETCHER: Uses Tracker cache to prevent 429s
const fetchAssetLocations = async () => {
  try {
    // 1. Try to get from background tracker cache
    let assets = AssetTracker.getCachedAssets();
    if (assets && assets.length > 0) {
      return assets;
    }

    // 2. Cache empty? Tell tracker to do a safe fetch (has built-in backoff)
    console.log("⚠️ Asset cache empty, asking tracker to fetch safely...");
    assets = await AssetTracker.getAssets();
    if (assets && assets.length > 0) {
      return assets;
    }

    // 3. If tracker returns empty, hit Mist API directly as a last resort
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/assets`;
    const response = await axios.get(url, {
      headers: getMistHeaders(),
      timeout: 5000,
    });
    const rawAssets = response.data;

    // Group them so the rest of the controller doesn't break
    const assetGroups = new Map();
    for (const a of rawAssets) {
      if (!a.mac) continue;
      let group = assetGroups.get(a.mac);
      if (!group) {
        group = [];
        assetGroups.set(a.mac, group);
      }
      group.push(a);
    }

    const processed = [];
    for (const [mac, detections] of assetGroups) {
      detections.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      const primary = detections[0];
      processed.push({
        mac: mac,
        device_name: primary.name || primary.device_name || "Unknown",
        map_id: primary.map_id,
        detections: detections,
        ap_mac: primary.ap_mac,
        rssi: primary.rssi,
        beam: primary.beam,
      });
    }
    return processed;
  } catch (error) {
    console.error("❌ Mist Fetch Error:", error.message);
    // If it's a 429, try to just return whatever is in the cache (even if empty)
    return AssetTracker.getCachedAssets() || [];
  }
};

// Fetch live AP coordinates directly from Mist API (cached by Mist for 60s)
const fetchMistAPs = async (mapId) => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/maps/${mapId}/discovered_aps`;
    const response = await axios.get(url, {
      headers: getMistHeaders(),
      timeout: 5000,
    });
    const apMap = new Map();
    for (const ap of response.data) {
      if (ap.mac) apMap.set(ap.mac.toLowerCase().trim(), ap);
    }
    return apMap;
  } catch (error) {
    console.warn(
      `⚠️ Failed to fetch live APs from Mist (using fallback):`,
      error.message,
    );
    return new Map();
  }
};

const fetchMapDetails = async (mapId) => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/maps/${mapId}`;
    const response = await axios.get(url, {
      headers: getMistHeaders(),
      timeout: 5000,
    });
    return response.data;
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
  return {
    x: (pixelX - mapData.origin_x) / mapData.ppm,
    z: -(pixelY - mapData.origin_y) / mapData.ppm,
    y: 0.1,
  };
};

function buildRoute(fromPx, toPx, ppm = 50.07391564392213) {
  if (!fromPx || !toPx) return null;
  const distPx = Math.hypot(toPx.x - fromPx.x, toPx.y - fromPx.y);
  return {
    nodes: [
      { name: "TAG", position: { x: fromPx.x, y: fromPx.y } },
      { name: "TARGET", position: { x: toPx.x, y: toPx.y } },
    ],
    path: ["TAG", "TARGET"],
    segments: 1,
    distance: { pixels: distPx, meters: distPx / ppm },
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
// GET VISITOR LOCATION
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

    // 1. Fetch safely
    const assets = await fetchAssetLocations();
    const assetNames = assets
      .map((a) => a.mac || a.device_name)
      .filter(Boolean);

    if (assetNames.length === 0) {
      return res.status(429).json({
        success: false,
        message: "Rate limited by Mist API. Please wait a few minutes.",
        error: "No assets available in cache and Mist API returned 429.",
      });
    }

    console.log(
      "📋 Available Assets (Cached from Mist):",
      assetNames.join(", "),
    );

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
      const detName = (asset.detections?.[0]?.name || "").toLowerCase().trim();

      return (
        (targetMac && aMac === targetMac) ||
        (targetIdNumber &&
          (aName === targetIdNumber ||
            aMac === targetIdNumber ||
            detName === targetIdNumber)) ||
        (targetNickname &&
          (aName === targetNickname || detName === targetNickname))
      );
    });

    if (!matchedAsset) {
      return res.status(404).json({
        success: false,
        message: `Asset "${visitor.tagMac || visitor.idNumber}" not found in Mist system`,
        available_assets: assetNames,
      });
    }

    // 2. Fetch live APs
    const currentMapId =
      matchedAsset.map_id || "30141417-44ea-4982-993c-6225c9f08315";
    const cfg =
      MAP_CONFIGS[currentMapId] ||
      MAP_CONFIGS["30141417-44ea-4982-993c-6225c9f08315"];
    const ppm = cfg.ppm;

    const mistAPs = await fetchMistAPs(currentMapId);

    // 3. Centroid Calculation
    let sumX = 0,
      sumY = 0,
      sumW = 0;
    let primaryDetection = null;

    for (const det of matchedAsset.detections || []) {
      if (
        det.ap_mac &&
        (primaryDetection === null || det.rssi > primaryDetection.rssi)
      ) {
        primaryDetection = det;
      }

      const apInfo = mistAPs.get((det.ap_mac || "").toLowerCase().trim());
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
        const weight = Math.max(1, (det.rssi ?? -100) + 100);
        sumX += apX * weight;
        sumY += apY * weight;
        sumW += weight;
      }
    }

    let assetX = null,
      assetY = null;

    if (sumW > 0) {
      assetX = sumX / sumW;
      assetY = sumY / sumW;
    } else {
      const primaryAp = mistAPs.get(
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
        message: `Asset "${matchedAsset.mac}" has no location data`,
      });
    }

    // 4. Build Route
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

    // 5. Return Response
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
        map: mapDetails,
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
exports.getWayfindingPath = async (req, res) =>
  res.status(200).json({
    success: true,
    message: "Wayfinding disabled",
    data: { map_id: req.params.mapId, nodes: [], edges: {} },
  });
exports.getNavigationRoute = async (req, res) =>
  res
    .status(200)
    .json({ success: true, message: "Route disabled", data: null });
exports.testCoordinateConversion = async (req, res) =>
  res.status(200).json({
    success: true,
    message: "Coordinate conversion disabled",
    data: null,
  });
exports.getAssetTrackingState = async (req, res) => {
  try {
    const assets = await fetchAssetLocations();
    const states = {};
    for (const a of assets)
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
    res
      .status(200)
      .json({ success: true, total: Object.keys(states).length, data: states });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
exports.resetAssetTracking = async (req, res) => {
  try {
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
