// controllers/CompanyController.js

const Company = require("../models/Company.model");

/* ===========================
   CREATE COMPANY
=========================== */

const createCompany = async (req, res) => {
  try {
    const company = await Company.create({
      ...req.body,
      createdBy: req.user?.userId || null,
    });

    res.status(201).json({
      success: true,
      message: "Company created successfully.",
      company,
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
   GET ALL COMPANIES
=========================== */

const getAllCompanies = async (req, res) => {
  try {
    const { search, industry, page = 1, limit = 10 } = req.query;

    const filter = {
      isActive: true,
    };

    if (industry) {
      filter.industry = industry;
    }

    if (search) {
      filter.$or = [
        { companyName: { $regex: search, $options: "i" } },
        { industry: { $regex: search, $options: "i" } },
      ];
    }

    const companies = await Company.find(filter)
      .populate("createdBy", "fullName email")
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await Company.countDocuments(filter);

    res.json({
      success: true,
      companies,
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
   GET COMPANY BY ID
=========================== */

const getCompanyById = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id).populate(
      "createdBy",
      "fullName email",
    );

    if (!company || !company.isActive) {
      return res.status(404).json({
        success: false,
        message: "Company not found.",
      });
    }

    res.json({
      success: true,
      company,
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
   UPDATE COMPANY
=========================== */

const updateCompany = async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    }).populate("createdBy", "fullName email");

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found.",
      });
    }

    res.json({
      success: true,
      message: "Company updated successfully.",
      company,
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
   DELETE COMPANY (Soft Delete)
=========================== */

const deleteCompany = async (req, res) => {
  try {
    const company = await Company.findByIdAndUpdate(
      req.params.id,
      {
        isActive: false,
        deletedAt: new Date(),
      },
      {
        new: true,
      },
    );

    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found.",
      });
    }

    res.json({
      success: true,
      message: "Company deleted successfully.",
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
   GET INDUSTRIES
=========================== */

const getIndustries = async (req, res) => {
  try {
    const industries = await Company.distinct("industry", {
      isActive: true,
    });

    res.json({
      success: true,
      industries,
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
   SEARCH COMPANIES
=========================== */

const searchCompanies = async (req, res) => {
  try {
    const { q } = req.query;

    const companies = await Company.find({
      isActive: true,
      $or: [
        { companyName: { $regex: q, $options: "i" } },
        { contactPerson: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { industry: { $regex: q, $options: "i" } },
      ],
    });

    res.json({
      success: true,
      companies,
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
   GET RECENT COMPANIES
=========================== */

const getRecentCompanies = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const companies = await Company.find({
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      companies,
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
   GET COMPANIES BY INDUSTRY
=========================== */

const getCompaniesByIndustry = async (req, res) => {
  try {
    const companies = await Company.find({
      industry: req.params.industry,
      isActive: true,
    });

    res.json({
      success: true,
      companies,
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
  createCompany,
  getAllCompanies,
  getCompanyById,
  updateCompany,
  deleteCompany,
  getIndustries,
  searchCompanies,
  getRecentCompanies,
  getCompaniesByIndustry,
};
