// Loads the game, installs the prepared resources and the player's saved
// files in its virtual filesystem, then starts it and keeps saving the
// player's files in the browser's storage (OPFS). A service worker (sw.js)
// keeps the large files for later visits.
import "./audio.js"; // before the game's glue, which keeps the AudioContext it finds

const ROOT = ".local/horizon-client/26.3";
const status = document.getElementById("status");

// Whether this browser can draw the game; says why not on the page.
async function webgpu() {
    if (!navigator.gpu) {
        status.textContent = `Horizon needs WebGPU, which this browser doesn't offer.`;
        return false;
    }
    if (!(await navigator.gpu.requestAdapter().catch(() => null))) {
        status.textContent = "Horizon needs WebGPU, and this browser offers it but found no GPU to use " +
            `(it may be switched off, or the graphics driver not supported).`;
        return false;
    }
    return true;
}

// Starts the service worker and, on a first visit, waits briefly for it to
// take over the page, so the large files it fetches are kept.
// A host that sends no isolation headers (a static host) gets them from the
// service worker: once it is active, a reload through it makes the page
// isolated. That also covers a first install slower than the wait and a hard
// reload, which skips the worker (it never takes over that page).
async function cacheWorker() {
    const workers = navigator.serviceWorker;
    if (!workers) return;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let active = false;
    try {
        await workers.register("sw.js");
        if (!workers.controller) {
            await Promise.race([
                new Promise((resolve) => workers.addEventListener("controllerchange", resolve, { once: true })),
                wait(3000),
            ]);
        }
        active = !!workers.controller ||
            (!window.crossOriginIsolated && !!(await Promise.race([workers.ready, wait(30000)]))?.active);
    } catch (e) {
        console.warn(`Horizon: no service worker, files won't be kept for later visits: ${e}`);
        return;
    }
    if (!window.crossOriginIsolated && active && !sessionStorage.getItem("horizon-isolating")) {
        sessionStorage.setItem("horizon-isolating", "1");
        location.reload();
        await new Promise(() => {});
    }
    sessionStorage.removeItem("horizon-isolating");
}

// The large files' and the page's scripts' addresses with their content hash
// (build.json), which the service worker keeps them by. Every file that must
// match the WebAssembly is asked for by its hash, so a browser or CDN cache
// that kept an older one (only the wasm's address changed) can't pair it with
// this build's module.
async function versioned() {
    const files = await fetch("build.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    const at = (path) => (files[path] ? `${path}?v=${files[path]}` : path);
    // The workers load the same glue as the page (horizon-os's workers.rs).
    const glue = files["pkg/horizon-client.js"];
    globalThis.horizonWorkerScript = glue ? `worker.js?v=${files["worker.js"] ?? ""}&glue=${glue}` : "worker.js";
    return { wasm: at("pkg/horizon-client_bg.wasm"), boot: at("fs/boot.tar.gz"), glue: `./${at("pkg/horizon-client.js")}`,
        manifest: at("fs/manifest.txt") };
}

async function download(url, label) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const total = Number(response.headers.get("Content-Length")) || 0;
    let received = 0;
    const counted = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            received += chunk.length;
            if (total) status.textContent = `${label} ${Math.round((received / total) * 100)}%`;
            controller.enqueue(chunk);
        },
    }));
    return counted;
}

