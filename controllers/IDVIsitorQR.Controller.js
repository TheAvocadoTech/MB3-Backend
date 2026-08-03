// controllers/IDVIsitorQR.Controller.js
const QRModel = require("../models/User/IdVisitorQR.model");
const Cabinet = require("../models/Cabinet.model");
const QRCode = require("qrcode");
const crypto = require("crypto");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const AssetTracker = require("../services/mistAssetTracker");

// ============================
// MIST API CONFIGURATION
// ============================

const MIST_API_TOKEN =
  process.env.MIST_API_TOKEN ||
  "li1iDhxqOaPiJyYwcEuIznaUcLqajVsVTnTS6eKtzFDh4N2ZPbInk8sodqYAFhjYqOOeB3LFIClQ2deNJUXDgIVWsJ6SCjlT";
const MIST_SITE_ID =
  process.env.MIST_SITE_ID || "8ddd401e-edb4-4b24-beb1-6298afdd0bd1";
const MIST_API_BASE = "https://api.mist.com/api/v1";

// ============================
// EMAIL CONFIGURATION
// ============================

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ============================
// MAP CONFIGURATIONS
// ============================

const MAP_CONFIGS = {
  "30141417-44ea-4982-993c-6225c9f08315": {
    name: "MB3-F00",
    width: 6400,
    height: 5120,
    width_m: 127.81105527098556,
    height_m: 102.24884421678846,
    origin_x: 306.45106507695385,
    origin_y: 3856.483584010582,
    ppm: 50.07391564392213,
  },
};

// Beam angles for direction estimation
const BEAM_ANGLES = {
  0: 0,
  1: 20,
  2: 40,
  3: 60,
  4: 80,
  5: 100,
  6: 120,
  7: 140,
  8: 160,
  9: 180,
  10: 200,
  11: 220,
  12: 240,
  13: 260,
  14: 280,
  15: 300,
  16: 320,
  17: 340,
};

// ============================
// MIST API HELPERS
// ============================

const getMistHeaders = () => ({
  Authorization: `Token ${MIST_API_TOKEN}`,
  "Content-Type": "application/json",
});

