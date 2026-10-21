// controllers/location.controller.js
const QRModel = require("../models/User/IdVisitorQR.model");
const axios = require("axios");
const mongoose = require("mongoose");
const AssetTracker = require("../services/mistAssetTracker");

// ============================
// MIST API CONFIGURATION
// ============================
const MIST_API_TOKEN = process.env.MIST_API_TOKEN;
const MIST_SITE_ID = process.env.MIST_SITE_ID;
const MIST_API_BASE = "https://api.mist.com/api/v1";

if (!MIST_API_TOKEN)
  throw new Error("MIST_API_TOKEN environment variable required");
if (!MIST_SITE_ID)
  throw new Error("MIST_SITE_ID environment variable required");

// ============================
// MAP CONFIGURATIONS
// ============================
// ppm  = pixels per meter
// origin_x / origin_y = pixel of map origin (0,0 world)
// lat0 / lng0 = geographic coordinate of that origin (OPTIONAL — see convertMapMetersToLatLng)
// north_rotation_deg = how the map image is rotated vs true north (OPTIONAL)
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

    // OPTIONAL — fill these in when you know the geo-anchor of the map.
    // If left null, lat/lng will be null in responses (indoor-only mode).
    lat0: null,
    lng0: null,
    north_rotation_deg: 0,
  },
};

// Beam index → degrees
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

const DEFAULT_MAP_ID =
  process.env.DEFAULT_MIST_MAP_ID || "30141417-44ea-4982-993c-6225c9f08315";

// Destination (default target point — keep your existing values)
const DEFAULT_TARGET_X = 5625.298750495607;
const DEFAULT_TARGET_Y = 2200.837930104785;

// ============================
// MIST API HELPERS
// ============================
const getMistHeaders = () => ({
  Authorization: `Token ${MIST_API_TOKEN}`,
  "Content-Type": "application/json",
});

// Safe fetch — never throws, always returns array or []
async function fetchAssetLocations() {
  try {
    // Prefer cache
    const cached = AssetTracker.getCachedAssets?.();
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
    // Fall back to fresh fetch (which internally caches)
    if (typeof AssetTracker.getAssets === "function") {
      const fresh = await AssetTracker.getAssets();
      if (Array.isArray(fresh)) return fresh;
    }
    return [];
  } catch (err) {
    console.error("❌ AssetTracker fetch failed:", err.message);
    // Last resort: direct call
    try {
      const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/assets`;
      const res = await axios.get(url, {
        headers: getMistHeaders(),
        timeout: 10000,
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch (err2) {
      console.error("❌ Direct Mist fallback failed:", err2.message);
      return [];
    }
  }
}

async function fetchMapDetails(mapId) {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/maps/${mapId}`;
    const res = await axios.get(url, {
      headers: getMistHeaders(),
      timeout: 10000,
    });
    const d = res.data;
    return {
      id: d.id,
      name: d.name,
      width: d.width,
      height: d.height,
      ppm: d.ppm,
      origin_x: d.origin_x,
      origin_y: d.origin_y,
      orientation: d.orientation,
      width_m: d.width_m,
      height_m: d.height_m,
      site_id: d.site_id,
      org_id: d.org_id,
      url: d.url,
      thumbnail_url: d.thumbnail_url,
      wayfinding_path: d.wayfinding_path || null,
      wall_path: d.wall_path || null,
    };
  } catch (err) {
    console.error(
      `❌ fetchMapDetails(${mapId}) failed:`,
      err.response?.status,
      err.message,
    );
    return null;
  }
}

async function fetchWayfindingPath(mapId) {
  const mapDetails = await fetchMapDetails(mapId);
  if (!mapDetails || !mapDetails.wayfinding_path) return null;

  const wf = mapDetails.wayfinding_path;
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) return null;

  const nodes = wf.nodes.map((node) => {
    let edges = node.edges || {};
    if (edges && typeof edges === "object" && !Array.isArray(edges)) {
      const e = {};
      Object.keys(edges).forEach((k) => {
        e[k] = { weight: parseInt(edges[k], 10) || 1 };
      });
      edges = e;
    }
    return { ...node, edges };
  });

  const edges = {};
  nodes.forEach((n) => {
    edges[n.name] = n.edges || {};
  });

  return { nodes, edges };
}

