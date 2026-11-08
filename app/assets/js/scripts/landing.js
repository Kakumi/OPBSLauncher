/**
 * Script for landing.ejs
 */
// Requirements
const { URL } = require("url");
const fetch = require("node-fetch");
const { MojangRestAPI } = require("helios-core/mojang");
const {
  RestResponseStatus,
  isDisplayableError,
  validateLocalFile,
} = require("helios-core/common");
const {
  FullRepair,
  DistributionIndexProcessor,
  MojangIndexProcessor,
  downloadFile,
} = require("helios-core/dl");
const {
  validateSelectedJvm,
  ensureJavaDirIsRoot,
  javaExecFromRoot,
  discoverBestJvmInstallation,
  latestOpenJDK,
  extractJdk,
} = require("helios-core/java");
const { status } = require("minecraft-server-util");

// Internal Requirements
const DiscordWrapper = require("./assets/js/discordwrapper");
const ProcessBuilder = require("./assets/js/processbuilder");
const PerformanceMode = require("./assets/js/performancemode");
const CrashReport = require("./assets/js/crashreport");
const crypto = require("crypto");
const { stringify } = require("querystring");

// Launch Elements
const launch_content = document.getElementById("launch_content");
const launch_details = document.getElementById("launch_details");
const launch_progress = document.getElementById("launch_progress");
const launch_progress_label = document.getElementById("launch_progress_label");
const launch_details_text = document.getElementById("launch_details_text");
const server_selection_button = document.getElementById(
  "server_selection_button",
);
const user_text = document.getElementById("user_text");

const loggerLanding = LoggerUtil.getLogger("Landing");

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading) {
  if (loading) {
    launch_details.style.display = "flex";
    launch_content.style.display = "none";
  } else {
    launch_details.style.display = "none";
    launch_content.style.display = "inline-flex";
  }
}

/**
 * Set the details text of the loading area.
 *
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details) {
  launch_details_text.innerHTML = details;
}

/**
 * Set the value of the loading progress bar and display that value.
 *
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent) {
  launch_progress.setAttribute("max", 100);
  launch_progress.setAttribute("value", percent);
  launch_progress_label.innerHTML = percent + "%";
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 *
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent) {
  remote.getCurrentWindow().setProgressBar(percent / 100);
  setLaunchPercentage(percent);
}

/**
 * Enable or disable the launch button.
 *
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val) {
  document.getElementById("launch_button").disabled = !val;
}

// Bind launch button. A pending launcher update is offered first (uicore.js).
document.getElementById("launch_button").addEventListener("click", (e) => {
  if (!promptLauncherUpdateBeforeLaunch(launchGame)) {
    launchGame();
  }
});

async function launchGame() {
    loggerLanding.info("Launching game..");
    try {
      const server = (await DistroAPI.getDistribution()).getServerById(
        ConfigManager.getSelectedServer(),
      );
      const jExe = ConfigManager.getJavaExecutable(
        ConfigManager.getSelectedServer(),
      );
      if (jExe == null) {
        await asyncSystemScan(server.effectiveJavaOptions);
      } else {
        setLaunchDetails(Lang.queryJS("landing.launch.pleaseWait"));
        toggleLaunchArea(true);
        setLaunchPercentage(0, 100);

        const details = await validateSelectedJvm(
          ensureJavaDirIsRoot(jExe),
          server.effectiveJavaOptions.supported,
        );
        if (details != null) {
          loggerLanding.info("Jvm Details", details);
          await dlAsync();
        } else {
          await asyncSystemScan(server.effectiveJavaOptions);
        }
      }
    } catch (err) {
      loggerLanding.error("Unhandled error in during launch process.", err);
      showLaunchFailure(
        Lang.queryJS("landing.launch.failureTitle"),
        Lang.queryJS("landing.launch.failureText"),
      );
    }
}

// Bind settings button
document.getElementById("settingsMediaButton").onclick = async (e) => {
  await prepareSettings();
  switchView(getCurrentView(), VIEWS.settings);
};

// Bind avatar overlay button.
document.getElementById("avatarOverlay").onclick = async (e) => {
  await prepareSettings();
  switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
    settingsNavItemListener(
      document.getElementById("settingsNavAccount"),
      false,
    );
  });
};

function populateUploadSkinPreview(user) {
  // 3D preview of the Appearance tab (skinpreview.js), back on the current skin.
  document
    .querySelectorAll(".skinHead.previewing")
    .forEach((el) => el.classList.remove("previewing"));
  SkinPreview.showAccount(user);
}

// Bind selected account
function updateSelectedAccount(authUser) {
  let username = Lang.queryJS("landing.selectedAccount.noAccountSelected");
  if (authUser != null) {
    if (authUser.displayName != null) {
      username = authUser.displayName;
    }
    if (authUser.uuid != null) {
      // Layers, top first: the profile picture from the website (custom avatar,
      // else OPBS skin face, else Microsoft skin face), then the Microsoft skin
      // from mineskin.eu. A layer that fails to load is not drawn, so the next shows.
      document.getElementById("avatarContainer").style.backgroundImage =
        `url('${opbsAvatarUrl(authUser)}'), url('https://mineskin.eu/helm/${
          authUser.displayName
        }/100')`;
      populateUploadSkinPreview(authUser);
      (async () => {
        await initSkins(authUser);
      })();
    }
  }

  user_text.innerHTML = username;

  updateDiscordRpc();
}
updateSelectedAccount(ConfigManager.getSelectedAccount());

// Bind selected server
function updateSelectedServer(serv) {
  if (getCurrentView() === VIEWS.settings) {
    fullSettingsSave();
  }
  ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null);
  ConfigManager.save();
  server_selection_button.innerHTML =
    "&#8226; " +
    (serv != null ? serv.rawServer.name : Lang.queryJS("landing.noSelection"));
  if (getCurrentView() === VIEWS.settings) {
    animateSettingsTabRefresh();
  }
  setLaunchEnabled(serv != null);
  updateDiscordRpc();
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML =
  "&#8226; " + Lang.queryJS("landing.selectedServer.loading");
server_selection_button.onclick = async (e) => {
  e.target.blur();
  await toggleServerSelection(true);
};

// Update Mojang Status Color
const refreshMojangStatuses = async function () {
  loggerLanding.info("Refreshing Mojang Statuses..");

  let status = "grey";
  let tooltipEssentialHTML = "";
  let tooltipNonEssentialHTML = "";

  const response = await MojangRestAPI.status();
  let statuses;
  if (response.responseStatus === RestResponseStatus.SUCCESS) {
    statuses = response.data;
  } else {
    loggerLanding.warn("Unable to refresh Mojang service status.");
    statuses = MojangRestAPI.getDefaultStatuses();
  }

  greenCount = 0;
  greyCount = 0;

  for (let i = 0; i < statuses.length; i++) {
    const service = statuses[i];

    const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(
              service.status,
            )};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`;
    if (service.essential) {
      tooltipEssentialHTML += tooltipHTML;
    } else {
      tooltipNonEssentialHTML += tooltipHTML;
    }

    if (service.status === "yellow" && status !== "red") {
      status = "yellow";
    } else if (service.status === "red") {
      status = "red";
    } else {
      if (service.status === "grey") {
        ++greyCount;
      }
      ++greenCount;
    }
  }

  if (greenCount === statuses.length) {
    if (greyCount === statuses.length) {
      status = "grey";
    } else {
      status = "green";
    }
  }

  document.getElementById("mojangStatusEssentialContainer").innerHTML =
    tooltipEssentialHTML;
  document.getElementById("mojangStatusNonEssentialContainer").innerHTML =
    tooltipNonEssentialHTML;
  document.getElementById("mojang_status_icon").style.color =
    MojangRestAPI.statusToHex(status);
};

const refreshServerStatus = async (fade = false) => {
  loggerLanding.info("Refreshing Server Status");
  const serv = (await DistroAPI.getDistribution()).getServerById(
    ConfigManager.getSelectedServer(),
  );

  let pLabel = Lang.queryJS("landing.serverStatus.server");
  let pVal = Lang.queryJS("landing.serverStatus.offline");

  try {
    //const servStat = await getServerStatus(47, serv.hostname, serv.port)
    //console.log(servStat)
    const servStat = await status(serv.hostname, serv.port);
    pLabel = Lang.queryJS("landing.serverStatus.players");
    pVal = servStat.players.online + "/" + servStat.players.max;
  } catch (err) {
    loggerLanding.warn("Unable to refresh server status, assuming offline.");
    loggerLanding.debug(err);
  }
  if (fade) {
    $("#server_status_wrapper").fadeOut(250, () => {
      document.getElementById("landingPlayerLabel").innerHTML = pLabel;
      document.getElementById("player_count").innerHTML = pVal;
      $("#server_status_wrapper").fadeIn(500);
    });
  } else {
    document.getElementById("landingPlayerLabel").innerHTML = pLabel;
    document.getElementById("player_count").innerHTML = pVal;
  }
};

refreshMojangStatuses();
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(
  () => refreshMojangStatuses(true),
  60 * 60 * 1000,
);
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000);

/**
 * Shows an error overlay, toggles off the launch area.
 *
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc) {
  setOverlayContent(title, desc, Lang.queryJS("landing.launch.okay"));
  setOverlayHandler(null);
  toggleOverlay(true);
  toggleLaunchArea(false);
}

/**
 * The game closed with an error: offer to send the crash log to the staff
 * (through the website, which posts it on a staff Discord channel).
 *
 * @param {string} instanceDir The instance folder of the server.
 * @param {number} launchedAt When the game was launched (ms timestamp).
 * @param {number} exitCode Exit code of the game.
 * @param {string} serverName Name of the server profile.
 */
