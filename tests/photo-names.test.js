// Matching a folder of photographs to a team, by filename.
//
// This is the one piece of the back office where being confidently wrong costs
// more than being unsure: a face filed against the wrong name goes onto the
// door screen, which exists to be recognised, and into the HR record. So the
// rule the tests hold it to is not "match as many as possible" — it is "never
// guess when two people could plausibly own the filename".
//
// The team it is tested against is the real one, which is what makes the test
// worth having: three people named Ibañez, two Jennifers, and Bon and Abagon
// each appearing as one person's surname and another's middle name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The matcher lives in the page it serves rather than in a module, because it
// runs in the browser against files that never leave the machine. Lifting it
// out by name keeps the test honest — it exercises the shipped code, not a
// second copy that can drift.
const app = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8');
const source = app.slice(app.indexOf('const nameWords ='), app.indexOf('function photosDialog'));
for (const needed of ['function scoreName', 'function bestMatch', 'function rarityAcross', 'let RARE']) {
  assert.ok(source.includes(needed), `the matcher moved (${needed}); this test needs updating`);
}

// bestMatch is the decision the screen actually makes, lifted whole. Nothing
// here re-implements it — a test that carried its own copy of the rule would
// keep passing while the shipped one broke, which is the failure this exists
// to prevent.
const { nameWords, bestMatch, rarityAcross, setRare } = new Function(`
  ${source}
  return { nameWords, bestMatch, rarityAcross, setRare: (m) => { RARE = m; } };
`)();

const TEAM = [
  'Melmark Tiangco Loberiano', 'Gina Abarracoso Ibañez', 'Jennifer Gojo Esplana',
  'Princess Mariel Dasalla Sevilla', 'Rey Allen Gonzales Delacruz',
  'Dixie Rose Reyes Alfonso', 'Reymar Cator Mahinay', 'Sarah Jane Fabros',
  'Cristalynn Cristi', 'Marygrace Belarmino Abagon', 'Prince Kenneth Asi Canlas',
  'Omar Villanueva Dispabeladero', 'John Renz Marientes Ibañez',
  'Jeorge Melvin Roxas Panesa', 'Mark Elvin Abagon Malapajo',
  'Stephanie Orandoy Mayordomo', 'Cathlene Aira Leorag Esguerra',
  'Mary Germae Tanwangco Mangulabnan', 'Gabriella Marie Zausa',
  'Aj Claurence Acutem Flormata', 'Carla Jane Cortez Malana',
  'Angela Aminah Lim Casitas', 'Fiona Gweneth Idorot Cremen',
  'Jerilo Batis Pepito', 'Ma. Beatriz Diane Gochuico Pardo',
  'Kryzerna Mariz Guiyab Apostol', 'Darevee Francisco Domingo',
  'Jeffrey Bon Labios', 'Angelhita Obello Laranang', 'John Merico Bon',
  'Nilo Macarayan Edulan', 'Pamfilo Martinez Casalme', 'Franklin Abecilla Varona',
  'Lionard Melgar Lamit', 'Kevin Reyes Francisco', 'Basty Bascones Costan',
  'Alliah Santos Tulabing', 'Jennifer Karen Crebillo Siguenza',
  'Chararose Merto Dorimon', 'Caila Manuel Ang', 'Adona Marie Leonador Belen',
  'Julia Allyson Celebre Alo', 'Alliyah Janela Garcia Estabaya',
  'Patrick Marientes Ibañez', 'Sara Mariano Barrinuevo',
  'Charmaine Longjas Lalaguna', 'Jasmine Soriano Aquino', 'Sonny Corsiga Lorica',
].map((name, i) => ({ id: i + 1, name }));

// The weighting the screen works out from the team it is looking at: a word
// only one person carries is worth more than one four people share.
setRare(rarityAcross(TEAM));

const matchFile = (filename) => bestMatch(filename, TEAM).who?.name ?? null;

test('a filename in any of the shapes people save them in finds its person', () => {
  const cases = {
    // "Surname, Given Middle" — how the printed list reads
    'Loberiano, Melmark Tiangco.jpg': 'Melmark Tiangco Loberiano',
    'Pardo, Ma. Beatriz Diane Gochuico.jpg': 'Ma. Beatriz Diane Gochuico Pardo',
    // Given-first, shortened, lower case, other separators, other extensions
    'melmark loberiano.webp': 'Melmark Tiangco Loberiano',
    'Siguenza_Jennifer_Karen.jpg': 'Jennifer Karen Crebillo Siguenza',
    'BON JOHN MERICO.jpg': 'John Merico Bon',
    // What a phone, a scanner and Windows add on the way through
    '03 Esplana Jennifer.png': 'Jennifer Gojo Esplana',
    'Alo, Julia Allyson Celebre (1).jpg': 'Julia Allyson Celebre Alo',
  };
  for (const [file, want] of Object.entries(cases)) {
    assert.equal(matchFile(file), want, file);
  }
});

