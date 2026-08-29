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
// VISIT OPERATIONS
// ============================

// Start visit for a visitor (assigns company & tag)
router.post("/visitors/:id/start-visit", visitorController.startVisit);

// End visit for a visitor (frees tag)
router.post("/visitors/:id/end-visit", visitorController.endVisit);

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
// LOCATION TRACKING ROUTES (UPDATED)
// ============================

// Get visitor location - NOW USING locationController
router.get("/visitors/:id/location", locationController.getVisitorRoute);

// Get visitor navigation with wayfinding
router.get("/visitors/:id/navigation", locationController.getVisitorRoute);

// Get visitor cabinet/asset
router.get("/visitors/:id/cabinet", locationController.getVisitorCabinet);

// Update visitor cabinet
router.put("/visitors/:id/cabinet", locationController.updateVisitorCabinet);

// Get all asset locations from Mist
router.get("/assets/locations", locationController.getAllAssetLocations);

// Get asset tracking state
router.get("/assets/tracking/state", locationController.getAssetTrackingState);

// Reset asset tracking
router.delete(
  "/assets/tracking/reset/:mac",
  locationController.resetAssetTracking,
);

// ============================
// MAP & WAYFINDING ROUTES
// ============================

/**
 * Get map details
 * GET /api/IDVisitor/maps/:mapId
 */
router.get("/maps/:mapId", locationController.getMapDetails);

/**
 * Get wayfinding path for a specific map
 * GET /api/IDVisitor/maps/:mapId/wayfinding
 */
router.get("/maps/:mapId/wayfinding", locationController.getWayfindingPath);

/**
 * Get navigation route between two points
 * GET /api/IDVisitor/maps/:mapId/route
 */
router.get("/maps/:mapId/route", locationController.getNavigationRoute);

/**
 * Test coordinate conversion
 * GET /api/IDVisitor/maps/:mapId/convert
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