function offerCrashReport(instanceDir, launchedAt, exitCode, serverName) {
  const log = CrashReport.findCrashLog(instanceDir, launchedAt);
  if (log == null) {
    return;
  }
  const escape = (text) =>
    String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = Lang.queryJS("landing.crashReport.title");

  setOverlayContent(
    title,
    Lang.queryJS("landing.crashReport.desc"),
    Lang.queryJS("landing.crashReport.send"),
    Lang.queryJS("landing.crashReport.ignore"),
  );
  setDismissHandler(null);
  setOverlayHandler(async () => {
    setOverlayContent(
      title,
      Lang.queryJS("landing.crashReport.sending"),
      Lang.queryJS("landing.crashReport.sending"),
    );
    setOverlayHandler(() => {}); // No double send.

    // The site checks the Minecraft session with Mojang: refresh it if expired.
    const sessionOk = await AuthManager.validateSelected();
    const result = sessionOk
      ? await CrashReport.send({
          accessToken: ConfigManager.getSelectedAccount().accessToken,
          serverName,
          launcherVersion: remote.app.getVersion(),
          exitCode,
          log,
        })
      : { ok: false, message: Lang.queryJS("landing.crashReport.sessionExpired") };

    setOverlayContent(
      title,
      result.ok
        ? Lang.queryJS("landing.crashReport.sent")
        : `${Lang.queryJS("landing.crashReport.failed")}<br>${escape(
            result.message ?? "",
          )}`,
      Lang.queryJS("landing.launch.okay"),
    );
    setOverlayHandler(null);
    toggleOverlay(true);
  });
  toggleOverlay(true, true);
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 *
 * @param {boolean} launchAfter Whether we should begin to launch after scanning.
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true) {
  setLaunchDetails(Lang.queryJS("landing.systemScan.checking"));
  toggleLaunchArea(true);
  setLaunchPercentage(0, 100);

  const jvmDetails = await discoverBestJvmInstallation(
    ConfigManager.getDataDirectory(),
    effectiveJavaOptions.supported,
  );

  console.log("Discovered JVM Details:", JSON.stringify(jvmDetails, null, 2));
  console.log(
    "Effective Java Options:",
    JSON.stringify(effectiveJavaOptions, null, 2),
  );

  if (jvmDetails == null) {
    // If the result is null, no valid Java installation was found.
    // Show this information to the user.
    setOverlayContent(
      Lang.queryJS("landing.systemScan.noCompatibleJava"),
      Lang.queryJS("landing.systemScan.installJavaMessage", {
        major: effectiveJavaOptions.suggestedMajor,
      }),
      Lang.queryJS("landing.systemScan.installJava"),
      Lang.queryJS("landing.systemScan.installJavaManually"),
    );
    setOverlayHandler(() => {
      setLaunchDetails(Lang.queryJS("landing.systemScan.javaDownloadPrepare"));
      toggleOverlay(false);

      try {
        downloadJava(effectiveJavaOptions, launchAfter);
      } catch (err) {
        loggerLanding.error("Unhandled error in Java Download", err);
        showLaunchFailure(
          Lang.queryJS("landing.systemScan.javaDownloadFailureTitle"),
          Lang.queryJS("landing.systemScan.javaDownloadFailureText"),
        );
      }
    });
    setDismissHandler(() => {
      $("#overlayContent").fadeOut(250, () => {
        //$('#overlayDismiss').toggle(false)
        setOverlayContent(
          Lang.queryJS("landing.systemScan.javaRequired", {
            major: effectiveJavaOptions.suggestedMajor,
          }),
          Lang.queryJS("landing.systemScan.javaRequiredMessage", {
            major: effectiveJavaOptions.suggestedMajor,
          }),
          Lang.queryJS("landing.systemScan.javaRequiredDismiss"),
          Lang.queryJS("landing.systemScan.javaRequiredCancel"),
        );
        setOverlayHandler(() => {
          toggleLaunchArea(false);
          toggleOverlay(false);
        });
        setDismissHandler(() => {
          toggleOverlay(false, true);

          asyncSystemScan(effectiveJavaOptions, launchAfter);
        });
        $("#overlayContent").fadeIn(250);
      });
    });
    toggleOverlay(true, true);
  } else {
    // Java installation found, use this to launch the game.
    const javaExec = javaExecFromRoot(jvmDetails.path);
    ConfigManager.setJavaExecutable(
      ConfigManager.getSelectedServer(),
      javaExec,
    );
    ConfigManager.save();

    // We need to make sure that the updated value is on the settings UI.
    // Just incase the settings UI is already open.
    settingsJavaExecVal.value = javaExec;
    await populateJavaExecDetails(settingsJavaExecVal.value);

    // TODO Callback hell, refactor
    // TODO Move this out, separate concerns.
    if (launchAfter) {
      await dlAsync();
    }
  }
}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {
  // TODO Error handling.
  // asset can be null.
  const asset = await latestOpenJDK(
    effectiveJavaOptions.suggestedMajor,
    ConfigManager.getDataDirectory(),
    effectiveJavaOptions.distribution,
  );

  if (asset == null) {
    throw new Error(Lang.queryJS("landing.downloadJava.findJdkFailure"));
  }

  let received = 0;
  await downloadFile(asset.url, asset.path, ({ transferred }) => {
    received = transferred;
    setDownloadPercentage(Math.trunc((transferred / asset.size) * 100));
  });
  setDownloadPercentage(100);

  if (received != asset.size) {
    loggerLanding.warn(
      `Java Download: Expected ${asset.size} bytes but received ${received}`,
    );
    if (!(await validateLocalFile(asset.path, asset.algo, asset.hash))) {
      log.error(`Hashes do not match, ${asset.id} may be corrupted.`);
      // Don't know how this could happen, but report it.
      throw new Error(
        Lang.queryJS("landing.downloadJava.javaDownloadCorruptedError"),
      );
    }
  }

  // Extract
  // Show installing progress bar.
  remote.getCurrentWindow().setProgressBar(2);

  // Wait for extration to complete.
  const eLStr = Lang.queryJS("landing.downloadJava.extractingJava");
  let dotStr = "";
  setLaunchDetails(eLStr);
  const extractListener = setInterval(() => {
    if (dotStr.length >= 3) {
      dotStr = "";
    } else {
      dotStr += ".";
    }
    setLaunchDetails(eLStr + dotStr);
  }, 750);

  const newJavaExec = await extractJdk(asset.path);

  // Extraction complete, remove the loading from the OS progress bar.
  remote.getCurrentWindow().setProgressBar(-1);

  // Extraction completed successfully.
  ConfigManager.setJavaExecutable(
    ConfigManager.getSelectedServer(),
    newJavaExec,
  );
  ConfigManager.save();

  clearInterval(extractListener);
  setLaunchDetails(Lang.queryJS("landing.downloadJava.javaInstalled"));

  // TODO Callback hell
  // Refactor the launch functions
  asyncSystemScan(effectiveJavaOptions, launchAfter);
}