const fetchAssetLocations = async () => {
  try {
    const processedAssets = await AssetTracker.getAssets();
    return processedAssets;
  } catch (error) {
    console.error("Mist API Error:", error.response?.data || error.message);
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/stats/assets`;
    const response = await axios.get(url, {
      headers: getMistHeaders(),
    });
    return response.data;
  }
};

const fetchMapDetails = async (mapId) => {
  try {
    const url = `${MIST_API_BASE}/sites/${MIST_SITE_ID}/maps/${mapId}`;
    const response = await axios.get(url, {
      headers: getMistHeaders(),
    });
    return response.data;
  } catch (error) {
    console.error("Map API Error:", error.response?.data || error.message);
    return null;
  }
};

// ============================
// COORDINATE CONVERSION HELPERS
// ============================

const convertMistToWorld = (pixelX, pixelY, mapId) => {
  const mapConfig = MAP_CONFIGS[mapId];
  if (!mapConfig) {
    console.warn(`Unknown map_id: ${mapId}, using raw coordinates`);
    return { x: pixelX, z: pixelY, y: 0.1 };
  }

  const { origin_x, origin_y, ppm } = mapConfig;
  const realX = (pixelX - origin_x) / ppm;
  const realZ = -(pixelY - origin_y) / ppm;

  return {
    x: realX,
    z: realZ,
    y: 0.1,
  };
};

// ============================
// QR CODE GENERATION HELPERS
// ============================

const generateQRToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

const generateQRCodeImage = async (token) => {
  try {
    const qrDataUrl = await QRCode.toDataURL(token, {
      width: 400,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
      errorCorrectionLevel: "H",
    });
    return qrDataUrl;
  } catch (error) {
    console.error("QR generation error:", error);
    return `qr_${token.substring(0, 8)}`;
  }
};

const getExpiryDate = (hours = 24) => {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
};

const findValidVisitorByToken = async (token) => {
  if (!token || typeof token !== "string") return null;

  const normalizedToken = token.trim();
  if (!normalizedToken) return null;

  const now = new Date();

  return QRModel.findOne({
    qrToken: normalizedToken,
    qrExpiresAt: { $gt: now },
  }).lean();
};

// ============================
// PDF GENERATION HELPER
// ============================

const generateVisitorPDF = async (visitorData, qrCodeImage) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 30,
        info: {
          Title: `Visitor Pass - ${visitorData.visitorName}`,
          Author: "Visitor Management System",
        },
      });

      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      doc
        .fontSize(22)
        .font("Helvetica-Bold")
        .fillColor("#1a237e")
        .text("VISITOR PASS", { align: "center" })
        .moveDown(0.2);

      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor("#666")
        .text("Visitor Management System", { align: "center" })
        .moveDown(0.3);

      doc
        .strokeColor("#1a237e")
        .lineWidth(1.5)
        .moveTo(40, doc.y)
        .lineTo(550, doc.y)
        .stroke()
        .moveDown(0.5);

      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#444")
        .text(`Name: `, { continued: true })
        .font("Helvetica")
        .fillColor("#000")
        .text(visitorData.visitorName, { continued: true })
        .font("Helvetica-Bold")
        .fillColor("#444")
        .text(`  |  Phone: `, { continued: true })
        .font("Helvetica")
        .fillColor("#000")
        .text(visitorData.phoneNumber)
        .moveDown(0.2);

      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#444")
        .text(`Company: `, { continued: true })
        .font("Helvetica")
        .fillColor("#000")
        .text(visitorData.company || "N/A", { continued: true })
        .font("Helvetica-Bold")
        .fillColor("#444")
        .text(`  |  Valid Until: `, { continued: true })
        .font("Helvetica")
        .fillColor("#000")
        .text(new Date(visitorData.qrExpiresAt).toLocaleString())
        .moveDown(0.5);

      doc
        .strokeColor("#ddd")
        .lineWidth(1)
        .moveTo(40, doc.y)
        .lineTo(550, doc.y)
        .stroke()
        .moveDown(0.8);

      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor("#1a237e")
        .text("📱 SCAN QR CODE", { align: "center" })
        .moveDown(0.5);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const availableHeight = pageHeight - doc.y - 100;
      const qrSize = Math.min(380, availableHeight, pageWidth - 80);

      if (qrCodeImage && qrCodeImage.startsWith("data:image")) {
        const base64Data = qrCodeImage.replace(/^data:image\/png;base64,/, "");
        const imageBuffer = Buffer.from(base64Data, "base64");
        doc.image(imageBuffer, {
          fit: [qrSize, qrSize],
          align: "center",
          valign: "center",
        });
      } else {
        doc
          .fontSize(12)
          .fillColor("#999")
          .text("QR Code Token: " + visitorData.qrToken, { align: "center" });
      }

      doc.moveDown(1);

      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#888")
        .text(`Token: ${visitorData.qrToken}`, { align: "center" })
        .moveDown(0.5);

      doc
        .strokeColor("#ddd")
        .lineWidth(1)
        .moveTo(40, doc.y)
        .lineTo(550, doc.y)
        .stroke()
        .moveDown(0.3);

      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#555")
        .text("Scan this QR code", {
          align: "center",
        })
        .moveDown(0.2);

      doc
        .fontSize(7)
        .fillColor("#999")
        .text(
          `Generated: ${new Date().toLocaleString()} | Pass ID: ${visitorData._id}`,
          { align: "center" },
        );

      doc.end();
    } catch (error) {
      console.error("PDF Generation Error:", error);
      reject(error);
    }
  });
};

// ============================
// TEMPORARY LOGIN HELPER
// ============================

const generateTemporaryPassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let password = "";
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

const generateVisitorToken = (visitorId) => {
  return jwt.sign(
    {
      visitorId,
      type: "visitor",
      timestamp: Date.now(),
    },
    process.env.JWT_SECRET || "visitor_secret_key",
    { expiresIn: "24h" },
  );
};

// ============================
// CONTROLLER FUNCTIONS
// ============================

// ===== AUTHENTICATION MIDDLEWARE =====
exports.verifyVisitorToken = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1] || req.query.token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "visitor_secret_key",
    );

    if (decoded.type !== "visitor") {
      return res.status(403).json({
        success: false,
        message: "Visitor access required",
      });
    }

    req.user = decoded;
    req.user.visitorId = decoded.visitorId;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired session",
    });
  }
};

// ===== CREATE VISITOR =====
exports.createVisitor = async (req, res) => {
  try {
    const {
      visitorName,
      phoneNumber,
      email,
      company,
      idNumber,
      purpose = "Meeting",
      expiryHours = 24,
    } = req.body;

    if (!visitorName || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: visitorName, phoneNumber",
      });
    }

    const qrToken = generateQRToken();
    const qrCodeImage = await generateQRCodeImage(qrToken);

    const visitorData = {
      visitorName: visitorName.trim(),
      phoneNumber: phoneNumber.trim(),
      qrCode: qrCodeImage,
      qrToken: qrToken,
      qrExpiresAt: getExpiryDate(expiryHours),
      checkedIn: false,
      purpose: purpose,
    };

    if (email) visitorData.email = email.trim();
    if (company) visitorData.company = company.trim();
    if (idNumber) visitorData.idNumber = idNumber.trim();

    const visitor = new QRModel(visitorData);
    await visitor.save();

    res.status(201).json({
      success: true,
      message: "Visitor created successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        phoneNumber: visitor.phoneNumber,
        email: visitor.email,
        company: visitor.company,
        idNumber: visitor.idNumber,
        qrCode: visitor.qrCode,
        qrToken: visitor.qrToken,
        qrExpiresAt: visitor.qrExpiresAt,
        checkedIn: visitor.checkedIn,
        purpose: visitor.purpose,
        createdAt: visitor.createdAt,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "QR token already exists. Please try again.",
      });
    }
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors,
      });
    }
    console.error("Error creating visitor:", error);
    res.status(500).json({
      success: false,
      message: "Error creating visitor",
      error: error.message,
    });
  }
};

// ===== BULK CREATE VISITORS =====
exports.bulkCreateVisitors = async (req, res) => {
  try {
    const visitorsData = req.body;

    if (!Array.isArray(visitorsData)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be an array of visitors",
      });
    }

    if (visitorsData.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No visitors data provided",
      });
    }

    const results = [];
    const errors = [];
    const createdVisitors = [];

    for (let i = 0; i < visitorsData.length; i++) {
      const data = visitorsData[i];

      try {
        if (!data.visitorName || !data.phoneNumber) {
          errors.push({
            index: i,
            data: data,
            error: "Missing required fields: visitorName, phoneNumber",
          });
          continue;
        }

        const qrToken = generateQRToken();
        const qrCodeImage = await generateQRCodeImage(qrToken);

        const visitorData = {
          visitorName: data.visitorName.trim(),
          phoneNumber: data.phoneNumber.trim(),
          qrCode: qrCodeImage,
          qrToken: qrToken,
          qrExpiresAt: getExpiryDate(data.expiryHours || 24),
          checkedIn: false,
          purpose: data.purpose || "Meeting",
        };

        if (data.email) visitorData.email = data.email.trim();
        if (data.company) visitorData.company = data.company.trim();
        if (data.idNumber) visitorData.idNumber = data.idNumber.trim();

        const visitor = new QRModel(visitorData);
        await visitor.save();

        createdVisitors.push({
          id: visitor._id,
          visitorName: visitor.visitorName,
          phoneNumber: visitor.phoneNumber,
          qrToken: visitor.qrToken,
          qrExpiresAt: visitor.qrExpiresAt,
        });

        results.push({
          index: i,
          success: true,
          data: visitor,
        });
      } catch (error) {
        errors.push({
          index: i,
          data: data,
          error: error.message,
        });
      }
    }

    res.status(201).json({
      success: true,
      message: `Created ${createdVisitors.length} visitors successfully`,
      total: visitorsData.length,
      created: createdVisitors.length,
      failed: errors.length,
      data: {
        created: createdVisitors,
        errors: errors,
      },
    });
  } catch (error) {
    console.error("Error in bulk create:", error);
    res.status(500).json({
      success: false,
      message: "Error creating visitors",
      error: error.message,
    });
  }
};

// ===== GET ALL VISITORS =====
exports.getAllVisitors = async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 10, search } = req.query;
    const now = new Date();
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let filter = {};

    if (status === "active") {
      filter = { qrExpiresAt: { $gt: now }, checkedIn: false };
    } else if (status === "expired") {
      filter = { qrExpiresAt: { $lt: now } };
    } else if (status === "checked-in") {
      filter = { checkedIn: true };
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      filter.$or = [
        { visitorName: searchRegex },
        { phoneNumber: searchRegex },
        { email: searchRegex },
        { company: searchRegex },
      ];
    }

    const [visitors, total] = await Promise.all([
      QRModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      QRModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      count: total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: visitors,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching visitors",
      error: error.message,
    });
  }
};

// ===== GET VISITOR BY ID =====
exports.getVisitorById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    res.status(200).json({
      success: true,
      data: visitor,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching visitor",
      error: error.message,
    });
  }
};

// ===== GET VISITOR BY TOKEN =====
exports.getVisitorByToken = async (req, res) => {
  try {
    const { token } = req.params;
    const now = new Date();

    const visitor = await QRModel.findOne({
      qrToken: token,
      qrExpiresAt: { $gt: now },
    });

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Invalid or expired QR token",
      });
    }

    res.status(200).json({
      success: true,
      data: visitor,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error validating QR token",
      error: error.message,
    });
  }
};

// ===== SEND QR WITH PDF VIA EMAIL =====
exports.sendQR = async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (visitor.isExpired()) {
      return res.status(400).json({
        success: false,
        message: "QR code has expired. Please generate a new one.",
      });
    }

    const recipientEmail = email || visitor.email;
    if (!recipientEmail) {
      return res.status(400).json({
        success: false,
        message: "Email address is required to send QR code",
      });
    }

    const tempPassword = generateTemporaryPassword();
    const visitorToken = generateVisitorToken(visitor._id);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    visitor.tempLoginToken = visitorToken;
    visitor.tempPasswordHash = hashedPassword;
    visitor.tempPasswordCreated = new Date();
    visitor.qrSentViaEmail = true;
    await visitor.save();

    const pdfBuffer = await generateVisitorPDF(visitor, visitor.qrCode);

    const mailOptions = {
      from: `"Visitor Management System" <${process.env.SMTP_FROM || "sonutech04@gmail.com"}>`,
      to: recipientEmail,
      subject: `📄 Your Visitor Pass with QR Code - ${visitor.visitorName}`,
      html: `
        <h1>Your Visitor Pass</h1>
        <p>Hello ${visitor.visitorName},</p>
        <p>Your visitor pass has been generated with a QR code.</p>
        <p><strong>Temporary Password:</strong> ${tempPassword}</p>
        <p><a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/visitor/login?token=${visitorToken}">Login to Visitor Portal</a></p>
      `,
      attachments: [
        {
          filename: `visitor_pass_${visitor.visitorName.replace(/\s/g, "_")}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    };

    await transporter.sendMail(mailOptions);

    visitor.lastQRSentAt = new Date();
    visitor.pdfSentAt = new Date();
    visitor.pdfDownloadCount = (visitor.pdfDownloadCount || 0) + 1;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "QR code sent successfully via email with PDF attachment",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        email: recipientEmail,
        expiresAt: visitor.qrExpiresAt,
        tempPassword: tempPassword,
        loginToken: visitorToken,
      },
    });
  } catch (error) {
    console.error("Error sending QR email:", error);
    res.status(500).json({
      success: false,
      message: "Error sending QR code",
      error: error.message,
    });
  }
};

