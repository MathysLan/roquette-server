// Le dictionnaire COMPILÉ, tel que le serveur le charge (dico/mots.txt,
// dico/prompts.txt, produits par tools/build-dico.mjs à partir de Grammalecte
// v7.7). Aucune dépendance, aucun réseau :
//     node test-dico.mjs
//
// Ce qui est vérifié : la mention MPL 2.0 en tête des deux fichiers, les
// volumes mesurés au lot 0, chaque forme affichée qui redonne bien sa clé
// (sinon un mot tapé ne retrouverait jamais sa forme), les cas de couverture
// du lot 0 (acceptés ET refusés) passés par la vraie normalisation, et les
// 987 prompts.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('./engine.js');
const { charger } = require('./dico.js');

let ok = 0, ko = 0;
const t = (name, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + name); }
  else { ko++; console.log('KO   ' + name + (detail ? ' — ' + detail : '')); }
};

const t0 = Date.now();
const { dico, prompts } = charger();
const dt = Date.now() - t0;
const tas = process.memoryUsage().heapUsed / 1048576;

for (const f of ['dico/mots.txt', 'dico/prompts.txt']) {
  const tete = fs.readFileSync(f, 'utf8').slice(0, 600);
  t(`${f} : mention MPL 2.0 et source Grammalecte v7.7 en tête`,
    /Mozilla Public\s*(#\s*)?License, v\. 2\.0/.test(tete) && /Grammalecte v7\.7/.test(tete) && /grammalecte\.net/.test(tete));
}
t(`chargement : ${dico.size} clés (lot 0 : 429 586, moins les abréviations)`, dico.size > 429000 && dico.size < 429600);
t(`chargement en ${dt} ms (< 3 s), tas ≈ ${tas.toFixed(0)} Mo (< 200 Mo)`, dt < 3000 && tas < 200);
t('toutes les clés : 3 à 30 lettres a–z', [...dico.keys()].every((k) => /^[a-z]{3,30}$/.test(k)));
t('chaque forme affichée redonne sa clé', [...dico].every(([k, f]) => !f || E.cle(f) === k));
t('fichier trié et sans doublon (build déterministe)', (() => {
  const l = fs.readFileSync('dico/mots.txt', 'utf8').split('\n').filter((x) => x && x[0] !== '#').map((x) => x.split('\t')[0]);
  return l.every((k, i) => i === 0 || l[i - 1] < k);
})());

const p2 = prompts.filter((p) => p.length === 2).length;
t(`prompts : 987 (258 de 2 lettres, 729 de 3) — trouvés ${prompts.length} (${p2} / ${prompts.length - p2})`,
  prompts.length === 987 && p2 === 258);
t('prompts : sans doublon, 2 ou 3 lettres', new Set(prompts).size === prompts.length && prompts.every((p) => /^[a-z]{2,3}$/.test(p)));
t('chaque prompt a au moins 200 mots dans le dictionnaire', (() => {
  const keys = [...dico.keys()];
  return prompts.every((p) => { let n = 0; for (const k of keys) if (k.includes(p) && ++n >= 200) return true; return false; });
})());

const OUI = ['mangeaient', 'vînmes', 'allassent', 'chevaux', 'autrice', 'chelou', 'boloss', 'selfie', 'hashtag', 'wokisme',
  'divulgâcher', 'putain', 'ognon', 'oignon', 'évènement', 'événement', 'cœur', 'oeuvre', 'ex-æquo', 'arc-en-ciel',
  "aujourd'hui", 'aujourd’hui', 'aujourdhui', 'porte-monnaie', 'portemonnaie', 'anticonstitutionnellement',
  'docteur', 'madame', 'monsieur', 'quant', 'paris', 'apéro', 'ado', 'appli', 'passion', 'camion', 'ionisation'];
const NON = ['etc', 'janv', 'km', 'kcal', 'arccos', 'Marseille', 'Nietzsche', 'Bretagne', 'Mathys', 'SNCF', 'ADN',
  'azertyuiop', 'blorpite', 'eu', 'va', 'jusqu'];
const absents = OUI.filter((m) => !dico.has(E.cle(m)));
const presents = NON.filter((m) => dico.has(E.cle(m)));
t(`couverture : ${OUI.length - absents.length}/${OUI.length} mots attendus acceptés`, !absents.length, absents.join(', '));
t(`couverture : ${NON.length - presents.length}/${NON.length} refusés (abréviations, noms propres, sigles…)`, !presents.length, presents.join(', '));
t('forme affichée rendue avec ses accents (ete → été, coeur → cœur)', dico.get('ete') === 'été' && dico.get('coeur') === 'cœur');

let leve = false;
try { charger('test-fixtures'); } catch (_) { leve = true; }
t('dossier sans dictionnaire : le chargement échoue franchement', leve);

console.log(`\n${ok} OK, ${ko} KO`);
process.exit(ko ? 1 : 0);
