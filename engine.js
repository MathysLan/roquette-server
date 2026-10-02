// Moteur PUR du jeu de mots à la roquette. Aucun réseau, aucun DOM, aucune
// minuterie : l'horloge (`now`, en ms) et le hasard (`random`) sont injectés à
// chaque appel. C'est la même forme que engine.js de passeur-server et de
// qui-ment-server : tout ce qui décide d'un tour, d'une vie ou d'un rang est
// ici, et rien d'autre. Le serveur (lot 2) ne fera que brancher ce moteur sur
// ses sockets et sur UNE minuterie, posée à `nextDeadline()`.
//
// La boucle, en une phrase : une menace centrale vise le joueur actif ; il
// valide un mot qui contient le prompt, elle vise le suivant ; si le temps
// expire avant, elle explose sur lui (−1 vie) ; à 0 vie il est éliminé ; le
// dernier vivant gagne.
//
// LE TEMPS EST LE SECRET DE CE JEU. `explodeAt` ne quitte jamais l'état
// interne : `view()` est la seule chose que le serveur a le droit d'envoyer, et
// elle ne contient ni l'instant de l'explosion, ni le temps restant, ni aucune
// échéance. Les tests le vérifient.
//
// Phases :  countdown → turn ⇄ boom → … → end
//   countdown  ordre révélé, rien n'est armé (COUNTDOWN_MS) ;
//   turn       la menace vise `holder` ; un mot valide la fait viser le suivant ;
//   boom       elle vient d'exploser (BOOM_MS) : aucun mot accepté ;
//   end        il reste au plus un vivant : classement final.
'use strict';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const VIES = { min: 1, max: 5, defaut: 3 };
// Le plancher : après un mot validé, le joueur suivant a AU MOINS ce temps.
const RYTHMES = {
  detendu: { plancherMs: 8000 },
  normal: { plancherMs: 6000 },
  nerveux: { plancherMs: 4000 },
};
const RYTHME_DEFAUT = 'normal';
// Une menace neuve dure entre 2× et 4× le plancher (tirage uniforme).
const INITIAL_MIN = 2;
const INITIAL_MAX = 4;
// Un prompt survit à une explosion ; il est remplacé après la deuxième.
const MAX_PROMPT_AGE = 2;
const COUNTDOWN_MS = 3000;
const BOOM_MS = 2200;
const RECENT_PROMPTS = 20;        // pas deux fois le même prompt parmi les 20 derniers
const MOT_MIN = 3;                // lettres, après normalisation
const MOT_MAX = 30;
const SAISIE_MAX = 60;            // caractères bruts acceptés avant normalisation

// Les refus, avec leur code (le serveur les relaie tels quels).
const REFUS = {
  NOT_IN_GAME: "tu n'es pas dans cette partie",
  NOT_PLAYING: "ce n'est pas le moment de jouer",
  NOT_YOUR_TURN: "ce n'est pas ton tour",
  STALE_TURN: 'ce tour est déjà passé',
  TOO_LATE: 'trop tard',
  BAD_CHARS: 'que des lettres',
  TOO_SHORT: 'trop court',
  TOO_LONG: 'trop long',
  NO_PROMPT: 'ne contient pas les lettres demandées',
  ALREADY_USED: 'déjà joué dans cette partie',
  NOT_A_WORD: "pas dans le dictionnaire",
};