// ============================
// WAYFINDING HELPERS
// ============================
function findNearestNode(wayfindingPath, x, y) {
  if (!wayfindingPath?.nodes?.length) return null;
  let nearest = null;
  let minD = Infinity;
  for (const node of wayfindingPath.nodes) {
    if (node.position?.x === undefined || node.position?.y === undefined)
      continue;
    const dx = node.position.x - x;
    const dy = node.position.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < minD) {
      minD = d;
      nearest = node;
    }
  }
  if (!nearest) return null;
  return { node: nearest, distance: minD, isOnPath: minD < 1000 };
}

function findRoute(wayfindingPath, startName, destName) {
  if (!wayfindingPath?.nodes || !wayfindingPath?.edges) return null;
  const adj = {};
  wayfindingPath.nodes.forEach((n) => (adj[n.name] = []));
  Object.keys(wayfindingPath.edges).forEach((src) => {
    const e = wayfindingPath.edges[src];
    if (e && typeof e === "object") {
      Object.keys(e).forEach((tgt) => {
        if (adj[src]) adj[src].push(tgt);
      });
    }
  });

  const queue = [[startName]];
  const visited = new Set([startName]);
  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];
    if (cur === destName) {
      const nodes = path
        .map((n) => wayfindingPath.nodes.find((x) => x.name === n))
        .filter(Boolean);
      return { path, nodes, segments: path.length - 1 };
    }
    for (const nb of adj[cur] || []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([...path, nb]);
      }
    }
  }
  return null;
}

// ============================
// COORDINATE HELPERS
// ============================
// Mist pixel → map-local meters
function convertMistToWorld(pixelX, pixelY, mapData) {
  if (!mapData || !mapData.ppm || mapData.origin_x === undefined) return null;
  const { origin_x, origin_y, ppm } = mapData;
  return {
    x: (pixelX - origin_x) / ppm, // east, meters
    z: -(pixelY - origin_y) / ppm, // north, meters (Y flipped)
    y: 0.1, // height, meters
  };
}

// Map-local meters → WGS84 lat/lng (only if the map has lat0/lng0).
function convertMapMetersToLatLng(xMeters, zMeters, cfg) {
  if (!cfg || cfg.lat0 == null || cfg.lng0 == null) return null;
  const rad = ((cfg.north_rotation_deg || 0) * Math.PI) / 180;
  const east = xMeters * Math.cos(rad) - zMeters * Math.sin(rad);
  const north = xMeters * Math.sin(rad) + zMeters * Math.cos(rad);

  const mPerDegLat = 110540;
  const mPerDegLng = 111320 * Math.cos((cfg.lat0 * Math.PI) / 180);

  return {
    lat: cfg.lat0 + north / mPerDegLat,
    lng: cfg.lng0 + east / mPerDegLng,
  };
}

