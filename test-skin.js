// Test WebSocket RÉEL du skin d'arme (contrat réseau, micro-lot 1) : de vrais
// clients entrent, changent de skin, jouent deux parties, et on lit ce qui
// passe VRAIMENT sur le fil.
//
//   node test-skin.js      (le serveur est démarré dans ce même processus)
//
// Le contrat : un id FERMÉ par joueur (`roquette` par défaut, `petoire`, `marmite`, `huntsman`), dans
// `join`, dans les joueurs de `lobby` et de `countdown`, et l'action `skin` au
// salon seulement, relayée en { type: 'skin', id, skin }. Tout le reste —
// absent, invalide, identique, hors salon, débit dépassé — ne produit RIEN :
// ni refus du join, ni erreur, ni diffusion. Aucun message de jeu ne change.
//
// « Rien n'a été diffusé » se prouve par un TÉMOIN : chaque client envoie une
// action inconnue, à laquelle le serveur ne répond qu'à lui. Une connexion est
// traitée dans l'ordre : quand chaque témoin est revenu, tout ce que l'action
// testée aurait diffusé est déjà arrivé.
'use strict';
process.env.PORT = process.env.PORT || '8798';
process.env.TEST_PLANCHER_MS = '150';
process.env.TEST_COUNTDOWN_MS = '50';
process.env.TEST_BOOM_MS = '50';
const { rooms, SKINS, SKIN_DEFAULT, cleanSkin } = require('./server.js');
const O = require('./test-outils.js');

const URL = `ws://127.0.0.1:${process.env.PORT}`;
const t = O.compteur();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tous = [];                       // tous les clients : le fil de chacun est inspecté à la fin

// Les valeurs forgées : aucune ne doit jamais ressortir, chez personne.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
const ARBITRAIRE = 'petoire"; drop table hub_plays; --';
const ENORME = 'p'.repeat(60000);      // sous les 64 Ko du serveur : le join arrive bien
const TRACES = ['<svg', 'onload', 'alert(', 'drop table', 'p'.repeat(32)];

async function entrer(champs, code) {
  const c = O.client(URL, 'X');
  tous.push(c);
  await c.open;
  const msg = { action: 'join', name: 'J' + Math.random().toString(36).slice(2, 5), avatar: { kind: 'emoji', emoji: '🐼' }, ...champs };
  if (code) msg.code = code;
  c.send(msg);
  const you = await c.wait((m) => m.type === 'you' || m.type === 'error');
  if (!you || you.type !== 'you') throw new Error('join refusé : ' + JSON.stringify(you));
  c.id = you.id; c.code = you.code;
  c.lobby = await c.wait((m) => m.type === 'lobby' && m.players.some((p) => p.id === you.id));
  return c;
}
const skinDe = (msg, c) => ((msg && msg.players || []).find((p) => p.id === c.id) || {}).skin;
const etat = (c) => rooms.get(c.code).players.find((p) => p.id === c.id);

async function temoin(x) {
  const i = x.msgs.length;
  x.send({ action: 'temoin' });
  return x.wait((m) => m.type === 'error' && m.message === 'action inconnue', 5000, i);
}
// Envoie `envois` depuis `acteur`, attend le témoin de chaque client de la
// table, et rend les messages `skin` reçus par chacun pendant ce temps.
async function apres(table, acteur, envois) {
  const avant = new Map(table.map((x) => [x, x.msgs.length]));
  for (const e of envois) acteur.send(e);
  for (const x of table) if (!(await temoin(x))) throw new Error('témoin perdu');
  return table.map((x) => x.depuis(avant.get(x), (m) => m.type === 'skin'));
}
const rien = (recus) => recus.every((l) => l.length === 0);

// B joue (mal puis bien) sur ses deux premiers tours de chaque partie : de quoi
// faire passer `rejected` et `accepted` sur le fil, en plus de turn / boom / end.
function bot(c) {
  const joues = new Set();
  let reponses = 0;
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'countdown') reponses = 0;
    if (m.type === 'accepted') joues.add(m.word);
    if (m.type !== 'turn' || m.holder !== c.id || reponses >= 2) return;
    reponses++;
    c.send({ action: 'submit', turnId: m.turnId, text: 'zzq' + m.prompt + 'xqz' });
    const w = O.motPour(m.prompt, joues);
    if (w) c.send({ action: 'submit', turnId: m.turnId, text: w });
  });
}