// Keep reference to Minecraft Process
let proc;
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/;
const GAME_LAUNCH_REGEX =
  /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/;
const MIN_LINGER = 5000;
// End of the mod loading (Forge 1.12): most crashes happen before this line.
const GAME_LOADED_REGEX = /Forge Mod Loader has successfully loaded \d+ mods/;

async function dlAsync(login = true) {
  // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
  // launching the game.

  const loggerLaunchSuite = LoggerUtil.getLogger("LaunchSuite");

  setLaunchDetails(Lang.queryJS("landing.dlAsync.loadingServerInfo"));

  let distro;

  try {
    distro = await DistroAPI.refreshDistributionOrFallback();
    onDistroRefresh(distro);
  } catch (err) {
    loggerLaunchSuite.error("Unable to refresh distribution index.", err);
    showLaunchFailure(
      Lang.queryJS("landing.dlAsync.fatalError"),
      Lang.queryJS("landing.dlAsync.unableToLoadDistributionIndex"),
    );
    return;
  }

  const serv = distro.getServerById(ConfigManager.getSelectedServer());

  if (login) {
    if (ConfigManager.getSelectedAccount() == null) {
      loggerLanding.error("You must be logged into an account.");
      return;
    }
  }

  setLaunchDetails(Lang.queryJS("landing.dlAsync.pleaseWait"));
  toggleLaunchArea(true);
  setLaunchPercentage(0, 100);

  const fullRepairModule = new FullRepair(
    ConfigManager.getCommonDirectory(),
    ConfigManager.getInstanceDirectory(),
    ConfigManager.getLauncherDirectory(),
    ConfigManager.getSelectedServer(),
    DistroAPI.isDevMode(),
  );

  fullRepairModule.spawnReceiver();

  fullRepairModule.childProcess.on("error", (err) => {
    loggerLaunchSuite.error("Error during launch", err);
    showLaunchFailure(
      Lang.queryJS("landing.dlAsync.errorDuringLaunchTitle"),
      err.message || Lang.queryJS("landing.dlAsync.errorDuringLaunchText"),
    );
  });
  fullRepairModule.childProcess.on("close", (code, _signal) => {
    if (code !== 0) {
      loggerLaunchSuite.error(
        `Full Repair Module exited with code ${code}, assuming error.`,
      );
      showLaunchFailure(
        Lang.queryJS("landing.dlAsync.errorDuringLaunchTitle"),
        Lang.queryJS("landing.dlAsync.seeConsoleForDetails"),
      );
    }
  });

  loggerLaunchSuite.info("Validating files.");
  setLaunchDetails(Lang.queryJS("landing.dlAsync.validatingFileIntegrity"));
  let invalidFileCount = 0;
  try {
    invalidFileCount = await fullRepairModule.verifyFiles((percent) => {
      setLaunchPercentage(percent);
    });
    setLaunchPercentage(100);
  } catch (err) {
    loggerLaunchSuite.error("Error during file validation.");
    showLaunchFailure(
      Lang.queryJS("landing.dlAsync.errorDuringFileVerificationTitle"),
      err.displayable || Lang.queryJS("landing.dlAsync.seeConsoleForDetails"),
    );
    return;
  }

  if (invalidFileCount > 0) {
    loggerLaunchSuite.info("Downloading files.");
    setLaunchDetails(Lang.queryJS("landing.dlAsync.downloadingFiles"));
    setLaunchPercentage(0);
    try {
      await fullRepairModule.download((percent) => {
        setDownloadPercentage(percent);
      });
      setDownloadPercentage(100);
    } catch (err) {
      loggerLaunchSuite.error("Error during file download.");
      showLaunchFailure(
        Lang.queryJS("landing.dlAsync.errorDuringFileDownloadTitle"),
        err.displayable || Lang.queryJS("landing.dlAsync.seeConsoleForDetails"),
      );
      return;
    }
  } else {
    loggerLaunchSuite.info("No invalid files, skipping download.");
  }

  await downloadCustomMainMenuFiles();

  await deleteCustomMods();

  // Remove download bar.
  remote.getCurrentWindow().setProgressBar(-1);

  fullRepairModule.destroyReceiver();

  setLaunchDetails(Lang.queryJS("landing.dlAsync.preparingToLaunch"));

  const mojangIndexProcessor = new MojangIndexProcessor(
    ConfigManager.getCommonDirectory(),
    serv.rawServer.minecraftVersion,
  );
  const distributionIndexProcessor = new DistributionIndexProcessor(
    ConfigManager.getCommonDirectory(),
    distro,
    serv.rawServer.id,
  );

  const modLoaderData =
    await distributionIndexProcessor.loadModLoaderVersionJson(serv);
  const versionData = await mojangIndexProcessor.getVersionJson();

  if (login) {
    const authUser = ConfigManager.getSelectedAccount();
    loggerLaunchSuite.info(
      `Sending selected account (${authUser.displayName}) to ProcessBuilder.`,
    );
    let pb = new ProcessBuilder(
      serv,
      versionData,
      modLoaderData,
      authUser,
      remote.app.getVersion(),
    );
    setLaunchDetails(Lang.queryJS("landing.dlAsync.launchingGame"));

    // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
    const SERVER_JOINED_REGEX = new RegExp(
      `\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`,
    );

    const onLoadComplete = () => {
      toggleLaunchArea(false);
      if (hasRPC) {
        proc.stdout.on("data", gameStateChange);
      }
      proc.stdout.removeListener("data", tempListener);
      proc.stderr.removeListener("data", gameErrorListener);
    };
    const start = Date.now();

    // Attach a temporary listener to the client output.
    // Will wait for a certain bit of text meaning that
    // the client application has started, and we can hide
    // the progress bar stuff.
    const tempListener = function (data) {
      if (GAME_LAUNCH_REGEX.test(data.trim())) {
        const diff = Date.now() - start;
        if (diff < MIN_LINGER) {
          setTimeout(onLoadComplete, MIN_LINGER - diff);
        } else {
          onLoadComplete();
        }
      }
    };

    // Listener for Discord RPC.
    const gameStateChange = function (data) {
      data = data.trim();
      if (SERVER_JOINED_REGEX.test(data)) {
        //DiscordWrapper.updateDetails(Lang.queryJS("landing.discord.joined"));
      } else if (GAME_JOINED_REGEX.test(data)) {
        //DiscordWrapper.updateDetails(Lang.queryJS("landing.discord.joining"));
      }
    };

    const gameErrorListener = function (data) {
      data = data.trim();
      if (
        data.indexOf(
          "Could not find or load main class net.minecraft.launchwrapper.Launch",
        ) > -1
      ) {
        loggerLaunchSuite.error(
          "Game launch failed, LaunchWrapper was not downloaded properly.",
        );
        showLaunchFailure(
          Lang.queryJS("landing.dlAsync.errorDuringLaunchTitle"),
          Lang.queryJS("landing.dlAsync.launchWrapperNotDownloaded"),
        );
      }
    };

    try {
      // Lighter graphics for small PCs (Settings > Minecraft > Performance mode).
      const instanceDir = path.join(
        ConfigManager.getInstanceDirectory(),
        serv.rawServer.id,
      );
      PerformanceMode.apply(instanceDir, ConfigManager.getPerformanceMode());
      const launchedAt = Date.now();

      // Build Minecraft process.
      proc = pb.build();

      // Bind listeners to stdout.
      proc.stdout.on("data", tempListener);
      proc.stderr.on("data", gameErrorListener);

      // Settings > Minecraft > close the launcher on launch: once the mods are
      // loaded, so a crash while loading can still be reported. The game keeps
      // running (it is started detached in that case, see processbuilder.js).
      if (ConfigManager.getCloseOnLaunch()) {
        const closeWhenLoaded = (data) => {
          if (GAME_LOADED_REGEX.test(data)) {
            proc.stdout.removeListener("data", closeWhenLoaded);
            loggerLaunchSuite.info("Game loaded, closing the launcher.");
            setTimeout(() => remote.app.quit(), 1000);
          }
        };
        proc.stdout.on("data", closeWhenLoaded);
      }

      updateMusic(false, ConfigManager.getMusicVolume());

      setLaunchDetails(Lang.queryJS("landing.dlAsync.doneEnjoyServer"));

      DiscordWrapper.updateDetails(
        Lang.queryJS("discord.gameDetails", {
          name: authUser.displayName,
        }),
      );

      DiscordWrapper.updateState(
        Lang.queryJS("discord.gameState", {
          server: serv.rawServer.name,
        }),
      );

      // Init Discord Hook
      proc.on("close", (code, signal) => {
        updateMusic(
          ConfigManager.getAllowMusic(),
          ConfigManager.getMusicVolume(),
        );

        DiscordWrapper.updateDetails(
          Lang.queryJS("discord.launcherDetails", {
            name: authUser.displayName,
          }),
        );

        DiscordWrapper.updateState(
          Lang.queryJS("discord.launcherState", {
            server: serv.rawServer.name,
          }),
        );

        // Closed with an error (0 = normal quit, null = killed by a signal).
        if (code != null && code !== 0) {
          loggerLaunchSuite.warn(`Game exited with code ${code}.`);
          offerCrashReport(instanceDir, launchedAt, code, serv.rawServer.name);
        }
      });
    } catch (err) {
      loggerLaunchSuite.error("Error during launch", err);
      showLaunchFailure(
        Lang.queryJS("landing.dlAsync.errorDuringLaunchTitle"),
        Lang.queryJS("landing.dlAsync.checkConsoleForDetails"),
      );
    }
  }
}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent = document.getElementById("newsContent");
const newsArticleTitle = document.getElementById("newsArticleTitle");
const newsArticleDate = document.getElementById("newsArticleDate");
const newsArticleAuthor = document.getElementById("newsArticleAuthor");
const newsArticleComments = document.getElementById("newsArticleComments");
const newsNavigationStatus = document.getElementById("newsNavigationStatus");
const newsArticleContentScrollable = document.getElementById(
  "newsArticleContentScrollable",
);
const nELoadSpan = document.getElementById("nELoadSpan");

