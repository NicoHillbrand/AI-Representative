// Thin, explicit bridge — the renderer gets exactly these capabilities and
// nothing else (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huddle", {
  storeGet: () => ipcRenderer.invoke("store-get"),
  storeSet: (patch) => ipcRenderer.invoke("store-set", patch),
  hideWindow: () => ipcRenderer.send("hide-window"),
  getPinned: () => ipcRenderer.invoke("get-pinned"),
  setPinned: (on) => ipcRenderer.invoke("set-pinned", on),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  copyText: (text) => ipcRenderer.send("copy-text", text),
  notify: (title, body, silent) => ipcRenderer.send("notify", { title, body, silent }),
  setShortcut: (accel) => ipcRenderer.invoke("set-shortcut", accel),
  getShortcut: () => ipcRenderer.invoke("get-shortcut"),
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  setAutostart: (on) => ipcRenderer.invoke("set-autostart", on),
  setTrayState: (available, tooltip) => ipcRenderer.send("tray-state", { available, tooltip }),
  onQuickAvailable: (fn) => ipcRenderer.on("quick-available", (_e, mins) => fn(mins)),
  onQuickClear: (fn) => ipcRenderer.on("quick-clear", () => fn()),
});
