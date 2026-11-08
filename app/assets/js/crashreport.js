/**
 * Crash reports: when the game closes with an error, the player can send what
 * explains the crash to the staff. It goes through the "opbs-launcher" plugin of
 * the website (which forwards it to a staff Discord channel), authenticated with
 * the player's Minecraft session like the skin upload.
 */
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const ENDPOINT = "https://opbluesea.fr/api/opbs-launcher/crash-report";

// Keeps the request small. A crash report fits easily; the log keeps its end.
const MAX_CHARS = 150000;

/**
 * Newest file of a folder modified since a date, or null.
 */
function newestSince(dir, since, extension) {
  if (!fs.existsSync(dir)) {
    return null;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(extension))
    .map((f) => ({ file: path.join(dir, f), time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((f) => f.time >= since)
    .sort((a, b) => b.time - a.time);
  return files.length > 0 ? files[0].file : null;
}

/**
 * Find what explains the crash: the crash report written by Minecraft/Forge
 * during this session, else the end of the game log.
 *
 * @param {string} instanceDir The instance folder of the server.
 * @param {number} since When the game was launched (ms timestamp).
 * @returns {{name: string, content: string, isCrashReport: boolean} | null}
 */
exports.findCrashLog = function (instanceDir, since) {
  const margin = since - 5000;

  const report = newestSince(path.join(instanceDir, "crash-reports"), margin, ".txt");
  if (report != null) {
    // The start of a crash report holds the description and the stack trace.
    return {
      name: path.basename(report),
      content: fs.readFileSync(report, "utf-8").substring(0, MAX_CHARS),
      isCrashReport: true,
    };
  }

  const log = path.join(instanceDir, "logs", "latest.log");
  if (fs.existsSync(log) && fs.statSync(log).mtimeMs >= margin) {
    const content = fs.readFileSync(log, "utf-8");
    return {
      name: "latest.log",
      content: content.substring(Math.max(0, content.length - MAX_CHARS)),
      isCrashReport: false,
    };
  }
  return null;
};

/**
 * Send a crash log to the staff.
 *
 * @param {Object} params
 * @param {string} params.accessToken Minecraft session token of the player.
 * @param {string} params.serverName Name of the server profile.
 * @param {string} params.launcherVersion
 * @param {number|null} params.exitCode Exit code of the game.
 * @param {{name: string, content: string}} params.log From findCrashLog().
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
exports.send = async function ({ accessToken, serverName, launcherVersion, exitCode, log }) {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        server: serverName,
        launcher_version: launcherVersion,
        os: `${os.type()} ${os.release()} (${process.arch})`,
        exit_code: exitCode,
        file_name: log.name,
        log: log.content,
      }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      // Not JSON (e.g. an HTML error page).
    }
    return { ok: res.ok, message: data?.message };
  } catch (err) {
    return { ok: false, message: err.message };
  }
};
