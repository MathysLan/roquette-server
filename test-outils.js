// Outils communs aux tests WebSocket de ce dépôt (test.js, test-16.js,
// test-depart.js). Pas un test : un client qui garde TOUT ce qu'il reçoit, des
// attentes sur condition (jamais de délai fixe), un trouveur de mots, et
// l'inspecteur de fil qui vérifie qu'aucun message ne trahit le temps.
'use strict';
const WebSocket = require('ws');
const { charger } = require('./dico.js');
const E = require('./engine.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compteur() {
  let ok = 0, ko = 0;
  const t = (nom, cond, detail) => {
    if (cond) { ok++; console.log('OK   ' + nom); }
    else { ko++; console.log('KO   ' + nom + (detail ? ' — ' + detail : '')); }
  };
  t.bilan = () => ({ ok, ko });
  return t;
}

// Un client : il répond à la présence (sauf si on le lui interdit), garde tous
// les messages, et sait attendre le prochain qui satisfait une condition.
function client(url, nom) {
  const ws = new WebSocket(url);
  const c = { ws, nom, msgs: [], repond: true, ferme: null, lu: 0 };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'presence' && m.remplace !== true && c.repond) ws.send(JSON.stringify({ action: 'presence', n: m.n }));
  });
  ws.on('close', (code, why) => { c.ferme = { code, raison: String(why) }; });
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  // Le premier message APRÈS l'index `depuis` (par défaut : le curseur `lu`).
  c.wait = async (pred, ms = 5000, depuis = c.lu) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      for (let i = depuis; i < c.msgs.length; i++) if (pred(c.msgs[i])) { c.lu = i + 1; return c.msgs[i]; }
      await sleep(3);
    }
    return null;
  };
  c.suite = (pred, ms) => c.wait(pred, ms, c.msgs.length);
  c.depuis = (i, pred) => c.msgs.slice(i).filter(pred);
  c.dernier = (type) => [...c.msgs].reverse().find((m) => m.type === type);
  return c;
}

async function joindre(c, nom, code, avatar) {
  await c.open;
  const msg = { action: 'join', name: nom, avatar: avatar || { kind: 'emoji', emoji: '🎯' } };
  if (code) msg.code = code;
  c.send(msg);
  const you = await c.wait((m) => m.type === 'you' || m.type === 'error');
  if (!you || you.type === 'error') throw new Error(`${nom} : join refusé (${you && you.message})`);
  c.id = you.id;
  return you;
}

async function attendre(cond, ms = 5000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (cond()) return true; await sleep(3); }
  return false;
}

