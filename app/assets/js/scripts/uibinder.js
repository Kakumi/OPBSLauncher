/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const fs = require("fs");
const path = require("path");
const { Type } = require("helios-distribution-types");

const AuthManager = require("./assets/js/authmanager");
const ConfigManager = require("./assets/js/configmanager");
const { DistroAPI } = require("./assets/js/distromanager");

let rscShouldLoad = false;
let fatalStartupError = false;

const musicFolder = path.join(__dirname, "assets", "musics");
const videoFolder = path.join(__dirname, "assets", "videos");
let lastTrackPath = null;

// Mapping of each view to their container IDs.
const VIEWS = {
  landing: "#landingContainer",
  loginOptions: "#loginOptionsContainer",
  login: "#loginContainer",
  settings: "#settingsContainer",
  welcome: "#welcomeContainer",
  waiting: "#waitingContainer",
};

// The currently shown view container.
let currentView;

/**
 * Switch launcher views.
 *
 * @param {string} current The ID of the current view container.
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
function switchView(
  current,
  next,
  currentFadeTime = 500,
  nextFadeTime = 500,
  onCurrentFade = () => {},
  onNextFade = () => {}
) {
  currentView = next;
  $(`${current}`).fadeOut(currentFadeTime, async () => {
    await onCurrentFade();
    $(`${next}`).fadeIn(nextFadeTime, async () => {
      await onNextFade();
    });
  });
}

/**
 * Get the currently shown view container.
 *
 * @returns {string} The currently shown view container.
 */
function getCurrentView() {
  return currentView;
}

async function showMainUI(data) {
  if (!isDev) {
    loggerAutoUpdater.info("Initializing..");
    ipcRenderer.send(
      "autoUpdateAction",
      "initAutoUpdater",
      ConfigManager.getAllowPrerelease()
    );
  }

  await prepareSettings(true);
  updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()));
  refreshServerStatus();
  setTimeout(() => {
    document.getElementById("frameBar").style.backgroundColor =
      "rgba(0, 0, 0, 0.5)";
    $("#main").show();

    const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0;

    // If this is enabled in a development environment we'll get ratelimited.
    // The relaunch frequency is usually far too high.
    if (!isDev && isLoggedIn) {
      validateSelectedAccount();
    }

    if (ConfigManager.isFirstLaunch()) {
      currentView = VIEWS.welcome;
      $(VIEWS.welcome).fadeIn(1000);
    } else {
      if (isLoggedIn) {
        currentView = VIEWS.landing;
        $(VIEWS.landing).fadeIn(1000);
      } else {
        loginOptionsCancelEnabled(false);
        loginOptionsViewOnLoginSuccess = VIEWS.landing;
        loginOptionsViewOnLoginCancel = VIEWS.loginOptions;
        currentView = VIEWS.loginOptions;
        $(VIEWS.loginOptions).fadeIn(1000);
      }
    }

    setTimeout(() => {
      $("#loadingContainer").fadeOut(500, () => {
        $("#loadSpinnerImage").removeClass("rotating");
      });
    }, 250);
  }, 750);
  // Disable tabbing to the news container.
  initNews().then(() => {
    $("#newsContainer *").attr("tabindex", "-1");
  });
}

function showFatalStartupError() {
  setTimeout(() => {
    $("#loadingContainer").fadeOut(250, () => {
      document.getElementById("overlayContainer").style.background = "none";
      setOverlayContent(
        Lang.queryJS("uibinder.startup.fatalErrorTitle"),
        Lang.queryJS("uibinder.startup.fatalErrorMessage"),
        Lang.queryJS("uibinder.startup.closeButton")
      );
      setOverlayHandler(() => {
        const window = remote.getCurrentWindow();
        window.close();
      });
      toggleOverlay(true);
    });
  }, 750);
}

// Save distro
let distro = null;
// Is DiscordRPC enabled
let hasRPC = false;

/**
 * Common functions to perform after refreshing the distro index.
 *
 * @param {Object} data The distro index object.
 */
function onDistroRefresh(data) {
  distro = data;
  updateSelectedServer(data.getServerById(ConfigManager.getSelectedServer()));
  updateDiscordRpc();
  refreshServerStatus();
  initNews();
  syncModConfigurations(data);
  ensureJavaSettings(data);
}

/**
 * Sync the mod configurations with the distro index.
 *
 * @param {Object} data The distro index object.
 */