// ------------------------------------------------------------ normalisation
// LA clé d'un mot, partagée par le dictionnaire et par la saisie : casse et
// accents ignorés, œ/æ dépliés, traits d'union, apostrophes et espaces retirés.
// « Aujourd’hui », « aujourd'hui » et « AUJOURDHUI » sont le même mot. C'est
// exactement la règle mesurée au lot 0 (mesure.pl), à l'octet près.
// (Les deux premières classes sont écrites en caractères littéraux : U+2019,
// U+2018, U+02BC → apostrophe ; U+2010, U+2011, U+2012, U+2013 → trait d'union.)
function cle(s) {
  return String(s == null ? '' : s)
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[‐‑‒–]/g, '-')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
    .toLowerCase()
    .replace(/[-' ]/g, '');
}

// ------------------------------------------------------------------ hasard
function shuffle(arr, random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initialMs(g, random) {
  const f = INITIAL_MIN + (INITIAL_MAX - INITIAL_MIN) * random();
  return Math.round(g.plancherMs * f);
}

// Un prompt parmi les éligibles, ni le prompt courant ni un des derniers tirés.
function drawPrompt(g, random) {
  // (slice(-0) rendrait TOUT l'historique : d'où le n > 0)
  const n = Math.min(RECENT_PROMPTS, g.prompts.length - 1);
  const evite = new Set(n > 0 ? g.recent.slice(-n) : []);
  if (g.prompt) evite.add(g.prompt);
  let pool = g.prompts.filter((p) => !evite.has(p));
  if (!pool.length) pool = g.prompts.filter((p) => p !== g.prompt);
  if (!pool.length) pool = g.prompts;
  const p = pool[Math.floor(random() * pool.length)];
  g.recent.push(p);
  if (g.recent.length > RECENT_PROMPTS) g.recent.shift();
  g.prompt = p;
  g.promptAge = 0;
  return p;
}

// --------------------------------------------------------------- création
// opts : { players: [id…], now, random, prompts: [str…], dico: Map(clé → forme),
//          rythme?, vies?, regles? }
// `regles` ({ countdownMs, boomMs, plancherMs }) n'existe que pour les tests
// du serveur, qui ne vont pas attendre 6 s par tour.
function createGame(opts) {
  const o = opts || {};
  const ids = Array.isArray(o.players) ? o.players.map(String) : [];
  if (new Set(ids).size !== ids.length) throw new Error('joueur en double');
  if (ids.length < MIN_PLAYERS) throw new Error(`il faut au moins ${MIN_PLAYERS} joueurs`);
  if (ids.length > MAX_PLAYERS) throw new Error(`${MAX_PLAYERS} joueurs maximum`);
  if (typeof o.random !== 'function') throw new Error('hasard non fourni');
  if (!Number.isFinite(o.now)) throw new Error('horloge non fournie');
  if (!o.dico || typeof o.dico.get !== 'function') throw new Error('dictionnaire non fourni');
  const prompts = Array.isArray(o.prompts) ? o.prompts.filter((p) => /^[a-z]{2,3}$/.test(p)) : [];
  if (!prompts.length) throw new Error('aucun prompt');

  const rythme = Object.prototype.hasOwnProperty.call(RYTHMES, o.rythme) ? o.rythme : RYTHME_DEFAUT;
  const vies = Number.isInteger(o.vies) && o.vies >= VIES.min && o.vies <= VIES.max ? o.vies : VIES.defaut;
  const r = o.regles || {};

  const order = shuffle(ids, o.random);       // tiré UNE fois, puis fixe et circulaire
  const players = new Map();
  for (const id of order) players.set(id, { id, lives: vies, out: false, left: false, rank: null, words: 0 });

  return {
    phase: 'countdown',
    rythme,
    vies,
    plancherMs: r.plancherMs || RYTHMES[rythme].plancherMs,
    countdownMs: r.countdownMs || COUNTDOWN_MS,
    boomMs: r.boomMs || BOOM_MS,
    order,
    players,
    holder: null,
    turnId: 0,
    prompt: null,
    promptAge: 0,
    recent: [],
    prompts,
    dico: o.dico,
    used: new Set(),
    explodeAt: null,      // SECRET : jamais dans view()
    phaseEndsAt: o.now + (r.countdownMs || COUNTDOWN_MS),
    lastTarget: null,     // celui sur qui la menace a explosé (le suivant reçoit la prochaine)
    random: o.random,
  };
}

// ---------------------------------------------------------------- outils
const vivants = (g) => g.order.filter((id) => !g.players.get(id).out);

// Le prochain vivant APRÈS `fromId` dans l'ordre fixe. `fromId` peut être
// éliminé ou parti : on part de sa place.
function nextAlive(g, fromId) {
  const n = g.order.length;
  const i = g.order.indexOf(fromId);
  for (let k = 1; k <= n; k++) {
    const id = g.order[(i + k) % n];
    if (!g.players.get(id).out) return id;
  }
  return null;
}

// Arme la menace sur `target` : nouvelle visée, nouveau turnId.
function viser(g, target, now, explodeAt, events) {
  g.phase = 'turn';
  g.holder = target;
  g.turnId += 1;
  g.explodeAt = explodeAt;
  g.phaseEndsAt = null;
  events.push({ type: 'turn', holder: target, turnId: g.turnId, prompt: g.prompt });
}

// Élimine un joueur : son rang = le nombre de vivants à cet instant (lui compris).
function eliminer(g, id, events, left) {
  const p = g.players.get(id);
  p.rank = vivants(g).length;
  p.out = true;
  p.lives = 0;
  if (left) p.left = true;
  events.push({ type: 'eliminated', id, rank: p.rank, left: !!left });
}

function finir(g, events) {
  if (g.phase === 'end') return;
  const restants = vivants(g);
  for (const id of restants) g.players.get(id).rank = 1;
  g.phase = 'end';
  g.holder = null;
  g.explodeAt = null;
  g.phaseEndsAt = null;
  events.push({ type: 'end', ranking: ranking(g) });
}

const fini = (g) => vivants(g).length <= 1;

// ----------------------------------------------------------------- horloge
// L'échéance que le serveur doit attendre (une seule minuterie). Jamais envoyée.
function nextDeadline(g) {
  if (g.phase === 'turn') return g.explodeAt;
  if (g.phase === 'countdown' || g.phase === 'boom') return g.phaseEndsAt;
  return null;
}

// Fait avancer le jeu jusqu'à `now`. Le serveur l'appelle à l'échéance (et
// `submit` / `leave` l'appellent d'abord : une minuterie en retard ne donne
// jamais de temps en plus). Rend la liste des événements.
function tick(g, now, events) {
  const ev = events || [];
  for (let garde = 0; garde < 1000; garde++) {
    if (g.phase === 'countdown' && now >= g.phaseEndsAt) {
      drawPrompt(g, g.random);
      // Le premier de l'ordre, sauf s'il est parti pendant le décompte.
      const premier = g.players.get(g.order[0]).out ? nextAlive(g, g.order[0]) : g.order[0];
      viser(g, premier, now, now + initialMs(g, g.random), ev);
    } else if (g.phase === 'turn' && now >= g.explodeAt) {
      exploser(g, now, ev);
    } else if (g.phase === 'boom' && now >= g.phaseEndsAt) {
      const cible = nextAlive(g, g.lastTarget);
      if (g.promptAge >= MAX_PROMPT_AGE) drawPrompt(g, g.random);
      viser(g, cible, now, now + initialMs(g, g.random), ev);
    } else break;
  }
  return ev;
}

function exploser(g, now, events) {
  const id = g.holder;
  const p = g.players.get(id);
  p.lives -= 1;
  g.promptAge += 1;                     // le prompt reste, il vieillit
  g.lastTarget = id;
  g.holder = null;
  g.explodeAt = null;
  events.push({ type: 'boom', id, lives: Math.max(0, p.lives), prompt: g.prompt });
  if (p.lives <= 0) eliminer(g, id, events, false);
  if (fini(g)) return finir(g, events);
  g.phase = 'boom';
  g.phaseEndsAt = now + g.boomMs;
}

// ------------------------------------------------------------------ actions
// Un mot proposé. Le serveur passe `turnId` tel que le client l'a reçu : un mot
// parti pour un tour déjà terminé (double envoi, message en retard) est refusé.
// Rend { ok, reason?, word?, events }.
function submit(g, playerId, turnId, text, now) {
  const events = tick(g, now);
  const refus = (reason) => ({ ok: false, reason, message: REFUS[reason], events });
  const p = g.players.get(String(playerId));
  if (!p) return refus('NOT_IN_GAME');
  // La menace a explosé entre-temps (tick vient de la faire sauter) : trop tard.
  if (events.some((e) => e.type === 'boom' && e.id === p.id)) return refus('TOO_LATE');
  if (g.phase !== 'turn') return refus('NOT_PLAYING');
  if (p.id !== g.holder) return refus('NOT_YOUR_TURN');
  if (turnId !== g.turnId) return refus('STALE_TURN');

  const brut = String(text == null ? '' : text);
  if (brut.length > SAISIE_MAX) return refus('TOO_LONG');
  const k = cle(brut);
  if (!/^[a-z]*$/.test(k)) return refus('BAD_CHARS');
  if (k.length < Math.max(MOT_MIN, g.prompt.length + 1)) return refus('TOO_SHORT');
  if (k.length > MOT_MAX) return refus('TOO_LONG');
  if (!k.includes(g.prompt)) return refus('NO_PROMPT');
  if (g.used.has(k)) return refus('ALREADY_USED');
  const forme = g.dico.get(k);
  if (forme === undefined) return refus('NOT_A_WORD');

  // Accepté.
  const word = forme || k;
  g.used.add(k);
  p.words += 1;
  events.push({ type: 'accepted', id: p.id, word, prompt: g.prompt });
  // Le plancher : le suivant a au moins `plancherMs`, sinon il hérite du reste.
  const explodeAt = Math.max(g.explodeAt, now + g.plancherMs);
  drawPrompt(g, g.random);              // nouveau prompt après chaque mot validé
  viser(g, nextAlive(g, p.id), now, explodeAt, events);
  return { ok: true, word, events };
}

// La saisie en cours du joueur actif, relayée aux autres. Ce n'est PAS un état :
// le moteur dit seulement si elle est recevable, et la nettoie. Au-delà de
// SAISIE_MAX caractères bruts, elle est ignorée ; sinon on ne garde que ce qui
// peut servir à écrire un mot (lettres, accents, espace, apostrophes, trait
// d'union) — ni chiffre, ni emoji, ni caractère de contrôle ou d'inversion du
// sens d'écriture, qui s'afficheraient tels quels chez les autres — puis on
// coupe à MOT_MAX.
function saisie(g, playerId, turnId, text) {
  if (g.phase !== 'turn' || String(playerId) !== g.holder || turnId !== g.turnId) return null;
  const brut = String(text == null ? '' : text);
  if (brut.length > SAISIE_MAX) return null;
  return brut.replace(/[^\p{L}\p{M} '’-]/gu, '').slice(0, MOT_MAX);
}

// Un joueur s'en va (onglet fermé, réseau coupé, présence expirée). Il est
// éliminé à l'instant, avec le rang du moment. S'il était visé, la menace vise
// le suivant tout de suite, avec au moins le plancher : on ne fait pas payer
// au suivant un départ qui n'est pas le sien. Le prompt ne change pas.
function leave(g, playerId, now) {
  const events = tick(g, now);
  const p = g.players.get(String(playerId));
  if (!p || p.left || g.phase === 'end') return events;
  if (p.out) { p.left = true; events.push({ type: 'left', id: p.id, rank: p.rank }); return events; }
  const etaitVise = g.phase === 'turn' && g.holder === p.id;
  eliminer(g, p.id, events, true);
  if (fini(g)) { finir(g, events); return events; }
  if (etaitVise) viser(g, nextAlive(g, p.id), now, Math.max(g.explodeAt, now + g.plancherMs), events);
  // Pendant une pause `boom`, rien à faire : à la fin de la pause, la menace
  // vise le suivant à partir de la place de `lastTarget`, parti ou non.
  return events;
}

// ------------------------------------------------------------------- lecture
function ranking(g) {
  return [...g.players.values()]
    .map((p) => ({ id: p.id, rank: p.rank, lives: p.lives, words: p.words, left: p.left }))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
}

// CE QUE TOUT LE MONDE A LE DROIT DE VOIR. Aucune échéance, aucun temps : ni
// `explodeAt`, ni le reste, ni la fin d'une pause. Le danger que montrera le
// client se calcule sur le temps ÉCOULÉ depuis le début du tour, qu'il mesure
// lui-même.
function view(g) {
  return {
    phase: g.phase,
    rythme: g.rythme,
    vies: g.vies,
    order: g.order.slice(),
    holder: g.holder,
    turnId: g.turnId,
    prompt: g.phase === 'countdown' ? null : g.prompt,
    players: g.order.map((id) => {
      const p = g.players.get(id);
      return { id, lives: p.lives, out: p.out, left: p.left, rank: p.rank, words: p.words };
    }),
  };
}

module.exports = {
  cle, shuffle, createGame, tick, nextDeadline, submit, saisie, leave, view, ranking, nextAlive,
  MIN_PLAYERS, MAX_PLAYERS, VIES, RYTHMES, RYTHME_DEFAUT, INITIAL_MIN, INITIAL_MAX,
  MAX_PROMPT_AGE, COUNTDOWN_MS, BOOM_MS, RECENT_PROMPTS, MOT_MIN, MOT_MAX, SAISIE_MAX, REFUS,
};
