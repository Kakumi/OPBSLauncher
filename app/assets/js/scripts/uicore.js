/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $ = require("jquery");
const { ipcRenderer, shell, webFrame } = require("electron");
const remote = require("@electron/remote");
const isDev = require("./assets/js/isdev");
const { LoggerUtil } = require("helios-core");
const Lang = require("./assets/js/langloader");

const loggerUICore = LoggerUtil.getLogger("UICore");
const loggerAutoUpdater = LoggerUtil.getLogger("AutoUpdater");

// Log deprecation and process warnings.
process.traceProcessWarnings = true;
process.traceDeprecation = true;

// Disable eval function.
// eslint-disable-next-line
window.eval = global.eval = function () {
  throw new Error("Sorry, this app does not support window.eval().");
};

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on("devtools-opened", () => {
  console.log(
    "%cThe console is dark and full of terrors.",
    "color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold"
  );
  console.log(
    "%cIf you've been told to paste something here, you're being scammed.",
    "font-size: 16px"
  );
  console.log(
    "%cUnless you know exactly what you're doing, close this window.",
    "font-size: 16px"
  );
});

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0);
webFrame.setVisualZoomLevelLimits(1, 1);

/**
 * Profile picture of an account, served by the "opbs-launcher" plugin of the
 * website: the avatar uploaded on opbluesea.fr, else the face of the OPBS skin,
 * else the face of the Microsoft skin.
 *
 * @param {Object} account An account from ConfigManager (uuid, displayName).
 * @returns {string}
 */
function opbsAvatarUrl(account) {
  return `https://opbluesea.fr/api/opbs-launcher/avatar/${
    account.uuid
  }?v=${Date.now()}`;
}

// Skin images come from the Azuriom "Skin API" plugin on opbluesea.fr, which may be
// unavailable. Images tagged with data-skin-fallback switch to that URL on error
// (the player's Microsoft skin from mineskin.eu) instead of showing broken.
// Inline onerror handlers are blocked by the CSP, hence this capture-phase listener.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (
      img instanceof HTMLImageElement &&
      img.dataset.skinFallback &&
      img.src !== img.dataset.skinFallback
    ) {
      img.src = img.dataset.skinFallback;
    }
  },
  true
);

// Initialize auto updates in production environments.
let updateCheckListener;
if (!isDev) {
  ipcRenderer.on("autoUpdateNotification", (event, arg, info) => {
    switch (arg) {
      case "checking-for-update":
        loggerAutoUpdater.info("Checking for update..");
        settingsUpdateButtonStatus(
          Lang.queryJS("uicore.autoUpdate.checkingForUpdateButton"),
          true
        );
        break;
      case "update-available":
        loggerAutoUpdater.info("New update available", info.version);

        if (process.platform === "darwin") {
          // Must match mac.artifactName in electron-builder.yml
          // ("One-Piece-Blue-Sea-setup-${arch}.${ext}"). Only x64 is built for
          // macOS (see electron-builder.yml), so arm64 installs are also sent to
          // the x64 build, which runs under Rosetta.
          info.darwindownload = `https://github.com/Kakumi/OPBSLauncher/releases/download/v${info.version}/One-Piece-Blue-Sea-setup-x64.dmg`;
          setUpdateState("available", info);
        } else if (launcherUpdate.state !== "ready") {
          // Windows / Linux: electron-updater downloads it in the background.
          setUpdateState("downloading", { ...info, percent: 0 });
        }

        populateSettingsUpdateInformation(info);
        break;
      case "download-progress":
        if (launcherUpdate.state === "downloading" && info) {
          setUpdateState("downloading", {
            ...launcherUpdate.info,
            percent: info.percent,
          });
        }
        break;
      case "update-downloaded":
        loggerAutoUpdater.info(
          "Update " + info.version + " ready to be installed."
        );
        settingsUpdateButtonStatus(
          Lang.queryJS("uicore.autoUpdate.installNowButton"),
          false,
          () => {
            if (!isDev) {
              ipcRenderer.send("autoUpdateAction", "installUpdateNow");
            }
          }
        );
        setUpdateState("ready", info);
        break;
      case "update-not-available":
        loggerAutoUpdater.info("No new update found.");
        settingsUpdateButtonStatus(
          Lang.queryJS("uicore.autoUpdate.checkForUpdatesButton")
        );
        break;
      case "ready":
        updateCheckListener = setInterval(() => {
          ipcRenderer.send("autoUpdateAction", "checkForUpdate");
        }, 1800000);
        ipcRenderer.send("autoUpdateAction", "checkForUpdate");
        break;
      case "realerror":
        // A failed download must not leave the banner stuck: the next check
        // (every 30 minutes) will try again.
        if (launcherUpdate.state === "downloading") {
          setUpdateState(null);
        }
        if (info != null && info.code != null) {
          if (info.code === "ERR_UPDATER_INVALID_RELEASE_FEED") {
            loggerAutoUpdater.info("No suitable releases found.");
          } else if (info.code === "ERR_XML_MISSED_ELEMENT") {
            loggerAutoUpdater.info("No releases found.");
          } else {
            loggerAutoUpdater.error("Error during update check..", info);
            loggerAutoUpdater.debug("Error Code:", info.code);
          }
        }
        break;
      default:
        loggerAutoUpdater.info("Unknown argument", arg);
        break;
    }
  });
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 *
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val) {
  ipcRenderer.send("autoUpdateAction", "allowPrereleaseChange", val);
}

