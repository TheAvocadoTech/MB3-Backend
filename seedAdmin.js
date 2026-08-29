require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/user.model");

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    // remove old admin if exists
    await User.deleteOne({ role: "ADMIN" });

    const admin = new User({
      name: "Super Admin",
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD, // ✅ plain text (model will hash)
      phoneNumber: process.env.ADMIN_PHONE,
      role: "ADMIN",
      isAdmin: true,
      isVerified: true,
    });

    await admin.save();

    console.log("✅ Admin seeded successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err.message);
    process.exit(1);
  }
};

seedAdmin();
