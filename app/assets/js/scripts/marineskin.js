/**
 * "Skin Marine" studio of the "Apparence" tab: the player's face and skin
 * colour on a Marine uniform. Pick an outfit, see it in 3D (skinpreview.js),
 * then apply it or download the PNG to retouch it.
 *
 * The outfit list lives in the launcher web space, so outfits can be added
 * without releasing a new launcher (see index.json next to the outfit images):
 *   https://launcher.opbluesea.fr/launcher/skins/index.json
 * Each outfit of group "marine" has (paths relative to index.json, "v" values
 * are cache-busting versions):
 *   - file: 64x64 PNG with the clothes only (head and bare skin transparent),
 *   - skin: optional 64x64 PNG with the bare skin only, in any reference tone,
 *     recoloured with the player's skin colour,
 *   - hat:  optional 64x64 PNG with a cap on the head/hat layer.
 * For local tests, OPBS_SKINS_INDEX can point to a local index.json instead.
 */
const MarineSkin = (() => {
  const marineFetch = require("node-fetch"); // No CORS from Node.
  const INDEX_URL =
    process.env.OPBS_SKINS_INDEX ??
    "https://launcher.opbluesea.fr/launcher/skins/index.json";
  const GROUP = "marine";

  const studio = document.getElementById("marineStudio");
  const grid = document.getElementById("marineOutfits");
  const toneInput = document.getElementById("marineSkinTone");
  const toneAuto = document.getElementById("marineSkinToneAuto");
  const tonePick = document.getElementById("marineSkinTonePick");
  const applyButton = document.getElementById("marineApply");
  const downloadButton = document.getElementById("marineDownload");
  const message = document.getElementById("marineMessage");

  const THUMB_SCALE = 3; // Thumbnails: 16x32 skin pixels -> 48x96.

  let outfits = []; // { name, image, hat, tone }
  let selected = null; // Selected outfit.
  let toneOverride = null; // Colour chosen by hand, or null = detected.

  /* ---------- Loading ---------- */

  /** Read a file of the outfit space (remote, or local for tests). */
  async function readBytes(location) {
    if (/^https?:\/\//.test(location)) {
      const res = await marineFetch(location);
      if (!res.ok) {
        throw new Error(`${location}: HTTP ${res.status}`);
      }
      return res.buffer();
    }
    return fs.readFileSync(location);
  }

  function resolve(file, version) {
    const remote = /^https?:\/\//.test(INDEX_URL);
    const location = remote
      ? new URL(file, INDEX_URL).toString()
      : path.join(path.dirname(INDEX_URL), file);
    // Version from index.json: no stale image from the Cloudflare cache.
    return version && remote ? `${location}?v=${version}` : location;
  }

  /** PNG bytes -> loaded image, usable on a canvas (data URL: never tainted). */
  function toImage(bytes) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("Invalid outfit image"));
      img.src = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    });
  }

  /* ---------- Colours ---------- */

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) {
        h = (g - b) / d + (g < b ? 6 : 0);
      } else if (max === g) {
        h = (b - r) / d + 2;
      } else {
        h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map((v) => Math.round((v + m) * 255));
  }

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const hslOf = (key) => rgbToHsl((key >> 16) & 255, (key >> 8) & 255, key & 255);

  /**
   * Skin tones, from very light to very dark: warm hue, some saturation (very
   * light skins are highly saturated in HSL, so no upper limit), no vivid red.
   */
  function looksLikeSkin(r, g, b) {
    const { h, s, l } = rgbToHsl(r, g, b);
    if ((h < 8 || h >= 350) && s > 0.75) {
      return false; // Lips, blood...
    }
    return (h <= 45 || h >= 350) && s >= 0.1 && l >= 0.1 && l <= 0.94 && r >= g && r > b;
  }

  /** Two shades of a same colour (light, base, shadow of a skin...). */
  function sameFamily(a, b) {
    const x = hslOf(a);
    const y = hslOf(b);
    const hueGap = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
    return hueGap <= 12 && Math.abs(x.l - y.l) <= 0.15 && Math.abs(x.s - y.s) <= 0.35;
  }

  function pixelsOf(image) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0); // Legacy 64x32 skins fill the top half.
    return ctx.getImageData(0, 0, 64, 64);
  }

  /**
   * Skin colour of a skin, from what is visible (outer layer if opaque, else
   * the base layer) on the face and the hands.
   *
   * Hair, beards, sleeves... often use warm colours that look like skin, so:
   *  - shades of a same colour are grouped into families (a skin has a light,
   *    a base and a shadow shade); the family with the most weight wins,
   *  - a family seen on both the face and the hands is skin for sure (x2),
   *  - a family covering the top/back of the head is hair (x0.1), unless it is
   *    also on the face and the hands (bald head: x0.5).
   * The result is the family's most frequent shade on the face (the main tone,
   * not the shadow). Tested on ~20 real skins and hand-made traps.
   *
   * @returns {{r: number, g: number, b: number} | null} null when no skin is
   * visible (full masks...).
   */
  function faceSkinTone(image) {
    const legacy = image.naturalHeight === 32;
    const { data } = pixelsOf(image);
    const alphaAt = (x, y) => data[(y * 64 + x) * 4 + 3];
    const keyAt = (x, y) => {
      const i = (y * 64 + x) * 4;
      return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    };

    // Minecraft ignores the hat layer of an old 64x32 skin when it is fully opaque.
    let ignoreHat = false;
    if (legacy) {
      ignoreHat = true;
      for (let y = 0; y < 16 && ignoreHat; y++) {
        for (let x = 32; x < 64; x++) {
          if (alphaAt(x, y) < 128) {
            ignoreHat = false;
            break;
          }
        }
      }
    }

    // Visible colour of a base pixel (bx, by) and its outer-layer pixel (ox, oy).
    const visible = (bx, by, ox, oy) => {
      if (!ignoreHat && alphaAt(ox, oy) > 128) {
        return keyAt(ox, oy);
      }
      return alphaAt(bx, by) < 255 ? null : keyAt(bx, by);
    };

    // Hair evidence: what is visible on the top and the back of the head.
    const hair = new Map();
    let hairTotal = 0;
    const hairAt = (x, y) => {
      let key = null;
      if (!ignoreHat && alphaAt(x + 32, y) > 128) {
        key = keyAt(x + 32, y);
      } else if (alphaAt(x, y) > 128) {
        key = keyAt(x, y);
      }
      if (key != null) {
        hair.set(key, (hair.get(key) ?? 0) + 1);
        hairTotal++;
      }
    };
    for (let y = 0; y < 8; y++) {
      for (let x = 8; x < 16; x++) {
        hairAt(x, y);
      }
    }
    for (let y = 8; y < 16; y++) {
      for (let x = 24; x < 32; x++) {
        hairAt(x, y);
      }
    }

    const face = new Map();
    const hands = new Map();
    const add = (map, key, weight) => {
      if (key != null && looksLikeSkin((key >> 16) & 255, (key >> 8) & 255, key & 255)) {
        map.set(key, (map.get(key) ?? 0) + weight);
      }
    };
    // Face; the lower face (cheeks, mouth) weighs more than the top (fringe).
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        add(face, visible(x, y, x + 32, y), y >= 12 ? 3 : 1);
      }
    }
    // Hands: bottom 4 rows of the 4 sides of both arms, and their bottom face.
    for (let y = 28; y < 32; y++) {
      for (let x = 40; x < 56; x++) {
        add(hands, visible(x, y, x, y + 16), 1);
      }
    }
    for (let y = 16; y < 20; y++) {
      for (let x = 48; x < 52; x++) {
        add(hands, visible(x, y, x, y + 16), 1);
      }
    }
    if (!legacy) {
      for (let y = 60; y < 64; y++) {
        for (let x = 32; x < 48; x++) {
          add(hands, visible(x, y, x + 16, y), 1);
        }
      }
      for (let y = 48; y < 52; y++) {
        for (let x = 40; x < 44; x++) {
          add(hands, visible(x, y, x + 16, y), 1);
        }
      }
    }

    const onFace = (k) => face.get(k) ?? 0;
    const onHands = (k) => hands.get(k) ?? 0;
    const weight = (k) => onFace(k) + 1.5 * onHands(k);
    const colours = [...new Set([...face.keys(), ...hands.keys()])];
    if (colours.length === 0) {
      return null;
    }

    // Group shades into families, heaviest colours first.
    const families = [];
    for (const key of colours.sort((a, b) => weight(b) - weight(a))) {
      const family = families.find((fam) => sameFamily(fam[0], key));
      if (family != null) {
        family.push(key);
      } else {
        families.push([key]);
      }
    }

    const both = (fam) => fam.some((k) => onFace(k) > 0) && fam.some((k) => onHands(k) > 0);
    const hairShare = (fam) => {
      if (hairTotal === 0) {
        return 0;
      }
      let n = 0;
      for (const [key, count] of hair) {
        if (fam.some((k) => sameFamily(k, key))) {
          n += count;
        }
      }
      return n / hairTotal;
    };
    const score = (fam) =>
      fam.reduce((sum, k) => sum + weight(k), 0) *
      (both(fam) ? 2 : 1) *
      (hairShare(fam) > 0.15 ? (both(fam) ? 0.5 : 0.1) : 1);

    const best = families.reduce((a, b) => (score(b) > score(a) ? b : a));
    const by = best.some((k) => onFace(k) > 0) ? onFace : onHands;
    const pick = best.reduce((a, b) => (by(b) > by(a) ? b : a));
    return { r: (pick >> 16) & 255, g: (pick >> 8) & 255, b: pick & 255 };
  }

  /** Most frequent opaque colour of an image (the base tone of a skin layer). */
  function dominantColor(image) {
    const { data } = pixelsOf(image);
    const counts = new Map();
    let best = null;
    let bestCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) {
        continue;
      }
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > bestCount) {
        best = key;
        bestCount = n;
      }
    }
    return best == null
      ? null
      : { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255 };
  }

  /**
   * The skin layer of an outfit (arms, hands, neck... drawn in a reference
   * tone) recoloured with another skin colour, keeping its shading: each pixel
   * keeps its lightness gap with the layer's base tone.
   *
   * @returns {HTMLCanvasElement}
   */
  function recoloredSkinLayer(outfit, to) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(outfit.skin, 0, 0, 64, 64);
    if (to == null || outfit.skinTone == null) {
      return canvas;
    }
    const image = ctx.getImageData(0, 0, 64, 64);
    const { data } = image;
    const src = rgbToHsl(outfit.skinTone.r, outfit.skinTone.g, outfit.skinTone.b);
    const dst = rgbToHsl(to.r, to.g, to.b);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) {
        continue;
      }
      const p = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const [r, g, b] = hslToRgb(
        dst.h,
        clamp(dst.s + (p.s - src.s) * 0.5, 0, 1),
        clamp(dst.l + (p.l - src.l), 0, 1)
      );
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /* ---------- Skin building ---------- */

  function playerTone() {
    if (toneOverride != null) {
      return toneOverride;
    }
    const head = SkinPreview.getCurrentSkinImage();
    return head == null ? null : faceSkinTone(head);
  }

  /**
   * The Marine skin of the player, in layers:
   *  1. the player's head only (base + hair/hat layer: the top 16 rows of a
   *     skin); their body and its clothes are left out,
   *  2. the outfit's skin layer, recoloured with the player's skin colour,
   *  3. the outfit's clothes,
   *  4. an optional cap.
   * Outfit + skin layer cover the whole body, so nothing of the player's own
   * clothes can show through.
   *
   * @returns {HTMLCanvasElement} A 64x64 skin.
   */
  function build(outfit) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");

    const head = SkinPreview.getCurrentSkinImage();
    if (head != null) {
      ctx.drawImage(head, 0, 0, 64, 16, 0, 0, 64, 16);
    }
    if (outfit.skin != null) {
      ctx.drawImage(recoloredSkinLayer(outfit, playerTone()), 0, 0);
    }
    ctx.drawImage(outfit.image, 0, 0, 64, 64);
    if (outfit.hat != null) {
      ctx.drawImage(outfit.hat, 0, 0, 64, 64);
    }
    return canvas;
  }

  /** Front view of a skin (16x32 pixels), for thumbnails. */
  function renderFront(skin) {
    const canvas = document.createElement("canvas");
    canvas.width = 16 * THUMB_SCALE;
    canvas.height = 32 * THUMB_SCALE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Slim (3 px) arms leave the 4th arm column transparent.
    const alpha = skin.getContext("2d").getImageData(54, 20, 1, 1).data[3];
    const arm = alpha === 0 ? 3 : 4;
    const parts = [
      // [sx, sy, w, h, dx, dy] base layer, then the matching outer layer.
      [8, 8, 8, 8, 4, 0], [40, 8, 8, 8, 4, 0], // Head, hat
      [20, 20, 8, 12, 4, 8], [20, 36, 8, 12, 4, 8], // Body, jacket
      [44, 20, arm, 12, 4 - arm, 8], [44, 36, arm, 12, 4 - arm, 8], // Right arm
      [36, 52, arm, 12, 12, 8], [52, 52, arm, 12, 12, 8], // Left arm
      [4, 20, 4, 12, 4, 20], [4, 36, 4, 12, 4, 20], // Right leg
      [20, 52, 4, 12, 8, 20], [4, 52, 4, 12, 8, 20], // Left leg
    ];
    for (const [sx, sy, w, h, dx, dy] of parts) {
      ctx.drawImage(
        skin, sx, sy, w, h,
        dx * THUMB_SCALE, dy * THUMB_SCALE, w * THUMB_SCALE, h * THUMB_SCALE
      );
    }
    return canvas;
  }

  function pngBytes(canvas) {
    return Buffer.from(canvas.toDataURL("image/png").split(",")[1], "base64");
  }

  /* ---------- Interface ---------- */

  function toHex({ r, g, b }) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  function showMessage(text, isError = false) {
    message.style.color = isError ? "red" : "white";
    message.textContent = text;
  }

  function renderTone() {
    const tone = playerTone() ?? outfits.find((o) => o.skinTone != null)?.skinTone;
    if (tone != null) {
      toneInput.value = toHex(tone);
    }
    if (toneOverride == null) {
      toneAuto.setAttribute("selected", "");
    } else {
      toneAuto.removeAttribute("selected");
    }
  }

  function preview(outfit) {
    SkinPreview.preview(
      build(outfit).toDataURL("image/png"),
      Lang.queryJS("settings.skins.outfitPreview", { name: outfit.name })
    );
  }

  function renderOutfits() {
    grid.innerHTML = "";
    for (const outfit of outfits) {
      const div = document.createElement("div");
      div.className = "skinHead outfitItem";
      if (outfit === selected) {
        div.classList.add("previewing");
      }

      const thumb = renderFront(build(outfit));
      thumb.title = Lang.queryJS("settings.skins.clickToPreview");
      thumb.onclick = () => {
        selected = outfit;
        markSkinPreviewing(div);
        applyButton.disabled = false;
        downloadButton.disabled = false;
        showMessage("");
        preview(outfit);
      };
      div.appendChild(thumb);

      const label = document.createElement("span");
      label.className = "outfitName";
      label.textContent = outfit.name;
      div.appendChild(label);

      grid.appendChild(div);
    }
  }

  /** Redraw everything after a change of head or skin colour. */
  function refresh() {
    if (outfits.length === 0) {
      return;
    }
    renderTone();
    renderOutfits();
    if (selected != null) {
      preview(selected);
    }
  }

  toneInput.oninput = () => {
    const hex = toneInput.value;
    toneOverride = {
      r: parseInt(hex.substring(1, 3), 16),
      g: parseInt(hex.substring(3, 5), 16),
      b: parseInt(hex.substring(5, 7), 16),
    };
    refresh();
  };

  toneAuto.onclick = () => {
    SkinPreview.cancelPick();
    toneOverride = null;
    refresh();
  };

  // Eyedropper: pick the colour on the player's own skin (shown flat, big
  // pixels, in the viewer). A second click cancels.
  tonePick.onclick = () => {
    tonePick.blur();
    if (SkinPreview.isPicking()) {
      SkinPreview.cancelPick();
      return;
    }
    const started = SkinPreview.pickColor((rgb) => {
      toneOverride = rgb;
      refresh();
    });
    if (started) {
      tonePick.setAttribute("selected", "");
      showMessage("");
    } else {
      showMessage(Lang.queryJS("settings.skins.pickUnavailable"), true);
    }
  };
  document.addEventListener("opbs:pickend", () => {
    tonePick.removeAttribute("selected");
  });

  applyButton.onclick = async () => {
    if (selected == null) {
      return;
    }
    const file = new File([pngBytes(build(selected))], "skin.png", { type: "image/png" });
    // Also kept in "Mes skins".
    await uploadSkin(file, true, message);
  };

  downloadButton.onclick = async () => {
    if (selected == null) {
      return;
    }
    const account = ConfigManager.getSelectedAccount();
    const slug = selected.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const result = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
      title: Lang.queryJS("settings.skins.marineDownloadTitle"),
      defaultPath: path.join(
        remote.app.getPath("downloads"),
        `skin-marine-${slug}${account ? `-${account.displayName}` : ""}.png`
      ),
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) {
      return;
    }
    try {
      fs.writeFileSync(result.filePath, pngBytes(build(selected)));
      showMessage(Lang.queryJS("settings.skins.marineDownloaded"));
    } catch (err) {
      showMessage(err.message, true);
    }
  };

  async function load() {
    try {
      const index = JSON.parse((await readBytes(INDEX_URL)).toString("utf-8"));
      const entries = (index.outfits ?? []).filter((o) => o.group === GROUP);
      const loaded = await Promise.all(
        entries.map(async (entry) => {
          try {
            const load = async (file, version) =>
              file ? toImage(await readBytes(resolve(file, version))) : null;
            const skin = await load(entry.skin, entry.skinV);
            return {
              name: entry.name,
              image: await load(entry.file, entry.v), // Clothes only.
              skin, // Bare skin (arms, neck...) in a reference tone, or null.
              skinTone: skin == null ? null : dominantColor(skin),
              hat: await load(entry.hat, entry.hatV),
            };
          } catch (err) {
            console.warn(`Outfit "${entry.name}" skipped:`, err.message);
            return null;
          }
        })
      );
      outfits = loaded.filter((o) => o != null);
      if (outfits.length > 0) {
        refresh();
        studio.style.display = "";
      }
    } catch (err) {
      // No outfit list online: the section simply stays hidden.
      console.warn("Marine outfits not available:", err.message);
    }
  }

  // The head and skin colour come from the current skin: redraw the thumbnails
  // when it changes (not the 3D view, which now shows that current skin).
  document.addEventListener("opbs:currentskin", () => {
    if (outfits.length > 0) {
      renderTone();
      renderOutfits();
    }
  });

  load();

  return { reload: load };
})();
