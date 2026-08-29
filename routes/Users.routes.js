const express = require("express");

const {
  signup,
  login,
  getProfile,
  updateProfile,
  getAllUsers,
  deleteUser,
  logout,
} = require("../controllers/AuthController");

const { protect, admin } = require("../middleware/auth.middleware");

const router = express.Router();

/* ===========================
   PUBLIC ROUTES
=========================== */

// Register
router.post("/signup", signup);

// Login
router.post("/login", login);

/* ===========================
   PROTECTED ROUTES
=========================== */

// Get Logged-in User Profile
router.get("/profile", protect, getProfile);

// Update Profile
router.put("/profile", protect, updateProfile);

// Logout
router.post("/logout", protect, logout);

/* ===========================
   ADMIN ROUTES
=========================== */

// Get All Users
router.get("/users", protect, admin, getAllUsers);

// Delete User
router.delete("/users/:id", protect, admin, deleteUser);

module.exports = router;