// News slide caches.
let newsActive = false;
let newsGlideCount = 0;

/**
 * Tabs of the news panel, each one an RSS feed served by the "opbs-launcher"
 * plugin of the website. "news" keeps using the "rss" field of distribution.json.
 * OPBS_FEED_BASE (environment) points the other tabs elsewhere, for tests.
 */
const OPBS_FEED_BASE =
  process.env.OPBS_FEED_BASE ?? "https://opbluesea.fr/api/opbs-launcher/";
const NEWS_FEEDS = ["news", "patchnotes", "wiki", "vote"];
let currentFeed = "news";

/**
 * Show the news UI via a slide animation.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up) {
  const lCUpper = document.querySelector("#landingContainer > #upper");
  const lCLLeft = document.querySelector("#landingContainer > #lower > #left");
  const lCLCenter = document.querySelector(
    "#landingContainer > #lower > #center",
  );
  const lCLRight = document.querySelector(
    "#landingContainer > #lower > #right",
  );
  const newsBtn = document.querySelector(
    "#landingContainer > #lower > #center #content",
  );
  const landingContainer = document.getElementById("landingContainer");
  const newsContainer = document.querySelector(
    "#landingContainer > #newsContainer",
  );

  newsGlideCount++;

  if (up) {
    lCUpper.style.top = "-200vh";
    lCLLeft.style.top = "-200vh";
    lCLCenter.style.top = "-200vh";
    lCLRight.style.top = "-200vh";
    newsBtn.style.top = "130vh";
    newsContainer.style.top = "0px";
    //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
    //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
    landingContainer.style.background = "rgba(0, 0, 0, 0.50)";
    // Same veil under the title bar (see "View veil under the title bar" in launcher.css).
    landingContainer.style.boxShadow = "0 -22px 0 0 rgba(0, 0, 0, 0.5)";
    landingContainer.setAttribute("newsopen", "");
    setTimeout(() => {
      if (newsGlideCount === 1) {
        lCLCenter.style.transition = "none";
        newsBtn.style.transition = "none";
      }
      newsGlideCount--;
    }, 2000);
  } else {
    setTimeout(() => {
      newsGlideCount--;
    }, 2000);
    landingContainer.style.background = null;
    landingContainer.style.boxShadow = null;
    landingContainer.removeAttribute("newsopen");
    lCLCenter.style.transition = null;
    newsBtn.style.transition = null;
    newsContainer.style.top = "100%";
    lCUpper.style.top = "0px";
    lCLLeft.style.top = "0px";
    lCLCenter.style.top = "0px";
    lCLRight.style.top = "0px";
    newsBtn.style.top = "10px";
  }
}

// Bind news button: opens the panel on the "news" tab, or closes it.
document.getElementById("newsButton").onclick = () => {
  toggleNewsPanel("news");
};

// Tabs of the panel.
Array.from(document.getElementsByClassName("newsTab")).forEach((tab) => {
  tab.onclick = () => {
    tab.blur();
    showFeed(tab.dataset.feed);
  };
});

// Patchnote / Wiki / Vote buttons of the right dock open the panel on their tab
// instead of the website (stopPropagation: no external link opening).
Array.from(document.querySelectorAll(".mediaURL[data-feed]")).forEach(
  (link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.activeElement.blur();
      if (!newsActive) {
        toggleNewsPanel(link.dataset.feed);
      } else {
        showFeed(link.dataset.feed);
      }
    });
  },
);

/**
 * Open the news panel on a tab, or close it if it is open.
 *
 * @param {string} feed Tab shown when opening (see NEWS_FEEDS).
 */