// ============================
// ASSET NORMALIZATION (the fix)
// ============================
// Your RAW AssetTracker emits { mac, device_name, map_id, detections,
//   ap_mac, ap_name, rssi, beam, radius }.
// This function reads x/y from ANY of the shapes the controller might
// receive (raw mode, shimmed mode, or direct Mist API response).
function extractAssetPosition(asset) {
  // 1) shimmed tracker shape
  if (asset.position?.x !== undefined && asset.position?.y !== undefined) {
    return {
      x: asset.position.x,
      y: asset.position.y,
      source: "position",
      map_id: asset.map_id || asset.position.map_id,
    };
  }
  // 2) tracker top-level x/y
  if (asset.x !== undefined && asset.y !== undefined) {
    return {
      x: asset.x,
      y: asset.y,
      source: "top-level",
      map_id: asset.map_id,
    };
  }
  // 3) raw Mist detection inside asset.raw
  if (asset.raw?.x !== undefined && asset.raw?.y !== undefined) {
    return {
      x: asset.raw.x,
      y: asset.raw.y,
      source: "raw",
      map_id: asset.raw.map_id || asset.map_id,
    };
  }
  // 4) strongest detection in detections[]  ← the RAW-MODE path
  if (Array.isArray(asset.detections) && asset.detections.length > 0) {
    const sorted = [...asset.detections].sort(
      (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
    );
    const best = sorted[0];
    if (best.x !== undefined && best.y !== undefined) {
      return {
        x: best.x,
        y: best.y,
        source: "detections[0]",
        map_id: best.map_id || asset.map_id,
        detection: best,
      };
    }
  }
  return null;
}

// Find the detection that matches the asset (best RSSI)
function pickPrimaryDetection(asset) {
  if (Array.isArray(asset.detections) && asset.detections.length > 0) {
    const sorted = [...asset.detections].sort(
      (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
    );
    return sorted[0];
  }
  return asset.raw || asset;
}

// ============================
// ASYNC WRAPPER (prevents 500 / crash from async throws)
// ============================
const catchAsync = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ============================
// GET VISITOR ROUTE
// ============================
exports.getVisitorRoute = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { includePath = "true" } = req.query;

  console.log("📍 getVisitorRoute:", id);

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid visitor ID format" });
  }

  const visitor = await QRModel.findById(id);
  if (!visitor) {
    return res
      .status(404)
      .json({ success: false, message: "Visitor not found" });
  }

  // Resolve target identity
  const targetMac = (
    visitor.tagMac ||
    visitor.mistMacAddress ||
    visitor.tagId?.macAddress ||
    ""
  )
    .toLowerCase()
    .trim();
  const targetIdNumber = (visitor.idNumber || "").toLowerCase().trim();
  const targetNickname = (visitor.tagNickname || "").toLowerCase().trim();

  if (!targetMac && !targetIdNumber && !targetNickname) {
    return res.status(404).json({
      success: false,
      message: "No ID/asset assigned to this visitor.",
    });
  }

  const assets = await fetchAssetLocations();
  const assetNames = assets
    .map((a) => a.device_name || a.raw?.name || a.mac)
    .filter(Boolean);

  const matchedAsset = assets.find((a) => {
    const aMac = (a.mac || a.raw?.mac || "").toLowerCase().trim();
    const aName = (a.device_name || a.name || a.raw?.name || "")
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
      message: `Asset "${targetMac || visitor.idNumber}" not found in Mist system`,
      available_assets: assetNames,
    });
  }

  // ✅ Position extraction — works for RAW MODE too
  const pos = extractAssetPosition(matchedAsset);
  if (!pos) {
    return res.status(404).json({
      success: false,
      message: `Asset "${matchedAsset.mac}" has no location data in Mist response`,
      data: {
        mac: matchedAsset.mac,
        has_location: false,
        detections_count: matchedAsset.detections?.length || 0,
      },
    });
  }

  const assetX = pos.x;
  const assetY = pos.y;
  const currentMapId =
    pos.map_id ||
    matchedAsset.map_id ||
    matchedAsset.detections?.[0]?.map_id ||
    DEFAULT_MAP_ID;

  // Map details + wayfinding
  let mapDetails = null;
  let wayfindingPath = null;
  let nearestNode = null;
  let routeToDestination = null;

  try {
    mapDetails = await fetchMapDetails(currentMapId);
  } catch (err) {
    console.warn("⚠️ fetchMapDetails failed:", err.message);
  }

  const cfg = MAP_CONFIGS[currentMapId] ||
    MAP_CONFIGS[DEFAULT_MAP_ID] || { ppm: 50.07391564392213 };
  const ppm = cfg.ppm || mapDetails?.ppm || 50.07391564392213;

  const targetX = DEFAULT_TARGET_X;
  const targetY = DEFAULT_TARGET_Y;

  if (includePath === "true") {
    try {
      wayfindingPath = await fetchWayfindingPath(currentMapId);
      if (wayfindingPath?.nodes?.length) {
        nearestNode = findNearestNode(wayfindingPath, assetX, assetY);
        const destNode = findNearestNode(wayfindingPath, targetX, targetY);
        if (nearestNode?.node && destNode?.node) {
          routeToDestination = findRoute(
            wayfindingPath,
            nearestNode.node.name,
            destNode.node.name,
          );
        }
      }
    } catch (err) {
      console.warn("⚠️ wayfinding failed:", err.message);
    }
  }

  // Distance
  const distancePixels = Math.sqrt(
    (assetX - targetX) ** 2 + (assetY - targetY) ** 2,
  );
  const distanceMeters = distancePixels / ppm;

  const proximity =
    distanceMeters < 2
      ? "Very Close"
      : distanceMeters < 5
        ? "Close"
        : distanceMeters < 10
          ? "Moderate"
          : distanceMeters < 20
            ? "Medium"
            : "Far";

  // World coords
  const worldCoordinates = convertMistToWorld(assetX, assetY, {
    origin_x: cfg.origin_x ?? mapDetails?.origin_x ?? 0,
    origin_y: cfg.origin_y ?? mapDetails?.origin_y ?? 0,
    ppm,
  });

  // Geographic lat/lng (null unless map has lat0/lng0)
  const latLng = worldCoordinates
    ? convertMapMetersToLatLng(worldCoordinates.x, worldCoordinates.z, cfg)
    : null;

  // Detection / RF info
  const primaryDet = pickPrimaryDetection(matchedAsset);
  const beamRaw = primaryDet?.beam ?? matchedAsset.beam ?? null;
  const beamAngle = beamRaw !== null ? (BEAM_ANGLES[beamRaw] ?? null) : null;
  const rssi = primaryDet?.rssi ?? matchedAsset.rssi ?? null;
  const lastSeen =
    primaryDet?.last_seen ||
    matchedAsset.last_seen ||
    visitor.lastLocationSync ||
    null;

  // Response
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
      // Mist pixel coordinates
      x: assetX,
      y: assetY,
      pixel_coordinates: { x: assetX, y: assetY },

      // Geo coordinates (may be null if map has no anchor)
      lat: latLng?.lat ?? null,
      lng: latLng?.lng ?? null,

      // Map-local meters
      world_coordinates: worldCoordinates,

      // Identity + RF
      mac: matchedAsset.mac,
      name: matchedAsset.device_name || matchedAsset.name || matchedAsset.mac,
      device_name: matchedAsset.device_name,
      map_id: currentMapId,
      ap_mac: primaryDet?.ap_mac || matchedAsset.ap_mac || null,
      ap_name: matchedAsset.ap_name || null,
      rssi,
      beam: beamRaw,
      beam_angle: beamAngle,
      last_seen: lastSeen,

      // uncertainty bubble (added by AssetTracker)
      radius: matchedAsset.radius ?? null,

      // source for debugging
      position_source: pos.source,
      detections_count: matchedAsset.detections?.length || 0,
    },
    map: mapDetails
      ? {
          id: mapDetails.id,
          name: mapDetails.name,
          width: mapDetails.width,
          height: mapDetails.height,
          ppm,
          origin_x: mapDetails.origin_x,
          origin_y: mapDetails.origin_y,
          width_m: mapDetails.width_m,
          height_m: mapDetails.height_m,
        }
      : {
          id: currentMapId,
          ppm,
          origin_x: cfg.origin_x,
          origin_y: cfg.origin_y,
          width_m: cfg.width_m,
          height_m: cfg.height_m,
          name: cfg.name,
        },
    target_coordinates: {
      x: targetX,
      y: targetY,
      x_m: targetX / ppm,
      y_m: targetY / ppm,
    },
    distance: { pixels: distancePixels, meters: distanceMeters },
    proximity,
    timestamp: new Date().toISOString(),
  };

  if (wayfindingPath && includePath === "true") {
    locationData.wayfinding = {
      total_nodes: wayfindingPath.nodes.length,
      total_edges: Object.keys(wayfindingPath.edges || {}).length,
      nearest_node: nearestNode
        ? {
            name: nearestNode.node.name,
            position: nearestNode.node.position,
            distance_pixels: nearestNode.distance,
            is_on_path: nearestNode.isOnPath,
          }
        : null,
      route_to_destination: routeToDestination
        ? {
            path: routeToDestination.path,
            segments: routeToDestination.segments,
            nodes: routeToDestination.nodes.map((n) => ({
              name: n.name,
              position: n.position,
            })),
          }
        : null,
      nodes: wayfindingPath.nodes.map((n) => ({
        name: n.name,
        position: n.position,
        edges: n.edges || {},
        worldPosition: mapDetails
          ? convertMistToWorld(n.position.x, n.position.y, mapDetails)
          : null,
      })),
      edges: wayfindingPath.edges,
    };
  }

  res.status(200).json({
    success: true,
    message: "Visitor location retrieved successfully",
    data: locationData,
  });
});