(async () => {
  O.motsPour('ion');                   // indexe le dictionnaire AVANT la partie (sinon le bot rate son tour)

  // ═══ 0. le contrat lui-même
  t('liste fermée : roquette, petoire, marmite et huntsman, rien d autre ; défaut roquette',
    same([...SKINS].sort(), ['huntsman', 'marmite', 'petoire', 'roquette']) && SKIN_DEFAULT === 'roquette');
  t('cleanSkin : petoire, marmite et huntsman passent, tout le reste devient roquette',
    cleanSkin('petoire') === 'petoire' && cleanSkin('marmite') === 'marmite' && cleanSkin('huntsman') === 'huntsman' && cleanSkin('roquette') === 'roquette'
    && [undefined, null, 42, {}, ['petoire'], 'disrupteur', 'Marmite', ' marmite', 'Huntsman', 'huntsman ', 'Petoire', ' petoire', SVG, ENORME].every((v) => cleanSkin(v) === 'roquette'));

  // ═══ 1. le join : chaque cas crée sa propre room
  const CAS = [
    ['join sans skin → roquette', {}, 'roquette'],
    ['join avec petoire → petoire', { skin: 'petoire' }, 'petoire'],
    ['join avec roquette → roquette', { skin: 'roquette' }, 'roquette'],
    ['join avec marmite → marmite', { skin: 'marmite' }, 'marmite'],
    ['join avec huntsman → huntsman', { skin: 'huntsman' }, 'huntsman'],
    ['join avec un id inconnu (disrupteur, pas encore ouvert) → roquette', { skin: 'disrupteur' }, 'roquette'],
    ['join avec une autre casse (Petoire) → roquette', { skin: 'Petoire' }, 'roquette'],
    ['join avec des espaces autour ( petoire ) → roquette', { skin: ' petoire ' }, 'roquette'],
    ['join avec un nombre → roquette', { skin: 42 }, 'roquette'],
    ['join avec un objet → roquette', { skin: { id: 'petoire' } }, 'roquette'],
    ['join avec un tableau → roquette', { skin: ['petoire'] }, 'roquette'],
    ['join avec null → roquette', { skin: null }, 'roquette'],
    ['join avec un booléen → roquette', { skin: true }, 'roquette'],
    ['join avec __proto__ → roquette', { skin: '__proto__' }, 'roquette'],
    ['join avec une chaîne énorme (60 000 caractères) → roquette', { skin: ENORME }, 'roquette'],
    ['sécurité : join avec un SVG forgé → roquette', { skin: SVG }, 'roquette'],
    ['sécurité : join avec une chaîne arbitraire → roquette', { skin: ARBITRAIRE }, 'roquette'],
  ];
  for (const [nom, champs, attendu] of CAS) {
    const c = await entrer(champs);
    const vu = skinDe(c.lobby, c), garde = etat(c).skin;
    t(nom, vu === attendu && garde === attendu, `salon ${String(vu).slice(0, 30)}, serveur ${String(garde).slice(0, 30)}`);
    c.ws.close();
  }
  t('aucun join refusé à cause du skin, aucune erreur', tous.every((c) => !c.msgs.some((m) => m.type === 'error')));

  // ═══ 2. une room : A (hôte, petoire), B (nouveau client), C (ANCIEN client)
  const a = await entrer({ skin: 'petoire' });
  const b = await entrer({ skin: 'roquette' }, a.code);
  // L'ancien client : exactement le join d'avant ce lot (pas de skin, avatar en chaîne).
  const c = await entrer({ avatar: '🦊' }, a.code);
  bot(b);
  let table = [a, b, c];
  const l3 = await a.wait((m) => m.type === 'lobby' && m.players.length === 3);
  t('lobby : chaque joueur porte son skin (A petoire, B roquette, C ancien client → roquette)',
    skinDe(l3, a) === 'petoire' && skinDe(l3, b) === 'roquette' && skinDe(l3, c) === 'roquette');
  t('lobby : les champs d un joueur sont id, name, avatar, skin, host — rien d autre',
    l3.players.every((p) => same(Object.keys(p).sort(), ['avatar', 'host', 'id', 'name', 'skin'])));

  // Avant le join : silence aussi (pas de « pas encore dans une partie » pour un skin).
  const z = O.client(URL, 'Z');
  tous.push(z);
  await z.open;
  z.send({ action: 'skin', skin: 'petoire' });
  z.send({ action: 'temoin' });
  await z.wait((m) => m.type === 'error');
  t('action skin avant le join : ignorée sans erreur (seul le témoin répond)', z.msgs.filter((m) => m.type === 'error').length === 1);
  z.ws.close();

  // Changement valide : diffusé à toute la room, sous la forme exacte du contrat.
  let recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('changement valide au salon : { type: skin, id, skin } chez les trois (B compris)',
    recus.every((l) => l.length === 1 && same(l[0], { type: 'skin', id: b.id, skin: 'petoire' })), JSON.stringify(recus));
  t('… et l état du serveur suit', etat(b).skin === 'petoire');
  t('… l ancien client le reçoit sans dommage (aucune erreur)', !c.msgs.some((m) => m.type === 'error' && m.message !== 'action inconnue'));
  recus = await apres(table, b, [{ action: 'skin', skin: 'marmite' }]);
  t('changement vers marmite : relayé chez les trois, état à marmite',
    recus.every((l) => l.length === 1 && same(l[0], { type: 'skin', id: b.id, skin: 'marmite' })) && etat(b).skin === 'marmite', JSON.stringify(recus));
  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('… et retour à petoire', recus.every((l) => l.length === 1 && l[0].skin === 'petoire') && etat(b).skin === 'petoire');
  await new Promise((r) => setTimeout(r, 1100));   // sort de la fenêtre de débit (4 par seconde) avant la suite
  recus = await apres(table, b, [{ action: 'skin', skin: 'huntsman' }]);
  t('changement vers huntsman : relayé chez les trois, état à huntsman',
    recus.every((l) => l.length === 1 && same(l[0], { type: 'skin', id: b.id, skin: 'huntsman' })) && etat(b).skin === 'huntsman', JSON.stringify(recus));
  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('… et retour à petoire (après huntsman)', recus.every((l) => l.length === 1 && l[0].skin === 'petoire') && etat(b).skin === 'petoire');
  await new Promise((r) => setTimeout(r, 1100));   // de nouveau hors de la fenêtre de débit

  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('changement identique : aucune diffusion', rien(recus), JSON.stringify(recus));

  recus = await apres(table, b, [
    { action: 'skin', skin: 'disrupteur' }, { action: 'skin', skin: SVG }, { action: 'skin', skin: ARBITRAIRE },
    { action: 'skin', skin: 42 }, { action: 'skin', skin: { id: 'roquette' } }, { action: 'skin' },
    { action: 'skin', skin: null }, { action: 'skin', skin: ' roquette' }, { action: 'skin', skin: ENORME },
  ]);
  t('changements invalides (inconnu, SVG, arbitraire, nombre, objet, absent, null, espaces, énorme) : aucune diffusion', rien(recus), JSON.stringify(recus).slice(0, 200));
  t('… et l état est inchangé (petoire)', etat(b).skin === 'petoire');

  // Le débit : 4 changements effectifs par seconde et par joueur.
  await O.sleep(1100);                 // une fenêtre neuve
  const rafale = ['roquette', 'petoire', 'roquette', 'petoire', 'roquette', 'petoire'];
  recus = await apres(table, b, rafale.map((s) => ({ action: 'skin', skin: s })));
  t('débit : 6 changements dans la même seconde → 4 diffusés, dans l ordre',
    recus.every((l) => same(l.map((m) => m.skin), ['roquette', 'petoire', 'roquette', 'petoire'])), JSON.stringify(recus.map((l) => l.map((m) => m.skin))));
  t('… l état est celui du 4e (petoire), les deux de trop sont ignorés', etat(b).skin === 'petoire');
  await O.sleep(1100);
  recus = await apres(table, b, [{ action: 'skin', skin: 'roquette' }]);
  t('… une seconde plus tard, un changement passe de nouveau', recus.every((l) => l.length === 1 && l[0].skin === 'roquette') && etat(b).skin === 'roquette');

  // Un joueur qui entre au salon APRÈS ces changements reçoit l'état du moment.
  const d = await entrer({ skin: 'petoire' }, a.code);
  table = [a, b, c, d];
  t('entrée tardive au salon : D voit les skins du moment (A petoire, B roquette, C roquette, D petoire)',
    skinDe(d.lobby, a) === 'petoire' && skinDe(d.lobby, b) === 'roquette' && skinDe(d.lobby, c) === 'roquette' && skinDe(d.lobby, d) === 'petoire');

  // ═══ 3. la partie
  const attendus = { [a.id]: 'petoire', [b.id]: 'roquette', [c.id]: 'roquette', [d.id]: 'petoire' };
  const debut = new Map(table.map((x) => [x, x.msgs.length]));
  a.send({ action: 'start', vies: 2, rythme: 'nerveux' });
  const cds = await Promise.all(table.map((x) => x.wait((m) => m.type === 'countdown', 5000, debut.get(x))));
  t('countdown : chaque joueur porte son skin, chez les quatre',
    cds.every((cd) => cd && cd.players.length === 4 && cd.players.every((p) => p.skin === attendus[p.id])));
  const roster = () => Object.fromEntries([...rooms.get(a.code).roster].map(([id, r]) => [id, r.skin]));
  t('roster de partie : skins figés au lancement', same(roster(), attendus));

  const tour = await b.wait((m) => m.type === 'turn', 5000, debut.get(b));
  t('turn : aucun skin (ni dans le message, ni dans ses joueurs)', !!tour && !JSON.stringify(tour).includes('skin'));

  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('en partie : changement ignoré, aucune diffusion', rien(recus));
  t('… ni l état du joueur ni le roster ne bougent', etat(b).skin === 'roquette' && same(roster(), attendus));

  d.ws.close();                        // un départ en pleine partie : un `left` passe sur le fil
  table = [a, b, c];
  const fin1 = await a.wait((m) => m.type === 'end', 30000, debut.get(a));
  t('la partie va au bout (end reçu)', !!fin1);
  t('roster : le skin est conservé jusqu à la fin, départ compris', same(roster(), attendus));
  t('end : aucun skin dans le classement', !!fin1 && !JSON.stringify(fin1).includes('skin'));

  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('écran de fin : changement ignoré, aucune diffusion', rien(recus) && etat(b).skin === 'roquette');

  // ═══ 4. la revanche (start depuis la fin) garde les skins ; le retour au salon les rouvre
  const avantRevanche = new Map(table.map((x) => [x, x.msgs.length]));
  a.send({ action: 'start', vies: 1, rythme: 'nerveux' });
  const cd2 = await c.wait((m) => m.type === 'countdown', 5000, avantRevanche.get(c));
  t('revanche : mêmes skins au countdown (A petoire, B roquette, C roquette)',
    !!cd2 && cd2.players.length === 3 && skinDe(cd2, a) === 'petoire' && skinDe(cd2, b) === 'roquette' && skinDe(cd2, c) === 'roquette');
  const fin2 = await a.wait((m) => m.type === 'end', 30000, avantRevanche.get(a));
  t('la revanche va au bout', !!fin2);
  const avantSalon = a.msgs.length;
  a.send({ action: 'lobby' });
  const retour = await a.wait((m) => m.type === 'lobby' && m.phase === 'lobby', 5000, avantSalon);
  t('retour au salon : les skins y sont', !!retour && skinDe(retour, a) === 'petoire' && skinDe(retour, b) === 'roquette' && skinDe(retour, c) === 'roquette');
  recus = await apres(table, b, [{ action: 'skin', skin: 'petoire' }]);
  t('… et un changement y est de nouveau accepté', recus.every((l) => l.length === 1 && l[0].skin === 'petoire') && etat(b).skin === 'petoire');

  // ═══ 5. le fil, chez tout le monde
  const types = new Set(tous.flatMap((x) => x.msgs.map((m) => m.type)));
  t('le fil a bien vu passer you, lobby, countdown, turn, rejected, accepted, boom, left, end, skin',
    ['you', 'lobby', 'countdown', 'turn', 'rejected', 'accepted', 'boom', 'left', 'end', 'skin'].every((k) => types.has(k)), [...types].join(' '));
  const JEU = new Set(['you', 'turn', 'typing', 'accepted', 'rejected', 'boom', 'left', 'end']);
  t('messages de jeu inchangés : aucun skin dans you, turn, accepted, rejected, boom, left, end',
    tous.every((x) => x.msgs.filter((m) => JEU.has(m.type)).every((m) => !JSON.stringify(m).includes('skin'))));
  const ecarts = tous.flatMap((x) => O.inspecterFil(x.msgs));
  t('fil inspecté (champs de chaque message, skins bien formés, aucun temps)', ecarts.length === 0, ecarts.slice(0, 5).join(' | '));
  t('seules erreurs reçues : les témoins (aucune pour un skin)',
    tous.every((x) => x.msgs.filter((m) => m.type === 'error').every((m) => m.message === 'action inconnue' || (x === z && m.message === 'pas encore dans une partie'))));
  const fil = JSON.stringify(tous.map((x) => x.msgs));
  t('sécurité : aucune valeur forgée (SVG, chaîne arbitraire, chaîne énorme) n a été diffusée', TRACES.every((s) => !fil.includes(s)),
    TRACES.filter((s) => fil.includes(s)).join(', '));
  t('sécurité : tout skin diffusé appartient à la liste fermée',
    tous.every((x) => x.msgs.every((m) => [m, ...(m.players || [])].every((p) => !('skin' in p) || SKINS.has(p.skin)))));
  t('ancien client (C) : partie complète jouée, aucune erreur hors témoins',
    c.msgs.some((m) => m.type === 'end') && c.msgs.filter((m) => m.type === 'error').every((m) => m.message === 'action inconnue'));

  table.forEach((x) => x.ws.close());
  const { ok, ko } = t.bilan();
  console.log(`\n${ok} OK, ${ko} KO`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.log('KO   exception : ' + (e.stack || e.message)); process.exit(1); });
