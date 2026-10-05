// roquette-server — serveur arbitre du jeu de mots à la roquette (nom provisoire).
//
// Même forme que les autres serveurs du portfolio (passeur, qui-ment…) : un
// seul WebSocket, du JSON, des rooms à code de 4 lettres, et une règle d'or —
// LE CLIENT N'A AUCUNE AUTORITÉ. Il envoie des intentions (« voici mon mot »,
// « voici ce que je tape ») ; engine.js décide de tout.
//
// Ce fichier ORCHESTRE le moteur, il ne recopie aucune de ses règles :
//   - une partie = E.createGame() ; chaque action passe par E.submit(),
//     E.saisie() ou E.leave() ;
//   - UNE minuterie par room, posée sur E.nextDeadline() ; à l'échéance,
//     E.tick(Date.now()) — puis on repose la minuterie ;
//   - les événements du moteur sont traduits en messages, et c'est tout.
//
// LE TEMPS EST LE SECRET DE CE JEU. Aucun message ne porte l'instant de
// l'explosion, le temps restant, la durée tirée de la menace, ni aucun
// horodatage : le client sait qui est visé, sur quel prompt, avec combien de
// vies, et voit passer les événements. C'est tout. test.js relit TOUT le fil
// de chaque client pour le vérifier.
//
// La progression est AUTOMATIQUE (le moteur et sa minuterie) : l'hôte ne sert
// qu'à lancer la partie et la revanche. Un hôte qui part ne bloque rien.
const http = require('node:http');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');
const { charger } = require('./dico.js');
const { cleanAvatar } = require('./avatar.js');
const presenceJoueurs = require('./presence.js');

const PORT = process.env.PORT || 8094;
const AVATAR_DEFAUT = '🙂';

// Le skin d'arme : purement cosmétique, un id FERMÉ par joueur. Le client
// dessine ; le serveur ne fait que filtrer et relayer l'id — jamais la valeur
// reçue. Absent, invalide ou mal formé : le défaut, sans jamais refuser un join.
// Un id s'ajoute ici AVANT que le front sache le dessiner (serveur d'abord).
const SKINS = new Set(['roquette', 'petoire']);
const SKIN_DEFAULT = 'roquette';
function cleanSkin(value) {
  return typeof value === 'string' && SKINS.has(value)
    ? value
    : SKIN_DEFAULT;
}

const { dico, prompts } = charger();

// Délais raccourcis : POUR LES TESTS SEULEMENT (personne ne pose ces variables
// en production ; sans elles, les valeurs du moteur s'appliquent).
const ms = (v) => (Number(v) > 0 ? Number(v) : undefined);
const REGLES = {
  countdownMs: ms(process.env.TEST_COUNTDOWN_MS),
  boomMs: ms(process.env.TEST_BOOM_MS),
  plancherMs: ms(process.env.TEST_PLANCHER_MS),
};

// Débit par connexion, sur une fenêtre d'une seconde. Au-delà : le mot est
// refusé (TOO_FAST), la saisie est ignorée, le reste aussi.
// `skin` : les changements EFFECTIFS seulement (chacun est diffusé à la room).
const DEBIT = { tout: 60, submit: 10, typing: 20, skin: 4 };

// Les refus qui concernent le MOT sont montrés à toute la table (« Bob :
// « zion » ✗ pas dans le dictionnaire ») ; les autres ne regardent que
// l'envoyeur (hors tour, tour passé, trop tard…).
const REFUS_PUBLICS = new Set(['BAD_CHARS', 'TOO_SHORT', 'TOO_LONG', 'NO_PROMPT', 'ALREADY_USED', 'NOT_A_WORD']);

const rooms = new Map();

const nouveauCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join(''); }
  while (rooms.has(c));
  return c;
};

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (room, obj, sauf) => room.players.forEach((p) => { if (p !== sauf) send(p.ws, obj); });

// ------------------------------------------------------------- ce qui se dit
// En partie : la vue du moteur (vies, éliminés, rangs, mots). Les noms et les
// avatars ne partent qu'au `countdown` (le client les garde) et dans le
// classement final : à 16 joueurs avec photo, les renvoyer à chaque tour ferait
// ~80 Ko par message, à chaque mot.
function etatJoueurs(room) {
  return E.view(room.game).players.map((v) => ({ id: v.id, lives: v.lives, out: v.out, left: v.left, rank: v.rank, words: v.words }));
}
// Au lancement : l'état ET l'identité (nom, avatar, skin, hôte), une fois.
function joueursComplets(room) {
  return etatJoueurs(room).map((p) => {
    const r = room.roster.get(p.id);
    return { ...p, name: r.name, avatar: r.avatar, skin: r.skin, host: p.id === room.hostId };
  });
}

function lobbyState(room) {
  return { type: 'lobby', code: room.code, phase: room.phase, max: E.MAX_PLAYERS, players: room.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, skin: p.skin, host: p.id === room.hostId })) };
}

