// Chargement du dictionnaire compilé (dico/mots.txt, dico/prompts.txt —
// produits par tools/build-dico.mjs, sous MPL 2.0). Aucune règle de jeu ici :
// le moteur reçoit une Map « clé → forme affichée » et une liste de prompts.
//
// Le dictionnaire ne quitte JAMAIS le serveur : aucun message n'en contient
// plus que le mot qui vient d'être validé.
'use strict';
const fs = require('fs');
const path = require('path');
const { cle } = require('./engine.js');

const DOSSIER = process.env.DICO_DIR || path.join(__dirname, 'dico');

function lignes(fichier) {
  return fs.readFileSync(fichier, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l && l[0] !== '#');
}

// Rend { dico: Map(clé → forme | ''), prompts: [str…] }. Lève une erreur si un
// fichier est absent ou mal formé : un serveur sans dictionnaire ne démarre pas.
function charger(dossier = DOSSIER) {
  const dico = new Map();
  for (const l of lignes(path.join(dossier, 'mots.txt'))) {
    const i = l.indexOf('\t');
    const k = i < 0 ? l : l.slice(0, i);
    const forme = i < 0 ? '' : l.slice(i + 1);
    if (!/^[a-z]{3,30}$/.test(k)) throw new Error(`mots.txt : clé invalide « ${k} »`);
    if (forme && cle(forme) !== k) throw new Error(`mots.txt : « ${forme} » ne donne pas la clé « ${k} »`);
    dico.set(k, forme);
  }
  const prompts = lignes(path.join(dossier, 'prompts.txt')).map((l) => l.split('\t')[0]);
  if (!prompts.length || !prompts.every((p) => /^[a-z]{2,3}$/.test(p))) throw new Error('prompts.txt : prompt invalide');
  if (!dico.size) throw new Error('mots.txt : vide');
  return { dico, prompts };
}

module.exports = { charger, DOSSIER };
