// Set what this machine is, without anybody having to edit JSON by hand.
//
//     node configure.js desk           this PC enrols people, and clocks nobody
//     node configure.js door 1         this PC is Bayan Bayanan's door
//     node configure.js door 2         this PC is Dao's door
//
// Editing door.json in Notepad is one missing comma away from a program that
// will not start, and the person doing it is usually standing in a shop.
import fs from 'node:fs';

const FILE = new URL('./door.json', import.meta.url);
const EXAMPLE = new URL('./door.example.json', import.meta.url);
const SHOPS = { 1: 'Bayan Bayanan', 2: 'Dao' };

const [what, which] = process.argv.slice(2);

let conf;
try {
  conf = JSON.parse(fs.readFileSync(fs.existsSync(FILE) ? FILE : EXAMPLE, 'utf8'));
} catch (e) {
  console.log(`\n  door.json could not be read: ${e.message}`);
  console.log('  Delete it and run this again — it will start from the example.\n');
  process.exit(1);
}

if (what === 'desk') {
  conf.desk = true;
  fs.writeFileSync(FILE, JSON.stringify(conf, null, 2) + '\n');
  console.log('\n  This PC is now an ENROLMENT DESK.');
  console.log('\n  It holds the scanner for enrolling people and clocks nobody on —');
  console.log('  which is what you want, because enrolling everybody means everybody');
  console.log('  puts a finger on the glass, and at a door each of those would be an');
  console.log('  arrival.');
  console.log('\n  Start it, then open http://127.0.0.1:9500/office to enrol.\n');
} else if (what === 'door' && SHOPS[which]) {
  conf.desk = false;
  conf.shop = Number(which);
  fs.writeFileSync(FILE, JSON.stringify(conf, null, 2) + '\n');
  console.log(`\n  This PC is now the door at ${SHOPS[which]} (shop ${which}).`);
  console.log('\n  It will only ever hold that shop\'s fingerprints — get this number');
  console.log('  wrong and the door simply will not recognise anybody.');
  console.log('\n  Start it, then open http://127.0.0.1:9500/ and leave it on screen.\n');
} else {
  console.log('\n  Say which:');
  console.log('     node configure.js desk        this PC enrols people');
  console.log('     node configure.js door 1      this PC is Bayan Bayanan\'s door');
  console.log('     node configure.js door 2      this PC is Dao\'s door\n');
  process.exit(1);
}