// Les événements du moteur → les messages. Rien n'est inventé ici.
function diffuser(room, events) {
  for (const e of events) {
    if (e.type === 'turn') {
      broadcast(room, { type: 'turn', turnId: e.turnId, holder: e.holder, prompt: e.prompt, players: etatJoueurs(room) });
    } else if (e.type === 'accepted') {
      broadcast(room, { type: 'accepted', id: e.id, word: e.word, prompt: e.prompt });
    } else if (e.type === 'boom') {
      // L'élimination qui suit (s'il n'a plus de vie) est dans le même lot.
      const el = events.find((x) => x.type === 'eliminated' && x.id === e.id && !x.left);
      broadcast(room, { type: 'boom', id: e.id, lives: e.lives, out: !!el, rank: el ? el.rank : null, prompt: e.prompt, players: etatJoueurs(room) });
    } else if ((e.type === 'eliminated' && e.left) || e.type === 'left') {
      broadcast(room, { type: 'left', id: e.id, rank: e.rank, players: etatJoueurs(room) });
    } else if (e.type === 'end') {
      terminer(room, e.ranking);
    }
  }
}

function terminer(room, ranking) {
  clearTimeout(room.timer);
  room.timer = null;
  room.phase = 'end';
  broadcast(room, {
    type: 'end',
    host: room.hostId,                 // qui peut lancer la revanche (l'hôte a pu partir)
    ranking: ranking.map((r) => {
      const p = room.roster.get(r.id);
      return { id: r.id, name: p.name, avatar: p.avatar, rank: r.rank, lives: r.lives, words: r.words, left: r.left };
    }),
  });
}

// ------------------------------------------------------------- la minuterie
// Une seule par room, toujours posée sur l'échéance que donne le moteur.
function planifier(room) {
  clearTimeout(room.timer);
  room.timer = null;
  if (room.phase !== 'playing' || !room.game) return;
  const d = E.nextDeadline(room.game);
  if (d == null) return;
  room.timer = setTimeout(() => echeance(room), Math.max(0, d - Date.now()));
}

function echeance(room) {
  room.timer = null;
  if (rooms.get(room.code) !== room || room.phase !== 'playing') return;
  diffuser(room, E.tick(room.game, Date.now()));
  planifier(room);       // une minuterie un poil en avance ne fait rien : on repose
}

// ------------------------------------------------------------------ partie
function lancer(room, msg) {
  room.game = E.createGame({
    players: room.players.map((p) => p.id),
    now: Date.now(),
    random: Math.random,
    prompts,
    dico,
    rythme: msg.rythme,
    vies: msg.vies,
    regles: REGLES,
  });
  // Le roster fige l'identité de la partie, skin compris : il ne change plus
  // avant la fin (l'action `skin` n'est acceptée qu'au salon).
  room.roster = new Map(room.players.map((p) => [p.id, { name: p.name, avatar: p.avatar, skin: p.skin }]));
  room.phase = 'playing';
  const g = room.game;
  broadcast(room, {
    type: 'countdown',
    order: g.order.slice(),
    rythme: g.rythme,
    vies: g.vies,
    seconds: Math.ceil(g.countdownMs / 1000),    // le décompte d'avant-partie, pas la menace
    players: joueursComplets(room),
  });
  planifier(room);
}

// --------------------------------------------------------------------- débit
function debit(ws, quoi) {
  const now = Date.now();
  const b = ws.debit || (ws.debit = {});
  const x = b[quoi] || (b[quoi] = { depuis: now, n: 0 });
  if (now - x.depuis >= 1000) { x.depuis = now; x.n = 0; }
  x.n += 1;
  return x.n <= DEBIT[quoi];
}

// ---------------------------------------------------------------- transport
const server = http.createServer((req, res) => {
  // Render veut une réponse HTTP pour son health check.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('roquette-server ok\n');
});
// 64 Ko : un join avec une photo de profil (≤ 12 Ko décodés) tient largement.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
// Présence applicative : un onglet gelé ne reste pas compté dans sa room (voir
// presence.js). Le module ne fait que fermer le socket ; le départ habituel fait le reste.
const presence = presenceJoueurs.attach(wss);

