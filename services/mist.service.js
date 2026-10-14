// index.js or main application file
const assetTracker = require("./src/services/mistAssetTracker");

// Example usage with polling
async function updateAssets() {
  try {
    // ✅ FIXED: getAssetsCached() is the raw-mode public API
    const processedAssets = await assetTracker.getAssetsCached({ force: true });

    // Process the smoothed asset data
    console.log(`Processed ${processedAssets.length} assets`);

    // Access individual asset states
    // NOTE: raw-mode tracker returns {} here (no in-memory state).
    //       Use processedAssets[] instead — it already has position + rssi.
    const allStates = assetTracker.getAssetStates();
    for (const [mac, state] of Object.entries(allStates)) {
      console.log(`Asset ${mac}:`, {
        position: state.position,
        stability: state.stabilityScore,
        lastUpdate: new Date(state.lastUpdate).toISOString(),
      });
    }

    return processedAssets;
  } catch (error) {
    console.error("Failed to update assets:", error);
    throw error;
  }
}

// Listen for real-time asset updates
assetTracker.on("assetUpdate", (update) => {
  console.log(`Asset ${update.mac} updated:`, {
    position: update.position,
    stability: update.stability,
    ap: update.primary_ap_mac, // ✅ changed: raw mode uses primary_ap_mac
    rssi: update.rssi, // ✅ changed: raw mode exposes rssi at top level
  });

  // You can emit this to your frontend via WebSocket
  // socketIo.emit('assetLocation', update);
});

// Run update every 5 seconds
setInterval(updateAssets, 2000);

// Initial update
updateAssets();

// Export for use in other modules
module.exports = {
  assetTracker,
  updateAssets,
};