function syncModConfigurations(data) {
  const syncedCfgs = [];

  for (let serv of data.servers) {
    const id = serv.rawServer.id;
    const mdls = serv.modules;
    const cfg = ConfigManager.getModConfiguration(id);

    if (cfg != null) {
      const modsOld = cfg.mods;
      const mods = {};

      for (let mdl of mdls) {
        const type = mdl.rawModule.type;

        if (
          type === Type.ForgeMod ||
          type === Type.LiteMod ||
          type === Type.LiteLoader ||
          type === Type.FabricMod
        ) {
          if (!mdl.getRequired().value) {
            const mdlID = mdl.getVersionlessMavenIdentifier();
            if (modsOld[mdlID] == null) {
              mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl);
            } else {
              mods[mdlID] = mergeModConfiguration(
                modsOld[mdlID],
                scanOptionalSubModules(mdl.subModules, mdl),
                false
              );
            }
          } else {
            if (mdl.subModules.length > 0) {
              const mdlID = mdl.getVersionlessMavenIdentifier();
              const v = scanOptionalSubModules(mdl.subModules, mdl);
              if (typeof v === "object") {
                if (modsOld[mdlID] == null) {
                  mods[mdlID] = v;
                } else {
                  mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true);
                }
              }
            }
          }
        }
      }

      syncedCfgs.push({
        id,
        mods,
      });
    } else {
      const mods = {};

      for (let mdl of mdls) {
        const type = mdl.rawModule.type;
        if (
          type === Type.ForgeMod ||
          type === Type.LiteMod ||
          type === Type.LiteLoader ||
          type === Type.FabricMod
        ) {
          if (!mdl.getRequired().value) {
            mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(
              mdl.subModules,
              mdl
            );
          } else {
            if (mdl.subModules.length > 0) {
              const v = scanOptionalSubModules(mdl.subModules, mdl);
              if (typeof v === "object") {
                mods[mdl.getVersionlessMavenIdentifier()] = v;
              }
            }
          }
        }
      }

      syncedCfgs.push({
        id,
        mods,
      });
    }
  }

  ConfigManager.setModConfigurations(syncedCfgs);
  ConfigManager.save();
}

/**
 * Ensure java configurations are present for the available servers.
 *
 * @param {Object} data The distro index object.
 */
function ensureJavaSettings(data) {
  // Nothing too fancy for now.
  for (const serv of data.servers) {
    ConfigManager.ensureJavaConfig(
      serv.rawServer.id,
      serv.effectiveJavaOptions,
      serv.rawServer.javaOptions?.ram
    );
  }

  ConfigManager.save();
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 *
 * @returns {boolean | Object} The resolved mod configuration.
 */
function scanOptionalSubModules(mdls, origin) {
  if (mdls != null) {
    const mods = {};

    for (let mdl of mdls) {
      const type = mdl.rawModule.type;
      // Optional types.
      if (
        type === Type.ForgeMod ||
        type === Type.LiteMod ||
        type === Type.LiteLoader ||
        type === Type.FabricMod
      ) {
        // It is optional.
        if (!mdl.getRequired().value) {
          mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(
            mdl.subModules,
            mdl
          );
        } else {
          if (mdl.hasSubModules()) {
            const v = scanOptionalSubModules(mdl.subModules, mdl);
            if (typeof v === "object") {
              mods[mdl.getVersionlessMavenIdentifier()] = v;
            }
          }
        }
      }
    }

    if (Object.keys(mods).length > 0) {
      const ret = {
        mods,
      };
      if (!origin.getRequired().value) {
        ret.value = origin.getRequired().def;
      }
      return ret;
    }
  }
  return origin.getRequired().def;
}

/**
 * Recursively merge an old configuration into a new configuration.
 *
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 *
 * @returns {boolean | Object} The merged configuration.
 */
function mergeModConfiguration(o, n, nReq = false) {
  if (typeof o === "boolean") {
    if (typeof n === "boolean") return o;
    else if (typeof n === "object") {
      if (!nReq) {
        n.value = o;
      }
      return n;
    }
  } else if (typeof o === "object") {
    if (typeof n === "boolean")
      return typeof o.value !== "undefined" ? o.value : true;
    else if (typeof n === "object") {
      if (!nReq) {
        n.value = typeof o.value !== "undefined" ? o.value : true;
      }

      const newMods = Object.keys(n.mods);
      for (let i = 0; i < newMods.length; i++) {
        const mod = newMods[i];
        if (o.mods[mod] != null) {
          n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod]);
        }
      }

      return n;
    }
  }
  // If for some reason we haven't been able to merge,
  // wipe the old value and use the new one. Just to be safe
  return n;
}