// ============================
// GET ALL ASSET LOCATIONS
// ============================
exports.getAllAssetLocations = catchAsync(async (req, res) => {
  const assets = await fetchAssetLocations();

  const formatted = assets.map((asset) => {
    const pos = extractAssetPosition(asset);
    const primaryDet = pickPrimaryDetection(asset);
    const mapId = pos?.map_id || asset.map_id || DEFAULT_MAP_ID;
    const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS[DEFAULT_MAP_ID];
    const ppm = cfg?.ppm || 50.07391564392213;

    const world =
      pos && cfg
        ? convertMistToWorld(pos.x, pos.y, {
            origin_x: cfg.origin_x,
            origin_y: cfg.origin_y,
            ppm,
          })
        : null;

    const latLng = world
      ? convertMapMetersToLatLng(world.x, world.z, cfg)
      : null;

    return {
      mac: asset.mac,
      device_name: asset.device_name || asset.name || asset.mac,
      map_id: mapId,
      x: pos?.x ?? null,
      y: pos?.y ?? null,
      lat: latLng?.lat ?? null,
      lng: latLng?.lng ?? null,
      world_coordinates: world,
      radius: asset.radius ?? null,
      rssi: primaryDet?.rssi ?? asset.rssi ?? null,
      beam: primaryDet?.beam ?? asset.beam ?? null,
      ap_mac: primaryDet?.ap_mac || asset.ap_mac || null,
      ap_name: asset.ap_name || null,
      last_seen: primaryDet?.last_seen || asset.last_seen || null,
      detections_count: asset.detections?.length || 0,
      detections: asset.detections || [], // pass through — no math
    };
  });

  res.status(200).json({
    success: true,
    total: formatted.length,
    data: formatted,
  });
});

