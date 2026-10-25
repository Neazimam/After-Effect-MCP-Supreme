// Installs (or removes) the CEP panel and enables unsigned-extension loading (PlayerDebugMode).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32', mac = process.platform === 'darwin';
if (!win && !mac) { console.error('After Effects only runs on Windows and macOS.'); process.exit(1); }

const extDir = win
  ? path.join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions')
  : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
const dest = path.join(extDir, 'com.aesupreme.mcp');
fs.rmSync(path.join(extDir, 'com.aegod.mcp'), { recursive: true, force: true }); // old name

if (process.argv.includes('--uninstall')) {
  fs.rmSync(dest, { recursive: true, force: true });
  console.log('Removed', dest); process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(extDir, { recursive: true });
fs.cpSync(path.join(root, 'ae-panel'), dest, { recursive: true });
console.log('Panel installed to', dest);

for (let v = 9; v <= 13; v++) {
  try {
    execSync(win ? `reg add HKCU\\Software\\Adobe\\CSXS.${v} /v PlayerDebugMode /t REG_SZ /d 1 /f` : `defaults write com.adobe.CSXS.${v} PlayerDebugMode 1`, { stdio: 'ignore' });
  } catch {}
}
if (mac) { try { execSync('killall cfprefsd', { stdio: 'ignore' }); } catch {} }
console.log('Enabled PlayerDebugMode for CSXS 9-13 (needed for unsigned panels).');
console.log('\nNext: restart After Effects, then Window > Extensions > "After Effect Supreme MCP".');