// The player's files (options, saves) live under this folder of the
// origin's private file system, laid out as in the virtual filesystem. Where
// that is refused, in IndexedDB instead, one record per path.
async function savedRoot() {
    try {
        return await (await navigator.storage.getDirectory()).getDirectoryHandle("horizon", { create: true });
    } catch (e) {
        try {
            return await idbOpen();
        } catch (e2) {
            console.warn(`Horizon: no browser storage, nothing will be saved: ${e}; ${e2}`);
            return null;
        }
    }
}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbOpen() {
    const request = indexedDB.open("horizon", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    return idbRequest(request);
}

// A path's record: { data, modified } for a file, { data: null } for a folder.
async function idbLoad(glue, db) {
    const files = db.transaction("files").objectStore("files");
    const [paths, records] = await Promise.all([idbRequest(files.getAllKeys()), idbRequest(files.getAll())]);
    // In key order: a folder before what it holds.
    paths.forEach((path, i) => {
        const { data, modified } = records[i];
        if (data) glue.horizon_install_saved_file(path, data, modified);
        else glue.horizon_install_saved_dir(path);
    });
    return records.filter((r) => r.data).length;
}

async function idbApply(db, path, kind, data) {
    const transaction = db.transaction("files", "readwrite");
    const files = transaction.objectStore("files");
    if (kind !== "dir") files.delete(IDBKeyRange.bound(`${path}/`, `${path}/\uffff`));
    if (kind === "gone") files.delete(path);
    else files.put(kind === "file" ? { data, modified: Date.now() } : { data: null }, path);
    await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
}

async function loadSaved(glue, dir, path) {
    if (dir instanceof IDBDatabase) return idbLoad(glue, dir);
    let files = 0;
    for await (const [name, handle] of dir.entries()) {
        const at = `${path}/${name}`;
        if (handle.kind === "directory") {
            glue.horizon_install_saved_dir(at);
            files += await loadSaved(glue, handle, at);
        } else {
            const file = await handle.getFile();
            glue.horizon_install_saved_file(at, new Uint8Array(await file.arrayBuffer()), file.lastModified);
            files += 1;
        }
    }
    return files;
}

// The folder holding `parts`, made when `create`; null when it's missing.
async function folder(root, parts, create) {
    let dir = root;
    for (const part of parts) {
        try {
            dir = await dir.getDirectoryHandle(part, { create });
        } catch (e) {
            if (create && e.name === "TypeMismatchError") {
                // A file where a folder goes now.
                await dir.removeEntry(part);
                dir = await dir.getDirectoryHandle(part, { create });
            } else if (e.name === "NotFoundError") {
                return null;
            } else {
                throw e;
            }
        }
    }
    return dir;
}

async function apply(root, path, kind, data) {
    if (root instanceof IDBDatabase) return idbApply(root, path, kind, data);
    const parts = path.split("/").filter(Boolean);
    if (kind === "gone") {
        const dir = await folder(root, parts.slice(0, -1), false);
        await dir?.removeEntry(parts.at(-1), { recursive: true }).catch((e) => {
            if (e.name !== "NotFoundError") throw e;
        });
    } else if (kind === "file") {
        const dir = await folder(root, parts.slice(0, -1), true);
        const name = parts.at(-1);
        let handle;
        try {
            handle = await dir.getFileHandle(name, { create: true });
        } catch (e) {
            if (e.name !== "TypeMismatchError") throw e;
            // A folder where a file goes now.
            await dir.removeEntry(name, { recursive: true });
            handle = await dir.getFileHandle(name, { create: true });
        }
        // Written to a scratch file and swapped in on close: never half a file.
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    } else {
        if (kind === "cleardir") {
            const dir = await folder(root, parts.slice(0, -1), false);
            await dir?.removeEntry(parts.at(-1), { recursive: true }).catch(() => {});
        }
        await folder(root, parts, true);
    }
}

// Saves what the game changed since the last time, one batch at a time.
let saving = null;
function saveChanges(glue, root) {
    saving ??= (async () => {
        for (const [path, kind, data] of glue.horizon_take_changes()) {
            try {
                await apply(root, path, kind, data);
            } catch (e) {
                console.error(`Horizon: could not save ${path}: ${e}`);
            }
        }
    })().finally(() => {
        saving = null;
    });
    return saving;
}

// The game's glue, its module and the resources, from the server.
async function served() {
    await cacheWorker();
    // The game's threads share memory, which browsers allow only on a
    // cross-origin isolated page.
    if (!window.crossOriginIsolated) throw new Error("the page can't share memory with the game's threads");
    const files = await versioned();
    status.textContent = "Loading the game…";
    // The resources download and unpack while the module downloads and
    // compiles (a first visit waited for one, then the other).
    const tar = download(files.boot, "Downloading resources")
        .then((gz) => new Response(gz.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const manifest = fetch(files.manifest).then((r) => r.text());
    // A failure while the module loads leaves these unread: not unhandled.
    tar.catch(() => {});
    manifest.catch(() => {});
    const glue = await import(files.glue);
    globalThis.horizon = glue; // horizon.horizon_status() and the like, from the console
    // Runs the game's main, which only registers the game to start.
    await glue.default({ module_or_path: files.wasm });
    return { glue, tar: new Uint8Array(await tar), manifest: await manifest, base: "fs/res/" };
}

// ---- File System Access API local persistent storage (horizon-26-3-save) ----
const SAVE_DIR_NAME = "horizon-26-3-save";
const WEB_CFG_FILE = "_horizon_web_config.json";
const FS_LINK_DB = "horizon-fs-link";
const FS_LINK_STORE = "handles";
const FS_LINK_KEY = "dirHandle";

let linkedDir = null;
let syncTimerId = null;
let activeGlue = null;
let activeRoot = null;
let externalSyncing = null;

function getSyncSeconds() {
    const raw = Number(localStorage.getItem("horizon.fs.syncSec"));
    return Number.isFinite(raw) && raw >= 5 ? Math.round(raw) : 30;
}

function fsLinkOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(FS_LINK_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(FS_LINK_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveLinkedDirHandle(handle) {
    const db = await fsLinkOpen();
    const tx = db.transaction(FS_LINK_STORE, "readwrite");
    tx.objectStore(FS_LINK_STORE).put(handle, FS_LINK_KEY);
    await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = tx.onabort = () => rej(tx.error);
    });
}

async function loadLinkedDirHandle() {
    try {
        const db = await fsLinkOpen();
        const tx = db.transaction(FS_LINK_STORE, "readonly");
        return (await idbRequest(tx.objectStore(FS_LINK_STORE).get(FS_LINK_KEY))) || null;
    } catch {
        return null;
    }
}

async function clearLinkedDirHandle() {
    try {
        const db = await fsLinkOpen();
        const tx = db.transaction(FS_LINK_STORE, "readwrite");
        tx.objectStore(FS_LINK_STORE).delete(FS_LINK_KEY);
        await new Promise((res, rej) => {
            tx.oncomplete = res;
            tx.onerror = tx.onabort = () => rej(tx.error);
        });
    } catch {
        // ignore
    }
}

async function hasExistingSave(dirHandle) {
    try {
        const sub = await dirHandle.getDirectoryHandle(SAVE_DIR_NAME, { create: false });
        for await (const _ of sub.entries()) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function getSaveSubdir(dirHandle, create = true) {
    return dirHandle.getDirectoryHandle(SAVE_DIR_NAME, { create });
}

function collectWebConfig() {
    return {
        minimap: localStorage.getItem("horizon.mod.xaerominimap") !== "false",
        worldmap: localStorage.getItem("horizon.mod.xaeroworldmap") !== "false",
        syncSec: getSyncSeconds(),
    };
}

function applyWebConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    if (typeof cfg.minimap === "boolean") {
        localStorage.setItem("horizon.mod.xaerominimap", String(cfg.minimap));
    }
    if (typeof cfg.worldmap === "boolean") {
        localStorage.setItem("horizon.mod.xaeroworldmap", String(cfg.worldmap));
    }
    if (typeof cfg.syncSec === "number" && cfg.syncSec >= 5) {
        localStorage.setItem("horizon.fs.syncSec", String(Math.round(cfg.syncSec)));
    }
    const cbMinimap = document.getElementById("mod-xaerominimap");
    const cbWorldmap = document.getElementById("mod-xaeroworldmap");
    const syncInput = document.getElementById("file-sync-time");
    if (cbMinimap) cbMinimap.checked = localStorage.getItem("horizon.mod.xaerominimap") !== "false";
    if (cbWorldmap) cbWorldmap.checked = localStorage.getItem("horizon.mod.xaeroworldmap") !== "false";
    if (syncInput) syncInput.value = String(getSyncSeconds());
}

async function importFromExternalDir(extDir, root, glue, prefix = "") {
    let count = 0;
    for await (const [name, handle] of extDir.entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") {
            if (root) await apply(root, rel, "dir", null);
            if (glue) glue.horizon_install_saved_dir(rel);
            count += await importFromExternalDir(handle, root, glue, rel);
        } else {
            const file = await handle.getFile();
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (rel === WEB_CFG_FILE) {
                try {
                    applyWebConfig(JSON.parse(new TextDecoder().decode(bytes)));
                } catch {
                    // ignore malformed config
                }
                continue;
            }
            if (root) await apply(root, rel, "file", bytes);
            if (glue) glue.horizon_install_saved_file(rel, bytes, file.lastModified);
            count += 1;
        }
    }
    return count;
}

async function exportOpfsToExternal(srcDir, dstDir) {
    for await (const [name, handle] of srcDir.entries()) {
        if (handle.kind === "directory") {
            const subDst = await dstDir.getDirectoryHandle(name, { create: true });
            await exportOpfsToExternal(handle, subDst);
        } else {
            const file = await handle.getFile();
            const fh = await dstDir.getFileHandle(name, { create: true });
            const writable = await fh.createWritable();
            await writable.write(await file.arrayBuffer());
            await writable.close();
        }
    }
}

async function exportIdbToExternal(db, dstDir) {
    const store = db.transaction("files", "readonly").objectStore("files");
    const [paths, records] = await Promise.all([idbRequest(store.getAllKeys()), idbRequest(store.getAll())]);
    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const rec = records[i];
        await apply(dstDir, path, rec.data ? "file" : "dir", rec.data);
    }
}

async function syncToExternal(root, dirHandle) {
    if (!dirHandle) return;
    if (externalSyncing) return externalSyncing;
    externalSyncing = (async () => {
        const perm = await dirHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") return;
        const extSave = await getSaveSubdir(dirHandle, true);
        const cfgBytes = new TextEncoder().encode(JSON.stringify(collectWebConfig(), null, 2));
        await apply(extSave, WEB_CFG_FILE, "file", cfgBytes);
        if (root instanceof IDBDatabase) {
            await exportIdbToExternal(root, extSave);
        } else if (root) {
            await exportOpfsToExternal(root, extSave);
        }
        // Also export IndexedDB "horizon" if it exists alongside OPFS.
        if (!(root instanceof IDBDatabase)) {
            try {
                const db = await idbOpen();
                await exportIdbToExternal(db, extSave);
            } catch {
                // ignore if no idb
            }
        }
    })().finally(() => {
        externalSyncing = null;
    });
    return externalSyncing;
}

function updateFilePanelUi(statusText) {
    const pathEl = document.getElementById("file-path");
    const syncInput = document.getElementById("file-sync-time");
    const statusEl = document.getElementById("file-status");
    const disconnectBtn = document.getElementById("file-disconnect");
    const syncNowBtn = document.getElementById("file-sync-now");
    if (pathEl) {
        pathEl.textContent = linkedDir ? `${linkedDir.name}/${SAVE_DIR_NAME}` : "Not connected";
    }
    if (syncInput && document.activeElement !== syncInput) {
        syncInput.value = String(getSyncSeconds());
    }
    if (statusEl && statusText !== undefined) {
        statusEl.textContent = statusText;
    }
    if (disconnectBtn) disconnectBtn.disabled = !linkedDir;
    if (syncNowBtn) syncNowBtn.disabled = !linkedDir;
}

function restartExternalSyncTimer() {
    if (syncTimerId !== null) {
        clearInterval(syncTimerId);
        syncTimerId = null;
    }
    if (!linkedDir || !activeRoot) return;
    const ms = getSyncSeconds() * 1000;
    syncTimerId = setInterval(async () => {
        if (!linkedDir || !activeRoot) return;
        try {
            if (activeGlue) await saveChanges(activeGlue, activeRoot);
            await syncToExternal(activeRoot, linkedDir);
            const now = new Date().toLocaleTimeString();
            updateFilePanelUi(`Synced (${now})`);
        } catch (e) {
            console.warn("Horizon: periodic external sync failed:", e);
        }
    }, ms);
}

const FILE_API_FAIL_MSG = "Your browser does not support the File System Access API, or you did not grant file access.";

function isNotFoundError(e) {
    return e?.name === "NotFoundError" || String(e?.message || e).includes("could not be found");
}

function isFileApiError(e) {
    return e?.name === "NotAllowedError" || e?.name === "SecurityError";
}

function setMsg(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#f87171" : "";
}

async function connectFolderFlow(root, glue, msgEl, reloadOnImport = false) {
    if (!window.showDirectoryPicker) {
        setMsg(msgEl, FILE_API_FAIL_MSG, true);
        updateFilePanelUi(FILE_API_FAIL_MSG);
        return false;
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
        setMsg(msgEl, FILE_API_FAIL_MSG, true);
        updateFilePanelUi(FILE_API_FAIL_MSG);
        return false;
    }
    const existed = await hasExistingSave(handle);
    linkedDir = handle;
    await saveLinkedDirHandle(handle);
    if (existed) {
        const extSave = await getSaveSubdir(handle, false);
        await importFromExternalDir(extSave, root, glue);
        updateFilePanelUi("Loaded successfully");
        restartExternalSyncTimer();
        if (reloadOnImport) {
            setMsg(msgEl, "Loaded successfully — reloading…", false);
            setTimeout(() => location.reload(), 600);
            return "reloaded";
        }
        setMsg(msgEl, "Loaded successfully", false);
    } else {
        await syncToExternal(root, handle);
        setMsg(msgEl, "Configured successfully", false);
        updateFilePanelUi("Configured successfully");
        restartExternalSyncTimer();
    }
    return true;
}

function promptFirstVisitOverlay(root, restoredHandle, initialMsg = "") {
    const overlay = document.getElementById("fs-overlay");
    const msgEl = document.getElementById("fs-overlay-msg");
    const btnConnect = document.getElementById("fs-overlay-connect");
    const btnLater = document.getElementById("fs-overlay-later");
    const btnNever = document.getElementById("fs-overlay-never");
    if (!overlay || !btnConnect || !btnLater || !btnNever) return Promise.resolve();

    let currentRestored = restoredHandle;
    btnConnect.textContent = currentRestored ? `Reconnect (${currentRestored.name})` : "Connect Local Folder";
    setMsg(msgEl, initialMsg, Boolean(initialMsg));
    overlay.classList.add("open");

    return new Promise((resolve) => {
        const done = () => {
            overlay.classList.remove("open");
            resolve();
        };
        btnConnect.onclick = async () => {
            try {
                if (currentRestored) {
                    const perm = await currentRestored.requestPermission({ mode: "readwrite" });
                    if (perm !== "granted") {
                        setMsg(msgEl, FILE_API_FAIL_MSG, true);
                        updateFilePanelUi(FILE_API_FAIL_MSG);
                        return;
                    }
                    linkedDir = currentRestored;
                    const existed = await hasExistingSave(currentRestored);
                    if (existed) {
                        const extSave = await getSaveSubdir(currentRestored, false);
                        await importFromExternalDir(extSave, root, null);
                        setMsg(msgEl, "Loaded successfully — reloading…", false);
                        updateFilePanelUi("Loaded successfully");
                        restartExternalSyncTimer();
                        setTimeout(() => location.reload(), 600);
                        return;
                    } else {
                        await syncToExternal(root, currentRestored);
                        setMsg(msgEl, "Configured successfully", false);
                        updateFilePanelUi("Configured successfully");
                    }
                    restartExternalSyncTimer();
                    setTimeout(done, 700);
                    return;
                }
                const ok = await connectFolderFlow(root, null, msgEl, true);
                if (ok === "reloaded") return;
                if (ok) setTimeout(done, 700);
            } catch (e) {
                if (e.name === "AbortError") return;
                if (currentRestored && isNotFoundError(e)) {
                    currentRestored = null;
                    linkedDir = null;
                    await clearLinkedDirHandle();
                    btnConnect.textContent = "Connect";
                    setMsg(msgEl, "Saved folder could not be found. Click Connect to choose a folder.", true);
                    updateFilePanelUi("Saved folder not found");
                } else if (isFileApiError(e) || !window.showDirectoryPicker) {
                    setMsg(msgEl, FILE_API_FAIL_MSG, true);
                    updateFilePanelUi(FILE_API_FAIL_MSG);
                } else {
                    setMsg(msgEl, `Connection failed: ${e.message || e}`, true);
                    updateFilePanelUi(`Connection failed: ${e.message || e}`);
                }
            }
        };
        btnLater.onclick = () => done();
        btnNever.onclick = () => {
            localStorage.setItem("horizon.fs.dontShow", "true");
            done();
        };
    });
}

async function prepareExternalStorage(root) {
    activeRoot = root;
    const savedHandle = await loadLinkedDirHandle();
    if (savedHandle) {
        const perm = await savedHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
        if (perm === "granted") {
            try {
                linkedDir = savedHandle;
                if (await hasExistingSave(savedHandle)) {
                    const extSave = await getSaveSubdir(savedHandle, false);
                    await importFromExternalDir(extSave, root, null);
                    updateFilePanelUi("Loaded successfully");
                } else {
                    await syncToExternal(root, savedHandle);
                    updateFilePanelUi("Configured successfully");
                }
                restartExternalSyncTimer();
                return null;
            } catch (e) {
                if (isNotFoundError(e)) {
                    linkedDir = null;
                    await clearLinkedDirHandle();
                } else {
                    throw e;
                }
            }
        }
        if (localStorage.getItem("horizon.fs.dontShow") !== "true") {
            updateFilePanelUi();
            return { needsPrompt: true, restoredHandle: linkedDir ? savedHandle : (perm === "prompt" ? savedHandle : null) };
        }
    } else if (localStorage.getItem("horizon.fs.dontShow") !== "true") {
        updateFilePanelUi();
        return { needsPrompt: true, restoredHandle: null };
    }
    updateFilePanelUi();
    return null;
}

async function main() {
    if (!(await webgpu())) return;
    const { glue, tar, manifest, base } = await served();
    activeGlue = glue;
    status.textContent = "Installing resources…";
    const t0 = performance.now();
    const installed = glue.horizon_install_tar(ROOT, tar);
    glue.horizon_install_manifest(ROOT, base, manifest);
    console.log(`Horizon: ${installed} files installed in ${Math.round(performance.now() - t0)} ms`);

    const root = await savedRoot();
    let pendingPrompt = null;
    if (root) {
        pendingPrompt = await prepareExternalStorage(root);
        const t1 = performance.now();
        const saved = await loadSaved(glue, root, "");
        console.log(`Horizon: ${saved} saved files loaded in ${Math.round(performance.now() - t1)} ms`);
        setInterval(() => saveChanges(glue, root), 2000);
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                saveChanges(glue, root).then(() => syncToExternal(root, linkedDir));
            }
        });
        addEventListener("pagehide", () => {
            saveChanges(glue, root);
            syncToExternal(root, linkedDir);
        });
    }

    status.textContent = "Loading resources…";
    // Let the status paint before the game blocks the page while it loads.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    status.textContent = "";
    // Install mod loader toggle state before starting Horizon.
    const modCfg = JSON.stringify({
        minimap: localStorage.getItem("horizon.mod.xaerominimap") !== "false",
        worldmap: localStorage.getItem("horizon.mod.xaeroworldmap") !== "false",
    });
    glue.horizon_install_saved_file(
        "config/xaero/mods_enabled.json",
        new TextEncoder().encode(modCfg),
        Date.now(),
    );
    // The game's command-line arguments, from the address: ?args=--world%20T
    const args = (new URLSearchParams(location.search).get("args") ?? "").split(" ").filter(Boolean);
    try {
        glue.horizon_start(args);
    } catch (e) {
        // winit leaves Rust's stack by throwing once its event loop is set up.
        if (!String(e).includes("Using exceptions for control flow")) throw e;
    }
    if (root && pendingPrompt?.needsPrompt) {
        promptFirstVisitOverlay(root, pendingPrompt.restoredHandle);
    }
}

