// routes/Cabinet.routes.js

const express = require("express");
const router = express.Router();
const cabinetController = require("../controllers/Cabinet.Controller");
const { protect, admin } = require("../middleware/auth.middleware");

/* ===========================
   CABINET ROUTES
=========================== */

// Public routes (no authentication required)
// GET /api/cabinets/search - Search cabinets
router.get("/search", cabinetController.searchCabinets);

// GET /api/cabinets/recent - Get recent cabinets
router.get("/recent", cabinetController.getRecentCabinets);

// GET /api/cabinets/company/:companyName - Get cabinets by company
router.get("/company/:companyName", cabinetController.getCabinetsByCompany);

// Protected routes (authentication required)
// GET /api/cabinets - Get all cabinets (with pagination, search, filter)
router.get("/", cabinetController.getAllCabinets);

// GET /api/cabinets/:id - Get cabinet by ID
router.get("/:id", cabinetController.getCabinetById);

// Protected routes (Admin only)
// POST /api/cabinets - Create a new cabinet
router.post("/", protect, cabinetController.createCabinet);

// PUT /api/cabinets/:id - Update cabinet
router.put("/:id", protect, cabinetController.updateCabinet);

// DELETE /api/cabinets/:id - Soft delete cabinet
router.delete("/:id", protect, cabinetController.deleteCabinet);

module.exports = router;
