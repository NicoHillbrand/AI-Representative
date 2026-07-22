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
    width: 320,
    height: 600,
    show: true,
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
  // DevTools toggle (F12 / Ctrl+Shift+I) — frameless windows have no menu, so
  // wire the accelerators by hand.
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    const ctrlShiftI = input.control && input.shift && input.key.toLowerCase() === "i";
    if (input.key === "F12" || ctrlShiftI) win.webContents.toggleDevTools();
  });
  // The overlay stays on screen deliberately — hiding is always an explicit
  // act (Esc, the global shortcut, or the tray).
  // Minimizing shows a taskbar tile (see "minimize-window"); once restored,
  // go back to being a tray-only floater.
  win.on("restore", () => win?.setSkipTaskbar(true));
  win.on("closed", () => (win = null));
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win?.isVisible() && !win.isMinimized()) win.hide();
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
ipcMain.on("minimize-window", () => {
  if (!win) return;
  win.setSkipTaskbar(false); // taskbar tile while minimized, so it's findable
  win.minimize();
});
// The renderer reports its natural content height so the window hugs the
// content (no dead space under a short friends list).
ipcMain.on("resize-window", (_e, height) => {
  if (!win || typeof height !== "number" || !Number.isFinite(height)) return;
  const h = Math.round(Math.min(640, Math.max(180, height)));
  const [w] = win.getSize();
  // setSize can be a no-op while resizable is false — toggle around it.
  win.setResizable(true);
  win.setSize(w, h);
  win.setResizable(false);
});
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

// Launch-at-login. Only meaningful once the app is packaged: in dev
// (`npm start`) process.execPath is electron.exe with no app path, so Windows
// would register a bare Electron that boots to the default welcome screen.
// Guard every registration on app.isPackaged so dev runs never touch the
// registry Run key.
ipcMain.handle("get-autostart", () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle("set-autostart", (_e, on) => {
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: !!on });
  storeSet({ autostart: !!on });
  return app.getLoginItemSettings().openAtLogin;
});
// On by default: enable launch-at-login on the first packaged run. Only an
// explicit user opt-out (the settings toggle, which writes autostart:false)
// suppresses it — a fresh store (autostart undefined) gets it turned on.
function initAutostart() {
  if (!app.isPackaged) return;
  if (storeGet().autostart !== undefined) return; // respect an explicit choice
  app.setLoginItemSettings({ openAtLogin: true });
  storeSet({ autostart: true });
}
// Renderer reports our own availability so the tray dot reflects it.
ipcMain.on("tray-state", (_e, { available, tooltip }) => {
  tray?.setImage(icon(available ? "available" : "idle"));
  if (tooltip) tray?.setToolTip(tooltip);
});

// --- lifecycle -----------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  createTray();
  initAutostart();
  const shortcut = storeGet().shortcut || DEFAULT_SHORTCUT;
  const ok = globalShortcut.register(shortcut, toggleWindow);
  if (!ok) console.error(`Huddle: failed to register global shortcut ${shortcut}`);
  // Tray-only app: no dock icon on macOS.
  app.dock?.hide();
  // Show on launch by default (including autostart) — hiding is always an
  // explicit act (Esc, the global shortcut, or the tray). Set HUDDLE_START_HIDDEN=1
  // to launch straight to the tray instead.
  if (!process.env.HUDDLE_START_HIDDEN) showWindow();
});

// Stay alive with all windows closed — we live in the tray.
app.on("window-all-closed", () => {});
app.on("will-quit", () => globalShortcut.unregisterAll());