// ============================
// GET MAP DETAILS
// ============================
exports.getMapDetails = catchAsync(async (req, res) => {
  const { mapId } = req.params;
  if (!mapId) {
    return res
      .status(400)
      .json({ success: false, message: "Map ID is required" });
  }
  const details = await fetchMapDetails(mapId);
  if (!details) {
    return res.status(404).json({ success: false, message: "Map not found" });
  }
  res.status(200).json({ success: true, data: details });
});

// ============================
// GET WAYFINDING PATH
// ============================
exports.getWayfindingPath = catchAsync(async (req, res) => {
  const { mapId } = req.params;
  if (!mapId) {
    return res
      .status(400)
      .json({ success: false, message: "Map ID is required" });
  }
  const details = await fetchMapDetails(mapId);
  if (!details) {
    return res.status(404).json({ success: false, message: "Map not found" });
  }
  const wf = await fetchWayfindingPath(mapId);
  if (!wf?.nodes?.length) {
    return res.status(404).json({
      success: false,
      message: "Wayfinding path not found for this map",
      debug: { mapId, hasWayfinding: !!wf },
    });
  }
  const nodes = wf.nodes.map((n) => ({
    ...n,
    worldPosition: convertMistToWorld(n.position.x, n.position.y, details),
  }));
  res.status(200).json({
    success: true,
    data: {
      nodes,
      edges: wf.edges,
      map: {
        id: details.id,
        name: details.name,
        ppm: details.ppm,
        origin_x: details.origin_x,
        origin_y: details.origin_y,
        width: details.width,
        height: details.height,
      },
      total_nodes: nodes.length,
      total_edges: Object.keys(wf.edges).length,
    },
  });
});