// ===== RESEND QR VIA EMAIL =====
exports.resendQR = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (visitor.isExpired()) {
      return res.status(400).json({
        success: false,
        message: "QR code has expired. Please regenerate the QR code.",
      });
    }

    const recipientEmail = email || visitor.email;
    if (!recipientEmail) {
      return res.status(400).json({
        success: false,
        message: "Email address is required to resend QR code",
      });
    }

    let tempPassword = null;
    let visitorToken = visitor.tempLoginToken;

    const passwordAge = visitor.tempPasswordCreated
      ? (Date.now() - new Date(visitor.tempPasswordCreated).getTime()) /
        (1000 * 60)
      : 999;

    if (!visitor.tempLoginToken || passwordAge > 60) {
      tempPassword = generateTemporaryPassword();
      visitorToken = generateVisitorToken(visitor._id);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      visitor.tempLoginToken = visitorToken;
      visitor.tempPasswordHash = hashedPassword;
      visitor.tempPasswordCreated = new Date();
      await visitor.save();
    }

    const pdfBuffer = await generateVisitorPDF(visitor, visitor.qrCode);

    const mailOptions = {
      from: `"Visitor Management System" <${process.env.SMTP_FROM || "sonutech04@gmail.com"}>`,
      to: recipientEmail,
      subject: `📄 Resent: Your Visitor Pass with QR Code - ${visitor.visitorName}`,
      html: `<p>Your visitor pass has been resent.</p>`,
      attachments: [
        {
          filename: `visitor_pass_${visitor.visitorName.replace(/\s/g, "_")}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    };

    await transporter.sendMail(mailOptions);

    visitor.lastQRSentAt = new Date();
    visitor.pdfSentAt = new Date();
    visitor.pdfDownloadCount = (visitor.pdfDownloadCount || 0) + 1;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "QR code resent successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        email: recipientEmail,
        expiresAt: visitor.qrExpiresAt,
        ...(tempPassword && { tempPassword }),
      },
    });
  } catch (error) {
    console.error("Error resending QR:", error);
    res.status(500).json({
      success: false,
      message: "Error resending QR code",
      error: error.message,
    });
  }
};

// ===== VISITOR LOGIN =====
exports.visitorLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const visitor = await QRModel.findOne({
      email: email.toLowerCase().trim(),
      qrExpiresAt: { $gt: new Date() },
    });

    if (!visitor) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials or QR expired.",
      });
    }

    if (!visitor.tempPasswordHash) {
      return res.status(401).json({
        success: false,
        message: "No login credentials found.",
      });
    }

    const isValidPassword = await bcrypt.compare(
      password,
      visitor.tempPasswordHash,
    );
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid password.",
      });
    }

    const sessionToken = jwt.sign(
      {
        visitorId: visitor._id,
        email: visitor.email,
        type: "visitor",
        loginTime: Date.now(),
      },
      process.env.JWT_SECRET || "visitor_session_secret",
      { expiresIn: "24h" },
    );

    visitor.lastLoginAt = new Date();
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        visitorId: visitor._id,
        visitorName: visitor.visitorName,
        email: visitor.email,
        company: visitor.company,
        sessionToken,
        expiresAt: visitor.qrExpiresAt,
        checkedIn: visitor.checkedIn,
        qrToken: visitor.qrToken,
        qrCode: visitor.qrCode,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Error during login",
      error: error.message,
    });
  }
};

// ===== GET VISITOR DASHBOARD =====
exports.getVisitorDashboard = async (req, res) => {
  try {
    const visitorId = req.user?.visitorId || req.query.visitorId;

    if (!visitorId || !mongoose.Types.ObjectId.isValid(visitorId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(visitorId);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        visitorName: visitor.visitorName,
        email: visitor.email,
        phoneNumber: visitor.phoneNumber,
        company: visitor.company,
        purpose: visitor.purpose,
        checkedIn: visitor.checkedIn,
        checkedInAt: visitor.checkedInAt,
        qrExpiresAt: visitor.qrExpiresAt,
        qrCode: visitor.qrCode,
        qrToken: visitor.qrToken,
        createdAt: visitor.createdAt,
        lastLoginAt: visitor.lastLoginAt,
        pdfSentAt: visitor.pdfSentAt,
        isExpired: visitor.isExpired(),
      },
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard data",
      error: error.message,
    });
  }
};

// ===== CHECK-IN VISITOR =====
exports.checkInVisitor = async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (visitor.checkedIn) {
      return res.status(400).json({
        success: false,
        message: "Visitor already checked in",
      });
    }

    if (visitor.isExpired()) {
      return res.status(400).json({
        success: false,
        message: "QR code has expired.",
      });
    }

    if (token && visitor.qrToken !== token) {
      return res.status(401).json({
        success: false,
        message: "Invalid QR token",
      });
    }

    visitor.checkedIn = true;
    visitor.checkedInAt = new Date();
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Visitor checked in successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        phoneNumber: visitor.phoneNumber,
        checkedIn: visitor.checkedIn,
        checkedInAt: visitor.checkedInAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error during check-in",
      error: error.message,
    });
  }
};

// ===== CHECK-OUT VISITOR =====
exports.checkOutVisitor = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    visitor.checkedIn = false;
    visitor.idNumber = "";
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Visitor checked out and ID freed successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        checkedIn: visitor.checkedIn,
        idNumber: visitor.idNumber,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error during check-out",
      error: error.message,
    });
  }
};

// ===== REGENERATE QR =====
exports.regenerateQR = async (req, res) => {
  try {
    const { id } = req.params;
    const { expiryHours = 24 } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    const newToken = generateQRToken();
    const newQRCode = await generateQRCodeImage(newToken);

    visitor.qrToken = newToken;
    visitor.qrCode = newQRCode;
    visitor.qrExpiresAt = getExpiryDate(expiryHours);
    visitor.checkedIn = false;
    visitor.checkedInAt = null;
    visitor.tempLoginToken = null;
    visitor.tempPasswordHash = null;
    visitor.tempPasswordCreated = null;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "QR code regenerated successfully",
      data: {
        id: visitor._id,
        qrCode: visitor.qrCode,
        qrToken: visitor.qrToken,
        qrExpiresAt: visitor.qrExpiresAt,
        checkedIn: visitor.checkedIn,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Token conflict. Please try again.",
      });
    }
    res.status(500).json({
      success: false,
      message: "Error regenerating QR",
      error: error.message,
    });
  }
};

// ===== DELETE VISITOR =====
exports.deleteVisitor = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findByIdAndDelete(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Visitor deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting visitor",
      error: error.message,
    });
  }
};

// ===== BULK DELETE VISITORS =====
exports.bulkDeleteVisitors = async (req, res) => {
  try {
    const { type = "expired" } = req.query;
    let filter = {};

    if (type === "expired") {
      filter = { qrExpiresAt: { $lt: new Date() } };
    } else if (type === "checked-in") {
      filter = { checkedIn: true };
    } else if (type === "all") {
      filter = {};
    }

    const result = await QRModel.deleteMany(filter);

    res.status(200).json({
      success: true,
      message: `Deleted ${result.deletedCount} visitors`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting visitors",
      error: error.message,
    });
  }
};

// ===== SCAN QR =====
exports.scanVisitorQR = async (req, res) => {
  try {
    const token =
      req.params?.token ||
      req.body?.token ||
      req.body?.qrToken ||
      req.query?.token;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "QR token is required",
      });
    }

    const visitor = await findValidVisitorByToken(token);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "QR code is invalid or expired",
        isValid: false,
      });
    }

    res.status(200).json({
      success: true,
      message: "QR scanned successfully",
      isValid: true,
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        phoneNumber: visitor.phoneNumber,
        email: visitor.email || "",
        company: visitor.company || "",
        idNumber: visitor.idNumber || "",
        purpose: visitor.purpose || "Meeting",
        checkedIn: visitor.checkedIn || false,
        checkedInAt: visitor.checkedInAt || null,
        qrExpiresAt: visitor.qrExpiresAt,
        createdAt: visitor.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error scanning QR",
      error: error.message,
    });
  }
};

// ===== VALIDATE QR =====
exports.validateQR = async (req, res) => {
  try {
    const { token } = req.params;
    const visitor = await findValidVisitorByToken(token);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "QR code is invalid or expired",
        isValid: false,
      });
    }

    res.status(200).json({
      success: true,
      message: "QR code is valid",
      isValid: true,
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        phoneNumber: visitor.phoneNumber,
        checkedIn: visitor.checkedIn || false,
        expiresAt: visitor.qrExpiresAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error validating QR",
      error: error.message,
    });
  }
};

// ===== SCAN QR & GET COMPANY CABINETS =====
exports.scanAndGetCabinets = async (req, res) => {
  try {
    const token =
      req.params?.token ||
      req.body?.token ||
      req.body?.qrToken ||
      req.query?.token;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "QR token is required",
      });
    }

    const visitor = await findValidVisitorByToken(token);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "QR code is invalid or expired",
        isValid: false,
      });
    }

    const companyName = visitor.company ? visitor.company.trim() : "";
    let cabinets = [];

    if (companyName) {
      cabinets = await Cabinet.find({
        companyName: {
          $regex: new RegExp(
            `^${companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "i",
          ),
        },
        isActive: true,
      })
        .sort({ cabinetName: 1 })
        .lean();

      if (cabinets.length === 0) {
        cabinets = await Cabinet.find({
          companyName: { $regex: companyName, $options: "i" },
          isActive: true,
        })
          .sort({ cabinetName: 1 })
          .lean();
      }
    }

    const commonAreas = [
      { id: "wash_room", name: "Wash Room", type: "Common" },
      { id: "key_cabinet", name: "Key Cabinet", type: "Common" },
      { id: "noc_room", name: "NOC Room", type: "Common" },
      { id: "loading_area", name: "Loading Area", type: "Common" },
    ];

    res.status(200).json({
      success: true,
      message: "QR validated and company cabinets retrieved successfully",
      isValid: true,
      data: {
        visitor: {
          id: visitor._id,
          visitorName: visitor.visitorName,
          phoneNumber: visitor.phoneNumber,
          email: visitor.email || "",
          company: visitor.company || "",
          purpose: visitor.purpose || "Meeting",
          checkedIn: visitor.checkedIn || false,
          checkedInAt: visitor.checkedInAt || null,
          qrExpiresAt: visitor.qrExpiresAt,
        },
        cabinets: cabinets.map((c) => ({
          id: c._id,
          cabinetName: c.cabinetName,
          companyName: c.companyName,
        })),
        totalCabinets: cabinets.length,
        commonAreas: commonAreas,
      },
    });
  } catch (error) {
    console.error("Error scanning QR for cabinets:", error);
    res.status(500).json({
      success: false,
      message: "Error scanning QR and fetching cabinets",
      error: error.message,
    });
  }
};

