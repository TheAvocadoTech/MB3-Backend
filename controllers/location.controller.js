// controllers/location.controller.js
const QRModel = require("../models/User/IdVisitorQR.model");
const axios = require("axios");
const mongoose = require("mongoose");

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
// MIST API HELPERS
// ============================

const getMistHeaders = () => ({
  Authorization: `Token ${MIST_API_TOKEN}`,
  "Content-Type": "application/json",
});

const fetchAssetLocations = async () => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/assets`;
    console.log("📡 Fetching assets from Mist API:", url);
    const response = await axios.get(url, {
      headers: getMistHeaders(),
    });
    console.log(`✅ Found ${response.data.length} assets`);
    return response.data;
  } catch (error) {
    console.error("❌ Mist API Error:", error.response?.data || error.message);
    throw error;
  }
};

// ============================
// FIXED: WAYFINDING PATH HELPERS
// ============================
const fetchMapDetails = async (mapId) => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/maps/${mapId}`;
    console.log(`🗺️ Fetching map details for ${mapId}:`, url);
    const response = await axios.get(url, {
      headers: getMistHeaders(),
    });

    const data = response.data;

    console.log("📋 Map details received:", {
      id: data.id,
      name: data.name,
      ppm: data.ppm,
      origin_x: data.origin_x,
      origin_y: data.origin_y,
      width: data.width,
      height: data.height,
      hasWayfinding: !!data.wayfinding_path,
      nodesCount: data.wayfinding_path?.nodes?.length || 0,
    });

    // Return ALL map data including wayfinding_path
    return {
      id: data.id,
      name: data.name,
      width: data.width,
      height: data.height,
      ppm: data.ppm,
      origin_x: data.origin_x,
      origin_y: data.origin_y,
      orientation: data.orientation,
      created_time: data.created_time,
      modified_time: data.modified_time,
      type: data.type,
      width_m: data.width_m,
      height_m: data.height_m,
      site_id: data.site_id,
      org_id: data.org_id,
      url: data.url,
      thumbnail_url: data.thumbnail_url,
      mapstack_id: data.mapstack_id,
      mapstack_floor: data.mapstack_floor,
      // CRITICAL: Include wayfinding_path from the map details
      wayfinding_path: data.wayfinding_path || null,
      wall_path: data.wall_path || null,
    };
  } catch (error) {
    console.error("❌ Map API Error:", error.response?.data || error.message);
    return null;
  }
};
/**
 * Fetch wayfinding path for a specific map
 * Handles different response formats from Mist API
 */
// controllers/location.controller.js

/**
 * Fetch wayfinding path for a specific map
 * Handles different response formats from Mist API
 */
// fetchWayfindingPath;
// controllers/location.controller.js

/**
 * Fetch wayfinding path for a specific map
 * Extracts from map details since Mist includes wayfinding_path in the map response
 */
const fetchWayfindingPath = async (mapId) => {
  try {
    // Fetch map details (which now includes wayfinding_path)
    const mapDetails = await fetchMapDetails(mapId);

    if (!mapDetails) {
      console.log(`❌ Map ${mapId} not found`);
      return null;
    }

    console.log(`🗺️ Checking map ${mapId} for wayfinding data...`);

    // Check if wayfinding_path exists in the map details
    if (!mapDetails.wayfinding_path) {
      console.log(`⚠️ No wayfinding_path found in map ${mapId}`);
      return null;
    }

    const wayfindingData = mapDetails.wayfinding_path;

    // Validate the structure
    if (
      !wayfindingData.nodes ||
      !Array.isArray(wayfindingData.nodes) ||
      wayfindingData.nodes.length === 0
    ) {
      console.log(`⚠️ Wayfinding data has no nodes for map ${mapId}`);
      return null;
    }

    console.log(
      `✅ Found ${wayfindingData.nodes.length} wayfinding nodes in map details`,
    );

    // Transform nodes to ensure edges are properly formatted
    const transformedNodes = wayfindingData.nodes.map((node) => {
      let edges = node.edges || {};

      // If edges is an object with string values like {"N3": "1", "N1": "1"}
      if (typeof edges === "object" && !Array.isArray(edges)) {
        const edgeObj = {};
        Object.keys(edges).forEach((key) => {
          edgeObj[key] = { weight: parseInt(edges[key]) || 1 };
        });
        edges = edgeObj;
      }

      return {
        ...node,
        edges: edges,
      };
    });

    // Build edges object
    const edges = {};
    transformedNodes.forEach((node) => {
      edges[node.name] = node.edges || {};
    });

    const result = {
      nodes: transformedNodes,
      edges: edges,
    };

    console.log(`✅ Processed ${result.nodes.length} nodes with edges`);
    console.log(`📋 Node names:`, result.nodes.map((n) => n.name).join(", "));

    return result;
  } catch (error) {
    console.error("❌ Error fetching wayfinding path:", error.message);
    return null;
  }
};
/**
 * Find the nearest node on the wayfinding path to a given asset position
 */
