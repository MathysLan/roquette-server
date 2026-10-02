// Les départs, en vraie partie, avec de vrais sockets qui se ferment :
//
//   node test-depart.js
//
// joueur inactif qui part ; joueur VISÉ qui part (le suivant est visé tout de
// suite, même prompt, au moins le plancher) ; départ pendant la pause d'une
// explosion ; éliminé qui part ; plusieurs départs d'un coup ; plus assez de
// joueurs (fin, le dernier est 1er) ; plus personne (room supprimée, minuterie
// coupée, aucun plantage) ; hôte qui part au salon ; onglet GELÉ en pleine
// partie (présence : fermé en 4000 « absent », traité comme un départ) et
// joueurs vivants jamais expulsés.
process.env.PORT = process.env.PORT || '8796';
process.env.TEST_PLANCHER_MS = '400';
process.env.TEST_COUNTDOWN_MS = '100';
process.env.TEST_BOOM_MS = '150';
Object.assign(process.env, { PRESENCE_MS: '300', ABSENCE_MS: '1500', NATIVE_PING_MS: '800', PRESENCE_KILL_MS: '300', PRESENCE_QUIET: '1' });
const { rooms } = require('./server.js');
const O = require('./test-outils.js');

const URL = `ws://127.0.0.1:${process.env.PORT}`;
const PLANCHER = 400;
const t = O.compteur();
const tous = [];

async function table(n, prefixe, vies = 3) {
  const cs = [];
  const h = O.client(URL, prefixe + '0'); tous.push(h);
  const you = await O.joindre(h, prefixe + '0');
  cs.push(h);
  for (let i = 1; i < n; i++) {
    const c = O.client(URL, prefixe + i); tous.push(c);
    await O.joindre(c, prefixe + i, you.code);
    cs.push(c);
  }
  await O.attendre(() => (h.dernier('lobby') || { players: [] }).players.length === n);
  const parId = Object.fromEntries(cs.map((c) => [c.id, c]));
  if (vies) h.send({ action: 'start', vies });
  const cd = vies ? await h.wait((m) => m.type === 'countdown') : null;
  return { cs, h, code: you.code, parId, order: cd && cd.order };
}
const suivant = (order, de, out) => {
  const i = order.indexOf(de);
  for (let k = 1; k <= order.length; k++) { const id = order[(i + k) % order.length]; if (!out.has(id)) return id; }
  return null;
};