// ===== GET VISITOR LOCATION =====
exports.getVisitorLocation = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (!visitor.idNumber || visitor.idNumber.trim() === "") {
      return res.status(404).json({
        success: false,
        message: "No ID/asset assigned to this visitor",
      });
    }

    const assets = await fetchAssetLocations();

    const matchedAsset = assets.find(
      (asset) =>
        asset.name === visitor.idNumber ||
        asset.mac === visitor.idNumber ||
        (asset.raw &&
          (asset.raw.name === visitor.idNumber ||
            asset.raw.mac === visitor.idNumber)),
    );

    if (!matchedAsset) {
      return res.status(404).json({
        success: false,
        message: "Asset location not found for this visitor",
      });
    }

    const rawData = matchedAsset.raw || matchedAsset;

    const targetX = 5525.298750495607;
    const targetY = 2491.837930104785;
    const distance =
      rawData.x && rawData.y
        ? Math.sqrt(
            Math.pow(rawData.x - targetX, 2) + Math.pow(rawData.y - targetY, 2),
          )
        : null;

    const proximityStatus =
      distance !== null
        ? distance < 100
          ? "Very Close"
          : distance < 300
            ? "Close"
            : distance < 500
              ? "Moderate"
              : "Far"
        : "Unknown";

    const stability = matchedAsset.stability || 1.0;
    const isStable = stability > 0.7;
    const beamAngle =
      rawData.beam !== undefined ? BEAM_ANGLES[rawData.beam] : null;

    const locationData = {
      visitor: {
        id: visitor._id,
        name: visitor.visitorName,
        phone: visitor.phoneNumber,
        email: visitor.email,
        company: visitor.company,
        idNumber: visitor.idNumber,
        purpose: visitor.purpose,
        checkedIn: visitor.checkedIn,
        checkedInAt: visitor.checkedInAt,
        qrExpiresAt: visitor.qrExpiresAt,
      },
      location: {
        x: rawData.x || null,
        y: rawData.y || null,
        name: rawData.name || matchedAsset.device_name,
        mac: rawData.mac,
        map_id: rawData.map_id,
        ap_mac: rawData.ap_mac,
        last_seen: rawData.last_seen,
        rssi: rawData.rssi,
        beam: rawData.beam,
        beam_angle: beamAngle,
        device_name: rawData.device_name,
        manufacture: rawData.manufacture,
        stability: stability,
        is_stable: isStable,
        smoothed_position: matchedAsset.position || null,
        ap_history: matchedAsset.apHistory || [],
      },
      target_coordinates: { x: targetX, y: targetY },
      distance: distance,
      proximity: proximityStatus,
      timestamp: new Date().toISOString(),
    };

    if (rawData.map_id) {
      const worldCoords = convertMistToWorld(
        rawData.x,
        rawData.y,
        rawData.map_id,
      );
      locationData.location.world_coordinates = worldCoords;
    }

    res.status(200).json({
      success: true,
      message: "Visitor location retrieved successfully",
      data: locationData,
    });
  } catch (error) {
    console.error("Error fetching visitor location:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching visitor location",
      error: error.message,
    });
  }
};