const findNearestNode = (wayfindingPath, assetX, assetY) => {
  if (
    !wayfindingPath ||
    !wayfindingPath.nodes ||
    wayfindingPath.nodes.length === 0
  ) {
    return null;
  }

  let nearestNode = null;
  let minDistance = Infinity;

  wayfindingPath.nodes.forEach((node) => {
    if (
      node.position &&
      node.position.x !== undefined &&
      node.position.y !== undefined
    ) {
      const dx = node.position.x - assetX;
      const dy = node.position.y - assetY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < minDistance) {
        minDistance = distance;
        nearestNode = node;
      }
    }
  });

  return {
    node: nearestNode,
    distance: minDistance,
    isOnPath: minDistance < 1000,
  };
};

/**
 * Build a route from start node to destination node using BFS
 */
const findRoute = (wayfindingPath, startNodeName, destNodeName) => {
  if (!wayfindingPath || !wayfindingPath.nodes || !wayfindingPath.edges) {
    return null;
  }

  // Build adjacency list from edges
  const adjacency = {};
  wayfindingPath.nodes.forEach((node) => {
    adjacency[node.name] = [];
  });

  // Populate edges (bidirectional)
  Object.keys(wayfindingPath.edges).forEach((sourceName) => {
    const edgeData = wayfindingPath.edges[sourceName];
    if (edgeData && typeof edgeData === "object") {
      Object.keys(edgeData).forEach((targetName) => {
        if (adjacency[sourceName]) {
          adjacency[sourceName].push(targetName);
        }
      });
    }
  });

  // BFS to find shortest path
  const queue = [[startNodeName]];
  const visited = new Set([startNodeName]);

  while (queue.length > 0) {
    const path = queue.shift();
    const currentNode = path[path.length - 1];

    if (currentNode === destNodeName) {
      const routeNodes = path
        .map((nodeName) => {
          return wayfindingPath.nodes.find((n) => n.name === nodeName);
        })
        .filter((n) => n);

      return {
        path: path,
        nodes: routeNodes,
        segments: path.length - 1,
      };
    }

    const neighbors = adjacency[currentNode] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }

  return null;
};

// ============================
// COORDINATE CONVERSION HELPERS
// ============================

const convertMistToWorld = (pixelX, pixelY, mapData) => {
  if (!mapData || !mapData.ppm || mapData.origin_x === undefined) {
    console.warn("⚠️ Missing map data for coordinate conversion");
    return null;
  }

  const { origin_x, origin_y, ppm } = mapData;

  const realX = (pixelX - origin_x) / ppm;
  const realZ = -(pixelY - origin_y) / ppm;

  return {
    x: realX,
    z: realZ,
    y: 0.1,
  };
};

const convertWayfindingNodes = (nodes, mapData) => {
  if (!nodes || !mapData) return [];

  return nodes.map((node) => {
    const worldPos = convertMistToWorld(
      node.position.x,
      node.position.y,
      mapData,
    );
    return {
      ...node,
      worldPosition: worldPos,
    };
  });
};

// ============================
// GET VISITOR LOCATION WITH ROUTE
// ============================

