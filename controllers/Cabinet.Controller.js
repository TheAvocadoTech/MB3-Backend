// controllers/Cabinet.Controller.js

const Cabinet = require("../models/Cabinet.model");

/* ===========================
   CREATE CABINET
=========================== */
const createCabinet = async (req, res) => {
  try {
    const cabinet = await Cabinet.create({
      ...req.body,
      createdBy: req.user?.userId || null,
    });

    res.status(201).json({
      success: true,
      message: "Cabinet created successfully.",
      cabinet,
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
   GET ALL CABINETS
=========================== */
const getAllCabinets = async (req, res) => {
  try {
    const { search, companyName, page = 1, limit = 10 } = req.query;

    const filter = { isActive: true };

    if (companyName) {
      filter.companyName = { $regex: companyName, $options: "i" };
    }

    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { cabinetName: { $regex: search, $options: "i" } },
      ];
    }

    const cabinets = await Cabinet.find(filter)
      .populate("createdBy", "fullName email")
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await Cabinet.countDocuments(filter);

    res.json({
      success: true,
      cabinets,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
      },
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
   GET CABINET BY ID
=========================== */
const getCabinetById = async (req, res) => {
  try {
    const cabinet = await Cabinet.findById(req.params.id).populate(
      "createdBy",
      "fullName email",
    );

    if (!cabinet || !cabinet.isActive) {
      return res.status(404).json({
        success: false,
        message: "Cabinet not found.",
      });
    }

    res.json({
      success: true,
      cabinet,
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
   UPDATE CABINET
=========================== */
const updateCabinet = async (req, res) => {
  try {
    const cabinet = await Cabinet.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    }).populate("createdBy", "fullName email");

    if (!cabinet) {
      return res.status(404).json({
        success: false,
        message: "Cabinet not found.",
      });
    }

    res.json({
      success: true,
      message: "Cabinet updated successfully.",
      cabinet,
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
   DELETE CABINET (Soft Delete)
=========================== */
const deleteCabinet = async (req, res) => {
  try {
    const cabinet = await Cabinet.findByIdAndUpdate(
      req.params.id,
      {
        isActive: false,
        deletedAt: new Date(),
      },
      { new: true },
    );

    if (!cabinet) {
      return res.status(404).json({
        success: false,
        message: "Cabinet not found.",
      });
    }

    res.json({
      success: true,
      message: "Cabinet deleted successfully.",
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
   SEARCH CABINETS
=========================== */
const searchCabinets = async (req, res) => {
  try {
    const { q } = req.query;

    const cabinets = await Cabinet.find({
      isActive: true,
      $or: [
        { companyName: { $regex: q, $options: "i" } },
        { cabinetName: { $regex: q, $options: "i" } },
      ],
    });

    res.json({
      success: true,
      cabinets,
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
   GET CABINETS BY COMPANY
=========================== */
const getCabinetsByCompany = async (req, res) => {
  try {
    const cabinets = await Cabinet.find({
      companyName: { $regex: req.params.companyName, $options: "i" },
      isActive: true,
    });

    res.json({
      success: true,
      cabinets,
      count: cabinets.length,
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
   GET RECENT CABINETS
=========================== */
const getRecentCabinets = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const cabinets = await Cabinet.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      cabinets,
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
   EXPORTS
=========================== */
module.exports = {
  createCabinet,
  getAllCabinets,
  getCabinetById,
  updateCabinet,
  deleteCabinet,
  searchCabinets,
  getCabinetsByCompany,
  getRecentCabinets,
};