// ===== GET VISITOR CABINET =====
exports.getVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    if (!visitor.idNumber || visitor.idNumber.trim() === "") {
      return res.status(404).json({
        success: false,
        message: "No cabinet/asset assigned to this visitor",
      });
    }

    const assets = await fetchAssetLocations();

    const cabinet = assets.find(
      (asset) =>
        asset.name === visitor.idNumber || asset.mac === visitor.idNumber,
    );

    if (!cabinet) {
      return res.status(404).json({
        success: false,
        message: "Cabinet/asset not found in system",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        visitor: {
          id: visitor._id,
          name: visitor.visitorName,
          company: visitor.company,
        },
        cabinet: {
          id: cabinet.id,
          name: cabinet.name,
          mac: cabinet.mac,
          x: cabinet.x || null,
          y: cabinet.y || null,
          map_id: cabinet.map_id,
          last_seen: cabinet.last_seen,
          rssi: cabinet.rssi,
          device_name: cabinet.device_name,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching visitor cabinet:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching visitor cabinet",
      error: error.message,
    });
  }
};

// ===== UPDATE VISITOR CABINET =====
// exports.updateVisitorCabinet = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { idNumber, assetName } = req.body;

//     if (!mongoose.Types.ObjectId.isValid(id)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid visitor ID",
//       });
//     }