/**
 * Launcher update state, shown by the banner of the title bar (frameUpdate.ejs)
 * and checked before launching the game (see the launch button in landing.js).
 *
 * state: null (up to date), "downloading" (Windows / Linux, background download),
 * "ready" (downloaded, installed on restart), "available" (macOS, manual .dmg).
 */
const launcherUpdate = { state: null, info: null, promptShown: false };

/**
 * Install the pending launcher update: restart and install (Windows / Linux), or
 * open the .dmg download page (macOS).
 */
function installLauncherUpdate() {
  if (launcherUpdate.state === "ready") {
    if (isDev) {
      loggerAutoUpdater.warn("Cannot install updates in development environment.");
      return;
    }
    ipcRenderer.send("autoUpdateAction", "installUpdateNow");
  } else if (
    launcherUpdate.state === "available" &&
    launcherUpdate.info &&
    launcherUpdate.info.darwindownload
  ) {
    shell.openExternal(launcherUpdate.info.darwindownload);
  }
}

/**
 * Update the banner of the title bar.
 *
 * @param {string|null} state See launcherUpdate.
 * @param {Object} info Update info from electron-updater (version, percent...).
 */
function setUpdateState(state, info) {
  launcherUpdate.state = state;
  if (info) {
    launcherUpdate.info = info;
  }
  const banner = document.getElementById("updateBanner");
  if (banner == null) {
    return;
  }
  if (state == null) {
    banner.style.display = "none";
    banner.removeAttribute("data-state");
    return;
  }
  const version = (launcherUpdate.info && launcherUpdate.info.version) || "";
  const text = document.getElementById("updateBannerText");
  const button = document.getElementById("updateBannerButton");
  if (state === "downloading") {
    const percent = Math.max(
      0,
      Math.min(100, Math.round((launcherUpdate.info && launcherUpdate.info.percent) || 0))
    );
    text.textContent = Lang.queryJS("uicore.autoUpdate.bannerDownloading", {
      version,
      percent,
    });
    document.getElementById("updateBannerProgressFill").style.width = percent + "%";
  } else if (state === "ready") {
    text.textContent = Lang.queryJS("uicore.autoUpdate.bannerReady", { version });
    button.textContent = Lang.queryJS("uicore.autoUpdate.bannerReadyButton");
  } else if (state === "available") {
    text.textContent = Lang.queryJS("uicore.autoUpdate.bannerAvailable", { version });
    button.textContent = Lang.queryJS("uicore.autoUpdate.bannerDownloadButton");
  }
  button.onclick = () => {
    button.blur();
    installLauncherUpdate();
  };
  if (banner.getAttribute("data-state") !== state) {
    banner.setAttribute("data-state", state);
  }
  banner.style.display = "flex";
}

/**
 * Before launching the game: if a launcher update is ready (or available on
 * macOS), offer to install it first. Shown once per session; "Play anyway"
 * continues with the launch.
 *
 * @param {function} launch Starts the game.
 * @returns {boolean} True if the prompt was shown (the launch waits for it).
 */
