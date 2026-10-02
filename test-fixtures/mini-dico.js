// Mini-dictionnaire de TEST du moteur. Le vrai (Grammalecte v7.7, MPL 2.0)
// arrive au lot 2 ; ici, juste assez de mots pour jouer des parties entières et
// couvrir les cas de normalisation mesurés au lot 0 (accents, œ, apostrophe
// typographique, trait d'union). Formes affichées telles que dans la source.
'use strict';

const MOTS = [
  // ION
  'passion', 'camion', 'ionisation', 'lion', 'avion', 'million', 'station', 'action',
  'nation', 'potion', 'région', 'émotion', 'pion', 'union', 'opinion', 'question',
  // ON
  'maison', 'bonbon', 'ballon', 'monde', 'oncle', 'ongle', 'montagne', 'pont',
  // AR
  'arbre', 'armoire', 'guitare', 'car', 'carte', 'phare', 'radar', 'parc',
  // ENT
  'vent', 'dent', 'lentement', 'parent', 'argent', 'serpent', 'ventre', 'centre',
  // EU
  'feu', 'jeu', 'bleu', 'heureux', 'cœur', 'peur', 'fleur', 'neveu',
  // OU
  "aujourd'hui", 'porte-monnaie', 'loup', 'roue', 'soupe', 'bouche', 'jour', 'route',
  // ETE
  'été', 'fête', 'tempête', 'bête', 'tête', 'arrête',
];

const PROMPTS = ['ion', 'on', 'ar', 'ent', 'eu', 'ou', 'ete'];

module.exports = { MOTS, PROMPTS };