//     if (!idNumber && !assetName) {
//       return res.status(400).json({
//         success: false,
//         message: "idNumber or assetName is required",
//       });
//     }

//     const visitor = await QRModel.findById(id);

//     if (!visitor) {
//       return res.status(404).json({
//         success: false,
//         message: "Visitor not found",
//       });
//     }

//     visitor.idNumber = idNumber || assetName;
//     await visitor.save();

//     res.status(200).json({
//       success: true,
//       message: "Visitor cabinet updated successfully",
//       data: {
//         id: visitor._id,
//         visitorName: visitor.visitorName,
//         idNumber: visitor.idNumber,
//       },
//     });
//   } catch (error) {
//     console.error("Error updating visitor cabinet:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error updating visitor cabinet",
//       error: error.message,
//     });
//   }
// };
// Only the relevant function – replace in your file
exports.updateVisitorCabinet = async (req, res) => {
  try {
    const { id } = req.params;
    const { idNumber, assetName } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid visitor ID",
      });
    }

    if (!idNumber && !assetName) {
      return res.status(400).json({
        success: false,
        message: "idNumber or assetName is required",
      });
    }

    const visitor = await QRModel.findById(id);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        message: "Visitor not found",
      });
    }

    const newIdNumber = idNumber || assetName;

    // Verify asset exists in Mist
    try {
      const assets = await fetchAssetLocations();
      const assetExists = assets.some((asset) => {
        const rawData = asset.raw || asset;
        return rawData.name === newIdNumber || rawData.mac === newIdNumber;
      });

      if (!assetExists) {
        // Return a list of available assets to help the user
        const assetNames = assets
          .map((a) => a.raw?.name || a.name)
          .filter((name) => name);
        return res.status(400).json({
          success: false,
          message: `Asset "${newIdNumber}" not found in Mist system`,
          available_assets: assetNames,
        });
      }
    } catch (error) {
      console.warn("⚠️ Could not verify asset in Mist:", error.message);
      // Proceed anyway – the location endpoint will fail if asset not found
    }

    // Update idNumber (and other fields if your schema supports them)
    visitor.idNumber = newIdNumber;
    // Uncomment if your model has these fields:
    // visitor.mistAssetId = newIdNumber;
    // visitor.mistMacAddress = newIdNumber;
    await visitor.save();

    res.status(200).json({
      success: true,
      message: "Visitor cabinet updated successfully",
      data: {
        id: visitor._id,
        visitorName: visitor.visitorName,
        idNumber: visitor.idNumber,
      },
    });
  } catch (error) {
    console.error("❌ Error updating visitor cabinet:", error);
    res.status(500).json({
      success: false,
      message: "Error updating visitor cabinet",
      error: error.message,
    });
  }
};

