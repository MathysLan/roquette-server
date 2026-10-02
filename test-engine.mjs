// Tests du moteur pur. Aucune dépendance, aucun réseau, aucune minuterie :
//     node test-engine.mjs
//
// L'horloge est un simple nombre qu'on avance à la main, le hasard une suite
// déterminée : chaque test dit EXACTEMENT ce qui doit se passer, à la
// milliseconde près. Les tests en négatif comptent autant que les autres :
// un mot accepté hors tour, une échéance qui fuit dans view(), un rang en
// double — rien de tout ça ne se voit à l'écran.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('./engine.js');
const { MOTS, PROMPTS } = require('./test-fixtures/mini-dico.js');

let ok = 0, ko = 0;
const t = (name, cond) => {
  if (cond) { ok++; console.log('OK   ' + name); }
  else { ko++; console.log('KO   ' + name); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return !re || re.test(e.message); } };

// Le dictionnaire comme le chargera le serveur : clé → forme affichée (vide
// quand elle est identique à la clé, comme dans le fichier compact du lot 0).
const DICO = new Map(MOTS.map((m) => [E.cle(m), E.cle(m) === m ? '' : m]));

// Hasard : une suite fixe, ou un générateur à graine (mulberry32).
const seq = (values) => { let i = 0; return () => values[i++ % values.length]; };
const graine = (s) => () => {
  s |= 0; s = (s + 0x6D2B79F5) | 0;
  let x = Math.imul(s ^ (s >>> 15), 1 | s);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const T0 = 1_000_000;
const partie = (o = {}) => E.createGame({
  players: ['a', 'b', 'c'], now: T0, random: seq([0.5]), prompts: PROMPTS, dico: DICO, ...o,
});
// Démarre (fin du décompte) et rend l'instant du premier tour.
const demarrer = (g) => { const now = T0 + g.countdownMs; E.tick(g, now); return now; };
// Un mot valide pour le prompt courant, pas encore joué.
const motPour = (g) => MOTS.find((m) => { const k = E.cle(m); return k.includes(g.prompt) && k.length > g.prompt.length && !g.used.has(k); });
// Fait exploser la menace sur le joueur visé, puis termine la pause.
const exploserEtReprendre = (g) => {
  const at = E.nextDeadline(g);
  const ev = E.tick(g, at);
  if (g.phase === 'boom') E.tick(g, E.nextDeadline(g));
  return { at, ev };
};

// ===================================================== normalisation (lot 0)
t('casse ignorée', E.cle('PASSION') === 'passion');
t('accents normalisés', E.cle('Émotion') === 'emotion' && E.cle('été') === 'ete');
t('œ déplié en oe', E.cle('cœur') === 'coeur' && E.cle('Œuvre') === 'oeuvre');
t('æ déplié en ae', E.cle('ex-æquo') === 'exaequo');
t('apostrophe droite, typographique, ou aucune : même clé',
  E.cle("aujourd'hui") === 'aujourdhui' && E.cle('aujourd’hui') === 'aujourdhui' && E.cle('aujourdhui') === 'aujourdhui');
t('trait d union et espace retirés', E.cle('porte-monnaie') === 'portemonnaie' && E.cle('PORTE MONNAIE') === 'portemonnaie');
t('null / undefined donnent une clé vide', E.cle(null) === '' && E.cle(undefined) === '');

// ================================================================= création
{
  const g = partie();
  t('création : phase countdown', g.phase === 'countdown');
  t('création : vies par défaut = 3', g.vies === 3 && [...g.players.values()].every((p) => p.lives === 3));
  t('création : rythme par défaut = normal, plancher 6 s', g.rythme === 'normal' && g.plancherMs === 6000);
  t('création : personne n est visé, aucun prompt', g.holder === null && E.view(g).prompt === null);
  t('création : décompte de 3 s', E.nextDeadline(g) === T0 + 3000);
}
t('rythmes : Détendu 8 s / Normal 6 s / Nerveux 4 s',
  partie({ rythme: 'detendu' }).plancherMs === 8000 && partie({ rythme: 'normal' }).plancherMs === 6000
  && partie({ rythme: 'nerveux' }).plancherMs === 4000);
t('rythme inconnu → normal', partie({ rythme: 'turbo' }).rythme === 'normal');
t('vies réglables de 1 à 5', [1, 2, 3, 4, 5].every((v) => partie({ vies: v }).vies === v));
t('vies hors plage → 3', [0, 6, -1, 2.5, '4', null].every((v) => partie({ vies: v }).vies === 3));
t('moins de 2 joueurs refusé', throws(() => partie({ players: ['a'] }), /2 joueurs/));
t('16 joueurs acceptés', partie({ players: Array.from({ length: 16 }, (_, i) => 'p' + i) }).order.length === 16);
t('17 joueurs refusés', throws(() => partie({ players: Array.from({ length: 17 }, (_, i) => 'p' + i) }), /16/));
t('joueur en double refusé', throws(() => partie({ players: ['a', 'a', 'b'] }), /double/));
t('sans hasard injecté : refusé', throws(() => partie({ random: undefined }), /hasard/));
t('sans horloge injectée : refusé', throws(() => partie({ now: undefined }), /horloge/));
t('sans dictionnaire : refusé', throws(() => partie({ dico: undefined }), /dictionnaire/));
t('sans prompt valide : refusé', throws(() => partie({ prompts: ['X', 'abcd'] }), /prompt/));

// ============================================================ ordre de jeu
{
  const ids = Array.from({ length: 10 }, (_, i) => 'p' + i);
  const g1 = partie({ players: ids, random: graine(7) });
  const g2 = partie({ players: ids, random: graine(7) });
  const g3 = partie({ players: ids, random: graine(8) });
  t('ordre : une permutation des joueurs', g1.order.slice().sort().join() === ids.slice().sort().join());
  t('ordre : même graine → même ordre', g1.order.join() === g2.order.join());
  t('ordre : autre graine → autre ordre', g1.order.join() !== g3.order.join());
  t('ordre : tiré au hasard (pas l ordre d arrivée)', g1.order.join() !== ids.join());
  const avant = g1.order.join();
  const now = demarrer(g1);
  t('ordre : le premier visé est le premier de l ordre', g1.holder === g1.order[0]);
  let vu = [g1.holder], n = now;
  for (let i = 0; i < 12; i++) { n += 100; E.submit(g1, g1.holder, g1.turnId, motPour(g1), n); vu.push(g1.holder); }
  t('ordre : fixe pendant toute la partie', g1.order.join() === avant);
  t('ordre : circulaire (le 11e tour revient au premier)', vu[10] === vu[0] && vu.slice(0, 10).join() === g1.order.join());
}

// ================================================== décompte et premier tour
{
  const g = partie();
  t('décompte : un mot est refusé (NOT_PLAYING)', E.submit(g, g.order[0], 0, 'passion', T0 + 10).reason === 'NOT_PLAYING');
  t('décompte : rien ne se passe avant la fin', E.tick(g, T0 + 2999).length === 0 && g.phase === 'countdown');
  const ev = E.tick(g, T0 + 3000);
  t('décompte terminé : premier tour', g.phase === 'turn' && ev.length === 1 && ev[0].type === 'turn');
  t('premier tour : turnId 1, prompt tiré parmi les prompts', g.turnId === 1 && PROMPTS.includes(g.prompt));
}

// ============================================================ durée initiale
for (const [r, plancher] of [['detendu', 8000], ['normal', 6000], ['nerveux', 4000]]) {
  // Les tirages : 2 pour le mélange de 3 joueurs, 1 pour le prompt, 1 pour la durée.
  const g0 = E.createGame({ players: ['a', 'b', 'c'], now: T0, random: seq([0.5, 0.5, 0.5, 0]), prompts: PROMPTS, dico: DICO, rythme: r });
  const n0 = demarrer(g0);
  const g1 = E.createGame({ players: ['a', 'b', 'c'], now: T0, random: seq([0.5, 0.5, 0.5, 0.999999]), prompts: PROMPTS, dico: DICO, rythme: r });
  const n1 = demarrer(g1);
  t(`durée initiale ${r} : hasard 0 → 2× le plancher`, g0.explodeAt - n0 === 2 * plancher);
  t(`durée initiale ${r} : hasard ~1 → 4× le plancher`, g1.explodeAt - n1 === Math.round(plancher * (2 + 2 * 0.999999)));
}
{
  let dansLaPlage = true;
  const rnd = graine(42);
  for (let i = 0; i < 300; i++) {
    const g = partie({ random: rnd });
    const n = demarrer(g);
    const d = g.explodeAt - n;
    if (d < 12000 || d > 24000) dansLaPlage = false;
  }
  t('durée initiale : 300 tirages, tous entre 2× et 4× (12–24 s au Normal)', dansLaPlage);
}

// ================================================================ mot valide
{
  const g = partie();
  let now = demarrer(g);
  const a = g.holder, tour = g.turnId, prompt = g.prompt, fin = g.explodeAt;
  const mot = motPour(g);
  now += 1000;
  const r = E.submit(g, a, tour, mot.toUpperCase(), now);
  t('mot valide : accepté', r.ok === true);
  t('mot valide : la menace vise le suivant', g.holder === E.nextAlive(g, a) && g.holder !== a);
  t('mot valide : nouveau turnId', g.turnId === tour + 1);
  t('mot valide : nouveau prompt, différent du précédent', g.prompt !== prompt && PROMPTS.includes(g.prompt));
  t('mot valide : compté au joueur et noté comme joué', g.players.get(a).words === 1 && g.used.has(E.cle(mot)));
  t('mot valide : événements accepted puis turn', r.events.map((e) => e.type).join() === 'accepted,turn');
  t('mot valide : temps restant > plancher → hérité tel quel', g.explodeAt === fin);
  t('mot valide : la forme affichée est celle du dictionnaire', r.word === mot);
}
{
  const g = partie();
  let now = demarrer(g);
  g.prompt = 'ion';
  const r = E.submit(g, g.holder, g.turnId, 'EMOTION', now + 10);
  t('mot tapé sans accent : la forme accentuée revient', r.ok && r.word === 'émotion');
}

// ================================================================== plancher
{
  const g = partie();
  let now = demarrer(g);
  const fin = g.explodeAt;
  now = fin - 2000;                                  // il reste 2 s < 6 s
  const r = E.submit(g, g.holder, g.turnId, motPour(g), now);
  t('plancher : reste 2 s → le suivant a 6 s', r.ok && g.explodeAt === now + 6000);
  now += 5999;
  t('plancher : rien n explose 1 ms avant', E.tick(g, now).length === 0 && g.phase === 'turn');
  t('plancher : explosion pile au plancher', E.tick(g, now + 1).some((e) => e.type === 'boom'));
}
{
  const g = partie({ rythme: 'nerveux' });
  let now = demarrer(g);
  now = g.explodeAt - 1;
  E.submit(g, g.holder, g.turnId, motPour(g), now);
  t('plancher Nerveux : 4 s', g.explodeAt === now + 4000);
}

// =========================================================== mots refusés
{
  const g = partie();
  const now = demarrer(g) + 500;
  g.prompt = 'ion';
  const avant = { holder: g.holder, turnId: g.turnId, explodeAt: g.explodeAt, prompt: g.prompt };
  const inchangé = () => g.holder === avant.holder && g.turnId === avant.turnId && g.explodeAt === avant.explodeAt && g.prompt === avant.prompt;
  const r = (txt) => E.submit(g, g.holder, g.turnId, txt, now).reason;
  t('mot inconnu : NOT_A_WORD', r('ionique') === 'NOT_A_WORD' && inchangé());
  t('mauvais prompt : NO_PROMPT', r('maison') === 'NO_PROMPT' && inchangé());
  t('mot égal au prompt : TOO_SHORT', r('ion') === 'TOO_SHORT' && inchangé());
  t('chiffres / symboles : BAD_CHARS', r('pass1on') === 'BAD_CHARS' && r('lion!') === 'BAD_CHARS' && inchangé());
  t('vide : TOO_SHORT', r('') === 'TOO_SHORT' && r('   ') === 'TOO_SHORT');
  t('plus de 30 lettres : TOO_LONG', r('a'.repeat(28) + 'ion') === 'TOO_LONG');
  t('saisie brute de plus de 60 caractères : TOO_LONG', r('ion' + ' '.repeat(70)) === 'TOO_LONG');
  t('un refus ne change rien : même joueur, même turnId, même temps, même prompt', inchangé());
  t('après un refus, le joueur peut réessayer', E.submit(g, g.holder, g.turnId, 'lion', now).ok);
}
{
  const g = partie();
  let now = demarrer(g);
  g.prompt = 'on';
  t('2 lettres : un mot de 2 lettres est trop court', E.submit(g, g.holder, g.turnId, 'on', now).reason === 'TOO_SHORT');
  t('2 lettres : 3 lettres suffisent (« pont » ok)', E.submit(g, g.holder, g.turnId, 'pont', now).ok);
}

// ===================================================================== doublon
{
  const g = partie();
  let now = demarrer(g);
  g.prompt = 'ion';
  E.submit(g, g.holder, g.turnId, 'émotion', now += 100);
  g.prompt = 'ion';
  t('doublon : refusé', E.submit(g, g.holder, g.turnId, 'émotion', now += 100).reason === 'ALREADY_USED');
  t('doublon : même mot sans accent ni casse → refusé', E.submit(g, g.holder, g.turnId, 'EMOTION', now).reason === 'ALREADY_USED');
  g.prompt = 'ou';
  E.submit(g, g.holder, g.turnId, "aujourd'hui", now += 100);
  g.prompt = 'ou';
  t('doublon : apostrophe typographique = même mot', E.submit(g, g.holder, g.turnId, 'aujourd’hui', now).reason === 'ALREADY_USED');
  g.prompt = 'eu';
  E.submit(g, g.holder, g.turnId, 'cœur', now += 100);
  g.prompt = 'eu';
  t('doublon : coeur après cœur → refusé', E.submit(g, g.holder, g.turnId, 'coeur', now).reason === 'ALREADY_USED');
}

// ======================================================== mauvais joueur
{
  const g = partie();
  const now = demarrer(g) + 100;
  const autre = g.order.find((id) => id !== g.holder);
  const tour = g.turnId;
  t('mauvais joueur : NOT_YOUR_TURN', E.submit(g, autre, tour, motPour(g), now).reason === 'NOT_YOUR_TURN');
  t('mauvais joueur : rien ne bouge', g.turnId === tour && g.used.size === 0);
  t('joueur inconnu : NOT_IN_GAME', E.submit(g, 'zz', tour, motPour(g), now).reason === 'NOT_IN_GAME');
}

// ======================================================== ancien turnId
{
  const g = partie();
  let now = demarrer(g);
  const a = g.holder, tour = g.turnId;
  t('turnId faux : STALE_TURN', E.submit(g, a, tour + 5, motPour(g), now).reason === 'STALE_TURN');
  E.submit(g, a, tour, motPour(g), now += 100);
  const b = g.holder;
  t('double validation : le 2e envoi de l ancien joueur est refusé', E.submit(g, a, tour, motPour(g), now).ok === false);
  t('message en retard : le nouveau joueur avec l ancien turnId → STALE_TURN', E.submit(g, b, tour, motPour(g), now).reason === 'STALE_TURN');
  t('…et avec le bon turnId, il joue', E.submit(g, b, g.turnId, motPour(g), now).ok);
}

// ================================================================= expiration
{
  const g = partie();
  demarrer(g);
  const a = g.holder, fin = g.explodeAt, prompt = g.prompt;
  t('expiration : rien 1 ms avant', E.tick(g, fin - 1).length === 0 && g.holder === a);
  const ev = E.tick(g, fin);
  t('expiration : boom sur le joueur visé', ev[0].type === 'boom' && ev[0].id === a);
  t('perte de vie : 3 → 2', g.players.get(a).lives === 2 && ev[0].lives === 2);
  t('après l explosion : pause, personne n est visé', g.phase === 'boom' && g.holder === null);
  t('pendant la pause : un mot est refusé', E.submit(g, a, g.turnId, 'passion', fin + 100).reason === 'NOT_PLAYING');
  t('pause : 2,2 s', E.nextDeadline(g) === fin + 2200);
  const tourAvant = g.turnId;
  const ev2 = E.tick(g, fin + 2200);
  t('après la pause : le suivant est visé', g.phase === 'turn' && g.holder === E.nextAlive(g, a) && ev2[0].type === 'turn');
  t('après la pause : MÊME prompt', g.prompt === prompt && g.promptAge === 1);
  t('après la pause : nouveau turnId', g.turnId === tourAvant + 1);
  t('après la pause : menace neuve, 2× à 4× le plancher', g.explodeAt - (fin + 2200) >= 12000 && g.explodeAt - (fin + 2200) <= 24000);
}
{
  const g = partie();
  demarrer(g);
  const a = g.holder, fin = g.explodeAt;
  const r = E.submit(g, a, g.turnId, motPour(g), fin);
  t('mot reçu pile à l échéance : TOO_LATE, et la vie est perdue', r.reason === 'TOO_LATE' && g.players.get(a).lives === 2);
  const g2 = partie();
  demarrer(g2);
  const r2 = E.submit(g2, g2.holder, g2.turnId, motPour(g2), g2.explodeAt + 50000);
  t('minuterie en retard : aucun temps offert (TOO_LATE)', r2.reason === 'TOO_LATE');
  t('minuterie très en retard : une seule explosion par appel', r2.events.filter((e) => e.type === 'boom').length === 1);
}

// ============================================================= MaxPromptAge
{
  const g = partie({ players: ['a', 'b', 'c', 'd'], random: graine(3) });
  demarrer(g);
  const p = g.prompt;
  exploserEtReprendre(g);
  t('MaxPromptAge : après 1 explosion, le prompt reste', g.prompt === p && g.promptAge === 1);
  exploserEtReprendre(g);
  t('MaxPromptAge = 2 : après la 2e, nouveau prompt', g.prompt !== p && g.promptAge === 0);
  const q = g.prompt;
  exploserEtReprendre(g);
  t('MaxPromptAge : le compteur repart de zéro sur le nouveau prompt', g.prompt === q && g.promptAge === 1);
  const r = E.submit(g, g.holder, g.turnId, motPour(g), E.nextDeadline(g) - 1000);
  t('un mot valide remet l âge à zéro (nouveau prompt)', r.ok && g.prompt !== q && g.promptAge === 0);
}

// ======================================================= nouveaux prompts
{
  const beaucoup = 'ab ac ad ae af ag ah ai aj ak al am an ao ap aq ar as at au av aw ax ay az ba bc bd be bf'.split(' ');
  const dico = new Map(beaucoup.map((p) => ['x' + p + 'x', '']));
  const g = E.createGame({ players: ['a', 'b'], now: T0, random: graine(11), prompts: beaucoup, dico });
  let now = demarrer(g);
  const tires = [g.prompt];
  for (let i = 0; i < 60; i++) {
    E.submit(g, g.holder, g.turnId, 'x' + g.prompt + 'x', now += 50);
    g.used.clear();
    tires.push(g.prompt);
  }
  let ok20 = true;
  for (let i = 0; i < tires.length; i++) {
    if (tires.slice(Math.max(0, i - 20), i).includes(tires[i])) ok20 = false;
  }
  t('nouveaux prompts : jamais deux fois parmi les 20 derniers', ok20);
  const g1 = E.createGame({ players: ['a', 'b'], now: T0, random: graine(5), prompts: ['ion'], dico: DICO });
  let n1 = demarrer(g1);
  E.submit(g1, g1.holder, g1.turnId, 'lion', n1 += 10);
  t('un seul prompt disponible : on le reprend sans boucler', g1.prompt === 'ion');
}

// ====================================================== élimination et saut
{
  const g = partie({ players: ['a', 'b', 'c'], vies: 1, random: graine(9) });
  demarrer(g);
  const premier = g.holder;
  const { ev } = exploserEtReprendre(g);
  t('élimination : à 0 vie, le joueur est éliminé', g.players.get(premier).out === true
    && ev.some((e) => e.type === 'eliminated' && e.id === premier));
  t('élimination : rang 3 sur 3 (premier éliminé)', g.players.get(premier).rank === 3);
  t('saut des éliminés : il n est plus jamais visé', (() => {
    let n = E.nextDeadline(g) - 5000, jamais = true;
    for (let i = 0; i < 8; i++) { if (g.holder === premier) jamais = false; E.submit(g, g.holder, g.turnId, motPour(g), n += 100); }
    return jamais;
  })());
  t('saut des éliminés : un mot de l éliminé est refusé', E.submit(g, premier, g.turnId, 'lion', T0 + 1e9).ok === false);
}
{
  // a b c d : b explose deux fois (2 vies) et sort ; la menace saute b.
  const g = E.createGame({ players: ['a', 'b', 'c', 'd'], now: T0, random: seq([0.99, 0.99, 0.99, 0.5]), prompts: PROMPTS, dico: DICO, vies: 2 });
  t('ordre déterminé par le hasard injecté', g.order.join() === 'a,b,c,d');
  let now = demarrer(g);
  E.submit(g, 'a', g.turnId, motPour(g), now += 10);         // → b
  exploserEtReprendre(g);                                    // b : 1 vie, → c
  E.submit(g, 'c', g.turnId, motPour(g), now = E.nextDeadline(g) - 9000); // → d
  E.submit(g, 'd', g.turnId, motPour(g), now += 10);         // → a
  E.submit(g, 'a', g.turnId, motPour(g), now += 10);         // → b
  t('b est de nouveau visé', g.holder === 'b');
  exploserEtReprendre(g);                                    // b : 0 vie → éliminé, rang 4
  t('b éliminé au rang 4', g.players.get('b').out && g.players.get('b').rank === 4);
  t('après l élimination de b, c est visé', g.holder === 'c');
  E.submit(g, 'c', g.turnId, motPour(g), now = E.nextDeadline(g) - 9000);
  E.submit(g, 'd', g.turnId, motPour(g), now += 10);
  t('a → (b sauté) → c', E.submit(g, 'a', g.turnId, motPour(g), now += 10).ok && g.holder === 'c');
}

// ================================================================ départs
{
  // Le joueur visé s'en va.
  const g = partie({ players: ['a', 'b', 'c', 'd'], random: seq([0.99, 0.99, 0.99, 0.5]) });
  let now = demarrer(g);
  const prompt = g.prompt, tour = g.turnId, fin = g.explodeAt;
  now += 1000;
  const ev = E.leave(g, 'a', now);
  t('départ du joueur actif : éliminé, rang 4', g.players.get('a').out && g.players.get('a').left && g.players.get('a').rank === 4);
  t('départ du joueur actif : le suivant est visé tout de suite', g.holder === 'b' && g.phase === 'turn');
  t('départ du joueur actif : pas d explosion, pas de vie perdue ailleurs', !ev.some((e) => e.type === 'boom') && g.players.get('b').lives === 3);
  t('départ du joueur actif : même prompt, nouveau turnId', g.prompt === prompt && g.turnId === tour + 1);
  t('départ du joueur actif : le suivant garde le reste (> plancher)', g.explodeAt === fin);
  t('départ : un mot du parti est refusé', E.submit(g, 'a', g.turnId, 'lion', now).ok === false);
  // Départ avec moins que le plancher : le suivant a le plancher.
  now = g.explodeAt - 1000;
  E.leave(g, 'b', now);
  t('départ du joueur actif à 1 s de l explosion : le suivant a le plancher', g.holder === 'c' && g.explodeAt === now + 6000);
  t('rangs des partis : 4 puis 3', g.players.get('b').rank === 3);
}
{
  // Un joueur NON visé s'en va.
  const g = partie({ players: ['a', 'b', 'c', 'd'], random: seq([0.99, 0.99, 0.99, 0.5]) });
  let now = demarrer(g);
  const tour = g.turnId, fin = g.explodeAt;
  E.leave(g, 'c', now += 500);
  t('départ d un inactif : éliminé, rang 4', g.players.get('c').out && g.players.get('c').rank === 4);
  t('départ d un inactif : rien ne change pour le joueur visé', g.holder === 'a' && g.turnId === tour && g.explodeAt === fin);
  E.submit(g, 'a', g.turnId, motPour(g), now += 10);
  E.submit(g, 'b', g.turnId, motPour(g), now += 10);
  t('départ d un inactif : il est sauté (b → d)', g.holder === 'd');
}
{
  // Départ pendant le décompte : le premier visé est le premier VIVANT.
  const g = partie({ players: ['a', 'b', 'c'], random: seq([0.99, 0.99, 0.5]) });
  E.leave(g, 'a', T0 + 100);
  demarrer(g);
  t('départ pendant le décompte : le premier vivant est visé', g.holder === 'b' && g.players.get('a').rank === 3);
}
{
  // Départ pendant la pause d'explosion, du joueur qui devait être visé.
  const g = partie({ players: ['a', 'b', 'c'], random: seq([0.99, 0.99, 0.5]) });
  demarrer(g);
  const fin = g.explodeAt;
  E.tick(g, fin);                                // a explose
  E.leave(g, 'b', fin + 500);                    // b devait être le suivant
  E.tick(g, fin + 2200);
  t('départ pendant la pause : la menace vise le suivant vivant', g.holder === 'c');
}
{
  // Un éliminé qui part : son rang ne bouge pas.
  const g = partie({ players: ['a', 'b', 'c'], vies: 1, random: seq([0.99, 0.99, 0.5]) });
  demarrer(g);
  exploserEtReprendre(g);                        // a éliminé, rang 3
  const ev = E.leave(g, 'a', E.nextDeadline(g) - 1000);
  t('éliminé qui part : rang inchangé, marqué parti', g.players.get('a').rank === 3 && g.players.get('a').left && ev[0].type === 'left');
  t('éliminé qui part : la partie continue', g.phase === 'turn');
}
{
  // Plusieurs départs en même temps.
  const g = partie({ players: ['a', 'b', 'c', 'd', 'e'], random: seq([0.99, 0.99, 0.99, 0.99, 0.5]) });
  const now = demarrer(g) + 100;
  E.leave(g, 'b', now); E.leave(g, 'a', now); E.leave(g, 'd', now);
  t('départs simultanés : rangs 5, 4, 3 dans l ordre des départs',
    g.players.get('b').rank === 5 && g.players.get('a').rank === 4 && g.players.get('d').rank === 3);
  t('départs simultanés : la partie continue à deux, c visé', g.phase === 'turn' && g.holder === 'c');
  const ev = E.leave(g, 'e', now);
  t('dernier vivant par départs : fin, c 1er', g.phase === 'end' && g.players.get('c').rank === 1 && ev.some((e) => e.type === 'end'));
}
{
  const g = partie();
  demarrer(g);
  E.leave(g, g.holder, T0 + 5000);
  const avant = JSON.stringify(E.view(g));
  E.leave(g, 'zz', T0 + 5000);
  t('départ d un inconnu : sans effet', JSON.stringify(E.view(g)) === avant);
}

// ============================================== dernier vivant et classement
{
  const g = partie({ players: ['a', 'b', 'c'], vies: 1, random: seq([0.99, 0.99, 0.5]) });
  demarrer(g);
  exploserEtReprendre(g);                       // a sort (3e)
  const { ev } = exploserEtReprendre(g);        // b sort (2e) → c gagne
  const end = ev.find((e) => e.type === 'end');
  t('dernier vivant : fin de partie', g.phase === 'end' && !!end);
  t('classement : c 1er, b 2e, a 3e', end.ranking.map((r) => r.id + r.rank).join() === 'c1,b2,a3');
  t('classement : trié par rang, sans égalité', end.ranking.map((r) => r.rank).join() === '1,2,3');
  t('fin : plus rien n est visé ni armé', g.holder === null && E.nextDeadline(g) === null);
  t('fin : un mot est refusé', E.submit(g, 'c', g.turnId, 'lion', T0 + 1e9).reason === 'NOT_PLAYING');
  t('fin : tick ne fait plus rien', E.tick(g, T0 + 1e10).length === 0);
  t('fin : un départ ne change plus le classement', E.leave(g, 'c', T0 + 1e10).length === 0 && g.players.get('c').rank === 1);
}

// ======================================== partie complète à 16, puis déterminisme
function jouer(seed, n, vies) {
  const rnd = graine(seed);
  const ids = Array.from({ length: n }, (_, i) => 'j' + i);
  const g = E.createGame({ players: ids, now: T0, random: rnd, prompts: PROMPTS, dico: DICO, vies });
  const journal = [];
  let now = T0, booms = 0;
  E.tick(g, now += g.countdownMs).forEach((e) => journal.push(e));
  for (let pas = 0; pas < 100000 && g.phase !== 'end'; pas++) {
    if (g.phase === 'turn') {
      // Le joueur visé trouve un mot (si le dico le permet) avec 60 % de chances.
      const mot = motPour(g);
      if (mot && rnd() < 0.6) {
        now += 1 + Math.floor(rnd() * 3000);
        const r = E.submit(g, g.holder, g.turnId, mot, now);
        r.events.forEach((e) => journal.push(e));
        if (!r.ok) { /* trop tard : explosion déjà au journal */ }
        continue;
      }
    }
    now = E.nextDeadline(g);
    const ev = E.tick(g, now);
    booms += ev.filter((e) => e.type === 'boom').length;
    ev.forEach((e) => journal.push(e));
    // Le dico de test s'épuise vite : on le remet à zéro (le moteur ne s'en soucie pas).
    if (g.used.size > MOTS.length - 10) g.used.clear();
  }
  return { g, journal, booms: journal.filter((e) => e.type === 'boom').length };
}
{
  const { g, booms } = jouer(2026, 16, 3);
  const r = E.ranking(g);
  t('16 joueurs, 3 vies : la partie se termine', g.phase === 'end');
  t('16 joueurs : rangs 1 à 16, chacun une fois', r.map((x) => x.rank).join() === Array.from({ length: 16 }, (_, i) => i + 1).join());
  t('16 joueurs : un seul vainqueur, encore en vie', r.filter((x) => x.rank === 1).length === 1 && r[0].lives > 0);
  t('16 joueurs : entre (N−1)×vies et N×vies−1 explosions', booms >= 15 * 3 && booms <= 16 * 3 - 1);
}
{
  const a = jouer(77, 6, 2), b = jouer(77, 6, 2), c = jouer(78, 6, 2);
  t('déterminisme : même graine → même partie, événement par événement', JSON.stringify(a.journal) === JSON.stringify(b.journal));
  t('déterminisme : même graine → même classement', JSON.stringify(E.ranking(a.g)) === JSON.stringify(E.ranking(b.g)));
  t('déterminisme : autre graine → autre partie', JSON.stringify(a.journal) !== JSON.stringify(c.journal));
}

// =============================================== LE TEMPS NE SORT JAMAIS
{
  const { g, journal } = jouer(5, 5, 2);
  void g;
  const g2 = partie({ random: graine(5) });
  let now = demarrer(g2);
  const vues = [E.view(g2)];
  E.submit(g2, g2.holder, g2.turnId, motPour(g2), now += 700); vues.push(E.view(g2));
  E.tick(g2, E.nextDeadline(g2)); vues.push(E.view(g2));
  E.tick(g2, E.nextDeadline(g2)); vues.push(E.view(g2));
  const INTERDIT = /explode|deadline|ends|remain|rest|left[A-Z]|ms$|time|at$/i;
  const cles = (o, acc = []) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.push(k); cles(v, acc); } return acc; };
  t('view() : aucune clé de temps (explodeAt, échéance, reste…)', vues.every((v) => !cles(v).some((k) => INTERDIT.test(k))));
  const nombres = (o, acc = []) => { if (typeof o === 'number') acc.push(o); else if (o && typeof o === 'object') Object.values(o).forEach((v) => nombres(v, acc)); return acc; };
  t('view() : aucun nombre qui ressemble à une horloge', vues.every((v) => nombres(v).every((n) => n < 1000)));
  t('événements : aucune clé de temps', journal.every((e) => !cles(e).some((k) => INTERDIT.test(k))));
  t('événements : aucun nombre qui ressemble à une horloge', journal.every((e) => nombres(e).every((n) => n < 1000)));
  t('view() pendant un tour : ni explodeAt, ni phaseEndsAt, ni dictionnaire, ni hasard',
    !('explodeAt' in vues[1]) && !('phaseEndsAt' in vues[1]) && !('dico' in vues[1]) && !('random' in vues[1]) && !('used' in vues[1]));
}