function promptLauncherUpdateBeforeLaunch(launch) {
  if (
    launcherUpdate.promptShown ||
    (launcherUpdate.state !== "ready" && launcherUpdate.state !== "available")
  ) {
    return false;
  }
  launcherUpdate.promptShown = true;
  const version = (launcherUpdate.info && launcherUpdate.info.version) || "";
  const ready = launcherUpdate.state === "ready";
  setOverlayContent(
    Lang.queryJS("uicore.autoUpdate.promptTitle"),
    Lang.queryJS(
      ready ? "uicore.autoUpdate.promptReadyDesc" : "uicore.autoUpdate.promptAvailableDesc",
      { version }
    ),
    Lang.queryJS(
      ready ? "uicore.autoUpdate.bannerReadyButton" : "uicore.autoUpdate.bannerDownloadButton"
    ),
    Lang.queryJS("uicore.autoUpdate.promptPlayAnyway")
  );
  setOverlayHandler(() => {
    toggleOverlay(false);
    installLauncherUpdate();
  });
  setDismissHandler(() => {
    toggleOverlay(false);
    launch();
  });
  toggleOverlay(true, true);
  return true;
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener(
  "readystatechange",
  function () {
    if (document.readyState === "interactive") {
      loggerUICore.info("UICore Initializing..");

      // Bind close button.
      Array.from(document.getElementsByClassName("fCb")).map((val) => {
        val.addEventListener("click", (e) => {
          const window = remote.getCurrentWindow();
          window.close();
        });
      });

      // Bind restore down button.
      Array.from(document.getElementsByClassName("fRb")).map((val) => {
        val.addEventListener("click", (e) => {
          const window = remote.getCurrentWindow();
          if (window.isMaximized()) {
            window.unmaximize();
          } else {
            window.maximize();
          }
          document.activeElement.blur();
        });
      });

      // Maximize / restore icon follows the window state.
      const syncMaximizedIcon = () => {
        const maximized = remote.getCurrentWindow().isMaximized();
        Array.from(document.getElementsByClassName("fRb")).forEach((val) =>
          val.toggleAttribute("maximized", maximized)
        );
      };
      remote.getCurrentWindow().on("maximize", syncMaximizedIcon);
      remote.getCurrentWindow().on("unmaximize", syncMaximizedIcon);
      window.addEventListener("beforeunload", () => {
        remote.getCurrentWindow().removeListener("maximize", syncMaximizedIcon);
        remote.getCurrentWindow().removeListener("unmaximize", syncMaximizedIcon);
      });
      syncMaximizedIcon();

      // Bind minimize button.
      Array.from(document.getElementsByClassName("fMb")).map((val) => {
        val.addEventListener("click", (e) => {
          const window = remote.getCurrentWindow();
          window.minimize();
          document.activeElement.blur();
        });
      });

      // Remove focus from social media buttons once they're clicked.
      Array.from(document.getElementsByClassName("mediaURL")).map((val) => {
        val.addEventListener("click", (e) => {
          document.activeElement.blur();
        });
      });
    } else if (document.readyState === "complete") {
      //266.01
      //170.8
      //53.21
      // Bind progress bar length to length of bot wrapper
      //const targetWidth = document.getElementById("launch_content").getBoundingClientRect().width
      //const targetWidth2 = document.getElementById("server_selection").getBoundingClientRect().width
      //const targetWidth3 = document.getElementById("launch_button").getBoundingClientRect().width

      document.getElementById("launch_details").style.maxWidth = 266.01;
      document.getElementById("launch_progress").style.width = 170.8;
      document.getElementById("launch_details_right").style.maxWidth = 170.8;
      document.getElementById("launch_progress_label").style.width = 53.21;
    }
  },
  false
);

/**
 * Open web links in the user's default browser.
 */
$(document).on("click", 'a[href^="http"]', function (event) {
  event.preventDefault();
  shell.openExternal(this.href);
});

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code.
 */
document.addEventListener("keydown", function (e) {
  if ((e.key === "I" || e.key === "i") && e.ctrlKey && e.shiftKey) {
    let window = remote.getCurrentWindow();
    window.toggleDevTools();
  }
});