exports.getVisitorRoute = async (req, res) => {
  try {
    const { id } = req.params;
    const { includePath = "true" } = req.query;

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
        suggestion:
          "Use PUT /api/IDVisitor/visitors/:id/cabinet with { 'idNumber': 'Tag1' }",
        visitor: {
          id: visitor._id,
          name: visitor.visitorName,
          company: visitor.company,
          currentIdNumber: visitor.idNumber || "Not assigned",
        },
      });
    }

    console.log("📡 Fetching asset locations from Mist API...");
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

    const assetNames = assets.map((a) => a.name).filter((name) => name);
    console.log("📋 Available assets:", assetNames.join(", "));

    const matchedAsset = assets.find(
      (asset) =>
        asset.name === visitor.idNumber || asset.mac === visitor.idNumber,
    );

    if (!matchedAsset) {
      return res.status(404).json({
        success: false,
        message: `Asset "${visitor.idNumber}" not found in Mist system`,
        available_assets: assetNames,
        suggestion:
          "Make sure the idNumber matches an asset name in Mist. Available assets: " +
          assetNames.join(", "),
      });
    }

    console.log("✅ Asset found:", matchedAsset.name);

    if (!matchedAsset.x || !matchedAsset.y) {
      return res.status(404).json({
        success: false,
        message: `Asset "${matchedAsset.name}" found but has no location data`,
        data: {
          name: matchedAsset.name,
          mac: matchedAsset.mac,
          last_seen: matchedAsset.last_seen,
          has_location: false,
        },
      });
    }

    let mapDetails = null;
    let wayfindingPath = null;
    let nearestNode = null;
    let routeToDestination = null;

    if (matchedAsset.map_id) {
      try {
        mapDetails = await fetchMapDetails(matchedAsset.map_id);

        if (includePath === "true") {
          wayfindingPath = await fetchWayfindingPath(matchedAsset.map_id);

          if (
            wayfindingPath &&
            wayfindingPath.nodes &&
            wayfindingPath.nodes.length > 0
          ) {
            const targetX = 5525.298750495607;
            const targetY = 2491.837930104785;

            nearestNode = findNearestNode(
              wayfindingPath,
              matchedAsset.x,
              matchedAsset.y,
            );
            const destNode = findNearestNode(wayfindingPath, targetX, targetY);

            if (nearestNode && nearestNode.node && destNode && destNode.node) {
              routeToDestination = findRoute(
                wayfindingPath,
                nearestNode.node.name,
                destNode.node.name,
              );
            }
          }
        }
      } catch (error) {
        console.warn("⚠️ Could not fetch wayfinding data:", error.message);
      }
    }

    const targetX = 5525.298750495607;
    const targetY = 2491.837930104785;

    const distance =
      matchedAsset.x && matchedAsset.y
        ? Math.sqrt(
            Math.pow(matchedAsset.x - targetX, 2) +
              Math.pow(matchedAsset.y - targetY, 2),
          )
        : null;

    const proximityStatus =
      distance !== null
        ? distance < 100
          ? "Very Close"
          : distance < 300
            ? "Close"
            : distance < 500
              ? "Moderate"
              : "Far"
        : "Unknown";

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
        x: matchedAsset.x,
        y: matchedAsset.y,
        name: matchedAsset.name,
        mac: matchedAsset.mac,
        map_id: matchedAsset.map_id,
        ap_mac: matchedAsset.ap_mac,
        last_seen: matchedAsset.last_seen,
        rssi: matchedAsset.rssi,
        beam: matchedAsset.beam,
        device_name: matchedAsset.device_name,
        manufacture: matchedAsset.manufacture,
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
            orientation: mapDetails.orientation,
            width_m: mapDetails.width_m,
            height_m: mapDetails.height_m,
          }
        : null,
      target_coordinates: {
        x: targetX,
        y: targetY,
      },
      distance: distance,
      proximity: proximityStatus,
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
              nodes: routeToDestination.nodes.map((node) => ({
                name: node.name,
                position: node.position,
              })),
            }
          : null,
        nodes: wayfindingPath.nodes.map((node) => ({
          name: node.name,
          position: node.position,
          edges: node.edges || {},
          worldPosition: convertMistToWorld(
            node.position.x,
            node.position.y,
            mapDetails,
          ),
        })),
        edges: wayfindingPath.edges,
      };
    }

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
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// ============================
// GET WAYFINDING PATH ONLY (FIXED)
// ============================

/**
 * GET WAYFINDING PATH - Get the wayfinding path for a map
 * GET /api/IDVisitor/maps/:mapId/wayfinding
 */
/**
 * GET WAYFINDING PATH - Get the wayfinding path for a map
 * GET /api/IDVisitor/maps/:mapId/wayfinding
 */
