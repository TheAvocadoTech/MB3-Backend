// src/utils/coordinateUtils.js
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

function validateCoordinates(x_m, y_m, mapId) {
  const mapConfig = MAP_CONFIGS[mapId];
  if (!mapConfig) return { valid: true, message: "Unknown map" };

  const isValid =
    x_m >= 0 &&
    x_m <= mapConfig.width_m &&
    y_m >= 0 &&
    y_m <= mapConfig.height_m;

  return {
    valid: isValid,
    message: isValid ? "Valid coordinates" : "Coordinates outside map bounds",
    bounds: {
      minX: 0,
      maxX: mapConfig.width_m,
      minY: 0,
      maxY: mapConfig.height_m,
    },
  };
}

function metersToPixels(x_m, y_m, mapId) {
  const mapConfig = MAP_CONFIGS[mapId];
  if (!mapConfig) return null;

  return {
    x_px: x_m * mapConfig.ppm + mapConfig.origin_x,
    y_px: mapConfig.origin_y - y_m * mapConfig.ppm,
  };
}

function pixelsToMeters(x_px, y_px, mapId) {
  const mapConfig = MAP_CONFIGS[mapId];
  if (!mapConfig) return null;

  return {
    x_m: (x_px - mapConfig.origin_x) / mapConfig.ppm,
    y_m: (mapConfig.origin_y - y_px) / mapConfig.ppm,
  };
}

module.exports = {
  validateCoordinates,
  metersToPixels,
  pixelsToMeters,
  MAP_CONFIGS,
};