// Le vrai dictionnaire du serveur, indexé UNE fois pour tous ses prompts : le
// chercher à chaque tour coûtait ~150 ms, assez pour que la menace (plancher de
// test à quelques centaines de ms) explose pendant que le « joueur » cherchait.
let DICO = null;
let parPrompt = null;
function indexer() {
  if (parPrompt) return;
  const d = charger();
  DICO = d.dico;
  parPrompt = new Map(d.prompts.map((p) => [p, []]));
  for (const [k, forme] of DICO) {
    const vus = new Set();
    for (const n of [2, 3]) for (let i = 0; i + n <= k.length; i++) {
      const s = k.slice(i, i + n);
      if (k.length > n && !vus.has(s) && parPrompt.has(s)) { vus.add(s); parPrompt.get(s).push({ k, forme: forme || k }); }
    }
  }
  for (const l of parPrompt.values()) l.sort((a, b) => a.k.length - b.k.length || (a.k < b.k ? -1 : 1));
}
function motsPour(prompt) { indexer(); return parPrompt.get(prompt) || []; }
// Un mot valide pour `prompt`, pas encore joué (Set de clés).
function motPour(prompt, joues) {
  const m = motsPour(prompt).find((x) => !joues.has(x.k));
  return m ? m.k : null;
}
// Un mot dont la forme affichée a des accents (pour vérifier la forme rendue).
function motAccentue(prompt, joues) {
  const m = motsPour(prompt).find((x) => !joues.has(x.k) && x.forme !== x.k && /[éèêàùç]/.test(x.forme) && !/[-' ]/.test(x.forme));
  return m || null;
}
const estUnMot = (txt) => { indexer(); return DICO.has(E.cle(txt)); };

// ---------------------------------------------------------------- le fil
// Chaque type de message a ses champs, et seulement eux. Un champ de plus —
// « juste pour l'affichage » — c'est typiquement là qu'une échéance finirait
// par fuiter : le test refuse tout champ inconnu.
const JOUEUR_SALON = ['id', 'name', 'avatar', 'host'];
const JOUEUR_PARTIE = ['id', 'lives', 'out', 'left', 'rank', 'words'];           // turn, boom, left : l'état seul
const JOUEUR_COMPLET = ['id', 'name', 'avatar', 'host', 'lives', 'out', 'left', 'rank', 'words']; // countdown : une fois
const CHAMPS = {
  presence: ['type', 'n', 'cle', 'remplace'],
  you: ['type', 'id', 'code', 'host'],
  lobby: ['type', 'code', 'phase', 'max', 'players'],
  countdown: ['type', 'order', 'rythme', 'vies', 'seconds', 'players'],
  turn: ['type', 'turnId', 'holder', 'prompt', 'players'],
  typing: ['type', 'id', 'turnId', 'text'],
  accepted: ['type', 'id', 'word', 'prompt'],
  rejected: ['type', 'id', 'turnId', 'reason', 'message', 'text'],
  boom: ['type', 'id', 'lives', 'out', 'rank', 'prompt', 'players'],
  left: ['type', 'id', 'rank', 'players'],
  end: ['type', 'host', 'ranking'],
  error: ['type', 'message'],
};
const CLASSEMENT = ['id', 'name', 'avatar', 'rank', 'lives', 'words', 'left'];
const AVATAR = ['kind', 'emoji', 'src'];
// Les seuls champs qui ont le droit d'être des nombres.
const NOMBRES = new Set(['n', 'turnId', 'lives', 'rank', 'words', 'vies', 'seconds', 'max']);
// Sur les NOMS de champs seulement : un mot joué peut très bien être « restant »
// ou « durée », et une photo en base64 contenir n'importe quelle suite de lettres.
const CLES_INTERDITES = /explod|deadline|remain|restant|phaseends|dur[eé]e|timestamp|^at$|endsat|^ms$|time|reste/i;
const toutesLesCles = (o, acc = []) => {
  if (Array.isArray(o)) o.forEach((x) => toutesLesCles(x, acc));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.push(k); toutesLesCles(v, acc); }
  return acc;
};

// Rend la liste des écarts (vide = fil propre). `secrets` : des nombres qui ne
// doivent apparaître nulle part (échéances, durées, restes relevés côté serveur).
function inspecterFil(msgs, secrets = []) {
  const ecarts = [];
  const verifierObjet = (o, champs, ou) => {
    for (const k of Object.keys(o)) if (!champs.includes(k)) ecarts.push(`${ou} : champ inattendu « ${k} »`);
  };
  const nombres = (o, cle, ou) => {
    if (typeof o === 'number') {
      if (!NOMBRES.has(cle)) ecarts.push(`${ou} : nombre dans « ${cle} »`);
      for (const s of secrets) if (Math.abs(o - s) <= 40 && o > 40) ecarts.push(`${ou} : ${cle}=${o} ressemble à un temps secret (${s})`);
    } else if (Array.isArray(o)) o.forEach((x) => nombres(x, cle, ou));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) nombres(v, k, ou);
  };
  msgs.forEach((m, i) => {
    const ou = `#${i} ${m.type}`;
    const champs = CHAMPS[m.type];
    if (!champs) { ecarts.push(`${ou} : type inconnu`); return; }
    verifierObjet(m, champs, ou);
    const joueurs = m.type === 'lobby' ? JOUEUR_SALON : m.type === 'countdown' ? JOUEUR_COMPLET : JOUEUR_PARTIE;
    (m.players || []).forEach((p) => { verifierObjet(p, joueurs, ou + ' joueur'); if (p.avatar) verifierObjet(p.avatar, AVATAR, ou + ' avatar'); });
    (m.ranking || []).forEach((p) => { verifierObjet(p, CLASSEMENT, ou + ' classement'); if (p.avatar) verifierObjet(p.avatar, AVATAR, ou + ' avatar'); });
    for (const k of toutesLesCles(m)) if (CLES_INTERDITES.test(k)) ecarts.push(`${ou} : champ interdit « ${k} »`);
    nombres(m, 'type', ou);
  });
  return ecarts;
}

module.exports = { sleep, compteur, client, joindre, attendre, motPour, motsPour, motAccentue, estUnMot, inspecterFil };
