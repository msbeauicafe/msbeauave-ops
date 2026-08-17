// Install the door agent as a Windows service, so it starts with the PC.
//
// A shop should not depend on somebody remembering to open a command prompt
// before the first person arrives. Run once:
//
//     npm install -g node-windows
//     node service-install.js
//
// To take it off again: `node service-install.js --remove`.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is not installed. Run:  npm install -g node-windows');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));

const service = new Service({
  name: 'MS BEAU AVE door',
  description: 'Holds the fingerprint scanner at this door and answers the time clock.',
  script: path.join(here, 'door.js'),
  // The scanner may not be ready the instant Windows is, and the shop's
  // internet usually is not either. Retry rather than give up.
  wait: 5,
  grow: 0.5,
  maxRestarts: 20,
});

service.on('install', () => {
  console.log('Installed. Starting…');
  service.start();
});
service.on('start', () => console.log('Running. It will start with the PC from now on.'));
service.on('uninstall', () => console.log('Removed.'));
service.on('alreadyinstalled', () => console.log('Already installed — nothing to do.'));
service.on('error', (e) => console.error('Service error:', e));

if (process.argv.includes('--remove')) service.uninstall();
else service.install();
