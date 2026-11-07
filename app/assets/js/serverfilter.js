/**
 * Which servers (profiles) of the distribution a player may see and use.
 *
 * Two OPBS-specific fields of distribution.json are taken into account:
 *  - restricted: account UUIDs allowed to see the server (empty or missing = everyone).
 *  - platforms:  OSes the server is shown on, as Node's process.platform values
 *                ("win32", "darwin", "linux"). Missing = every OS.
 */

/**
 * UUIDs may be written with or without dashes, compare them normalized.
 *
 * @param {string} uuid
 * @returns {string}
 */
function normalizeUuid(uuid) {
  return String(uuid).replace(/-/g, "").toLowerCase();
}

/**
 * @param {Object} rawServer The server object from distribution.json.
 * @returns {boolean} Whether the server is meant for the current OS.
 */
function isForCurrentPlatform(rawServer) {
  const platforms = rawServer.platforms;
  return (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.includes(process.platform)
  );
}

/**
 * @param {Object} rawServer The server object from distribution.json.
 * @param {Object|null} account The selected account (ConfigManager.getSelectedAccount()).
 * @returns {boolean} Whether the account may see the server.
 */
function isAllowedForAccount(rawServer, account) {
  const restricted = (rawServer.restricted ?? []).map(normalizeUuid);
  if (restricted.length === 0) {
    return true;
  }
  return account != null && restricted.includes(normalizeUuid(account.uuid));
}

/**
 * @param {Object} rawServer The server object from distribution.json.
 * @param {Object|null} account The selected account.
 * @returns {boolean} Whether the server should be listed and selectable.
 */
function isServerAvailable(rawServer, account) {
  return isForCurrentPlatform(rawServer) && isAllowedForAccount(rawServer, account);
}

/**
 * Pick the server to select by default for this OS and account.
 * Priority: a main server made specifically for this OS, then any available main
 * server, then any available server, then the distribution's main server.
 *
 * @param {Object} distro The HeliosDistribution.
 * @param {Object|null} account The selected account.
 * @returns {Object} The HeliosServer to select.
 */
function pickDefaultServer(distro, account) {
  const available = distro.servers.filter((s) =>
    isServerAvailable(s.rawServer, account)
  );
  const targetsThisOs = (s) =>
    Array.isArray(s.rawServer.platforms) &&
    s.rawServer.platforms.includes(process.platform);

  return (
    available.find((s) => s.rawServer.mainServer && targetsThisOs(s)) ??
    available.find((s) => s.rawServer.mainServer) ??
    available[0] ??
    distro.getMainServer()
  );
}

module.exports = {
  normalizeUuid,
  isServerAvailable,
  pickDefaultServer,
};
