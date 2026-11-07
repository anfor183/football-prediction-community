const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const checks = [
  { p: path.join(__dirname, '..', 'resources', 'icon.ico'), desc: 'Windows icon (resources/icon.ico)' },
  { p: path.join(root, 'utils'), desc: 'utils folder' },
  { p: path.join(root, 'chrome'), desc: 'chrome folder' }
];

let ok = true;
for (const c of checks) {
  if (!fs.existsSync(c.p)) {
    console.error('Missing required package resource:', c.desc, '->', c.p);
    ok = false;
  } else {
    console.log('OK:', c.desc);
  }
}

if (!ok) {
  console.error('\nOne or more required package resources are missing. Aborting packaging.');
  process.exit(1);
}

console.log('\nAll required package resources found.');
process.exit(0);
