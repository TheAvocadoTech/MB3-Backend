const mongoose = require("mongoose");
const dns = require("dns");
require("dotenv").config();

// Set Google Public DNS for SRV record resolution (fixes MongoDB Atlas SRV lookup issues)
dns.setServers(["8.8.8.8", "8.8.4.4"]);
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not defined in environment variables");
    }

    console.log("Attempting to connect to MongoDB...");

    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      dbName: "Navigation",
    });

    console.log("✅ MongoDB connected!");
    console.log("Host:", conn.connection.host);
    console.log("DB:", conn.connection.name);

    return conn;
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