test('an ñ that did not survive the journey still matches', () => {
  // Filenames go through Windows, Drive and a zip; the accent often does not.
  assert.equal(matchFile('Ibañez, Gina Abarracoso.png'), 'Gina Abarracoso Ibañez');
  assert.equal(matchFile('IBANEZ, GINA ABARRACOSO.JPG'), 'Gina Abarracoso Ibañez');
});

test('a surname three people share is told apart by the rest of the name', () => {
  assert.equal(matchFile('Ibañez, Gina Abarracoso.jpg'), 'Gina Abarracoso Ibañez');
  assert.equal(matchFile('Ibañez, John Renz Marientes.jpg'), 'John Renz Marientes Ibañez');
  assert.equal(matchFile('Ibañez, Patrick Marientes.jpg'), 'Patrick Marientes Ibañez');
});

test("one person's surname is another's middle name, and they do not cross", () => {
  // Bon is John Merico's surname and Jeffrey's middle name; Abagon is
  // Marygrace's surname and Mark Elvin's middle name.
  assert.equal(matchFile('Labios, Jeffrey Bon.jpg'), 'Jeffrey Bon Labios');
  assert.equal(matchFile('Bon, John Merico.jpg'), 'John Merico Bon');
  assert.equal(matchFile('Abagon, Marygrace Belarmino.jpg'), 'Marygrace Belarmino Abagon');
  assert.equal(matchFile('Malapajo, Mark Elvin Abagon.jpg'), 'Mark Elvin Abagon Malapajo');
});

test('a filename that could be two people is left for a person to decide', () => {
  // Each of these carries only a word more than one of the team owns. Picking
  // either would be a coin toss with somebody's face.
  for (const file of ['Jennifer.jpg', 'Ibañez.jpg', 'Ibanez.png', 'John.jpg',
                      'Marie.jpg', 'Jane.jpg']) {
    assert.equal(matchFile(file), null, `${file} should not have been guessed`);
  }
});

test('a filename with no name in it is left alone', () => {
  for (const file of ['IMG_20260818_0932.jpg', 'scan001.png', 'DSC_4471.JPG',
                      'WhatsApp Image 2026-08-18 at 09.32.11.jpeg']) {
    assert.equal(matchFile(file), null, `${file} should not have been guessed`);
  }
});

test('a single letter in a filename is not treated as a name', () => {
  // "Ibañez, G." must not become Gina on the strength of one letter.
  assert.deepEqual(nameWords('Ibañez, G.jpg'), ['ibanez']);
  assert.equal(matchFile('Ibañez, G.jpg'), null);
});

test('a name written as one word in one place and two in the other still matches', () => {
  // The roster says "Marygrace Abagon"; the photograph was filed as
  // "MARY GRACE ABAGON". On separate words alone the only thing left to go on
  // is "Mary", which belongs to Mary Germae Mangulabnan — a real wrong match,
  // caught in a dry run against the live folder before anything was written.
  assert.equal(matchFile('MARY GRACE ABAGON.png'), 'Marygrace Belarmino Abagon');
  assert.equal(matchFile('marygrace abagon.jpg'), 'Marygrace Belarmino Abagon');
  // And the person it was wrongly landing on still finds her own.
  assert.equal(matchFile('Mangulabnan, Mary Germae Tanwangco.jpg'),
    'Mary Germae Tanwangco Mangulabnan');
});

test('running words together does not invent a match that is not there', () => {
  // Two words belonging to two different people must not become a third person
  // when they land next to each other. "Cortez" is Carla Jane's and "Soriano"
  // is Jasmine's; "cortezsoriano" is nobody, so this ties on the real words
  // and is handed back rather than guessed.
  assert.equal(matchFile('Cortez Soriano.jpg'), null);

  // A surname only one person has is still enough on its own, joins or not.
  assert.equal(matchFile('Jane Aquino.jpg'), 'Jasmine Soriano Aquino');
});