main().catch((e) => {
    console.error(e);
    // The game's workers share memory, which browsers allow only on a
    // cross-origin isolated page.
    const isolation = window.crossOriginIsolated ? "" :
        "\n\nThe page isn't cross-origin isolated: its server must send " +
        "Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.";
    status.textContent = `Horizon could not start:\n${e}${isolation}`;
});


function initModsPanel() {
    const toggleBtn = document.getElementById("mods-toggle");
    const panel = document.getElementById("mods-panel");
    const fileToggle = document.getElementById("file-toggle");
    const filePanel = document.getElementById("file-panel");
    const cbMinimap = document.getElementById("mod-xaerominimap");
    const cbWorldmap = document.getElementById("mod-xaeroworldmap");
    const note = document.getElementById("mods-note");
    const reloadBtn = document.getElementById("mods-reload");
    if (!toggleBtn || !panel || !cbMinimap || !cbWorldmap) return;

    cbMinimap.checked = localStorage.getItem("horizon.mod.xaerominimap") !== "false";
    cbWorldmap.checked = localStorage.getItem("horizon.mod.xaeroworldmap") !== "false";

    toggleBtn.addEventListener("click", () => {
        const open = panel.classList.toggle("open");
        if (fileToggle) fileToggle.style.display = open ? "none" : "";
        if (open && filePanel) filePanel.classList.remove("open");
    });

    const onToggle = () => {
        localStorage.setItem("horizon.mod.xaerominimap", String(cbMinimap.checked));
        localStorage.setItem("horizon.mod.xaeroworldmap", String(cbWorldmap.checked));
        if (note) note.style.display = "block";
        if (reloadBtn) reloadBtn.style.display = "block";
    };

    cbMinimap.addEventListener("change", onToggle);
    cbWorldmap.addEventListener("change", onToggle);
    if (reloadBtn) {
        reloadBtn.addEventListener("click", () => location.reload());
    }
}

