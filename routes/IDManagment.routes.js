// routes/IdManagement.routes.js
const express = require("express");
const router = express.Router();
const {
  createIdRecord,
  getAllIdRecords,
  getAvailableTags,
  getIdRecordById,
  updateIdRecord,
  deleteIdRecord,
  getIdStats,
} = require("../controllers/IDManagment.Controller");

const { protect } = require("../middleware/auth.middleware");

/* ===========================
   ROUTES
=========================== */

// Get available tags only (for dropdowns)
router.get("/available", getAvailableTags);

// Get tag statistics
router.get("/stats", getIdStats);

// Get all tags with search & filters
router.get("/", getAllIdRecords);

// Create a new tag
router.post("/", createIdRecord);

// Get tag by ID
router.get("/:id", getIdRecordById);

// Update tag
router.put("/:id", updateIdRecord);

// Delete tag
router.delete("/:id", deleteIdRecord);

module.exports = router;

