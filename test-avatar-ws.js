// Test WebSocket RÉEL de la photo de profil (même rôle que test-avatar-ws.js
// des autres serveurs, adapté à ce protocole) : de vrais clients rejoignent une
// room, jouent une partie courte, et on lit ce qui passe VRAIMENT sur le fil.
//
//   node test-avatar-ws.js      (le serveur est démarré dans ce même processus)
//
// La data-URL envoyée par A ressort À L'OCTET PRÈS chez B (salon, countdown,
// tours, classement final), l'emoji de B ressort chez A, et chaque avatar
// refusé (SVG, > 12 Ko, mauvais type, structure) ressort en emoji sans `src`.
const fs = require('fs');
const path = require('path');
process.env.PORT = process.env.PORT || '8797';
process.env.TEST_PLANCHER_MS = '150';
process.env.TEST_COUNTDOWN_MS = '50';
process.env.TEST_BOOM_MS = '50';
const { rooms } = require('./server.js');
const O = require('./test-outils.js');

const URL = `ws://127.0.0.1:${process.env.PORT}`;
const DEFAUT = '🙂';                  // l'emoji par défaut de CE serveur
const t = O.compteur();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fx = (f) => fs.readFileSync(path.join(__dirname, 'test-fixtures', f));
const PP = 'data:image/webp;base64,' + fx('avatar-96.webp').toString('base64');
const IMG_A = { kind: 'image', emoji: '🦊', src: PP };
const EMO_B = { kind: 'emoji', emoji: '🐼' };
const find = (list, id) => (list || []).find((p) => p.id === id) || {};

async function joindre(avatar, code) {
  const c = O.client(URL, 'X');
  await c.open;
  const msg = { action: 'join', name: 'J' + Math.random().toString(36).slice(2, 5) };
  if (avatar !== undefined) msg.avatar = avatar;
  if (code) msg.code = code;
  c.send(msg);
  const you = await c.wait((m) => m.type === 'you');
  c.id = you.id; c.code = you.code;
  c.lobby = await c.wait((m) => m.type === 'lobby' && m.players.some((p) => p.id === you.id));
  return c;
}

(async () => {
  // ═══ 1. A (vraie PP) crée la room, B (emoji) la rejoint
  const a = await joindre(IMG_A);
  t('A se voit lui-même avec sa PP', same(find(a.lobby.players, a.id).avatar, IMG_A));
  const etat = rooms.get(a.code).players.find((p) => p.id === a.id);
  t('état joueur côté serveur : la PP est conservée telle quelle', same(etat.avatar, IMG_A) && etat.avatar.src === PP);
  const b = await joindre(EMO_B, a.code);
  t('B voit la PP de A, data-URL identique à l octet près', find(b.lobby.players, a.id).avatar.src === PP);
  t('B voit l avatar de A complet et rien d autre', same(find(b.lobby.players, a.id).avatar, IMG_A));
  const la = await a.wait((m) => m.type === 'lobby' && m.players.length === 2);
  t('A voit l emoji de B', same(find(la.players, b.id).avatar, EMO_B));
  t('au salon : uniquement les champs publics', la.players.every((p) => same(Object.keys(p).sort(), ['avatar', 'host', 'id', 'name', 'skin'])));

  // ═══ 2. une partie courte à deux : la PP suit partout
  a.send({ action: 'start', vies: 1 });
  const cd = await b.wait((m) => m.type === 'countdown');
  t('countdown : PP de A retransmise à l octet près', find(cd.players, a.id).avatar.src === PP);
  const tour = await b.wait((m) => m.type === 'turn');
  t('tour : l état seul (vies…), ni nom ni avatar renvoyés à chaque tour',
    tour.players.every((p) => !('avatar' in p) && !('name' in p)) && JSON.stringify(tour).length < 400);
  const end = await b.wait((m) => m.type === 'end', 5000);
  t('classement final : PP de A retransmise, emoji de B conservé',
    !!end && same(find(end.ranking, a.id).avatar, IMG_A) && same(find(end.ranking, b.id).avatar, EMO_B));
  t(`countdown avec une PP : ${JSON.stringify(cd).length} octets (la PP n y est qu une fois)`,
    JSON.stringify(cd).length < PP.length + 800);
  t('fin : l hôte est indiqué (qui peut lancer la revanche)', !!end && end.host === a.id);
  a.ws.close(); b.ws.close();

  // ═══ 3. ce que le serveur refuse : chaque cas crée sa propre room
  const LOURDE = 'data:image/webp;base64,' + fx('avatar-13k.webp').toString('base64');
  const CAS = [
    ['image > 12 Ko (vrai webp de 12,9 Ko) refusée → emoji', { kind: 'image', emoji: '🐸', src: LOURDE }, '🐸'],
    ['SVG refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64') }, '🐸'],
    ['type MIME inattendu (gif) refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, '🐸'],
    ['png déguisé en webp refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/webp;base64,' + fx('avatar-96.png').toString('base64') }, '🐸'],
    ['kind inconnu refusé → emoji', { kind: 'video', emoji: '🐸', src: PP }, '🐸'],
    ['avatar mal formé (tableau) → emoji par défaut', [PP], DEFAUT],
    ['avatar mal formé (nombre) → emoji par défaut', 42, DEFAUT],
    ['avatar absent → emoji par défaut', undefined, DEFAUT],
    ['ancien client (emoji en chaîne) → accepté', '🔥', '🔥'],
    ['ancien client (data-URL en chaîne) → pas tronquée, défaut', PP, DEFAUT],
  ];
  for (const [nom, avatar, attendu] of CAS) {
    const c = await joindre(avatar);
    const av = find(c.lobby.players, c.id).avatar;
    t(nom, same(av, { kind: 'emoji', emoji: attendu }), JSON.stringify(av).slice(0, 100));
    c.ws.close();
  }
  // Un message trop gros (au-delà de 64 Ko) ferme la connexion, sans planter le serveur.
  const g = O.client(URL, 'G');
  await g.open;
  g.send({ action: 'join', name: 'G', avatar: { kind: 'image', emoji: '🐸', src: 'data:image/webp;base64,' + 'A'.repeat(70000) } });
  await O.attendre(() => !!g.ferme, 2000);
  t('message de plus de 64 Ko : connexion fermée (1009)', !!g.ferme && g.ferme.code === 1009);
  const h = await joindre(EMO_B);
  t('… et le serveur répond toujours', !!h.id);
  h.ws.close();

  const { ok, ko } = t.bilan();
  console.log(`\n${ok} OK, ${ko} KO`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.log('KO   exception : ' + (e.stack || e.message)); process.exit(1); });
