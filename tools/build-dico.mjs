// Compile le dictionnaire du jeu à partir du lexique Grammalecte (lot 0).
//
//     node tools/build-dico.mjs <lexique-grammalecte-fr-v7.7.txt>
//
// La source (55 Mo, https://grammalecte.net/dic/lexique-grammalecte-fr-v7.7.zip)
// n'est PAS versionnée : seuls les deux fichiers produits le sont.
//   dico/mots.txt     une clé par ligne, suivie de la forme affichée si elle
//                     diffère (« ete\tété ») ; c'est ce que le serveur charge ;
//   dico/prompts.txt  les prompts de 2 et 3 lettres retenus, avec leur nombre
//                     de lemmes courants.
// Les deux restent sous MPL 2.0, comme la source : la mention est en tête.
//
// Règles (validées au lot 0) :
//   - normalisation : E.cle() du moteur, la MÊME que pour la saisie ;
//   - une ligne est écartée si : nom propre (npr / prn / patr), hors mot
//     (signe, ponctuation, préfixe, suffixe, chiffre romain, élision), note
//     abréviation / symbole / sigle (abty / symb / sig), élision (forme qui
//     finit par une apostrophe : « jusqu’ », « lorsqu’ »), majuscule, autre chose
//     que des lettres, moins de 3 ou plus de 30 lettres ;
//   - une clé est gardée si AU MOINS UNE de ses lignes passe (« paris », pluriel
//     de « pari », reste ; « Paris » la ville ne change rien) ;
//   - un prompt est retenu s'il apparaît dans au moins 200 LEMMES distincts par
//     une forme d'indice de fréquence ≥ 3 (sans ce filtre, un prompt présent
//     dans 300 mots obscurs passerait pour facile).
// Le résultat est déterministe (tri par clé) : relancer le script sur la même
// source redonne les mêmes fichiers, à l'octet.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const E = require('../engine.js');

const SOURCE = process.argv[2];
if (!SOURCE) { console.error('usage : node tools/build-dico.mjs <lexique-grammalecte-fr-v7.7.txt>'); process.exit(2); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dico');

const SEUIL_LEMMES = 200;
const INDICE_COURANT = 3;
const HORS = new Set(['sign', 'ponc', 'div', 'pfx', 'sfx', 'nbro', 'err']);
const PROPRES = new Set(['npr', 'prn', 'patr']);
const NOTES_EXCLUES = new Set(['abty', 'symb', 'sig']);

const texte = fs.readFileSync(SOURCE, 'utf8');
const entete = texte.slice(0, 2000);
if (!/Mozilla Public\s+(#\s*)?License, v\. 2\.0/.test(entete) || !/Grammalecte v7\.7/.test(entete)) {
  console.error('source inattendue : pas l\'en-tête MPL 2.0 de Grammalecte v7.7');
  process.exit(1);
}

const forme = new Map();        // clé → [forme affichée, occurrences]
const lemmesCourants = new Map(); // clé de lemme → Set des clés de formes courantes
const raisons = {};
let lignes = 0;
for (const l of texte.split('\n')) {
  const f = l.replace(/\r$/, '').split('\t');
  if (f.length < 20 || !/^\d+$/.test(f[0])) continue;
  lignes++;
  const [flexion, lemme, etiquettes, notes, occ, indice] = [f[2], f[3], f[4], f[7], f[15], f[19]];
  if (!flexion) continue;
  const tags = etiquettes.split(' ');
  const nts = notes.split(' ');
  const k = E.cle(flexion);
  let why = null;
  if (tags.some((x) => PROPRES.has(x))) why = 'nom propre';
  else if (tags.some((x) => HORS.has(x))) why = 'hors mot';
  else if (nts.some((x) => NOTES_EXCLUES.has(x))) why = 'abréviation / symbole / sigle';
  else if (/['’]$/.test(flexion)) why = 'élision (jusqu’, lorsqu’…)';
  else if (/\p{Lu}/u.test(flexion)) why = 'majuscule';
  else if (!/^[a-z]+$/.test(k)) why = 'caractères';
  else if (k.length < E.MOT_MIN || k.length > E.MOT_MAX) why = 'longueur';
  if (why) { raisons[why] = (raisons[why] || 0) + 1; continue; }
  const n = Number(occ) || 0;
  const prev = forme.get(k);
  if (!prev || n > prev[1] || (n === prev[1] && flexion < prev[0])) forme.set(k, [flexion, n]);
  if (Number(indice) >= INDICE_COURANT) {
    const lk = E.cle(lemme);
    if (!lemmesCourants.has(lk)) lemmesCourants.set(lk, new Set());
    lemmesCourants.get(lk).add(k);
  }
}

// Prompts : pour chaque lemme courant, l'union des sous-chaînes de 2 et 3 lettres
// de ses formes courantes ; puis le nombre de lemmes par sous-chaîne.
const compte = new Map();
for (const formes of lemmesCourants.values()) {
  const subs = new Set();
  for (const k of formes) for (const n of [2, 3]) for (let i = 0; i + n <= k.length; i++) subs.add(k.slice(i, i + n));
  for (const s of subs) compte.set(s, (compte.get(s) || 0) + 1);
}
const prompts = [...compte].filter(([, c]) => c >= SEUIL_LEMMES).sort((a, b) => (a[0] < b[0] ? -1 : 1));

const MENTION = [
  '# Dérivé du « Lexique des formes fléchies du français — Grammalecte v7.7 »',
  '# (Dicollecte, https://grammalecte.net/), distribué sous Mozilla Public License 2.0.',
  '# This Source Code Form is subject to the terms of the Mozilla Public',
  '# License, v. 2.0. If a copy of the MPL was not distributed with this',
  '# file, You can obtain one at http://mozilla.org/MPL/2.0/.',
  '# Normalisé et filtré par tools/build-dico.mjs (voir README).',
];
const cles = [...forme.keys()].sort();
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'mots.txt'),
  MENTION.concat(['# clé[TAB forme affichée si elle diffère]'],
    cles.map((k) => (forme.get(k)[0] === k ? k : `${k}\t${forme.get(k)[0]}`))).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'prompts.txt'),
  MENTION.concat([`# prompt TAB lemmes courants (indice >= ${INDICE_COURANT}), seuil ${SEUIL_LEMMES}`],
    prompts.map(([p, c]) => `${p}\t${c}`)).join('\n') + '\n');

const p2 = prompts.filter(([p]) => p.length === 2).length;
console.log(`lignes de formes lues : ${lignes}`);
console.log('lignes écartées       :', JSON.stringify(raisons));
console.log(`clés gardées          : ${cles.length}`);
console.log(`lemmes courants       : ${lemmesCourants.size}`);
console.log(`prompts retenus       : ${prompts.length} (${p2} de 2 lettres, ${prompts.length - p2} de 3 lettres)`);
console.log(`écrit dans            : ${OUT}`);
