// models/IdManagement.model.js
const mongoose = require("mongoose");

const idManagementSchema = new mongoose.Schema(
  {
    // BLE Tag MAC address (e.g. ea2671f0003d)
    macAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    // Device Name in Mist (e.g. ER-BLE1-26G003d)
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Friendly Nickname (e.g. Tag 1, Visitor Tag A)
    nickname: {
      type: String,
      required: true,
      trim: true,
    },

    // Current availability status
    status: {
      type: String,
      enum: ["Available", "In Use", "Maintenance", "Active", "Expired", "Revoked"],
      default: "Available",
    },

    // Assigned visitor reference if currently in use
    assignedVisitor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QRModel",
      default: null,
    },

    assignedVisitorName: {
      type: String,
      default: "",
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

idManagementSchema.index({ macAddress: 1 });
idManagementSchema.index({ name: 1 });
idManagementSchema.index({ status: 1 });

module.exports = mongoose.model("IdManagement", idManagementSchema);

