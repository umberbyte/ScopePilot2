// Renderer integration harness. No engines, target transport, account state or external AI.
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1400, height: 1000, webPreferences: {
    preload: join(__dirname, '../../dist/preload.cjs'), contextIsolation: true, nodeIntegration: false,
    additionalArguments: ['--scopepilot-api-base=http://127.0.0.1:9'],
  } });
  window.loadFile(join(__dirname, '../../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