// ============================
// GET NAVIGATION ROUTE
// ============================
exports.getNavigationRoute = catchAsync(async (req, res) => {
  const { mapId } = req.params;
  const { fromX, fromY, toX, toY } = req.query;

  if (!mapId) {
    return res
      .status(400)
      .json({ success: false, message: "Map ID is required" });
  }
  if (!fromX || !fromY || !toX || !toY) {
    return res.status(400).json({
      success: false,
      message: "fromX, fromY, toX, toY are required",
    });
  }

  const mapDetails = await fetchMapDetails(mapId);
  const wf = await fetchWayfindingPath(mapId);
  if (!wf?.nodes?.length) {
    return res
      .status(404)
      .json({ success: false, message: "No wayfinding path for this map" });
  }

  const start = findNearestNode(wf, parseFloat(fromX), parseFloat(fromY));
  const end = findNearestNode(wf, parseFloat(toX), parseFloat(toY));
  if (!start?.node) {
    return res
      .status(404)
      .json({ success: false, message: "No start node near fromX/fromY" });
  }
  if (!end?.node) {
    return res
      .status(404)
      .json({ success: false, message: "No end node near toX/toY" });
  }

  const route = findRoute(wf, start.node.name, end.node.name);
  if (!route) {
    return res.status(404).json({ success: false, message: "No route found" });
  }

  res.status(200).json({
    success: true,
    data: {
      start: {
        position: { x: parseFloat(fromX), y: parseFloat(fromY) },
        nearest_node: {
          name: start.node.name,
          position: start.node.position,
          distance: start.distance,
        },
      },
      end: {
        position: { x: parseFloat(toX), y: parseFloat(toY) },
        nearest_node: {
          name: end.node.name,
          position: end.node.position,
          distance: end.distance,
        },
      },
      route: {
        ...route,
        nodes: route.nodes.map((n) => ({
          ...n,
          worldPosition: mapDetails
            ? convertMistToWorld(n.position.x, n.position.y, mapDetails)
            : null,
        })),
      },
      total_segments: route.segments,
      total_nodes: route.path.length,
      map: mapDetails
        ? { id: mapDetails.id, name: mapDetails.name, ppm: mapDetails.ppm }
        : null,
    },
  });
});

// ============================
// GET VISITOR CABINET
// ============================
exports.getVisitorCabinet = catchAsync(async (req, res) => {
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
  if (!visitor.idNumber?.trim()) {
    return res
      .status(404)
      .json({ success: false, message: "No cabinet assigned" });
  }

  const assets = await fetchAssetLocations();
  const cabinet = assets.find((a) => {
    const name = (a.device_name || a.name || a.raw?.name || "").toLowerCase();
    const mac = (a.mac || "").toLowerCase();
    const target = visitor.idNumber.toLowerCase();
    return name === target || mac === target;
  });

  if (!cabinet) {
    return res.status(404).json({
      success: false,
      message: `Cabinet "${visitor.idNumber}" not found in Mist`,
      available_assets: assets
        .map((a) => a.device_name || a.name)
        .filter(Boolean),
    });
  }

  const pos = extractAssetPosition(cabinet);
  res.status(200).json({
    success: true,
    data: {
      visitor: {
        id: visitor._id,
        name: visitor.visitorName,
        company: visitor.company,
      },
      cabinet: {
        mac: cabinet.mac,
        name: cabinet.device_name || cabinet.mac,
        x: pos?.x ?? null,
        y: pos?.y ?? null,
        map_id: pos?.map_id || cabinet.map_id,
        radius: cabinet.radius ?? null,
      },
    },
  });
});

