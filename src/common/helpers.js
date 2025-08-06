/**
 * Recursively convert all object keys to camelCase
 * @param {any} obj
 * @returns {any}
 */
function toCamelCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  } else if (obj && typeof obj === "object") {
    return Object.keys(obj).reduce((acc, key) => {
      const camelKey = key
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase())
        .replace(/^([A-Z])/, (g) => g.toLowerCase());
      acc[camelKey] = toCamelCase(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

module.exports = { toCamelCase };