wss.on('connection', (ws) => {
  let room = null, me = null;
  const fail = (message) => send(ws, { type: 'error', message });
  // Une trame illisible ou trop grosse (> maxPayload) fait émettre `error` au
  // socket, puis `ws` le ferme (1009) et `close` fait le départ habituel. Sans
  // cet écouteur, l'erreur non traitée faisait tomber TOUT le serveur
  // (vérifié par test-avatar-ws.js).
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return fail('message illisible'); }
    if (!msg || typeof msg !== 'object') return fail('message illisible');
    if (presence.consume(ws, msg)) return;   // { action: 'presence' } : jamais « pas encore dans une partie »
    if (!debit(ws, 'tout')) return;

    if (msg.action === 'join') {
      if (me) return fail('déjà dans une partie');
      const name = String(msg.name || '').trim().slice(0, 16) || 'Joueur';
      // Emoji, ou photo de profil revalidée : voir avatar.js.
      const avatar = cleanAvatar(msg.avatar, AVATAR_DEFAUT);
      const skin = cleanSkin(msg.skin);     // un ancien client n'en envoie pas : le défaut
      let r;
      if (msg.code) {
        r = rooms.get(String(msg.code).toUpperCase().trim());
        if (!r) return fail('aucune partie avec ce code');
        if (r.phase !== 'lobby') return fail('partie déjà commencée');
        if (r.players.length >= E.MAX_PLAYERS) return fail('partie complète');
      } else {
        const c = nouveauCode();
        r = { code: c, players: [], hostId: null, phase: 'lobby', game: null, roster: null, timer: null };
        rooms.set(c, r);
      }
      let id;
      do { id = Math.random().toString(36).slice(2, 9); } while (r.players.some((p) => p.id === id));
      room = r;
      me = { id, ws, name, avatar, skin };
      room.players.push(me);
      if (!room.hostId) room.hostId = me.id;
      send(ws, { type: 'you', id: me.id, code: room.code, host: room.hostId === me.id });
      broadcast(room, lobbyState(room));
      return;
    }

    // Changer de skin : au salon seulement, et toujours EN SILENCE — hors salon,
    // avant le join, id invalide, id identique ou débit dépassé, rien ne part
    // (ni erreur, ni diffusion). Seul l'id nettoyé est relayé.
    if (msg.action === 'skin') {
      if (!room || !me || room.phase !== 'lobby') return;
      if (typeof msg.skin !== 'string' || !SKINS.has(msg.skin) || msg.skin === me.skin) return;
      if (!debit(ws, 'skin')) return;
      me.skin = msg.skin;
      return broadcast(room, { type: 'skin', id: me.id, skin: me.skin });
    }

    if (!room || !me) return fail('pas encore dans une partie');

    if (msg.action === 'start') {
      if (me.id !== room.hostId) return fail("seul l'hôte lance la partie");
      if (room.phase === 'playing') return fail('partie déjà en cours');
      if (room.players.length < E.MIN_PLAYERS) return fail(`il faut au moins ${E.MIN_PLAYERS} joueurs`);
      return lancer(room, msg);             // depuis le salon, ou la fin (revanche)
    }

    if (msg.action === 'lobby') {
      if (me.id !== room.hostId) return fail("seul l'hôte ramène au salon");
      if (room.phase !== 'end') return;
      room.phase = 'lobby';
      room.game = null;
      room.roster = null;
      return broadcast(room, lobbyState(room));
    }

    if (msg.action === 'submit') {
      const turnId = msg.turnId;
      const refuser = (reason) => send(ws, { type: 'rejected', id: me.id, turnId: Number.isInteger(turnId) ? turnId : null, reason, message: E.REFUS[reason] || reason });
      if (!debit(ws, 'submit')) return send(ws, { type: 'rejected', id: me.id, turnId: null, reason: 'TOO_FAST', message: 'trop vite' });
      if (room.phase !== 'playing') return refuser('NOT_PLAYING');
      const g = room.game;
      const text = typeof msg.text === 'string' ? msg.text : '';
      const r = E.submit(g, me.id, turnId, text, Date.now());
      diffuser(room, r.events);             // dont une explosion survenue juste avant (TOO_LATE)
      if (!r.ok) {
        if (REFUS_PUBLICS.has(r.reason)) {
          broadcast(room, { type: 'rejected', id: me.id, turnId: g.turnId, reason: r.reason, message: r.message, text: E.saisie(g, me.id, g.turnId, text) });
        } else refuser(r.reason);
      }
      return planifier(room);
    }

    if (msg.action === 'typing') {
      if (room.phase !== 'playing' || !debit(ws, 'typing')) return;
      const text = E.saisie(room.game, me.id, msg.turnId, msg.text);
      if (text === null) return;             // pas lui, pas ce tour, ou trop long : ignoré
      return broadcast(room, { type: 'typing', id: me.id, turnId: room.game.turnId, text }, me);
    }

    fail('action inconnue');
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.players = room.players.filter((p) => p !== me);
    if (!room.players.length) {
      clearTimeout(room.timer);
      room.timer = null;
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === me.id) room.hostId = room.players[0].id;
    if (room.phase === 'playing') {
      // Partir = être éliminé, à l'instant (le moteur fixe le rang, et vise le
      // suivant tout de suite si c'était son tour).
      diffuser(room, E.leave(room.game, me.id, Date.now()));
      return planifier(room);
    }
    broadcast(room, lobbyState(room));     // salon, ou écran de fin (`phase: 'end'`)
  });
});

server.listen(PORT, () => console.log(`roquette-server à l'écoute sur :${PORT} — ${dico.size} mots, ${prompts.length} prompts`));

module.exports = { server, wss, rooms, SKINS, SKIN_DEFAULT, cleanSkin };