// ============================
// UPDATE VISITOR CABINET
// ============================
exports.updateVisitorCabinet = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { idNumber, assetName } = req.body;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid visitor ID" });
  }
  if (!idNumber && !assetName) {
    return res.status(400).json({
      success: false,
      message: "idNumber or assetName is required",
    });
  }
  const visitor = await QRModel.findById(id);
  if (!visitor) {
    return res
      .status(404)
      .json({ success: false, message: "Visitor not found" });
  }

  visitor.idNumber = idNumber || assetName;
  await visitor.save();
  res.status(200).json({
    success: true,
    data: {
      id: visitor._id,
      visitorName: visitor.visitorName,
      idNumber: visitor.idNumber,
    },
  });
});

// ============================
// TEST COORDINATE CONVERSION
// ============================
exports.testCoordinateConversion = catchAsync(async (req, res) => {
  const { mapId } = req.params;
  const { x, y } = req.query;
  if (!mapId) {
    return res
      .status(400)
      .json({ success: false, message: "Map ID is required" });
  }
  if (!x || !y) {
    return res
      .status(400)
      .json({ success: false, message: "x and y are required" });
  }
  const mapData = await fetchMapDetails(mapId);
  if (!mapData) {
    return res.status(404).json({ success: false, message: "Map not found" });
  }
  const world = convertMistToWorld(parseFloat(x), parseFloat(y), mapData);
  const cfg = MAP_CONFIGS[mapId] || MAP_CONFIGS[DEFAULT_MAP_ID];
  const latLng = world ? convertMapMetersToLatLng(world.x, world.z, cfg) : null;
  res.json({
    success: true,
    data: {
      pixel: { x: parseFloat(x), y: parseFloat(y) },
      world,
      latLng,
      map: {
        id: mapData.id,
        ppm: mapData.ppm,
        origin_x: mapData.origin_x,
        origin_y: mapData.origin_y,
      },
    },
  });
});

// ============================
// ASSET TRACKING STATE (stub — safe)
// ============================
exports.getAssetTrackingState = catchAsync(async (req, res) => {
  // AssetTracker in RAW MODE no longer exposes getAssetStates().
  // Return cached assets instead, formatted for the frontend.
  const assets = AssetTracker.getCachedAssets?.() || [];
  const formatted = {};
  for (const a of assets) {
    formatted[a.mac] = {
      device_name: a.device_name,
      position: extractAssetPosition(a),
      rssi: a.rssi,
      beam: a.beam,
      radius: a.radius ?? null,
      detections_count: a.detections?.length || 0,
    };
  }
  res.status(200).json({
    success: true,
    total: Object.keys(formatted).length,
    data: formatted,
  });
});

// ============================
// RESET ASSET TRACKING (stub — safe)
// ============================
exports.resetAssetTracking = catchAsync(async (req, res) => {
  // No-op — AssetTracker RAW MODE has no per-asset state to reset.
  // Kept as a route so the frontend doesn't 404.
  res.status(200).json({
    success: true,
    message: `No-op (raw mode). Cache will refresh on next Mist poll.`,
  });
});

module.exports = {
  getVisitorRoute: exports.getVisitorRoute,
  getWayfindingPath: exports.getWayfindingPath,
  getNavigationRoute: exports.getNavigationRoute,
  getAllAssetLocations: exports.getAllAssetLocations,
  getMapDetails: exports.getMapDetails,
  getVisitorCabinet: exports.getVisitorCabinet,
  updateVisitorCabinet: exports.updateVisitorCabinet,
  testCoordinateConversion: exports.testCoordinateConversion,
  getAssetTrackingState: exports.getAssetTrackingState,
  resetAssetTracking: exports.resetAssetTracking,
};
