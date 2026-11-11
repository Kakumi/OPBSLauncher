/**
 * 3D skin viewer of the "Apparence" settings tab, built on skinview3d
 * (loaded as the global "skinview3d" from node_modules in app.ejs).
 *
 * It shows the selected account's current skin (the OPBS skin from the
 * website, or the Microsoft skin when none is set) and lets the player
 * preview a skin of their list before applying it.
 */
const SkinPreview = (() => {
  const SKIN_API = "https://opbluesea.fr/api/skin-api";
  const canvas = document.getElementById("skinViewerCanvas");
  const caption = document.getElementById("skinViewerCaption");
  const backButton = document.getElementById("skinViewerBack");
  // Only the animation buttons (other .skinViewerAnim buttons, like the Marine
  // "Auto" one, must keep their own state).
  const animButtons = Array.from(
    document.querySelectorAll("#skinViewerAnimations .skinViewerAnim")
  );
  const rotateButton = document.getElementById("skinViewerRotate");
  const picker = document.getElementById("skinPicker");
  const pickerCanvas = document.getElementById("skinPickerCanvas");
  const pickerHover = document.getElementById("skinPickerHover");

  const ANIMATIONS = {
    idle: () => new skinview3d.IdleAnimation(),
    walk: () => new skinview3d.WalkingAnimation(),
    run: () => new skinview3d.RunningAnimation(),
    wave: () => new skinview3d.WaveAnimation(),
  };

  let viewer = null;
  let account = null; // Account whose current skin is shown.
  let requestId = 0; // Lets a newer request win over a slower, older one.
  let currentSkinImage = null; // Image of the current skin (used by outfits.js).

  // Rotation of the model, kept between launches (pause button).
  let rotating = true;
  try {
    rotating = localStorage.getItem("opbs.skinRotation") !== "off";
  } catch (err) {
    // No storage: rotation on.
  }
  rotateButton.toggleAttribute("paused", !rotating);

  function getViewer() {
    if (viewer != null) {
      return viewer;
    }
    if (typeof skinview3d === "undefined") {
      console.error("skinview3d is not loaded, 3D skin preview disabled.");
      return null;
    }
    viewer = new skinview3d.SkinViewer({ canvas, width: 240, height: 300 });
    viewer.fov = 40;
    viewer.zoom = 0.9; // The player fills the frame, head to feet.
    viewer.autoRotate = rotating;
    viewer.autoRotateSpeed = 0.5;
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.animation = ANIMATIONS.idle();

    // Only render while the Appearance tab is actually visible.
    new IntersectionObserver((entries) => {
      viewer.renderPaused = !entries[0].isIntersecting;
    }).observe(canvas);

    return viewer;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // Both skin hosts send CORS headers.
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Cannot load skin ${url}`));
      img.src = url;
    });
  }

  /**
   * Show the first skin of `sources` that loads.
   *
   * @param {number} id Request id, see requestId.
   * @param {{url: string, model?: string}[]} sources Skins to try, in order.
   * @param {string} label Caption under the viewer.
   * @param {boolean} isPreview Whether it is a not-yet-applied preview.
   */
  async function display(id, sources, label, isPreview) {
    const v = getViewer();
    if (v == null) {
      return;
    }
    caption.textContent = label;
    backButton.style.display = isPreview ? "" : "none";

    for (const source of sources) {
      try {
        const img = await loadImage(source.url);
        if (id !== requestId) {
          return; // Another skin was requested meanwhile.
        }
        v.loadSkin(img, { model: source.model ?? "auto-detect" });
        if (!isPreview) {
          currentSkinImage = img;
          // Lets the outfit gallery put this head on its outfits.
          document.dispatchEvent(
            new CustomEvent("opbs:currentskin", { detail: img })
          );
        }
        return;
      } catch (err) {
        if (id !== requestId) {
          return;
        }
        console.warn(err.message);
      }
    }
  }

  const api = {
    /**
     * Show the current skin of an account. Called when the selected account
     * changes and after a skin upload.
     *
     * @param {Object|null} acc The account (ConfigManager format).
     */
    async showAccount(acc) {
      stopPicking();
      account = acc;
      if (acc == null) {
        return;
      }
      const id = ++requestId;
      const name = acc.displayName;
      const microsoftSkin = {
        url: `https://mineskin.eu/skin/${encodeURIComponent(name)}`,
      };
      let sources = [microsoftSkin];
      let capeUrl = null;

      // OPBS skin set on the website, if any ("default" = no custom skin).
      try {
        const res = await fetch(
          `${SKIN_API}/profile/${encodeURIComponent(name)}`,
          { cache: "no-store" }
        );
        const profile = await res.json();
        if (res.ok && profile.cape && profile.cape.url) {
          capeUrl = `${profile.cape.url}?v=${encodeURIComponent(
            profile.cape.hash ?? Date.now()
          )}`;
        }
        if (res.ok && profile.skin && !profile.skin.default) {
          sources = [
            {
              // The hash changes with the skin: no stale copy from caches.
              url: `${profile.skin.url}?v=${encodeURIComponent(
                profile.skin.hash ?? Date.now()
              )}`,
              model: profile.skin.slim ? "slim" : "default",
            },
            microsoftSkin,
          ];
        }
      } catch (err) {
        console.warn("Cannot read the OPBS skin profile:", err.message);
      }

      if (id !== requestId) {
        return;
      }
      const v = getViewer();
      await display(
        id,
        sources,
        Lang.queryJS("settings.skins.currentSkin"),
        false
      );

      // Cape (only when capes are enabled on the website and the player has one).
      if (v != null && id === requestId) {
        if (capeUrl == null) {
          v.loadCape(null);
        } else {
          loadImage(capeUrl)
            .then((img) => {
              if (id === requestId) {
                v.loadCape(img);
              }
            })
            .catch((err) => console.warn(err.message));
        }
      }
    },

    /**
     * @returns {HTMLImageElement|null} Image of the account's current skin.
     */
    getCurrentSkinImage() {
      return currentSkinImage;
    },

    /**
     * Preview a skin without applying it.
     *
     * @param {string} url Skin URL (https or data:).
     * @param {string} label Caption under the viewer.
     */
    preview(url, label) {
      const id = ++requestId;
      display(id, [{ url }], label, true);
    },

    /**
     * Colour picker: the 3D model is replaced by the current skin seen flat
     * from the front, with big pixels (exact colours, easy to aim, unlike the
     * shaded 3D model). A click calls onPick; Escape or "Annuler" cancels.
     *
     * @param {function({r: number, g: number, b: number})} onPick
     * @returns {boolean} False if the skin is not loaded (or unreadable).
     */
    pickColor(onPick) {
      stopPicking();
      if (currentSkinImage == null) {
        return false;
      }
      const ctx = pickerCanvas.getContext("2d");
      ctx.clearRect(0, 0, 16, 32);
      // Front view drawing shared with the account card (settings.js).
      ctx.drawImage(skinFrontCanvas(currentSkinImage), 0, 0);
      try {
        pickPixels = ctx.getImageData(0, 0, 16, 32).data;
      } catch (err) {
        return false; // Texture without CORS headers.
      }
      pickDone = onPick;
      pickCaption = caption.textContent;
      canvas.style.visibility = "hidden";
      picker.setAttribute("active", "");
      showPickCaption(null);
      document.addEventListener("keydown", onPickKey, true);
      return true;
    },

    /** Leave the colour picker without choosing. */
    cancelPick() {
      stopPicking();
    },

    /** @returns {boolean} Whether the colour picker is shown. */
    isPicking() {
      return pickDone != null;
    },

    /** Go back to the current skin of the account. */
    reset() {
      document
        .querySelectorAll(".skinHead.previewing")
        .forEach((el) => el.classList.remove("previewing"));
      api.showAccount(account);
    },
  };

  backButton.onclick = () => api.reset();

  rotateButton.onclick = () => {
    rotateButton.blur();
    rotating = !rotating;
    rotateButton.toggleAttribute("paused", !rotating);
    if (viewer != null) {
      viewer.autoRotate = rotating;
    }
    try {
      localStorage.setItem("opbs.skinRotation", rotating ? "on" : "off");
    } catch (err) {
      // Not kept for the next launch.
    }
  };

  /* ---------- Colour picker (see pickColor) ---------- */

  let pickDone = null; // Callback while the picker is shown.
  let pickPixels = null; // RGBA of the 16x32 front view.
  let pickCaption = ""; // Caption to put back afterwards.

  function stopPicking() {
    if (pickDone == null) {
      return;
    }
    pickDone = null;
    picker.removeAttribute("active");
    pickerHover.style.display = "none";
    canvas.style.visibility = "";
    caption.textContent = pickCaption;
    document.removeEventListener("keydown", onPickKey, true);
    document.dispatchEvent(new CustomEvent("opbs:pickend"));
  }

  function onPickKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      stopPicking();
    }
  }

  /** Caption while picking: the hint, or the hovered colour. */
  function showPickCaption(rgb) {
    caption.replaceChildren();
    if (rgb == null) {
      caption.append(Lang.queryJS("settings.skins.pickHint"));
    } else {
      const hex = `#${[rgb.r, rgb.g, rgb.b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
      const swatch = document.createElement("span");
      swatch.className = "skinPickerSwatch";
      swatch.style.background = hex;
      caption.append(swatch, hex);
    }
    const cancel = document.createElement("button");
    cancel.className = "skinPickerCancel";
    cancel.textContent = Lang.queryJS("settings.skins.pickCancel");
    cancel.onclick = () => stopPicking();
    caption.append(cancel);
  }

  /** Skin pixel under the mouse ({x, y, rgb}), null outside or transparent. */
  function pixelAt(e) {
    const rect = pickerCanvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 16);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 32);
    if (pickPixels == null || x < 0 || y < 0 || x >= 16 || y >= 32) {
      return null;
    }
    const i = (y * 16 + x) * 4;
    if (pickPixels[i + 3] === 0) {
      return null;
    }
    return {
      x,
      y,
      rgb: { r: pickPixels[i], g: pickPixels[i + 1], b: pickPixels[i + 2] },
    };
  }

  pickerCanvas.addEventListener("mousemove", (e) => {
    if (pickDone == null) {
      return;
    }
    const px = pixelAt(e);
    if (px == null) {
      pickerHover.style.display = "none";
      showPickCaption(null);
      return;
    }
    const cell = pickerCanvas.getBoundingClientRect().width / 16;
    pickerHover.style.display = "block";
    pickerHover.style.left = `${px.x * cell}px`;
    pickerHover.style.top = `${px.y * cell}px`;
    pickerHover.style.width = pickerHover.style.height = `${cell}px`;
    showPickCaption(px.rgb);
  });

  pickerCanvas.addEventListener("mouseleave", () => {
    pickerHover.style.display = "none";
    if (pickDone != null) {
      showPickCaption(null);
    }
  });

  pickerCanvas.addEventListener("click", (e) => {
    const px = pixelAt(e);
    if (pickDone == null || px == null) {
      return;
    }
    const done = pickDone;
    stopPicking();
    done(px.rgb);
  });

  for (const button of animButtons) {
    button.onclick = () => {
      const v = getViewer();
      if (v == null) {
        return;
      }
      animButtons.forEach((b) => b.removeAttribute("selected"));
      button.setAttribute("selected", "");
      v.animation = ANIMATIONS[button.getAttribute("anim")]();
    };
  }

  return api;
})();