function toggleNewsPanel(feed) {
  if (!newsActive) {
    showFeed(feed);
  }
  // Toggle tabbing.
  if (newsActive) {
    $("#landingContainer *").removeAttr("tabindex");
    $("#newsContainer *").attr("tabindex", "-1");
  } else {
    $("#landingContainer *").attr("tabindex", "-1");
    $("#newsContainer, #newsContainer *, #lower, #lower #center *").removeAttr(
      "tabindex",
    );
  }
  slide_(!newsActive);
  newsActive = !newsActive;
}

/**
 * Show a tab of the news panel (loads its feed when it changes).
 *
 * @param {string} feed See NEWS_FEEDS.
 */
async function showFeed(feed) {
  if (!NEWS_FEEDS.includes(feed)) {
    feed = "news";
  }
  Array.from(document.getElementsByClassName("newsTab")).forEach((tab) =>
    tab.toggleAttribute("active", tab.dataset.feed === feed),
  );
  // The red dot of the news button is about the "news" tab only.
  if (feed === "news" && newsAlertShown) {
    $("#newsButtonAlert").fadeOut(2000);
    document
      .querySelector('.newsTab[data-feed="news"]')
      .removeAttribute("unread");
    newsAlertShown = false;
    ConfigManager.setNewsCacheDismissed(true);
    ConfigManager.save();
  }
  if (feed === currentFeed && newsArr != null) {
    return;
  }
  currentFeed = feed;
  newsArr = null;
  await showNewsLoading();
  // Another tab may have been chosen during the fade.
  if (feed === currentFeed) {
    await initNews(feed);
  }
}

/**
 * Replace the shown article by the loading message.
 */
async function showNewsLoading() {
  await $("#newsContent").fadeOut(150).promise();
  $("#newsErrorFailed, #newsErrorNone").hide();
  $("#newsErrorLoading").show();
  await $("#newsErrorContainer").fadeIn(150).promise();
}

// Array to store article meta.
let newsArr = null;

// News load animation listener.
let newsLoadingListener = null;