(async () => {
  O.motsPour('on');
  // ===================================== inactif qui part, puis actif qui part
  {
    const { cs, h, code, parId, order } = await table(4, 'D');
    const joues = new Set();
    const tour = await h.wait((m) => m.type === 'turn');
    const L = cs.find((c) => c.id !== tour.holder && c !== h);
    const n = h.msgs.length;
    L.ws.close();
    const left = await h.wait((m) => m.type === 'left', 2000, n);
    t('inactif qui part : « left » diffusé, rang 4', !!left && left.id === L.id && left.rank === 4
      && left.players.find((p) => p.id === L.id).out === true && left.players.find((p) => p.id === L.id).left === true);
    t('inactif qui part : le joueur visé ne change pas', h.dernier('turn').turnId === tour.turnId);
    // On joue 8 tours : L n'est plus jamais visé.
    let tc = tour, jamais = true;
    for (let i = 0; i < 8; i++) {
      if (tc.holder === L.id) jamais = false;
      const w = O.motPour(tc.prompt, joues); joues.add(w);
      parId[tc.holder].send({ action: 'submit', turnId: tc.turnId, text: w });
      tc = await h.wait((m) => m.type === 'turn', 2000);
      if (!tc) break;
    }
    t('inactif parti : ignoré aux tours suivants (8 tours joués)', jamais && !!tc);

    // Le joueur VISÉ s'en va.
    const H = parId[tc.holder];
    if (H === h) {
      // l'hôte est visé : on fait d'abord passer la main pour garder l'hôte (il lit le fil)
      const w = O.motPour(tc.prompt, joues); joues.add(w);
      H.send({ action: 'submit', turnId: tc.turnId, text: w });
      tc = await h.wait((m) => m.type === 'turn', 2000);
    }
    const Hv = parId[tc.holder];
    const n2 = h.msgs.length;
    const room = rooms.get(code);
    const t0 = Date.now();
    Hv.ws.close();
    const l2 = await h.wait((m) => m.type === 'left', 2000, n2);
    const t2 = await h.wait((m) => m.type === 'turn', 2000, n2);
    const delai = Date.now() - t0;
    const reste = room.game.explodeAt - Date.now();
    t('actif qui part : éliminé avec son rang (3)', !!l2 && l2.id === Hv.id && l2.rank === 3);
    t(`actif qui part : le suivant est visé tout de suite (${delai} ms)`, !!t2 && delai < 300
      && t2.holder === suivant(order, Hv.id, new Set([L.id, Hv.id])));
    t('actif qui part : même prompt, nouveau turnId', !!t2 && t2.prompt === tc.prompt && t2.turnId === tc.turnId + 1);
    t(`actif qui part : le suivant a au moins le plancher (${reste} ms)`, reste >= PLANCHER - 60);
    t('actif qui part : aucune explosion, aucune vie perdue', !h.depuis(n2, (m) => m.type === 'boom').length
      && t2.players.filter((p) => !p.out).every((p) => p.lives === 3));
    // Il reste 2 joueurs : un départ de plus → fin, l'autre est 1er.
    const restant = cs.find((c) => c.ws.readyState === 1 && c.id !== h.id && c.id !== L.id && c.id !== Hv.id);
    const n3 = h.msgs.length;
    restant.ws.close();
    const end = await h.wait((m) => m.type === 'end', 2000, n3);
    t('plus assez de joueurs : la partie se termine, le dernier est 1er', !!end && end.ranking[0].id === h.id && end.ranking[0].rank === 1);
    t('plus assez de joueurs : les partis sont classés (2, 3, 4) et marqués « left »',
      !!end && end.ranking.slice(1).map((r) => r.rank).join() === '2,3,4' && end.ranking.slice(1).every((r) => r.left));
    t('après la fin : aucune minuterie en attente', room.timer === null);
    h.ws.close();
  }

  // ================================== départ pendant la pause d'une explosion
  {
    const { cs, h, parId, order } = await table(4, 'P');
    const tour = await h.wait((m) => m.type === 'turn');
    const b = await h.wait((m) => m.type === 'boom', 3000);
    const prochain = suivant(order, b.id, new Set());
    const victime = parId[prochain];
    const obs = cs.find((c) => c !== victime);      // un autre joueur lit le fil
    const n = obs.msgs.length;
    victime.ws.close();
    const t2 = await obs.wait((m) => m.type === 'turn', 2000, n);
    t('départ pendant la pause, de celui qui devait être visé : la menace vise le suivant',
        !!t2 && t2.holder === suivant(order, b.id, new Set([prochain])));
    void tour;
    cs.forEach((c) => c.ws.close());
  }

  // ============================================= éliminé qui part, puis gel
  {
    const { cs, h, parId } = await table(3, 'G', 1);
    const tour = await h.wait((m) => m.type === 'turn');
    const b = await h.wait((m) => m.type === 'boom', 3000);
    const E1 = parId[b.id];
    t('vies = 1 : éliminé au rang 3', b.out && b.rank === 3);
    const obs = cs.find((c) => c !== E1);
    const n = obs.msgs.length;
    E1.ws.close();
    const l = await obs.wait((m) => m.type === 'left', 2000, n);
    t('éliminé qui part : rang inchangé (3), la partie continue', !!l && l.rank === 3 && !!(await obs.wait((m) => m.type === 'turn', 2000, n)));
    void tour;
    cs.forEach((c) => c.ws.close());
  }
  {
    // Onglet GELÉ en pleine partie : il ne répond plus à la présence.
    const { cs, h } = await table(3, 'F', 5);
    await h.wait((m) => m.type === 'turn');
    const F = cs.find((c) => c !== h);
    const n = h.msgs.length;
    const t0 = Date.now();
    F.repond = false;
    const l = await h.wait((m) => m.type === 'left' && m.id === F.id, 6000, n);
    const d = Date.now() - t0;
    await O.sleep(100);
    t(`onglet gelé en partie : fermé en 4000 « absent » (${d} ms)`, !!F.ferme && F.ferme.code === 4000 && F.ferme.raison === 'absent');
    t('onglet gelé : traité comme un départ (« left », éliminé)', !!l && l.players.find((p) => p.id === F.id).left === true);
    await O.sleep(4700);                    // > 3 × ABSENCE_MS
    t('heartbeat : les joueurs qui répondent ne sont jamais expulsés', cs.filter((c) => c !== F).every((c) => !c.ferme && c.ws.readyState === 1));
    cs.forEach((c) => c.ws.close());
  }

  // =========================================== plusieurs départs d'un coup
  {
    const { cs, h, code } = await table(5, 'M');
    const tour = await h.wait((m) => m.type === 'turn');
    const partants = cs.filter((c) => c !== h).slice(0, 3);
    const n = h.msgs.length;
    partants.forEach((c) => c.ws.close());
    await O.attendre(() => h.depuis(n, (m) => m.type === 'left').length === 3, 3000);
    const lefts = h.depuis(n, (m) => m.type === 'left');
    t('trois départs simultanés : trois « left », rangs 5, 4, 3', lefts.map((m) => m.rank).sort().join() === '3,4,5');
    const reste = cs.filter((c) => !partants.includes(c));
    const r = rooms.get(code);
    t('trois départs simultanés : pas de blocage (un joueur restant est visé)', r.game.phase !== 'end' && reste.some((c) => c.id === r.game.holder || r.game.phase === 'boom'));
    const next = await h.wait((m) => m.type === 'turn' || m.type === 'boom', 3000, n);
    t('… et la partie avance encore', !!next,
      `reçu : ${h.depuis(n, () => true).map((m) => m.type).join(' ')} ; phase ${r.game.phase}, visé ${r.game.holder}, reste ${r.game.explodeAt - Date.now()} ms, minuterie ${r.timer ? 'posée' : 'absente'}, observateur ${h.ferme ? 'FERMÉ ' + JSON.stringify(h.ferme) : 'connecté'}`);
    void tour;
    // Plus personne.
    reste.forEach((c) => c.ws.close());
    await O.attendre(() => !rooms.has(code), 2000);
    t('plus personne : la room est supprimée', !rooms.has(code));
    t('plus personne : sa minuterie est coupée', r.timer === null);
    await O.sleep(1800);                    // plus longue qu'une menace : aucune échéance orpheline
    t('plus personne : aucune échéance orpheline ne plante le serveur', true);
  }

  // ================================================ hôte qui part en partie
  {
    const { cs, h } = await table(3, 'Q', 1);
    await h.wait((m) => m.type === 'turn');
    const obs = cs[1];
    const n = obs.msgs.length;
    h.ws.close();
    const l = await obs.wait((m) => m.type === 'left' && m.id === h.id, 2000, n);
    t('hôte qui part en pleine partie : éliminé comme les autres, la partie continue', !!l && !!(await obs.wait((m) => m.type === 'turn' || m.type === 'boom', 3000, n)));
    const end = await obs.wait((m) => m.type === 'end', 6000, n);
    t('… elle va jusqu au bout sans lui, et la fin désigne le nouvel hôte', !!end && end.host === cs[1].id);
    obs.send({ action: 'start', vies: 1 });
    t('… qui peut lancer la revanche', await O.attendre(() => cs[2].msgs.filter((m) => m.type === 'countdown').length === 2, 2000));
    cs.forEach((c) => c.ws.close());
  }

  // ======================================================= hôte au salon
  {
    const { cs, h, code } = await table(3, 'H', 0);
    const n = cs[1].msgs.length;
    h.ws.close();
    const l = await cs[1].wait((m) => m.type === 'lobby' && m.players.length === 2, 2000, n);
    const nouvelHote = l && l.players.find((p) => p.host);
    t('hôte qui part au salon : un nouvel hôte est désigné', !!nouvelHote && nouvelHote.id === cs[1].id);
    cs[1].send({ action: 'start', vies: 2 });
    t('le nouvel hôte peut lancer', !!(await cs[2].wait((m) => m.type === 'countdown', 2000)));
    cs.forEach((c) => c.ws.close());
    void code;
  }

  const ecarts = tous.flatMap((c) => O.inspecterFil(c.msgs).map((e) => `${c.nom} ${e}`));
  t(`le fil des départs : ${tous.reduce((s, c) => s + c.msgs.length, 0)} messages, aucun champ hors liste`, !ecarts.length, ecarts.slice(0, 3).join(' | '));
  const { ok, ko } = t.bilan();
  console.log(`\n${ok} OK, ${ko} KO`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.log('KO   exception : ' + (e.stack || e.message)); process.exit(1); });