async function validateSelectedAccount() {
  const selectedAcc = ConfigManager.getSelectedAccount();
  if (selectedAcc != null) {
    const val = await AuthManager.validateSelected();
    if (!val) {
      ConfigManager.removeAuthAccount(selectedAcc.uuid);
      ConfigManager.save();
      const accLen = Object.keys(ConfigManager.getAuthAccounts()).length;
      setOverlayContent(
        Lang.queryJS("uibinder.validateAccount.failedMessageTitle"),
        accLen > 0
          ? Lang.queryJS("uibinder.validateAccount.failedMessage", {
              account: selectedAcc.displayName,
            })
          : Lang.queryJS(
              "uibinder.validateAccount.failedMessageSelectAnotherAccount",
              { account: selectedAcc.displayName }
            ),
        Lang.queryJS("uibinder.validateAccount.loginButton"),
        Lang.queryJS("uibinder.validateAccount.selectAnotherAccountButton")
      );
      setOverlayHandler(() => {
        const isMicrosoft = selectedAcc.type === "microsoft";

        if (isMicrosoft) {
          // Empty for now
        } else {
          // Mojang
          // For convenience, pre-populate the username of the account.
          document.getElementById("loginUsername").value = selectedAcc.username;
          validateEmail(selectedAcc.username);
        }

        loginOptionsViewOnLoginSuccess = getCurrentView();
        loginOptionsViewOnLoginCancel = VIEWS.loginOptions;

        if (accLen > 0) {
          loginOptionsViewOnCancel = getCurrentView();
          loginOptionsViewCancelHandler = () => {
            if (isMicrosoft) {
              ConfigManager.addMicrosoftAuthAccount(
                selectedAcc.uuid,
                selectedAcc.accessToken,
                selectedAcc.username,
                selectedAcc.expiresAt,
                selectedAcc.microsoft.access_token,
                selectedAcc.microsoft.refresh_token,
                selectedAcc.microsoft.expires_at
              );
            } else {
              ConfigManager.addMojangAuthAccount(
                selectedAcc.uuid,
                selectedAcc.accessToken,
                selectedAcc.username,
                selectedAcc.displayName
              );
            }
            ConfigManager.save();
            validateSelectedAccount();
          };
          loginOptionsCancelEnabled(true);
        } else {
          loginOptionsCancelEnabled(false);
        }
        toggleOverlay(false);
        switchView(getCurrentView(), VIEWS.loginOptions);
      });
      setDismissHandler(() => {
        if (accLen > 1) {
          prepareAccountSelectionList();
          $("#overlayContent").fadeOut(250, () => {
            bindOverlayKeys(true, "accountSelectContent", true);
            $("#accountSelectContent").fadeIn(250);
          });
        } else {
          const accountsObj = ConfigManager.getAuthAccounts();
          const accounts = Array.from(
            Object.keys(accountsObj),
            (v) => accountsObj[v]
          );
          // This function validates the account switch.
          setSelectedAccount(accounts[0].uuid);
          toggleOverlay(false);
        }
      });
      toggleOverlay(true, accLen > 0);
    } else {
      return true;
    }
  } else {
    return true;
  }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 *
 * @param {string} uuid The UUID of the account.
 */
function setSelectedAccount(uuid) {
  const authAcc = ConfigManager.setSelectedAccount(uuid);
  ConfigManager.save();
  updateSelectedAccount(authAcc);
  validateSelectedAccount();
}

// Synchronous Listener
document.addEventListener(
  "readystatechange",
  async () => {
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      if (rscShouldLoad) {
        rscShouldLoad = false;
        if (!fatalStartupError) {
          const data = await DistroAPI.getDistribution();
          await showMainUI(data);
        } else {
          showFatalStartupError();
        }
      }
    }
  },
  false
);

// Actions that must be performed after the distribution index is downloaded.
ipcRenderer.on("distributionIndexDone", async (event, res) => {
  if (res) {
    const data = await DistroAPI.getDistribution();
    syncModConfigurations(data);
    ensureJavaSettings(data);
    distro = data;
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      await showMainUI(data);
    } else {
      rscShouldLoad = true;
    }
  } else {
    fatalStartupError = true;
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      showFatalStartupError();
    } else {
      rscShouldLoad = true;
    }
  }
});

