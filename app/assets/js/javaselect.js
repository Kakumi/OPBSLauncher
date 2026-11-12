/**
 * Java selection: helios-core's discoverBestJvmInstallation / validateSelectedJvm
 * with an architecture check for macOS.
 *
 * The macOS launcher is built for x64 only (see electron-builder.yml) and runs
 * under Rosetta on Apple Silicon, because Minecraft 1.12.2 uses LWJGL 2 whose
 * natives are x86_64 only. helios-core only checks the JVM architecture on arm64
 * builds, so the x64 build happily picked an arm64 Java (Oracle's
 * JavaAppletPlugin 8u511 on an M2, crash of 2026-11-12) and the game died with
 * "UnsatisfiedLinkError: no lwjgl in java.library.path".
 * On macOS only x86_64 JVMs are accepted; when none is installed the launcher
 * offers to download one (latestOpenJDK follows process.arch = x64).
 */
const { pathExists } = require("fs-extra");
const { LoggerUtil } = require("helios-core");
const {
  getValidatableJavaPaths,
  resolveJvmSettings,
  filterApplicableJavaPaths,
  rankApplicableJvms,
} = require("helios-core/java");

const logger = LoggerUtil.getLogger("JavaSelect");

const X64_ARCHS = ["x86_64", "amd64"];

function keepUsableArch(resolvedSettings) {
  if (process.platform !== "darwin") {
    return resolvedSettings;
  }
  const kept = {};
  for (const [path, settings] of Object.entries(resolvedSettings)) {
    if (X64_ARCHS.includes(settings["os.arch"])) {
      kept[path] = settings;
    } else {
      logger.warn(
        `Ignoring ${settings["os.arch"]} Java at '${path}': Minecraft 1.12.2 needs an x86_64 Java on macOS.`,
      );
    }
  }
  return kept;
}

function bestOf(resolvedSettings, semverRange) {
  const details = filterApplicableJavaPaths(
    keepUsableArch(resolvedSettings),
    semverRange,
  );
  rankApplicableJvms(details);
  return details.length > 0 ? details[0] : null;
}

async function discoverBestJvmInstallation(dataDir, semverRange) {
  const paths = [...new Set(await getValidatableJavaPaths(dataDir))];
  return bestOf(await resolveJvmSettings(paths), semverRange);
}

async function validateSelectedJvm(path, semverRange) {
  if (!(await pathExists(path))) {
    return null;
  }
  return bestOf(await resolveJvmSettings([path]), semverRange);
}

module.exports = { discoverBestJvmInstallation, validateSelectedJvm };
