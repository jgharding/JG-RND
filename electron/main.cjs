// JG-RND desktop app: wraps the built web app (dist/) in Electron so Web MIDI (SysEx), WebUSB
// (DFU firmware flasher) and IndexedDB work exactly as in Chrome, on Windows, macOS and Linux.
//
// The app is served from a custom app://jg-rnd/ origin (not file://) so it is a secure context
// (needed for Web MIDI / WebUSB), fetch() of public/firmware/*.json works, and the library's
// IndexedDB / localStorage keep one stable origin between launches.

const { app, BrowserWindow, Menu, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "app";
const HOST = "jg-rnd";
const DIST_DIR = path.join(__dirname, "..", "dist");

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// One window only; a second launch focuses the first
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;

function serveDist() {
  protocol.handle(SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const filePath = path.normalize(path.join(DIST_DIR, relative));
    // Never serve anything outside dist/
    if (!filePath.startsWith(DIST_DIR + path.sep)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// STMicroelectronics DFU bootloader, as requested by the firmware flasher (flasherService.ts)
const isDfuDevice = (device) =>
  device.vendorId === 0x0483 || (device.deviceClass === 0xfe && device.deviceSubclass === 0x01);

function setUpPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(["midi", "midiSysex", "usb"]);

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
  ses.setDevicePermissionHandler((details) => details.deviceType === "usb");

  // Electron has no device chooser like Chrome's: pick the RND in DFU mode automatically
  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    const device = details.deviceList.find(isDfuDevice) ?? details.deviceList[0];
    callback(device?.deviceId);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0c0e",
    title: "JG-RND",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.maximize();

  // Links (Cyma Forma updater, GitHub releases) open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== `${SCHEME}://${HOST}`) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`${SCHEME}://${HOST}/index.html`);
  mainWindow.on("closed", () => (mainWindow = null));
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  // No menu bar on Windows / Linux (copy / paste in text fields still work); macOS keeps its
  // default app menu, which is what provides Cmd+C / Cmd+V there
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  serveDist();
  setUpPermissions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