/**
 * Set the news loading animation.
 *
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val) {
  // Two loads can overlap (tab change, distribution refresh): one animation only.
  if (newsLoadingListener != null) {
    clearInterval(newsLoadingListener);
    newsLoadingListener = null;
  }
  if (val) {
    const nLStr = Lang.queryJS("landing.news.checking");
    let dotStr = "..";
    nELoadSpan.innerHTML = nLStr + dotStr;
    newsLoadingListener = setInterval(() => {
      if (dotStr.length >= 3) {
        dotStr = "";
      } else {
        dotStr += ".";
      }
      nELoadSpan.innerHTML = nLStr + dotStr;
    }, 750);
  }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
  $("#newsErrorFailed").fadeOut(250, () => {
    initNews();
    $("#newsErrorLoading").fadeIn(250);
  });
};

newsArticleContentScrollable.onscroll = (e) => {
  if (
    e.target.scrollTop >
    Number.parseFloat($(".newsArticleSpacerTop").css("height"))
  ) {
    newsContent.setAttribute("scrolled", "");
  } else {
    newsContent.removeAttribute("scrolled");
  }
};

/**
 * Reload the news without restarting.
 *
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function reloadNews() {
  await showNewsLoading();
  await initNews();
}

let newsAlertShown = false;

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert() {
  newsAlertShown = true;
  $(newsButtonAlert).fadeIn(250);
  // Also on the "Actualités" tab, seen while another tab is open.
  document
    .querySelector('.newsTab[data-feed="news"]')
    .setAttribute("unread", "");
}

async function digestMessage(str) {
  const msgUint8 = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

// Number of the last feed load: the answer of an older one (tab left meanwhile) is dropped.
let newsRequest = 0;

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 *
 * @param {string} feed Optional. The tab to load (see NEWS_FEEDS), the shown one by default.
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(feed = currentFeed) {
  const request = ++newsRequest;
  setNewsLoading(true);

  const news = await loadNews(feed);

  if (request !== newsRequest) {
    return;
  }

  newsArr = news?.articles || null;
  fillWikiNav(feed);

  if (newsArr == null) {
    // News Loading Failed
    setNewsLoading(false);

    await $("#newsErrorLoading").fadeOut(250).promise();
    await $("#newsErrorFailed").fadeIn(250).promise();
  } else if (newsArr.length === 0) {
    // No News Articles
    setNewsLoading(false);

    if (feed === "news") {
      ConfigManager.setNewsCache({
        date: null,
        content: null,
        dismissed: false,
      });
      ConfigManager.save();
    }

    await $("#newsErrorLoading").fadeOut(250).promise();
    await $("#newsErrorNone").fadeIn(250).promise();
  } else {
    // Success
    setNewsLoading(false);

    // New article alert (red dot of the news button): "news" tab only.
    if (feed === "news") {
      const lN = newsArr[0];
      const cached = ConfigManager.getNewsCache();
      let newHash = await digestMessage(lN.content);
      let newDate = new Date(lN.timestamp);
      let isNew = false;

      if (cached.date != null && cached.content != null) {
        if (new Date(cached.date) >= newDate) {
          // Compare Content
          if (cached.content !== newHash) {
            isNew = true;
          } else if (!cached.dismissed) {
            isNew = true;
          }
        } else {
          isNew = true;
        }
      } else {
        isNew = true;
      }

      // Already read if the panel is open on this tab.
      if (isNew && newsActive && currentFeed === "news") {
        ConfigManager.setNewsCache({
          date: newDate.getTime(),
          content: newHash,
          dismissed: true,
        });
        ConfigManager.save();
      } else if (isNew) {
        showNewsAlert();
        ConfigManager.setNewsCache({
          date: newDate.getTime(),
          content: newHash,
          dismissed: false,
        });
        ConfigManager.save();
      }
    }

    const switchHandler = (forward) => {
      if (newsArr == null || newsArr.length === 0) {
        return;
      }
      let cArt = parseInt(newsContent.getAttribute("article"));
      let nxtArt = forward
        ? cArt >= newsArr.length - 1
          ? 0
          : cArt + 1
        : cArt <= 0
          ? newsArr.length - 1
          : cArt - 1;

      displayArticle(newsArr[nxtArt], nxtArt + 1);
    };

    document.getElementById("newsNavigateRight").onclick = () => {
      switchHandler(true);
    };
    document.getElementById("newsNavigateLeft").onclick = () => {
      switchHandler(false);
    };
    await $("#newsErrorContainer").fadeOut(250).promise();
    if (request !== newsRequest || newsArr == null) {
      return;
    }
    displayArticle(newsArr[0], 1);
    if (feed === "vote") {
      setupVoteCards();
    }
    const shown = $("#newsContent").fadeIn(250).promise();
    // Once displayed (a hidden element keeps its old scroll position).
    newsArticleContentScrollable.scrollTop = 0;
    await shown;
  }
}

/*
 * Vote tab: voting from the launcher. The site cards of the feed carry
 * data-vote-site (site id) and data-vote-target (vote site URL, may contain
 * {player}). A click opens the vote site in the browser, then the website
 * ("opbs-launcher" plugin) is asked every 5 seconds until the vote site has
 * seen the vote, and the reward is given: same rules as the website vote page.
 * Sites already voted show the time left before the next vote.
 */
const VOTE_POLL_DELAY = 5000;
const VOTE_POLL_TRIES = 36; // 3 minutes
let voteTicker = null;
const votePolls = new Map(); // site id -> timeout of its next check

/**
 * Request to the website vote API of the plugin, over IPv4: the vote sites
 * check the vote by IP, the website vote page does the same (IPv4 adapter).
 *
 * @param {string} method "GET" or "POST".
 * @param {string} path Path after OPBS_FEED_BASE.
 * @param {Object} body Optional. JSON body.
 * @returns {Promise<{status: number, json: Object|null}>}
 */
function voteApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(OPBS_FEED_BASE + path);
    const lib = url.protocol === "http:" ? require("http") : require("https");
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: "application/json",
      "User-Agent": navigator.userAgent,
    };
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = lib.request(
      url,
      { method, family: 4, timeout: 20000, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (err) {
            // Not JSON (error page): json stays null.
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

/**
 * Prepare the vote site cards of the shown vote article: time left before
 * each site can be voted again, for the selected account.
 */
async function setupVoteCards() {
  const account = ConfigManager.getSelectedAccount();
  const cards = Array.from(
    newsArticleContentScrollable.querySelectorAll("[data-vote-site]"),
  );
  if (account == null || cards.length === 0) {
    return;
  }
  cards.forEach((card) => {
    if (card.querySelector(".voteCardState") == null) {
      const state = document.createElement("div");
      state.className = "voteCardState";
      card.appendChild(state);
    }
  });
  updateVoteCards();
  if (voteTicker == null) {
    voteTicker = setInterval(updateVoteCards, 1000);
  }

  let res = null;
  try {
    res = await voteApi(
      "GET",
      `vote/status/${encodeURIComponent(account.displayName)}?uuid=${encodeURIComponent(account.uuid)}`,
    );
  } catch (err) {
    loggerLanding.warn("Vote status unavailable:", err.message);
  }
  if (res != null && res.status === 200 && res.json?.sites) {
    for (const card of cards) {
      card.dataset.voteNext = res.json.sites[card.dataset.voteSite] ?? "";
    }
  } else if (res?.json?.message) {
    showVoteMessage(res.json.message, "error");
  }
  updateVoteCards();
}

/**
 * Refresh the state line of every vote card (called every second).
 */
function updateVoteCards() {
  const cards = newsArticleContentScrollable.querySelectorAll(
    "[data-vote-site]",
  );
  if (currentFeed !== "vote" || cards.length === 0) {
    clearInterval(voteTicker);
    voteTicker = null;
    return;
  }
  cards.forEach((card) => {
    const state = card.querySelector(".voteCardState");
    if (state == null) {
      return;
    }
    const checking = votePolls.has(card.dataset.voteSite);
    const left = Number(card.dataset.voteNext || 0) - Date.now();
    card.toggleAttribute("checking", checking);
    card.toggleAttribute("cooldown", !checking && left > 0);
    if (checking) {
      state.textContent = "Vérification du vote…";
    } else if (left > 0) {
      const s = Math.ceil(left / 1000);
      const pad = (n) => String(n).padStart(2, "0");
      state.textContent = `Revote dans ${pad(Math.floor(s / 3600))}:${pad(
        Math.floor((s % 3600) / 60),
      )}:${pad(s % 60)}`;
    } else {
      state.textContent = "Clique pour voter";
    }
  });
}

/**
 * Message above the vote site cards (reward received, error...).
 *
 * @param {string} message Text from the website (may contain simple HTML).
 * @param {string} level "success" or "error".
 */
function showVoteMessage(message, level) {
  const cards = newsArticleContentScrollable.querySelector("[data-vote-site]");
  if (cards == null) {
    return;
  }
  let box = document.getElementById("voteFeedMessage");
  if (box == null) {
    box = document.createElement("div");
    box.id = "voteFeedMessage";
    cards.parentElement.parentElement.insertBefore(box, cards.parentElement);
  }
  box.setAttribute("level", level);
  box.textContent = $("<div>").html(message).text();
}

/**
 * Ask the website, every 5 seconds, whether the vote site has seen the vote.
 *
 * @param {string} siteId The vote site id.
 * @param {Object} account The account who votes.
 * @param {number} attempt Number of checks already done.
 */
function pollVote(siteId, account, attempt) {
  votePolls.set(
    siteId,
    setTimeout(async () => {
      let res = null;
      try {
        res = await voteApi("POST", `vote/${siteId}/done`, {
          player: account.displayName,
          uuid: account.uuid,
        });
      } catch (err) {
        loggerLanding.warn("Vote check failed:", err.message);
      }
      if (res?.status === 200 && res.json?.status === "pending") {
        if (attempt + 1 < VOTE_POLL_TRIES) {
          pollVote(siteId, account, attempt + 1);
          return;
        }
        votePolls.delete(siteId);
        showVoteMessage(
          "Le site de vote n'a pas encore vu ton vote. Si tu as bien voté, reclique sur le site dans un moment.",
          "error",
        );
      } else {
        votePolls.delete(siteId);
        const ok = res?.status === 200 && res.json?.message;
        showVoteMessage(
          res?.json?.message ??
            "Vérification du vote impossible pour le moment, réessaie plus tard.",
          ok ? "success" : "error",
        );
      }
      setupVoteCards();
    }, VOTE_POLL_DELAY),
  );
  updateVoteCards();
}

// A click on a vote site card opens the vote site for the selected account and
// starts checking the vote (instead of opening the website vote page).
newsArticleContentScrollable.addEventListener("click", (e) => {
  const card = e.target.closest("[data-vote-site]");
  const account = ConfigManager.getSelectedAccount();
  if (card == null || currentFeed !== "vote" || account == null) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const siteId = card.dataset.voteSite;
  if (card.hasAttribute("cooldown") || votePolls.has(siteId)) {
    return;
  }
  document.getElementById("voteFeedMessage")?.remove();
  shell.openExternal(
    card.dataset.voteTarget.replace(
      "{player}",
      encodeURIComponent(account.displayName),
    ),
  );
  pollVote(siteId, account, 0);
});

/**
 * The "wiki" tab has many pages: the left column lists them by category
 * (titles are "Category › Page") instead of showing the title. Hidden on the
 * other tabs.
 *
 * @param {string} feed The loaded tab.
 */
function fillWikiNav(feed) {
  const nav = document.getElementById("newsWikiNav");
  nav.replaceChildren();
  const isWiki = feed === "wiki" && newsArr != null && newsArr.length > 0;
  newsContent.toggleAttribute("wiki", isWiki);
  if (!isWiki) {
    return;
  }
  let lastCategory = null;
  newsArr.forEach((article, i) => {
    const parts = article.title.split(" › ");
    const category = parts.length > 1 ? parts.shift() : "";
    if (category !== lastCategory) {
      lastCategory = category;
      const header = document.createElement("div");
      header.className = "newsWikiCategory";
      header.textContent = category;
      nav.appendChild(header);
    }
    const page = document.createElement("button");
    page.className = "newsWikiPage";
    page.dataset.index = String(i);
    page.textContent = parts.join(" › ");
    page.onclick = () => {
      page.blur();
      displayArticle(newsArr[i], i + 1);
      newsArticleContentScrollable.scrollTop = 0;
    };
    nav.appendChild(page);
  });
}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener("keydown", (e) => {
  if (newsActive) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      document
        .getElementById(
          e.key === "ArrowRight" ? "newsNavigateRight" : "newsNavigateLeft",
        )
        .click();
    }
    // Interferes with scrolling an article using the down arrow.
    // Not sure of a straight forward solution at this point.
    // if(e.key === 'ArrowDown'){
    //     document.getElementById('newsButton').click()
    // }
  } else {
    if (getCurrentView() === VIEWS.landing) {
      if (e.key === "ArrowUp") {
        document.getElementById("newsButton").click();
      }
    }
  }
});

/**
 * Display a news article on the UI.
 *
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index) {
  newsArticleTitle.innerHTML = articleObject.title;
  newsArticleTitle.href = articleObject.link;
  newsArticleAuthor.innerHTML = "par " + articleObject.author;
  newsArticleDate.innerHTML = articleObject.date;
  // No date on the "vote" tab (the page is always up to date).
  newsArticleDate.style.display = articleObject.date ? "" : "none";
  // Wiki tab: highlight the shown page in the list.
  const navPages = document.querySelectorAll(".newsWikiPage");
  navPages.forEach((p) =>
    p.toggleAttribute("active", p.dataset.index === String(index - 1)),
  );
  document
    .querySelector(".newsWikiPage[active]")
    ?.scrollIntoView({ block: "nearest" });
  newsArticleComments.innerHTML = articleObject.comments;
  newsArticleComments.href = articleObject.commentsLink;
  // The changelog feed has no comments: hide the counter instead of "0".
  newsArticleComments.style.display = articleObject.comments ? "" : "none";
  newsArticleContentScrollable.innerHTML =
    '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' +
    articleObject.content +
    '<div class="newsArticleSpacerBot"></div></div>';
  Array.from(
    newsArticleContentScrollable.getElementsByClassName("bbCodeSpoilerButton"),
  ).forEach((v) => {
    v.onclick = () => {
      const text =
        v.parentElement.getElementsByClassName("bbCodeSpoilerText")[0];
      text.style.display = text.style.display === "block" ? "none" : "block";
    };
  });
  newsNavigationStatus.innerHTML = Lang.query(
    "ejs.landing.newsNavigationStatus",
    { currentPage: index, totalPages: newsArr.length },
  );
  // No "1 sur 1" arrows on a single page tab (vote).
  document.getElementById("newsNavigationContainer").style.visibility =
    newsArr.length > 1 ? "" : "hidden";
  newsContent.setAttribute("article", index - 1);
}

/**
 * Load the articles of a tab. "news" reads the RSS feed specified in the
 * distribution index, the other tabs the matching feed of the website.
 *
 * @param {string} feed Optional. See NEWS_FEEDS.
 */
async function loadNews(feed = "news") {
  let newsFeed = OPBS_FEED_BASE + feed;
  if (feed === "news") {
    const distroData = await DistroAPI.getDistribution();
    if (!distroData.rawDistribution.rss) {
      loggerLanding.debug("No RSS feed provided.");
      return null;
    }
    newsFeed = distroData.rawDistribution.rss;
  }

  const promise = new Promise((resolve, reject) => {
    const newsHost = new URL(newsFeed).origin + "/";
    $.ajax({
      url: newsFeed,
      success: (data) => {
        const items = $(data).find("item");
        const articles = [];

        for (let i = 0; i < items.length; i++) {
          // JQuery Element
          const el = $(items[i]);

          // Resolve date (none on the "vote" tab).
          const timestamp = new Date(el.find("pubDate").text()).getTime();
          const date =
            feed === "vote"
              ? ""
              : new Date(timestamp).toLocaleDateString("fr-FR", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "numeric",
                });

          // Resolve comments (none in the changelog feed: no counter shown).
          const commentCount = el.find("slash\\:comments").text();
          const comments = commentCount
            ? commentCount + " commentaire" + (commentCount === "1" ? "" : "s")
            : "";

          // Fix relative links in content.
          let content = el.find("content\\:encoded").text();
          let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g;
          let matches;
          while ((matches = regex.exec(content))) {
            content = content.replace(
              `"${matches[1]}"`,
              `"${newsHost + matches[1]}"`,
            );
          }

          let link = el.find("link").text();
          let title = el.find("title").text();
          let author = el.find("dc\\:creator").text();

          // Generate article.
          articles.push({
            link,
            title,
            date,
            timestamp,
            author,
            content,
            comments,
            commentsLink: link + "#comments",
          });
        }
        resolve({
          articles,
        });
      },
      // The website may have to ask Discord first (and publish new patch notes).
      timeout: 10000,
    }).catch((err) => {
      resolve({
        articles: null,
      });
    });
  });

  return await promise;
}

