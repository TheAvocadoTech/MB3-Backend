// controllers/IdManagementController.js
const IdManagement = require("../models/IDManagement.model");

/* ===========================
   CREATE ID / TAG RECORD
=========================== */
const createIdRecord = async (req, res) => {
  try {
    const { macAddress, name, nickname, status = "Available" } = req.body;

    if (!macAddress || !name || !nickname) {
      return res.status(400).json({
        success: false,
        message: "MAC Address, Device Name, and Nickname are required.",
      });
    }

    // Check if tag already exists with this MAC
    const existing = await IdManagement.findOne({
      macAddress: macAddress.trim().toLowerCase(),
      isActive: true,
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A tag with MAC address "${macAddress}" already exists (${existing.nickname}).`,
      });
    }

    const record = await IdManagement.create({
      macAddress: macAddress.trim().toLowerCase(),
      name: name.trim(),
      nickname: nickname.trim(),
      status: status,
      createdBy: req.user?.userId || null,
    });

    res.status(201).json({
      success: true,
      message: "Tag registered successfully.",
      data: record,
    });
  } catch (err) {
    console.error("Create tag error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET ALL ID / TAG RECORDS
=========================== */
const getAllIdRecords = async (req, res) => {
  try {
    // Migrate any legacy document missing macAddress
    await IdManagement.collection.updateMany(
      { macAddress: { $exists: false } },
      {
        $set: {
          macAddress: "ea2671f0003d",
          name: "ER-BLE1-26G003d",
          nickname: "Tag 1",
          status: "Available",
          isActive: true,
        },
      }
    );

    const tag2Exists = await IdManagement.findOne({ macAddress: "ea2671f0003e" });
    if (!tag2Exists) {
      await IdManagement.create({
        macAddress: "ea2671f0003e",
        name: "ER-BLE1-26G003e",
        nickname: "Tag 2",
        status: "Available",
        isActive: true,
      });
    }

    const {
      search,
      status,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = {
      isActive: true,
    };

    if (status && status !== "all") filter.status = status;

    if (search) {
      filter.$or = [
        { macAddress: { $regex: search, $options: "i" } },
        { name: { $regex: search, $options: "i" } },
        { nickname: { $regex: search, $options: "i" } },
        { assignedVisitorName: { $regex: search, $options: "i" } },
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder.toLowerCase() === "asc" ? 1 : -1;

    const records = await IdManagement.find(filter)
      .populate("assignedVisitor", "visitorName phoneNumber email company")
      .populate("createdBy", "fullName email")
      .sort(sort);

    const total = await IdManagement.countDocuments(filter);

    res.json({
      success: true,
      records,
      total,
    });
  } catch (err) {
    console.error("Get tags error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET AVAILABLE TAGS ONLY
=========================== */
const getAvailableTags = async (req, res) => {
  try {
    // 1. Migrate legacy tag documents if missing macAddress
    await IdManagement.collection.updateMany(
      { macAddress: { $exists: false } },
      {
        $set: {
          macAddress: "ea2671f0003d",
          name: "ER-BLE1-26G003d",
          nickname: "Tag 1",
          status: "Available",
          isActive: true,
        },
      }
    );

    const tag2Exists = await IdManagement.findOne({ macAddress: "ea2671f0003e" });
    if (!tag2Exists) {
      await IdManagement.create({
        macAddress: "ea2671f0003e",
        name: "ER-BLE1-26G003e",
        nickname: "Tag 2",
        status: "Available",
        isActive: true,
      });
    }

    // 2. Fetch tags that are Available
    const records = await IdManagement.find({
      status: "Available",
      isActive: true,
    }).sort({ nickname: 1 });

    res.json({
      success: true,
      records,
      count: records.length,
    });
  } catch (err) {
    console.error("Get available tags error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET ID RECORD BY ID
=========================== */
const getIdRecordById = async (req, res) => {
  try {
    const record = await IdManagement.findById(req.params.id)
      .populate("assignedVisitor", "visitorName phoneNumber email company")
      .populate("createdBy", "fullName email");

    if (!record || !record.isActive) {
      return res.status(404).json({
        success: false,
        message: "Tag not found.",
      });
    }

    res.json({
      success: true,
      data: record,
    });
  } catch (err) {
    console.error("Get tag by id error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   UPDATE ID / TAG RECORD
=========================== */
const updateIdRecord = async (req, res) => {
  try {
    const { macAddress, name, nickname, status } = req.body;

    const updateData = {};
    if (macAddress) updateData.macAddress = macAddress.trim().toLowerCase();
    if (name) updateData.name = name.trim();
    if (nickname) updateData.nickname = nickname.trim();
    if (status) updateData.status = status;

    const record = await IdManagement.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Tag not found.",
      });
    }

    res.json({
      success: true,
      message: "Tag updated successfully.",
      data: record,
    });
  } catch (err) {
    console.error("Update tag error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   DELETE ID RECORD (Soft Delete)
=========================== */
const deleteIdRecord = async (req, res) => {
  try {
    const record = await IdManagement.findByIdAndUpdate(
      req.params.id,
      {
        isActive: false,
        deletedAt: new Date(),
      },
      { new: true }
    );

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "Tag not found.",
      });
    }

    res.json({
      success: true,
      message: "Tag deleted successfully.",
    });
  } catch (err) {
    console.error("Delete tag error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ===========================
   GET TAG STATISTICS
=========================== */
const getIdStats = async (req, res) => {
  try {
    const total = await IdManagement.countDocuments({ isActive: true });
    const available = await IdManagement.countDocuments({
      status: "Available",
      isActive: true,
    });
    const inUse = await IdManagement.countDocuments({
      status: "In Use",
      isActive: true,
    });
    const maintenance = await IdManagement.countDocuments({
      status: "Maintenance",
      isActive: true,
    });

    res.json({
      success: true,
      stats: {
        total,
        available,
        inUse,
        maintenance,
      },
    });
  } catch (err) {
    console.error("Get tag stats error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = {
  createIdRecord,
  getAllIdRecords,
  getAvailableTags,
  getIdRecordById,
  updateIdRecord,
  deleteIdRecord,
  getIdStats,
};