function updateMusic(allowed, volume) {
  const musicContainer = document.getElementById("musicInfo");
  const audioElement = document.getElementById("audio-player");
  if (audioElement) {
    audioElement.volume = volume / 2;
    if (allowed) {
      musicContainer.style.display = "flex";
      audioElement.play().catch((err) => {
        console.error("Erreur de lecture audio :", err);
      });
    } else {
      musicContainer.style.display = "none";
      audioElement.pause();
    }
  }
}

function setupMusic() {
  if (ConfigManager.getAllowMusic()) {
    const audioElement = document.getElementById("audio-player");
    // Lecture initiale
    playRandomTrack(audioElement);

    // Régler le volume de l'élément audio
    audioElement.volume = ConfigManager.getMusicVolume();
    // Lecture suivante à la fin de la piste
    audioElement.addEventListener("ended", () => {
      playRandomTrack(audioElement);
    });
  }
}

function setupBackground() {
  const video = document.getElementById("background-video");
  const fallback = document.getElementById("background-fallback");

  if (video && fallback) {
    const videos = fs
      .readdirSync(videoFolder)
      .filter((file) => file.endsWith(".mp4"));
    if (videos.length > 0) {
      const videoUrl = path.join(videoFolder, videos[0]);
      video.addEventListener("canplay", () => {
        fallback.style.display = "none";
      });

      video.addEventListener("error", (err) => {
        console.error("Error reading video :", err);
        fallback.src = `data:video/mp4;base64,${document.body.getAttribute(
          "bkid"
        )}.jpg')`;
      });

      fs.readFile(videoUrl, (err, data) => {
        if (err) {
          console.error("Error reading file :", err);
          return;
        }
        const base64 = data.toString("base64");
        video.src = `data:video/mp4;base64,${base64}`;
      });
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupMusic();
  setupBackground();
});

function getRandomTrack() {
  const files = fs
    .readdirSync(musicFolder)
    .filter((file) => file.endsWith(".mp3"));
  if (files.length === 0) return null;

  // Filtrer l'ancien
  let choices = files.map((file) => path.join(musicFolder, file));
  if (lastTrackPath && choices.length > 1) {
    choices = choices.filter((file) => file !== lastTrackPath);
  }

  const randomFile = choices[Math.floor(Math.random() * choices.length)];
  return randomFile;
}

// Joue une piste audio aléatoire
function playRandomTrack(audioElement) {
  const musicText = document.getElementById("musicText");
  musicText.innerHTML = Lang.queryJS("music.loadingMusic");
  const trackPath = getRandomTrack();
  if (trackPath) {
    lastTrackPath = trackPath;
    fs.readFile(trackPath, (err, data) => {
      if (err) {
        console.error("Error reading file :", err);
        return;
      }
      musicText.innerHTML = path.basename(trackPath).replace(/\..+$/, "");
      const base64 = data.toString("base64");
      audioElement.src = `data:audio/ogg;base64,${base64}`; //file://${trackPath}
      audioElement.play().catch((err) => {
        console.error("Error reading audio file :", err);
      });
    });
  } else {
    console.warn("Aucune piste audio trouvée.");
  }
}

// Util for development
async function devModeToggle() {
  DistroAPI.toggleDevMode(true);
  const data = await DistroAPI.refreshDistributionOrFallback();
  ensureJavaSettings(data);
  updateSelectedServer(data.servers[0]);
  syncModConfigurations(data);
}

//Discord RPC
function updateDiscordRpc() {
  if (distro != null) {
    const user = ConfigManager.getSelectedAccount();
    const serverId = ConfigManager.getSelectedServer();
    const serv = distro.servers.find((s) => s.rawServer.id === serverId);

    if (
      serv != null &&
      serv.rawServer.discord != null &&
      distro.rawDistribution.discord != null
    ) {
      if (!hasRPC) {
        DiscordWrapper.initRPC(
          distro.rawDistribution.discord,
          serv.rawServer.discord
        );
        hasRPC = true;
      }
    } else if (hasRPC) {
      loggerLaunchSuite.info("Shutting down Discord Rich Presence..");
      DiscordWrapper.shutdownRPC();
      hasRPC = false;
    }
  }
}
