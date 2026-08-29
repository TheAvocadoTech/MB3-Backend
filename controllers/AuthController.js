// controllers/AuthController.js

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

/* ===========================
   SIGNUP
=========================== */
const signup = async (req, res) => {
  try {
    console.log("📥 Signup Request:", req.body);

    const fullName =
      req.body.fullName || req.body.FullName || req.body.fullname;

    const email = (req.body.email || req.body.Email || "").trim().toLowerCase();

    const password = req.body.password || req.body.Password;

    const role = req.body.role || req.body.Role || "Receptionist";

    if (!fullName || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Full Name, Email and Password are required.",
      });
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email already exists.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName,
      email,
      password: hashedPassword,
      role,
    });

    const token = jwt.sign(
      {
        userId: user._id,
        role: user.role,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    const userData = user.toObject();
    delete userData.password;

    res.status(201).json({
      success: true,
      message: "Signup successful.",
      token,
      user: userData,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   LOGIN
=========================== */
const login = async (req, res) => {
  try {
    const email = (req.body.email || req.body.Email || "").trim().toLowerCase();

    const password = req.body.password || req.body.Password;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and Password are required.",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid Email or Password.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid Email or Password.",
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      {
        userId: user._id,
        role: user.role,
        email: user.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      },
    );

    const userData = user.toObject();
    delete userData.password;

    res.json({
      success: true,
      message: "Login successful.",
      token,
      user: userData,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET PROFILE
=========================== */
const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   UPDATE PROFILE
=========================== */
const updateProfile = async (req, res) => {
  try {
    const updateData = {};

    if (req.body.fullName) updateData.fullName = req.body.fullName;

    if (req.body.phoneNumber) updateData.phoneNumber = req.body.phoneNumber;

    if (req.body.profileImage) updateData.profileImage = req.body.profileImage;

    const user = await User.findByIdAndUpdate(req.user.userId, updateData, {
      new: true,
    }).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.json({
      success: true,
      message: "Profile updated successfully.",
      user,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET ALL USERS
=========================== */
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password");

    res.json({
      success: true,
      users,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   DELETE USER
=========================== */
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    res.json({
      success: true,
      message: "User deleted successfully.",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   LOGOUT
=========================== */
const logout = async (req, res) => {
  res.json({
    success: true,
    message: "Logged out successfully.",
  });
};

module.exports = {
  signup,
  login,
  getProfile,
  updateProfile,
  getAllUsers,
  deleteUser,
  logout,
};