exports.getWayfindingPath = async (req, res) => {
  try {
    const { mapId } = req.params;

    if (!mapId) {
      return res.status(400).json({
        success: false,
        message: "Map ID is required",
      });
    }

    console.log("🗺️ Fetching wayfinding path for map:", mapId);

    // Fetch map details first for coordinate conversion
    const mapDetails = await fetchMapDetails(mapId);

    if (!mapDetails) {
      return res.status(404).json({
        success: false,
        message: "Map not found",
        debug: { mapId },
      });
    }

    const wayfindingPath = await fetchWayfindingPath(mapId);

    if (
      !wayfindingPath ||
      !wayfindingPath.nodes ||
      wayfindingPath.nodes.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message: "Wayfinding path not found for this map",
        suggestion:
          "Make sure wayfinding paths are drawn in the Mist dashboard",
        debug: {
          mapId: mapId,
          mapName: mapDetails.name,
          hasWayfinding: !!wayfindingPath,
          nodesCount: wayfindingPath?.nodes?.length || 0,
        },
      });
    }

    // Add world coordinates to nodes
    const nodesWithWorldCoords = wayfindingPath.nodes.map((node) => ({
      ...node,
      worldPosition: mapDetails
        ? convertMistToWorld(node.position.x, node.position.y, mapDetails)
        : null,
    }));

    // Build the response
    const responseData = {
      nodes: nodesWithWorldCoords,
      edges: wayfindingPath.edges || {},
      map: {
        id: mapDetails.id,
        name: mapDetails.name,
        ppm: mapDetails.ppm,
        origin_x: mapDetails.origin_x,
        origin_y: mapDetails.origin_y,
        width: mapDetails.width,
        height: mapDetails.height,
      },
      total_nodes: nodesWithWorldCoords.length,
      total_edges: Object.keys(wayfindingPath.edges || {}).length,
    };

    console.log(
      `✅ Returning ${responseData.total_nodes} nodes with ${responseData.total_edges} edges`,
    );

    res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("❌ Error fetching wayfinding path:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching wayfinding path",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};
// exports.getWayfindingPath = async (req, res) => {
//   try {
//     const { mapId } = req.params;

//     if (!mapId) {
//       return res.status(400).json({
//         success: false,
//         message: "Map ID is required",
//       });
//     }

//     console.log("🗺️ Fetching wayfinding path for map:", mapId);

//     // Fetch map details first for coordinate conversion
//     const mapDetails = await fetchMapDetails(mapId);

//     if (!mapDetails) {
//       return res.status(404).json({
//         success: false,
//         message: "Map not found",
//         debug: { mapId },
//       });
//     }

//     const wayfindingPath = await fetchWayfindingPath(mapId);

//     if (
//       !wayfindingPath ||
//       !wayfindingPath.nodes ||
//       wayfindingPath.nodes.length === 0
//     ) {
//       return res.status(404).json({
//         success: false,
//         message: "Wayfinding path not found for this map",
//         suggestion:
//           "Make sure wayfinding paths are drawn in the Mist dashboard",
//         debug: {
//           mapId: mapId,
//           mapName: mapDetails.name,
//           hasWayfinding: !!wayfindingPath,
//           nodesCount: wayfindingPath?.nodes?.length || 0,
//         },
//       });
//     }

//     // Add world coordinates to nodes
//     const nodesWithWorldCoords = wayfindingPath.nodes.map((node) => ({
//       ...node,
//       worldPosition: mapDetails
//         ? convertMistToWorld(node.position.x, node.position.y, mapDetails)
//         : null,
//     }));

//     res.status(200).json({
//       success: true,
//       data: {
//         nodes: nodesWithWorldCoords,
//         edges: wayfindingPath.edges,
//         map: {
//           id: mapDetails.id,
//           name: mapDetails.name,
//           ppm: mapDetails.ppm,
//           origin_x: mapDetails.origin_x,
//           origin_y: mapDetails.origin_y,
//           width: mapDetails.width,
//           height: mapDetails.height,
//         },
//         total_nodes: nodesWithWorldCoords.length,
//         total_edges: Object.keys(wayfindingPath.edges || {}).length,
//       },
//     });
//   } catch (error) {
//     console.error("❌ Error fetching wayfinding path:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error fetching wayfinding path",
//       error: error.message,
//       stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
//     });
//   }
// };