// ===================================================== saisie relayée
{
  const g = partie();
  const now = demarrer(g);
  const autre = g.order.find((id) => id !== g.holder);
  t('saisie : celle du joueur visé est relayée', E.saisie(g, g.holder, g.turnId, 'pass') === 'pass');
  t('saisie : celle d un autre joueur est ignorée', E.saisie(g, autre, g.turnId, 'pass') === null);
  t('saisie : ancien turnId ignoré', E.saisie(g, g.holder, g.turnId - 1, 'pass') === null);
  t('saisie : tronquée à 30, caractères de contrôle retirés', E.saisie(g, g.holder, g.turnId, 'a\u0000b\n' + 'x'.repeat(50)).length === 30
    && !/[\u0000\n]/.test(E.saisie(g, g.holder, g.turnId, 'a\u0000b\n')));
  const ch = (c) => String.fromCodePoint(c);
  const sale = 'ab' + ch(0x2028) + 'cd' + ch(0x2029) + '2089' + ch(0x202E) + 'é' + ch(0x1F680) + "'" + ch(0x2019) + '- x';
  t('saisie : seuls lettres, accents, espace, apostrophes, trait d union passent', E.saisie(g, g.holder, g.turnId, sale) === "abcdé'" + ch(0x2019) + '- x');
  t('saisie : plus de 60 caractères bruts → ignorée', E.saisie(g, g.holder, g.turnId, 'a'.repeat(61)) === null
    && E.saisie(g, g.holder, g.turnId, 'a'.repeat(60)) === 'a'.repeat(30));
  E.tick(g, g.explodeAt);
  t('saisie : rien pendant la pause d explosion', E.saisie(g, g.order[0], g.turnId, 'x') === null);
  void now;
}

console.log(`\n${ok} OK, ${ko} KO`);
process.exit(ko ? 1 : 0);