// ===== GET ALL ASSET LOCATIONS =====
exports.getAllAssetLocations = async (req, res) => {
  try {
    const assets = await fetchAssetLocations();

    const formattedAssets = assets.map((asset) => {
      const rawData = asset.raw || asset;
      return {
        ...asset,
        raw: {
          x: rawData.x,
          y: rawData.y,
          name: rawData.name,
          mac: rawData.mac,
          map_id: rawData.map_id,
          ap_mac: rawData.ap_mac,
          rssi: rawData.rssi,
          beam: rawData.beam,
          beam_angle:
            rawData.beam !== undefined ? BEAM_ANGLES[rawData.beam] : null,
          last_seen: rawData.last_seen,
          device_name: rawData.device_name,
          manufacture: rawData.manufacture,
        },
        stability: asset.stability || 1.0,
        is_stable: (asset.stability || 1.0) > 0.7,
        ap_history: asset.apHistory || [],
      };
    });

    res.status(200).json({
      success: true,
      total: formattedAssets.length,
      data: formattedAssets,
    });
  } catch (error) {
    console.error("Error fetching asset locations:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching asset locations",
      error: error.message,
    });
  }
};

// ===== GET MAP DETAILS =====
exports.getMapDetails = async (req, res) => {
  try {
    const { mapId } = req.params;

    if (!mapId) {
      return res.status(400).json({
        success: false,
        message: "Map ID is required",
      });
    }

    const mapDetails = await fetchMapDetails(mapId);

    if (!mapDetails) {
      return res.status(404).json({
        success: false,
        message: "Map not found",
      });
    }

    const mapConfig = MAP_CONFIGS[mapId];

    res.status(200).json({
      success: true,
      data: {
        ...mapDetails,
        config: mapConfig || null,
      },
    });
  } catch (error) {
    console.error("Error fetching map details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching map details",
      error: error.message,
    });
  }
};

