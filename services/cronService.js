// services/cronService.js
const QRModel = require("../models/User/IdVisitorQR.model");
const IdManagement = require("../models/IDManagement.model");

/**
 * Perform 12:00 AM auto-release of all active visits and BLE tags
 */
async function releaseAllTagsAndVisits() {
  try {
    console.log(
      "🕛 [Midnight Auto-Release] Running 12:00 AM Tag & Visit Relief Job...",
    );

    // 1. Find and close all active visits
    const visitorResult = await QRModel.updateMany(
      { $or: [{ isOnVisit: true }, { checkedIn: true }] },
      {
        $set: {
          isOnVisit: false,
          checkedIn: false,
          company: "",
          idNumber: "",
          tagId: null,
          tagNickname: "",
          tagMac: "",
          mistMacAddress: "",
          qrCode: "",
          visitEndedAt: new Date(),
        },
        $unset: {
          qrToken: 1,
          tempLoginToken: 1,
          tempPasswordHash: 1,
        },
      },
    );

    // 2. Free all tags in ID Management
    const tagResult = await IdManagement.updateMany(
      { status: { $in: ["In Use", "Active"] } },
      {
        $set: {
          status: "Available",
          assignedVisitor: null,
          assignedVisitorName: "",
          assignedAt: null,
        },
      },
    );

    console.log(
      `✅ [Midnight Auto-Release] Completed successfully: ${visitorResult.modifiedCount} active visits closed, ${tagResult.modifiedCount} tags returned to Available.`,
    );
  } catch (error) {
    console.error("❌ [Midnight Auto-Release Error]:", error);
  }
}

/**
 * Ensure default physical Mist tags exist on startup
 */
async function seedDefaultTags() {
  try {
    const defaultTags = [
      {
        macAddress: "ea2671f0003d",
        name: "ER-BLE1-26G003d",
        nickname: "Tag 1",
        status: "Available",
        isActive: true,
      },
      {
        macAddress: "ea2671f0003e",
        name: "ER-BLE1-26G003e",
        nickname: "Tag 2",
        status: "Available",
        isActive: true,
      },
    ];

    for (const tag of defaultTags) {
      const exists = await IdManagement.findOne({ macAddress: tag.macAddress });
      if (!exists) {
        await IdManagement.create(tag);
        console.log(
          `🏷️ [Tag Setup] Created default BLE tag: ${tag.nickname} (${tag.macAddress})`,
        );
      }
    }
  } catch (err) {
    console.error("Error seeding default tags:", err.message);
  }
}

/**
 * Ensure legacy MongoDB TTL indexes are dropped so visitors are never deleted
 */
async function dropLegacyTTLIndexes() {
  try {
    const indexes = await QRModel.collection.indexes();
    for (const idx of indexes) {
      if (
        idx.expireAfterSeconds !== undefined ||
        idx.name === "qrExpiresAt_1"
      ) {
        await QRModel.collection.dropIndex(idx.name);
        console.log(
          `🛡️ [Database Protection] Dropped legacy TTL index "${idx.name}" from visitors collection.`,
        );
      }
      if (idx.name === "qrToken_1" && !idx.sparse) {
        await QRModel.collection.dropIndex("qrToken_1").catch(() => {});
        await QRModel.collection.createIndex(
          { qrToken: 1 },
          { unique: true, sparse: true },
        ).catch(() => {});
        console.log(`🛡️ [Database Protection] Recreated "qrToken_1" as sparse unique index.`);
      }
    }
  } catch (err) {
    if (err.codeName !== "IndexNotFound") {
      console.warn("Index check note:", err.message);
    }
  }
}

/**
 * Schedule the midnight cron job to run precisely at 00:00:00 every day
 */
function initMidnightCron() {
  // Drop any legacy TTL index that auto-deletes visitors
  dropLegacyTTLIndexes();

  // Check and seed default tags
  seedDefaultTags();

  function scheduleNextMidnight() {
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1, // Next day
      0,
      0,
      0,
      0, // 12:00:00.000 AM
    );

    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    console.log(
      `⏱️ [Cron Service] Midnight Auto-Release scheduled in ${(msUntilMidnight / (1000 * 60 * 60)).toFixed(2)} hours (at ${nextMidnight.toLocaleTimeString()})`,
    );

    setTimeout(async () => {
      await releaseAllTagsAndVisits();
      // Reschedule for next midnight
      scheduleNextMidnight();
    }, msUntilMidnight);
  }

  scheduleNextMidnight();
}

module.exports = {
  initMidnightCron,
  releaseAllTagsAndVisits,
  seedDefaultTags,
};
