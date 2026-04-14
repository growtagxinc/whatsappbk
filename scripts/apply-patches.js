/**
 * Post-install script: Apply WhatsApp protocol patches to @whiskeysockets/baileys
 *
 * Two fixes are needed because WhatsApp updated their protocol:
 * 1. baileys-version.json: Update WA protocol version from 1019707846 to 1034074495
 *    (Without this: WebSocket closes with HTTP 405 "Method Not Allowed")
 * 2. noise-handler.js: Defensively handle ephemeral/static as null/undefined/empty
 *    (Without this: "Cannot read properties of undefined (reading 'length')" in handshake)
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const baileysDir = path.join(rootDir, 'node_modules/@whiskeysockets/baileys/lib');

function applyPatch(name, srcFile, destRelPath) {
    const destPath = path.join(baileysDir, destRelPath);
    if (!fs.existsSync(destPath)) {
        console.warn(`[patches] SKIP: ${name} — target not found: ${destPath}`);
        return;
    }
    fs.copyFileSync(srcFile, destPath);
    console.log(`[patches] OK: ${name} applied`);
}

// 1. Update WA protocol version (fixes 405 error)
const versionSrc = path.join(rootDir, 'patches/baileys-version.json');
if (fs.existsSync(versionSrc)) {
    const versionDest = path.join(baileysDir, 'Defaults/baileys-version.json');
    if (fs.existsSync(versionDest)) {
        fs.copyFileSync(versionSrc, versionDest);
        console.log('[patches] OK: baileys-version.json updated to [2,3000,1034074495]');
    }
}

// 2. Patch noise-handler.js (fixes undefined ephemeral/static crash)
const noiseSrc = path.join(rootDir, 'patches/noise-handler.js');
if (fs.existsSync(noiseSrc)) {
    const noiseDest = path.join(baileysDir, 'Utils/noise-handler.js');
    if (fs.existsSync(noiseDest)) {
        fs.copyFileSync(noiseSrc, noiseDest);
        console.log('[patches] OK: noise-handler.js patched (defensive ephemeral/static handling)');
    }
}
