window.polytrackModConfiguration = {
  modName: "MisoTweaks",
  author: "missonance",
};

(() => {
  "use strict";

  const DB_NAME = "misotweaks_clips";
  const DB_VERSION = 1;
  const META_STORE = "clip_meta";
  const PAYLOAD_STORE = "clip_payloads";
  const LEGACY_KEY = "miso_clips";
  const UNKNOWN_FOLDER = "__unknown__";
  const CLIP_KEY = "_clipKeyBind";
  const DEFAULT_CLIP_KEY = "KeyC";
  let databasePromise;
  let selectedClipIds = new Set();
  let currentFolder = null;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const meta = db.createObjectStore(META_STORE, { keyPath: "id" });
        meta.createIndex("trackId", "trackId", { unique: false });
        meta.createIndex("createdAt", "createdAt", { unique: false });
        meta.createIndex("name", "name", { unique: false });
        db.createObjectStore(PAYLOAD_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  }

  async function getAllClipMetadata() {
    const db = await openDatabase();
    const transaction = db.transaction(META_STORE, "readonly");
    return requestResult(transaction.objectStore(META_STORE).getAll());
  }

  async function getClipPayload(id) {
    const db = await openDatabase();
    const transaction = db.transaction(PAYLOAD_STORE, "readonly");
    return requestResult(transaction.objectStore(PAYLOAD_STORE).get(id));
  }

  async function putClip(meta, payload) {
    const db = await openDatabase();
    const transaction = db.transaction(
      [META_STORE, PAYLOAD_STORE],
      "readwrite",
    );
    transaction.objectStore(META_STORE).put(meta);
    transaction.objectStore(PAYLOAD_STORE).put({ id: meta.id, ...payload });
    await transactionDone(transaction);
  }

  async function updateClipMetadata(meta) {
    const db = await openDatabase();
    const transaction = db.transaction(META_STORE, "readwrite");
    transaction.objectStore(META_STORE).put(meta);
    await transactionDone(transaction);
  }

  async function deleteClips(ids) {
    const db = await openDatabase();
    const transaction = db.transaction(
      [META_STORE, PAYLOAD_STORE],
      "readwrite",
    );
    for (const id of ids) {
      transaction.objectStore(META_STORE).delete(id);
      transaction.objectStore(PAYLOAD_STORE).delete(id);
    }
    await transactionDone(transaction);
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    }
    return btoa(binary);
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function base64ToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function transformDeflate(bytes, mode) {
    const stream =
      mode === "compress"
        ? new CompressionStream("deflate")
        : new DecompressionStream("deflate");
    const output = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(output).arrayBuffer());
  }

  async function recordingStringForPayload(payload) {
    if (payload?.recording) return payload.recording;
    if (!payload?.legacyBytes) return null;
    const compressed = await transformDeflate(
      new Uint8Array(payload.legacyBytes),
      "compress",
    );
    return bytesToBase64Url(compressed);
  }

  function uniqueId(base = `clip_${Date.now()}`) {
    return `${base}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  }

  function displayDate(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function framesToTime(frames) {
    const milliseconds = Math.round((frames * 1000) / 60);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    const remainder = milliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
  }

  function currentTrackName(trackId) {
    const catalogName = window.__misoGetTrackName?.(trackId);
    if (catalogName) return catalogName;
    return (
      document.querySelector(".game-toolbar-ui .track-name")?.textContent?.trim() ||
      null
    );
  }

  async function migrateLegacyClips() {
    let raw;
    try {
      raw = localStorage.getItem(LEGACY_KEY);
    } catch {
      return;
    }
    if (!raw) return;

    let clips;
    try {
      clips = JSON.parse(raw);
    } catch (error) {
      console.error("MisoTweaks could not read legacy clips", error);
      return;
    }
    if (!Array.isArray(clips)) return;

    const db = await openDatabase();
    const transaction = db.transaction(
      [META_STORE, PAYLOAD_STORE],
      "readwrite",
    );
    const metaStore = transaction.objectStore(META_STORE);
    const payloadStore = transaction.objectStore(PAYLOAD_STORE);

    for (const clip of clips) {
      if (!clip?.id || !Number.isFinite(clip.frames) || !clip.recordingBytes)
        continue;
      const id = clip.id;
      const trackId = clip.trackId || "";
      const trackName = window.__misoGetTrackName?.(trackId) || null;
      metaStore.put({
        id,
        name: clip.name || "Imported clip",
        playerName: clip.playerName || clip.name || "Anonymous",
        trackId,
        trackName,
        carStyle: clip.carStyle || "",
        frames: clip.frames,
        createdAt: clip.createdAt || Date.now(),
      });
      payloadStore.put({
        id,
        legacyBytes: base64ToBytes(clip.recordingBytes).buffer,
      });
    }

    try {
      await transactionDone(transaction);
      localStorage.removeItem(LEGACY_KEY);
    } catch (error) {
      console.error("MisoTweaks clip migration failed; legacy clips were kept", error);
    }
  }

  async function refreshTrackNames(metadata) {
    let changed = false;
    for (const clip of metadata) {
      if (!clip.trackName && clip.trackId) {
        const name = window.__misoGetTrackName?.(clip.trackId);
        if (name) {
          clip.trackName = name;
          await updateClipMetadata(clip);
          changed = true;
        }
      }
    }
    return changed;
  }

  async function createClip() {
    const recorder = window.__misoFrameRecorder;
    const car = window.__misoRecordingCar;
    const trackId = window.__misoCurrentTrackId || "";
    if (!recorder?.serialize || !car?.getTime || !trackId) {
      alert("Start a run before saving a clip.");
      return;
    }

    const frames = car.getTime()?.numberOfFrames ?? 0;
    if (!Number.isSafeInteger(frames) || frames < 1) {
      alert("There is not enough of the run to save yet.");
      return;
    }

    const createdAt = Date.now();
    const id = uniqueId(`clip_${createdAt}`);
    const meta = {
      id,
      name: displayDate(createdAt),
      playerName: window.__misoPlayerName || "Anonymous",
      trackId,
      trackName: currentTrackName(trackId),
      carStyle: car.getCarStyle?.()?.serialize?.() || "",
      frames,
      createdAt,
    };

    try {
      await putClip(meta, { recording: recorder.serialize() });
      showToast("Clip saved");
    } catch (error) {
      console.error("MisoTweaks failed to save a clip", error);
      alert("The clip could not be saved. Check that browser storage is available.");
    }
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "miso-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 250);
    }, 1600);
  }

  async function playSelected(metadata) {
    const selected = metadata.filter((clip) => selectedClipIds.has(clip.id));
    if (!selected.length) return alert("Select at least one clip first.");
    if (!selected.every((clip) => clip.trackId === selected[0].trackId)) {
      return alert("Clips must be from the same map to watch them together.");
    }
    if (window.__misoCurrentTrackId !== selected[0].trackId) {
      return alert(`Open ${selected[0].trackName || "the clip's map"} before watching this clip.`);
    }
    if (
      !window.__misoRecordingClass ||
      !window.__misoTimeClass ||
      !window.__misoWatchClips
    ) {
      return alert("The replay system is not ready yet.");
    }

    const opponents = [];
    for (const clip of selected) {
      const payload = await getClipPayload(clip.id);
      const serialized = await recordingStringForPayload(payload);
      const recording = window.__misoRecordingClass.deserialize(serialized);
      if (!recording) return alert(`Could not read “${clip.name}”.`);
      opponents.push({
        recording,
        carStyle: window.__misoCarStyleClass.deserializeSafe(clip.carStyle),
        nickname: clip.playerName || clip.name,
        time: new window.__misoTimeClass(clip.frames),
        isSelf: false,
      });
    }
    closeClipLibrary();
    window.__misoWatchClips(opponents);
  }

  async function clipToExport(meta) {
    const payload = await getClipPayload(meta.id);
    let recordingBytes;
    if (payload.legacyBytes) recordingBytes = new Uint8Array(payload.legacyBytes);
    else {
      recordingBytes = await transformDeflate(
        base64ToBytes(payload.recording),
        "decompress",
      );
    }

    const encoder = new TextEncoder();
    const fields = [
      encoder.encode(meta.name || ""),
      encoder.encode(meta.playerName || meta.name || ""),
      encoder.encode(meta.trackId || ""),
      encoder.encode(meta.carStyle || ""),
    ];
    const total = fields.reduce((sum, value) => sum + 1 + value.length, 4) + recordingBytes.length;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const field of fields) {
      bytes[offset++] = field.length;
      bytes.set(field, offset);
      offset += field.length;
    }
    bytes[offset++] = meta.frames & 255;
    bytes[offset++] = (meta.frames >> 8) & 255;
    bytes[offset++] = (meta.frames >> 16) & 255;
    bytes[offset++] = (meta.frames >> 24) & 255;
    bytes.set(recordingBytes, offset);
    const once = await transformDeflate(bytes, "compress");
    const twice = await transformDeflate(once, "compress");
    return `ClipsMiso2${bytesToBase64Url(twice)}`;
  }

  async function importClipCode(code) {
    const trimmed = code.trim();
    const versionTwo = trimmed.startsWith("ClipsMiso2");
    if (!versionTwo && !trimmed.startsWith("ClipsMiso1")) {
      throw new Error("Unsupported clip code");
    }
    const compressed = base64ToBytes(trimmed.slice("ClipsMiso1".length));
    const once = await transformDeflate(compressed, "decompress");
    const bytes = await transformDeflate(once, "decompress");
    const decoder = new TextDecoder();
    let offset = 0;
    const readField = () => {
      const length = bytes[offset++];
      const value = decoder.decode(bytes.slice(offset, offset + length));
      offset += length;
      return value;
    };
    const name = readField();
    const playerName = versionTwo ? readField() : name;
    const trackId = readField();
    const carStyle = readField();
    const frames =
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24);
    offset += 4;
    const id = uniqueId();
    await putClip(
      {
        id,
        name: name || "Imported clip",
        playerName: playerName || "Anonymous",
        trackId,
        trackName: window.__misoGetTrackName?.(trackId) || null,
        carStyle,
        frames,
        createdAt: Date.now(),
      },
      { legacyBytes: bytes.slice(offset).buffer },
    );
  }

  function makeButton(label, icon, onClick, className = "") {
    const button = document.createElement("button");
    button.className = `button ${className}`.trim();
    if (icon) button.innerHTML = `<img class="button-icon" src="${icon}" alt=""> `;
    button.append(document.createTextNode(label));
    button.addEventListener("click", onClick);
    return button;
  }

  function createSearch(placeholder, onInput) {
    const wrapper = document.createElement("div");
    wrapper.className = "miso-search";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => onInput(input.value));
    const icon = document.createElement("img");
    icon.src = "images/search.svg";
    icon.alt = "";
    wrapper.append(input, icon);
    return { wrapper, input };
  }

  function groupClips(metadata) {
    const folders = new Map();
    folders.set(UNKNOWN_FOLDER, {
      id: UNKNOWN_FOLDER,
      name: "Unknown Maps",
      clips: [],
    });
    for (const clip of metadata) {
      const key = clip.trackName && clip.trackId ? clip.trackId : UNKNOWN_FOLDER;
      if (!folders.has(key)) {
        folders.set(key, { id: key, name: clip.trackName, clips: [] });
      }
      folders.get(key).clips.push(clip);
    }
    return [...folders.values()].sort((a, b) => {
      if (a.id === UNKNOWN_FOLDER) return 1;
      if (b.id === UNKNOWN_FOLDER) return -1;
      return a.name.localeCompare(b.name);
    });
  }

  async function promptImportClip() {
    const code = prompt("Paste a MisoTweaks clip code:");
    if (!code) return;
    try {
      await importClipCode(code);
      await renderLibrary();
      showToast("Clip imported");
    } catch (error) {
      console.error(error);
      alert("That clip code could not be imported.");
    }
  }

  async function renderLibrary() {
    const panel = document.querySelector(".miso-clip-library");
    if (!panel) return;
    const content = panel.querySelector(".miso-clip-content");
    const title = panel.querySelector("h2");
    const actions = panel.querySelector(".miso-clip-actions");
    content.replaceChildren();
    actions.replaceChildren();
    selectedClipIds = new Set();

    let metadata = await getAllClipMetadata();
    await refreshTrackNames(metadata);
    metadata = await getAllClipMetadata();
    metadata.sort((a, b) => b.createdAt - a.createdAt);

    if (!currentFolder) {
      title.textContent = "Your Clips:";
      const folders = groupClips(metadata);
      const search = createSearch("Search maps…", (query) => {
        const value = query.trim().toLowerCase();
        content.querySelectorAll(".miso-folder").forEach((element) => {
          element.hidden = !element.dataset.search.includes(value);
        });
      });
      content.appendChild(search.wrapper);
      const grid = document.createElement("div");
      grid.className = "miso-folder-grid";
      for (const folder of folders) {
        const button = document.createElement("button");
        button.className = "button miso-folder";
        button.dataset.search = folder.name.toLowerCase();
        button.innerHTML = `<h2></h2><p></p>`;
        button.querySelector("h2").textContent = folder.name;
        button.querySelector("p").textContent = `${folder.clips.length} ${folder.clips.length === 1 ? "clip" : "clips"}`;
        button.addEventListener("click", () => {
          currentFolder = folder.id;
          renderLibrary();
        });
        grid.appendChild(button);
      }
      content.appendChild(grid);
      actions.append(
        makeButton("Back", "images/back.svg", closeClipLibrary, "back"),
        makeButton("Import", "images/import.svg", promptImportClip),
      );
      return;
    }

    const folder = groupClips(metadata).find((item) => item.id === currentFolder);
    if (!folder) {
      currentFolder = null;
      return renderLibrary();
    }
    title.textContent = folder.name;
    const search = createSearch("Search clips…", (query) => {
      const value = query.trim().toLowerCase();
      content.querySelectorAll(".miso-clip-entry").forEach((element) => {
        element.hidden = !element.dataset.search.includes(value);
      });
    });
    content.appendChild(search.wrapper);
    const list = document.createElement("div");
    list.className = "miso-clip-list";
    if (!folder.clips.length) {
      const empty = document.createElement("p");
      empty.className = "miso-empty";
      empty.textContent =
        folder.id === UNKNOWN_FOLDER
          ? "Clips whose maps are unavailable will appear here."
          : "No clips in this folder.";
      list.appendChild(empty);
    }
    for (const clip of folder.clips) {
      const button = document.createElement("button");
      button.className = "button miso-clip-entry";
      button.dataset.search = `${clip.name} ${clip.playerName || ""} ${clip.trackId || ""}`.toLowerCase();
      const subtitle =
        folder.id === UNKNOWN_FOLDER && clip.trackId
          ? `${clip.trackId.slice(0, 12)}… · ${framesToTime(clip.frames)}`
          : `${clip.playerName || "Anonymous"} · ${framesToTime(clip.frames)}`;
      button.innerHTML = `<h2></h2><p></p><img class="miso-check" src="images/checkmark.svg" alt="Selected">`;
      button.querySelector("h2").textContent = clip.name;
      button.querySelector("p").textContent = subtitle;
      button.addEventListener("click", () => {
        if (selectedClipIds.has(clip.id)) selectedClipIds.delete(clip.id);
        else selectedClipIds.add(clip.id);
        button.classList.toggle("selected", selectedClipIds.has(clip.id));
      });
      list.appendChild(button);
    }
    content.appendChild(list);
    actions.append(
      makeButton("Maps", "images/back.svg", () => {
        currentFolder = null;
        renderLibrary();
      }, "back"),
      makeButton("Export", "images/export.svg", async () => {
        const selected = metadata.filter((clip) => selectedClipIds.has(clip.id));
        if (selected.length !== 1) return alert("Select one clip to export.");
        const code = await clipToExport(selected[0]);
        try {
          await navigator.clipboard.writeText(code);
          showToast("Clip code copied");
        } catch {
          prompt("Copy this clip code:", code);
        }
      }),
      makeButton("Import", "images/import.svg", promptImportClip),
      makeButton("Watch", "images/play.svg", () => playSelected(metadata)),
      makeButton("Delete", "images/delete.svg", async () => {
        if (!selectedClipIds.size) return alert("Select at least one clip first.");
        if (!confirm(`Delete ${selectedClipIds.size} selected ${selectedClipIds.size === 1 ? "clip" : "clips"}?`)) return;
        await deleteClips([...selectedClipIds]);
        renderLibrary();
      }),
      makeButton("Rename", "images/reset.svg", async () => {
        const selected = metadata.filter((clip) => selectedClipIds.has(clip.id));
        if (selected.length !== 1) return alert("Select one clip to rename.");
        const name = prompt("Clip name:", selected[0].name);
        if (!name?.trim()) return;
        selected[0].name = name.trim();
        await updateClipMetadata(selected[0]);
        renderLibrary();
      }),
    );
  }

  function closeClipLibrary() {
    document.querySelector(".miso-clip-library")?.remove();
    currentFolder = null;
    selectedClipIds = new Set();
  }

  async function openClipLibrary() {
    if (document.querySelector(".miso-clip-library")) return;
    const panel = document.createElement("section");
    panel.className = "miso-clip-library";
    panel.setAttribute("aria-label", "Clip library");
    panel.innerHTML = `<header><h2>Your Clips:</h2></header><div class="miso-clip-content"><div class="miso-loading">Loading clips…</div></div><footer class="miso-clip-actions"></footer>`;
    document.getElementById("ui")?.appendChild(panel);
    try {
      await migrateLegacyClips();
      await renderLibrary();
    } catch (error) {
      console.error(error);
      panel.querySelector(".miso-clip-content").textContent =
        "Clips could not be loaded from browser storage.";
    }
  }

  function formatKey(code) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    return code;
  }

  function ensureMenuButton() {
    const container = document.querySelector(".menu-ui > .main-buttons-container");
    if (!container || document.getElementById("miso-clips-button")) return;
    const button = document.createElement("button");
    button.id = "miso-clips-button";
    button.className = "button button-image button-spawn";
    button.innerHTML = `<img src="images/video.svg" alt=""><p>Clips</p>`;
    button.addEventListener("click", openClipLibrary);
    container.insertBefore(button, container.lastElementChild);
  }

  document.addEventListener("keydown", (event) => {
    if (
      event.code !== (localStorage.getItem(CLIP_KEY) || DEFAULT_CLIP_KEY) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    createClip();
  });

  const observer = new MutationObserver(ensureMenuButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", ensureMenuButton);
  setTimeout(() => migrateLegacyClips().catch(console.error), 2500);
})();