function initFilePanel() {
    const toggleBtn = document.getElementById("file-toggle");
    const panel = document.getElementById("file-panel");
    const modsPanel = document.getElementById("mods-panel");
    const syncInput = document.getElementById("file-sync-time");
    const connectBtn = document.getElementById("file-connect");
    const syncNowBtn = document.getElementById("file-sync-now");
    const disconnectBtn = document.getElementById("file-disconnect");
    const statusEl = document.getElementById("file-status");
    if (!toggleBtn || !panel) return;

    if (syncInput) syncInput.value = String(getSyncSeconds());
    updateFilePanelUi();

    toggleBtn.addEventListener("click", () => {
        const open = panel.classList.toggle("open");
        if (open && modsPanel) modsPanel.classList.remove("open");
    });

    if (syncInput) {
        syncInput.addEventListener("change", () => {
            const val = Math.max(5, Math.round(Number(syncInput.value) || 30));
            syncInput.value = String(val);
            localStorage.setItem("horizon.fs.syncSec", String(val));
            restartExternalSyncTimer();
            updateFilePanelUi(`Sync interval set to ${val}s`);
        });
    }

    if (connectBtn) {
        connectBtn.addEventListener("click", async () => {
            try {
                const root = activeRoot || (await savedRoot());
                if (!root) {
                    updateFilePanelUi("Browser storage unavailable.");
                    return;
                }
                activeRoot = root;
                const ok = await connectFolderFlow(root, activeGlue, statusEl);
                if (!ok && (!window.showDirectoryPicker || statusEl?.textContent === FILE_API_FAIL_MSG)) {
                    promptFirstVisitOverlay(root, null, FILE_API_FAIL_MSG);
                }
            } catch (e) {
                if (e.name === "AbortError") return;
                if (isFileApiError(e) || !window.showDirectoryPicker) {
                    updateFilePanelUi(FILE_API_FAIL_MSG);
                    promptFirstVisitOverlay(activeRoot, null, FILE_API_FAIL_MSG);
                } else {
                    updateFilePanelUi(`Connection failed: ${e.message || e}`);
                }
            }
        });
    }

    if (syncNowBtn) {
        syncNowBtn.addEventListener("click", async () => {
            if (!linkedDir || !activeRoot) return;
            try {
                if (activeGlue) await saveChanges(activeGlue, activeRoot);
                await syncToExternal(activeRoot, linkedDir);
                updateFilePanelUi(`Synced (${new Date().toLocaleTimeString()})`);
            } catch (e) {
                updateFilePanelUi(`Sync failed: ${e.message || e}`);
            }
        });
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener("click", async () => {
            linkedDir = null;
            if (syncTimerId !== null) {
                clearInterval(syncTimerId);
                syncTimerId = null;
            }
            await clearLinkedDirHandle();
            updateFilePanelUi("Disconnected");
        });
    }
}

initModsPanel();
initFilePanel();