// ===== GET ASSET TRACKING STATE =====
exports.getAssetTrackingState = async (req, res) => {
  try {
    const states = AssetTracker.getAssetStates();

    const formattedStates = {};
    for (const [mac, state] of Object.entries(states)) {
      formattedStates[mac] = {
        device_name: state.device_name,
        position: state.position,
        stability: state.stability,
        is_stable: state.stability > 0.7,
        lastUpdate: state.lastUpdate,
        lastUpdateFormatted: new Date(state.lastUpdate).toISOString(),
        apHistory: state.apHistory || [],
      };
    }

    res.status(200).json({
      success: true,
      total: Object.keys(formattedStates).length,
      data: formattedStates,
    });
  } catch (error) {
    console.error("Error fetching tracking state:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching tracking state",
      error: error.message,
    });
  }
};

// ===== RESET ASSET TRACKING =====
exports.resetAssetTracking = async (req, res) => {
  try {
    const { mac } = req.params;

    if (!mac) {
      return res.status(400).json({
        success: false,
        message: "Asset MAC address is required",
      });
    }

    AssetTracker.resetAsset(mac);

    res.status(200).json({
      success: true,
      message: `Asset tracking reset for ${mac}`,
    });
  } catch (error) {
    console.error("Error resetting tracking:", error);
    res.status(500).json({
      success: false,
      message: "Error resetting tracking",
      error: error.message,
    });
  }
};
