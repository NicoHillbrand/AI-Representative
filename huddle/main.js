// Huddle — desktop overlay shell (specs/desktop-call-overlay.md §8).
// Owns everything native: window, tray, global shortcut, notifications,
// local persistence. All product logic lives in the renderer.
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  shell,
  Notification,
  nativeImage,
  clipboard,
} = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

// --- single instance ---------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

// --- tiny JSON store (token, settings) ----------------------------------------
const storeFile = () => join(app.getPath("userData"), "huddle-store.json");
function storeGet() {
  try {
    return JSON.parse(readFileSync(storeFile(), "utf8"));
  } catch {
    return {};
  }
}
function storeSet(patch) {
  const next = { ...storeGet(), ...patch };
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(storeFile(), JSON.stringify(next, null, 2));
  return next;
}

// --- window ------------------------------------------------------------------
let win = null;
let tray = null;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
    },
  });
  win.loadFile(join(__dirname, "renderer", "index.html"));
  // The overlay stays on screen deliberately — hiding is always an explicit
  // act (Esc, the global shortcut, or the tray).
  win.on("closed", () => (win = null));
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win?.isVisible()) win.hide();
  else showWindow();
}

// --- tray ---------------------------------------------------------------------
const icon = (name) =>
  nativeImage.createFromPath(join(__dirname, "assets", `tray-${name}.png`));

function createTray() {
  tray = new Tray(icon("idle"));
  tray.setToolTip("Huddle — nobody signaled");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide", click: toggleWindow },
      { type: "separator" },
      {
        label: "Available for 60 min",
        click: () => {
          showWindow();
          win.webContents.send("quick-available", 60);
        },
      },
      {
        label: "Clear my signal",
        click: () => win?.webContents.send("quick-clear"),
      },
      { type: "separator" },
      { label: "Quit Huddle", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleWindow);
}

// --- IPC (surface used by preload.js) -----------------------------------------
ipcMain.handle("store-get", () => storeGet());
ipcMain.handle("store-set", (_e, patch) => storeSet(patch));
ipcMain.on("hide-window", () => win?.hide());
ipcMain.on("open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on("copy-text", (_e, text) => {
  if (typeof text === "string") clipboard.writeText(text.slice(0, 1000));
});
ipcMain.on("notify", (_e, { title, body, silent }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: !!silent });
  n.on("click", showWindow);
  n.show();
});

// Rebind the global show/hide shortcut. Keeps the old binding on failure
// (e.g. the accelerator is taken by another app).
ipcMain.handle("set-shortcut", (_e, accel) => {
  if (typeof accel !== "string" || !accel.trim()) return { ok: false, error: "empty" };
  const current = storeGet().shortcut || DEFAULT_SHORTCUT;
  try {
    globalShortcut.unregister(current);
    if (!globalShortcut.register(accel, toggleWindow)) throw new Error("taken");
    storeSet({ shortcut: accel });
    return { ok: true };
  } catch {
    globalShortcut.register(current, toggleWindow);
    return { ok: false, error: "That combination couldn't be registered (already in use?)." };
  }
});
ipcMain.handle("get-shortcut", () => storeGet().shortcut || DEFAULT_SHORTCUT);

// Launch-at-login. Note: has no effect in dev (`npm start` runs electron.exe,
// not an installed app) — meaningful once the app is packaged.
ipcMain.handle("get-autostart", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("set-autostart", (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return app.getLoginItemSettings().openAtLogin;
});
// Renderer reports our own availability so the tray dot reflects it.
ipcMain.on("tray-state", (_e, { available, tooltip }) => {
  tray?.setImage(icon(available ? "available" : "idle"));
  if (tooltip) tray?.setToolTip(tooltip);
});

// --- lifecycle -----------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  createTray();
  const shortcut = storeGet().shortcut || DEFAULT_SHORTCUT;
  const ok = globalShortcut.register(shortcut, toggleWindow);
  if (!ok) console.error(`Huddle: failed to register global shortcut ${shortcut}`);
  // Tray-only app: no dock icon on macOS.
  app.dock?.hide();
  // Dev convenience: HUDDLE_DEBUG=1 shows the window immediately (and keeps it
  // open on blur) instead of waiting for the shortcut.
  if (process.env.HUDDLE_DEBUG) {
    win.removeAllListeners("blur");
    showWindow();
  }
});

// Stay alive with all windows closed — we live in the tray.
app.on("window-all-closed", () => {});
app.on("will-quit", () => globalShortcut.unregisterAll());
