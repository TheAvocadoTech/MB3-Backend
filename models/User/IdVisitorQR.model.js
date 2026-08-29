const mongoose = require("mongoose");

const QRSchema = new mongoose.Schema(
  {
    // ==========================
    // QR INFORMATION
    // ==========================
    qrCode: {
      type: String,
      default: "",
    },

    qrToken: {
      type: String,
      unique: true,
      sparse: true,
    },

    qrExpiresAt: {
      type: Date,
      default: null,
    },

    checkedIn: {
      type: Boolean,
      default: false,
    },

    checkedInAt: {
      type: Date,
      default: null,
    },

    checkedOutAt: {
      type: Date,
      default: null,
    },

    // ==========================
    // VISITOR INFORMATION
    // ==========================
    visitorName: {
      type: String,
      required: true,
      trim: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    company: {
      type: String,
      trim: true,
      default: "",
    },

    idNumber: {
      type: String,
      trim: true,
      default: "",
    },

    purpose: {
      type: String,
      enum: ["Meeting", "Interview", "Delivery", "Maintenance", "Other"],
      default: "Meeting",
    },

    // ==========================
    // MIST ASSET DETAILS
    // ==========================
    mistAssetId: {
      type: String,
      default: "",
      trim: true,
    },

    mistMacAddress: {
      type: String,
      default: "",
      trim: true,
    },

    // ==========================
    // DESTINATION
    // ==========================
    destination: {
      name: {
        type: String,
        default: "",
      },

      floor: {
        type: String,
        default: "",
      },

      cabinetId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Cabinet",
        default: null,
      },

      coordinates: {
        x: {
          type: Number,
          default: 0,
        },

        y: {
          type: Number,
          default: 0,
        },
      },
    },

    // ==========================
    // VISIT & LIFECYCLE
    // ==========================
    isOnVisit: {
      type: Boolean,
      default: false,
      index: true,
    },

    tagId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IdManagement",
      default: null,
    },

    tagNickname: {
      type: String,
      default: "",
    },

    tagMac: {
      type: String,
      default: "",
    },

    visitStartedAt: {
      type: Date,
      default: null,
    },

    visitEndedAt: {
      type: Date,
      default: null,
    },

    // ==========================
    // NAVIGATION
    // ==========================
    navigationStatus: {
      type: String,
      enum: ["Not Started", "In Progress", "Reached", "Cancelled"],
      default: "Not Started",
    },

    lastLocationSync: {
      type: Date,
      default: null,
    },

    // ==========================
    // EMAIL
    // ==========================
    lastQRSentAt: {
      type: Date,
      default: null,
    },

    qrSentViaEmail: {
      type: Boolean,
      default: false,
    },

    pdfSentAt: {
      type: Date,
      default: null,
    },

    pdfDownloadCount: {
      type: Number,
      default: 0,
    },

    // ==========================
    // LOGIN
    // ==========================
    tempLoginToken: {
      type: String,
      index: true,
      sparse: true,
    },

    tempPasswordHash: {
      type: String,
    },

    tempPasswordCreated: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// ==========================
// INDEXES
// ==========================

// Note: TTL index removed so visitors are permanent records
QRSchema.index({ phoneNumber: 1 });
QRSchema.index({ visitorName: 1 });
QRSchema.index({ isOnVisit: 1 });

QRSchema.index(
  { qrToken: 1 },
  {
    unique: true,
    sparse: true,
  },
);

QRSchema.index({
  email: 1,
});

QRSchema.index({
  tempLoginToken: 1,
});

QRSchema.index({
  mistMacAddress: 1,
});

QRSchema.index({
  mistAssetId: 1,
});

// ==========================
// METHODS
// ==========================

QRSchema.methods.isExpired = function () {
  if (!this.qrExpiresAt) return true;
  return new Date() > this.qrExpiresAt;
};

QRSchema.methods.canLogin = function () {
  return (
    this.isOnVisit &&
    !this.isExpired() &&
    this.tempPasswordHash &&
    this.tempLoginToken &&
    this.email
  );
};

QRSchema.methods.hasValidPDF = function () {
  return this.qrSentViaEmail && this.pdfSentAt && !this.isExpired();
};

module.exports = mongoose.model("QRModel", QRSchema);
