// routes/IDVisitor.routes.js
const express = require("express");
const router = express.Router();
const visitorController = require("../controllers/IDVIsitorQR.Controller");
const locationController = require("../controllers/location.controller");

// ============================
// PUBLIC VISITOR ROUTES
// ============================

// Visitor login with temporary password
router.post("/visitors/login", visitorController.visitorLogin);

// Validate QR token (public)
router.get("/visitors/validate/:token", visitorController.validateQR);

// Scan QR (public - supports both GET and POST)
router.get("/visitors/scan/:token", visitorController.scanVisitorQR);
router.post("/visitors/scan", visitorController.scanVisitorQR);

// Scan QR & fetch cabinets for specific company
router.get(
  "/visitors/scan-cabinets/:token",
  visitorController.scanAndGetCabinets,
);
router.post("/visitors/scan-cabinets", visitorController.scanAndGetCabinets);

// Get visitor dashboard (requires authentication)
router.get(
  "/visitors/dashboard",
  visitorController.verifyVisitorToken,
  visitorController.getVisitorDashboard,
);

// ============================
// ADMIN ROUTES (Visitor CRUD)
// ============================

// Create visitor
router.post("/visitors", visitorController.createVisitor);

// Bulk create visitors
router.post("/visitors/bulk", visitorController.bulkCreateVisitors);

// Get all visitors with filters
router.get("/visitors", visitorController.getAllVisitors);

// Get single visitor by ID
router.get("/visitors/:id", visitorController.getVisitorById);

// Get visitor by QR token
router.get("/visitors/token/:token", visitorController.getVisitorByToken);

// ============================
// QR CODE OPERATIONS
// ============================

// Send QR via email with PDF attachment
router.post("/visitors/:id/send-qr", visitorController.sendQR);

// Resend QR via email with PDF
router.post("/visitors/:id/resend-qr", visitorController.resendQR);

// Check-in visitor
router.post("/visitors/:id/check-in", visitorController.checkInVisitor);

// Check-out visitor
router.post("/visitors/:id/check-out", visitorController.checkOutVisitor);

// Regenerate QR code
router.post("/visitors/:id/regenerate-qr", visitorController.regenerateQR);

// ============================
// LOCATION TRACKING ROUTES
// ============================

// Get visitor location
router.get("/visitors/:id/location", visitorController.getVisitorLocation);

// Get visitor navigation with wayfinding
router.get("/visitors/:id/navigation", visitorController.getVisitorLocation);

// Get visitor cabinet/asset
router.get("/visitors/:id/cabinet", visitorController.getVisitorCabinet);

// Update visitor cabinet
router.put("/visitors/:id/cabinet", visitorController.updateVisitorCabinet);

// Get all asset locations from Mist
router.get("/assets/locations", visitorController.getAllAssetLocations);

// Get asset tracking state
router.get("/assets/tracking/state", visitorController.getAssetTrackingState);

// Reset asset tracking
router.delete(
  "/assets/tracking/reset/:mac",
  visitorController.resetAssetTracking,
);

// ============================
// MAP & WAYFINDING ROUTES (NEW)
// ============================

/**
 * Get map details
 * GET /api/IDVisitor/maps/:mapId
 */
router.get("/maps/:mapId", visitorController.getMapDetails);

/**
 * Get wayfinding path for a specific map
 * GET /api/IDVisitor/maps/:mapId/wayfinding
 *
 * Response: {
 *   success: true,
 *   data: {
 *     nodes: [...],
 *     edges: {...},
 *     map: {...},
 *     total_nodes: number,
 *     total_edges: number
 *   }
 * }
 */
router.get("/maps/:mapId/wayfinding", locationController.getWayfindingPath);

/**
 * Get navigation route between two points
 * GET /api/IDVisitor/maps/:mapId/route
 *
 * Query params:
 * - fromX: number (start X coordinate in pixels)
 * - fromY: number (start Y coordinate in pixels)
 * - toX: number (end X coordinate in pixels)
 * - toY: number (end Y coordinate in pixels)
 *
 * Example: /maps/123/route?fromX=100&fromY=200&toX=500&toY=600
 */
router.get("/maps/:mapId/route", locationController.getNavigationRoute);

/**
 * Test coordinate conversion
 * GET /api/IDVisitor/maps/:mapId/convert
 *
 * Query params: ?x=6140&y=1369
 */
router.get("/maps/:mapId/convert", locationController.testCoordinateConversion);

// ============================
// DELETE OPERATIONS
// ============================

// Delete single visitor
router.delete("/visitors/:id", visitorController.deleteVisitor);

// Bulk delete visitors (expired/checked-in/all)
router.delete("/visitors/bulk", visitorController.bulkDeleteVisitors);

module.exports = router;
