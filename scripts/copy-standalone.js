/* eslint-disable @typescript-eslint/no-require-imports */
const { cpSync } = require('node:fs');
const { resolve } = require('node:path');

const root = process.cwd();
const staticSrc = resolve(root, '.next/static');
const standaloneDotNextDest = resolve(root, '.next/standalone/.next');
const publicSrc = resolve(root, 'public');
const standalonePublicDest = resolve(root, '.next/standalone/public');

cpSync(staticSrc, standaloneDotNextDest, { recursive: true });
cpSync(publicSrc, standalonePublicDest, { recursive: true });

console.log('Copied standalone assets to .next/standalone');
