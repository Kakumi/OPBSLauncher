/**
 * Performance mode: lighter graphics for small PCs.
 *
 * Applied right before the game starts. It edits the game option files of the
 * instance (the distribution never overwrites them, they are "untracked"):
 * shaders off, fast graphics, short render distance... The player's own values
 * are saved first and restored when the mode is turned off.
 */
const fs = require("fs-extra");
const path = require("path");
const { LoggerUtil } = require("helios-core");

const logger = LoggerUtil.getLogger("PerformanceMode");

const BACKUP_FILE = "opbs-performance-backup.json";

/** Values applied per option file. */
const PRESET = {
  // Vanilla options, "key:value".
  "options.txt": {
    renderDistance: "6",
    particles: "2", // Minimal
    fancyGraphics: "false",
    ao: "0", // Smooth lighting off
    renderClouds: "false",
    mipmapLevels: "0",
    entityShadows: "false",
  },
  // OptiFine options, "key:value".
  "optionsof.txt": {
    ofFastRender: "true",
    ofFastMath: "true",
    ofRenderRegions: "true",
    ofSmoothFps: "false",
    ofDynamicLights: "3", // Off
    ofClouds: "3", // Off
    ofTrees: "1", // Fast
    ofDroppedItems: "1", // Fast
    ofRain: "1", // Fast
    ofBetterGrass: "3", // Off
  },
  // OptiFine shaders, "key=value".
  "optionsshaders.txt": {
    shaderPack: "OFF",
  },
};

function separatorOf(file) {
  return file === "optionsshaders.txt" ? "=" : ":";
}

/**
 * @returns {Map<string, string>} Options of a file, in file order.
 */
function readOptions(filePath, separator) {
  const options = new Map();
  if (!fs.existsSync(filePath)) {
    return options;
  }
  for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const i = line.indexOf(separator);
    if (i > 0 && !line.startsWith("#")) {
      options.set(line.substring(0, i), line.substring(i + 1));
    }
  }
  return options;
}

/**
 * Set some options of a file, keeping every other line as it is.
 */
function writeOptions(filePath, separator, values) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  // Keep the file's own line endings (Minecraft writes CRLF on Windows).
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const i = line.indexOf(separator);
    if (i > 0 && !line.startsWith("#")) {
      const key = line.substring(0, i);
      if (pending.has(key)) {
        const value = pending.get(key);
        pending.delete(key);
        return `${key}${separator}${value}`;
      }
    }
    return line;
  });
  // Keys missing from the file are appended.
  for (const [key, value] of pending) {
    const at = updated.length > 0 && updated[updated.length - 1] === "" ? updated.length - 1 : updated.length;
    updated.splice(at, 0, `${key}${separator}${value}`);
  }
  fs.outputFileSync(filePath, updated.join(eol), "utf-8");
}

/**
 * Apply or remove the performance preset on an instance.
 *
 * @param {string} instanceDir The instance folder of the server
 * (<instances>/<server id>).
 * @param {boolean} enabled Whether the performance mode is on.
 */
exports.apply = function (instanceDir, enabled) {
  const backupPath = path.join(instanceDir, BACKUP_FILE);
  try {
    if (enabled) {
      // First activation: save the player's values to restore them later.
      if (!fs.existsSync(backupPath)) {
        const backup = {};
        for (const [file, values] of Object.entries(PRESET)) {
          const current = readOptions(path.join(instanceDir, file), separatorOf(file));
          backup[file] = {};
          for (const key of Object.keys(values)) {
            backup[file][key] = current.has(key) ? current.get(key) : null;
          }
        }
        fs.outputJsonSync(backupPath, backup, { spaces: 2 });
      }
      // Applied on every launch: options changed in game are reset while the mode is on.
      for (const [file, values] of Object.entries(PRESET)) {
        writeOptions(path.join(instanceDir, file), separatorOf(file), values);
      }
      logger.info("Performance mode applied.");
    } else if (fs.existsSync(backupPath)) {
      const backup = fs.readJsonSync(backupPath);
      for (const [file, values] of Object.entries(backup)) {
        const restore = Object.fromEntries(
          Object.entries(values).filter(([, value]) => value !== null)
        );
        writeOptions(path.join(instanceDir, file), separatorOf(file), restore);
      }
      fs.removeSync(backupPath);
      logger.info("Performance mode removed, player options restored.");
    }
  } catch (err) {
    // Never block the launch because of this.
    logger.error("Could not apply the performance mode:", err);
  }
};