async function downloadCustomMainMenuFiles() {
  const user = ConfigManager.getSelectedAccount();
  const serv = (await DistroAPI.getDistribution()).getServerById(
    ConfigManager.getSelectedServer(),
  );
  const resourceFolder = path.join(
    ConfigManager.getInstanceDirectory(),
    serv.rawServer.id,
    "resources",
  );
  const folder = path.join(resourceFolder, "opbluesea", "textures");
  const launcherFolder = path.join(resourceFolder, "launcher");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(launcherFolder, { recursive: true });
  const filePath = path.join(folder, "skin.png");
  const url = `https://minotar.net/armor/bust/${user.uuid}/128.png`;

  const response = await fetch(url);
  const buffer = await response.buffer();
  fs.writeFile(filePath, buffer, () => console.log("finished downloading!"));

  const files = fs.readdirSync(launcherFolder);
  const panoramaFiles = files.filter((f) => /^panorama_\d+\./.test(f));
  if (panoramaFiles.length > 0) {
    const idx = Math.floor(Math.random() * panoramaFiles.length);
    let randomPanoramaFile = path.join(launcherFolder, panoramaFiles[idx]);
    const newPanoramaFile = path.join(folder, "panorama.png");
    fs.copyFile(randomPanoramaFile, newPanoramaFile, (err) => {
      if (err) {
        console.error(err);
      } else {
        console.log("copied panorama file to resources folder");
      }
    });
  }
}

async function deleteCustomMods() {
  const user = ConfigManager.getSelectedAccount();
  const serv = (await DistroAPI.getDistribution()).getServerById(
    ConfigManager.getSelectedServer(),
  );

  if (serv.rawServer.customMods == false) {
    const modsFolder = path.join(
      ConfigManager.getInstanceDirectory(),
      serv.rawServer.id,
      "mods",
    );

    //delete all files in the mods folder
    fs.readdir(modsFolder, (err, files) => {
      if (err) {
        loggerUICore.error("Error reading mods folder", err);
        return;
      }
      files.forEach((file) => {
        const filePath = path.join(modsFolder, file);
        fs.unlink(filePath, (err) => {
          if (err) {
            loggerUICore.error("Error deleting file", err);
          }
        });
      });
    });
  }
}

let fileHashes = {};

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function analyzeFolderChanges() {
  try {
    const serv = (await DistroAPI.getDistribution()).getServerById(
      ConfigManager.getSelectedServer(),
    );
    const defaultResourcesPacks = serv.rawServer.modules.filter(
      (m) =>
        m.artifact.path != null && m.artifact.path.startsWith("resourcepacks/"),
    );
    const folderToWatch = await getFolderToWatch(serv);
    const files = fs.readdirSync(folderToWatch);
    for (const file of files) {
      const fullPath = path.join(folderToWatch, file);
      const newHash = await hashFile(fullPath);
      const artifactFromServer = defaultResourcesPacks.filter(
        (m) => m.name === file,
      );
      if (fileHashes[file] === undefined && artifactFromServer.length > 0) {
        fileHashes[file] = newHash;
      } else {
        if (fileHashes[file] === undefined) {
          await callSecurityWebhook(
            "Ajout d'un fichier",
            `Le fichier ${file} a été ajouté dans le dossier de ressources du serveur ${serv.rawServer.name}.`,
          );
        } else if (
          fileHashes[file] !== newHash &&
          (artifactFromServer.length == 0 ||
            artifactFromServer[0].artifact.MD5 !== newHash)
        ) {
          await callSecurityWebhook(
            "Modification d'un fichier",
            `Le fichier ${file} a été modifié dans le dossier de ressources du serveur ${serv.rawServer.name}.`,
          );
        }

        fileHashes[file] = newHash;
      }
    }

    for (const file of Object.keys(fileHashes)) {
      if (!fs.existsSync(path.join(folderToWatch, file))) {
        await callSecurityWebhook(
          "Suppression d'un fichier",
          `Le fichier ${file} a été supprimé du dossier de ressources du serveur ${serv.rawServer.name}.`,
        );
        delete fileHashes[file];
      }
    }
  } catch (err) {
    console.error("Error analyzing folder:", err);
  }
}

async function getFolderToWatch(serv) {
  return path.join(
    ConfigManager.getInstanceDirectory(),
    serv.rawServer.id,
    "resourcepacks",
  );
}

// Run every 10 seconds
setInterval(analyzeFolderChanges, 10000);

async function callSecurityWebhook(title, message) {
  try {
    const webhookUrl =
      "https://discord.com/api/webhooks/1360368753854120156/91lDIFKriPO93EaitlUMdfTXn5RuM3r_5J3QW-W22AhX5NFNmrJpNxz2WRZXAWeM8hEe";
    const user = ConfigManager.getSelectedAccount();
    const embed = {
      title: title,
      description: message,
      color: 0xff0000,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: "Utilisateur",
          value: user?.displayName || "N/A",
          inline: true,
        },
        {
          name: "UUID",
          value: user?.uuid || "N/A",
          inline: true,
        },
      ],
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (ex) {
    LoggerUtil.getLogger("SecurityWebhook").error(
      `Can't call security webhook, ${ex.message}`,
    );
  }
}
