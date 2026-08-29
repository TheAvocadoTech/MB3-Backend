// routes/Companies.routes.js
const express = require("express");
const router = express.Router();
const {
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
  getIndustries,
  searchCompanies,
  getRecentCompanies,
  getCompaniesByIndustry,
} = require("../controllers/Company.Controller");
const { protect, admin } = require("../middleware/auth.middleware");
// Public routes (optional - depending on your auth requirements)
router.get("/industries", getIndustries);
router.get("/search", searchCompanies);
router.get("/recent", getRecentCompanies);
router.get("/industry/:industry", getCompaniesByIndustry);

// Protected routes (require authentication)
router.post("/", protect, createCompany);
router.get("/", getAllCompanies);
router.get("/:id", protect, getCompanyById);
router.put("/:id", protect, updateCompany);
router.delete("/:id", protect, deleteCompany);

module.exports = router;