// ============================
// GET ASSET NAVIGATION ROUTE
// ============================

exports.getNavigationRoute = async (req, res) => {
  try {
    const { mapId } = req.params;
    const { fromX, fromY, toX, toY } = req.query;

    if (!mapId) {
      return res.status(400).json({
        success: false,
        message: "Map ID is required",
      });
    }

    if (!fromX || !fromY || !toX || !toY) {
      return res.status(400).json({
        success: false,
        message: "fromX, fromY, toX, toY are required as query parameters",
        example:
          "/api/IDVisitor/maps/123/route?fromX=100&fromY=200&toX=500&toY=600",
      });
    }

    console.log("🗺️ Finding route on map:", mapId);
    console.log(`   From: (${fromX}, ${fromY})`);
    console.log(`   To: (${toX}, ${toY})`);

    const mapDetails = await fetchMapDetails(mapId);
    const wayfindingPath = await fetchWayfindingPath(mapId);

    if (
      !wayfindingPath ||
      !wayfindingPath.nodes ||
      wayfindingPath.nodes.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message: "No wayfinding path found for this map",
        suggestion: "Draw wayfinding paths in the Mist dashboard first",
        debug: {
          mapId: mapId,
          hasWayfinding: !!wayfindingPath,
          nodesCount: wayfindingPath?.nodes?.length || 0,
        },
      });
    }

    const startX = parseFloat(fromX);
    const startY = parseFloat(fromY);
    const endX = parseFloat(toX);
    const endY = parseFloat(toY);

    const startNode = findNearestNode(wayfindingPath, startX, startY);
    const endNode = findNearestNode(wayfindingPath, endX, endY);

    if (!startNode || !startNode.node) {
      return res.status(404).json({
        success: false,
        message: "Could not find a wayfinding node near the start position",
        debug: { startX, startY },
      });
    }

    if (!endNode || !endNode.node) {
      return res.status(404).json({
        success: false,
        message: "Could not find a wayfinding node near the end position",
        debug: { endX, endY },
      });
    }

    const route = findRoute(
      wayfindingPath,
      startNode.node.name,
      endNode.node.name,
    );

    if (!route) {
      return res.status(404).json({
        success: false,
        message: "No route found between the specified points",
        start_node: startNode.node.name,
        end_node: endNode.node.name,
      });
    }

    const routeNodesWithWorld = route.nodes.map((node) => ({
      ...node,
      worldPosition: mapDetails
        ? convertMistToWorld(node.position.x, node.position.y, mapDetails)
        : null,
    }));

    res.status(200).json({
      success: true,
      data: {
        start: {
          position: { x: startX, y: startY },
          nearest_node: {
            name: startNode.node.name,
            position: startNode.node.position,
            distance: startNode.distance,
          },
          worldPosition: mapDetails
            ? convertMistToWorld(startX, startY, mapDetails)
            : null,
        },
        end: {
          position: { x: endX, y: endY },
          nearest_node: {
            name: endNode.node.name,
            position: endNode.node.position,
            distance: endNode.distance,
          },
          worldPosition: mapDetails
            ? convertMistToWorld(endX, endY, mapDetails)
            : null,
        },
        route: {
          ...route,
          nodes: routeNodesWithWorld,
        },
        total_segments: route.segments,
        total_nodes: route.path.length,
        map: mapDetails
          ? {
              id: mapDetails.id,
              name: mapDetails.name,
              ppm: mapDetails.ppm,
              origin_x: mapDetails.origin_x,
              origin_y: mapDetails.origin_y,
              width: mapDetails.width,
              height: mapDetails.height,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Error finding navigation route:", error);
    res.status(500).json({
      success: false,
      message: "Error finding navigation route",
      error: error.message,
    });
  }
};

// ============================
// TEST COORDINATE CONVERSION
// ============================

exports.testCoordinateConversion = async (req, res) => {
  try {
    const { mapId } = req.params;
    const { x, y } = req.query;

    if (!mapId) {
      return res.status(400).json({
        success: false,
        message: "Map ID is required",
      });
    }

    if (!x || !y) {
      return res.status(400).json({
        success: false,
        message: "x and y query parameters are required",
        example: "/api/IDVisitor/maps/123/convert?x=6140&y=1369",
      });
    }

    const mapData = await fetchMapDetails(mapId);

    if (!mapData) {
      return res.status(404).json({
        success: false,
        message: "Map not found",
      });
    }

    const pixelX = parseFloat(x);
    const pixelY = parseFloat(y);
    const worldPos = convertMistToWorld(pixelX, pixelY, mapData);

    res.json({
      success: true,
      data: {
        pixel: { x: pixelX, y: pixelY },
        map: {
          id: mapData.id,
          name: mapData.name,
          origin_x: mapData.origin_x,
          origin_y: mapData.origin_y,
          ppm: mapData.ppm,
          width: mapData.width,
          height: mapData.height,
        },
        world: worldPos,
        formula: {
          realX: "(pixelX - origin_x) / ppm",
          realZ: "-(pixelY - origin_y) / ppm",
          y: "0.1 (default height)",
        },
      },
    });
  } catch (error) {
    console.error("❌ Error testing conversion:", error);
    res.status(500).json({
      success: false,
      message: "Error testing conversion",
      error: error.message,
    });
  }
};

// ============================
// GET ALL ASSET LOCATIONS
// ============================

exports.getAllAssetLocations = async (req, res) => {
  try {
    console.log("📍 Fetching all asset locations...");

    const assets = await fetchAssetLocations();

    const locatedAssets = assets.filter(
      (asset) => asset.x !== undefined && asset.x !== null,
    );

    console.log(`✅ Found ${locatedAssets.length} assets with location data`);

    res.status(200).json({
      success: true,
      total: locatedAssets.length,
      totalAssets: assets.length,
      data: locatedAssets,
    });
  } catch (error) {
    console.error("❌ Error fetching asset locations:", error);
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
      return res.status(400).json({
        success: false,
        message: "Map ID is required",
      });
    }

    console.log("📍 Fetching map details for ID:", mapId);

    const mapDetails = await fetchMapDetails(mapId);

    if (!mapDetails) {
      return res.status(404).json({
        success: false,
        message: "Map not found",
      });
    }

    res.status(200).json({
      success: true,
      data: mapDetails,
    });
  } catch (error) {
    console.error("❌ Error fetching map details:", error);
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
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (!visitor.idNumber || visitor.idNumber.trim() === "") {
      return res.status(404).json({
        success: false,
        message: "No cabinet/asset assigned to this visitor",
        suggestion: "Use PUT /api/IDVisitor/visitors/:id/cabinet to assign one",
      });
    }

    const assets = await fetchAssetLocations();

    const cabinet = assets.find(
      (asset) =>
        asset.name === visitor.idNumber || asset.mac === visitor.idNumber,
    );

    if (!cabinet) {
      return res.status(404).json({
        success: false,
        message: `Cabinet/asset "${visitor.idNumber}" not found in Mist system`,
        available_assets: assets.map((a) => a.name).filter((name) => name),
      });
    }

    let mapDetails = null;
    if (cabinet.map_id) {
      mapDetails = await fetchMapDetails(cabinet.map_id);
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
          id: cabinet.id,
          name: cabinet.name,
          mac: cabinet.mac,
          x: cabinet.x || null,
          y: cabinet.y || null,
          map_id: cabinet.map_id,
          last_seen: cabinet.last_seen,
          rssi: cabinet.rssi,
          device_name: cabinet.device_name,
          manufacture: cabinet.manufacture,
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
            }
          : null,
      },
    });
  } catch (error) {
    console.error("❌ Error fetching visitor cabinet:", error);
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
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    if (!idNumber && !assetName) {
      return res.status(400).json({
        success: false,
        message: "idNumber or assetName is required",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    const newIdNumber = idNumber || assetName;

    try {
      const assets = await fetchAssetLocations();
      const assetExists = assets.some(
        (asset) => asset.name === newIdNumber || asset.mac === newIdNumber,
      );

      if (!assetExists) {
        return res.status(400).json({
          success: false,
          message: `Asset "${newIdNumber}" not found in Mist system`,
          available_assets: assets.map((a) => a.name).filter((name) => name),
        });
      }
    } catch (error) {
      console.warn("⚠️ Could not verify asset in Mist:", error.message);
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
    console.error("❌ Error updating visitor cabinet:", error);
    res.status(500).json({
      success: false,
      message: "Error updating visitor cabinet",
      error: error.message,
    });
  }
};
