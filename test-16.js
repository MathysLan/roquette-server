// Seize joueurs, une vraie room, de vrais clients WebSocket :
//
//   node test-16.js
//
// lancement ; ordre (une permutation des seize, la même chez tous) ; une
// rotation complète où chacun trouve un mot (la menace vise chacun à son tour,
// dans l'ordre) ; puis plus personne ne répond : les explosions éliminent un
// joueur à la fois, la menace saute toujours les éliminés, et la partie finit
// sur un classement de 1 à 16, sans trou ni doublon, dans l'ordre inverse des
// éliminations. Le dix-septième est refusé.
process.env.PORT = process.env.PORT || '8795';
process.env.TEST_PLANCHER_MS = '200';     // menace neuve : 400 à 800 ms
process.env.TEST_COUNTDOWN_MS = '100';
process.env.TEST_BOOM_MS = '80';
require('./server.js');
const O = require('./test-outils.js');

const URL = `ws://127.0.0.1:${process.env.PORT}`;
const N = 16;
const t = O.compteur();

(async () => {
  O.motsPour('on');                         // index du dictionnaire avant la partie
  const cs = [];
  const h = O.client(URL, 'J0');
  const you = await O.joindre(h, 'J0');
  cs.push(h);
  for (let i = 1; i < N; i++) {
    const c = O.client(URL, 'J' + i);
    await O.joindre(c, 'J' + i, you.code);
    cs.push(c);
  }
  await O.attendre(() => (h.dernier('lobby') || { players: [] }).players.length === N);
  t('16 joueurs dans la room', h.dernier('lobby').players.length === N);
  const de17 = O.client(URL, 'J16');
  await de17.open;
  de17.send({ action: 'join', name: 'J16', code: you.code });
  t('le 17e est refusé (partie complète)', /complète/.test(((await de17.wait((m) => m.type === 'error')) || {}).message));
  de17.ws.close();
  const parId = Object.fromEntries(cs.map((c) => [c.id, c]));

  h.send({ action: 'start', vies: 1, rythme: 'nerveux' });
  const cds = await Promise.all(cs.map((c) => c.wait((m) => m.type === 'countdown')));
  const order = cds[0].order;
  t('lancement : countdown chez les 16', cds.every((m) => m && m.order.join() === order.join()));
  t('ordre : une permutation des 16 joueurs', new Set(order).size === N && order.every((id) => parId[id]));
  t('ordre : tiré au hasard (pas l ordre d arrivée)', order.join() !== cs.map((c) => c.id).join());
  t('réglages de l hôte : 1 vie, rythme nerveux', cds[0].vies === 1 && cds[0].rythme === 'nerveux');

  // Une rotation complète : chacun trouve un mot.
  const joues = new Set();
  const vises = [];
  h.lu = h.msgs.indexOf(cds[0]) + 1;
  let tour = await h.wait((m) => m.type === 'turn');
  for (let i = 0; i < N; i++) {
    vises.push(tour.holder);
    const w = O.motPour(tour.prompt, joues);
    joues.add(w);
    parId[tour.holder].send({ action: 'submit', turnId: tour.turnId, text: w });
    const suite = await h.wait((m) => m.type === 'turn' || m.type === 'boom', 3000);
    if (!suite || suite.type !== 'turn') { t('rotation : chaque mot est accepté à temps', false); break; }
    tour = suite;
  }
  t('rotation : les 16 visés dans l ordre fixe', vises.join() === order.join());
  t('rotation : le 17e tour revient au premier', tour.holder === order[0]);
  const acc = cs[5].msgs.filter((m) => m.type === 'accepted').length;
  t(`rotation : 16 mots acceptés, vus par tous (${acc} chez J5)`, acc === N);

  // Plus personne ne répond : une élimination par explosion.
  const elimines = [];
  let end = null, sautOk = true, vise = tour.holder;
  for (let garde = 0; garde < 200 && !end; garde++) {
    const m = await h.wait((x) => x.type === 'boom' || x.type === 'turn' || x.type === 'end', 4000);
    if (!m) break;
    if (m.type === 'end') end = m;
    else if (m.type === 'boom') {
      if (m.id !== vise || !m.out) sautOk = false;
      elimines.push({ id: m.id, rank: m.rank });
    } else {
      vise = m.holder;
      if (elimines.some((e) => e.id === m.holder)) sautOk = false;
      // le suivant du dernier éliminé, en sautant tous les éliminés
      const out = new Set(elimines.map((e) => e.id));
      const i = order.indexOf(elimines[elimines.length - 1].id);
      let attendu = null;
      for (let k = 1; k <= N; k++) { const id = order[(i + k) % N]; if (!out.has(id)) { attendu = id; break; } }
      if (attendu !== m.holder) sautOk = false;
    }
  }
  t(`éliminations : ${elimines.length} explosions, chacune élimine le joueur visé`, elimines.length === N - 1 && sautOk);
  t('éliminations : rangs 16, 15, … 2, dans l ordre des explosions', elimines.map((e) => e.rank).join() === Array.from({ length: N - 1 }, (_, i) => N - i).join());
  t('fin de partie', !!end);
  if (end) {
    t('classement : 1 → 16, sans trou ni doublon', end.ranking.map((r) => r.rank).join() === Array.from({ length: N }, (_, i) => i + 1).join());
    const vainqueur = order.find((id) => !elimines.some((e) => e.id === id));
    t('classement : le seul survivant est 1er', end.ranking[0].id === vainqueur && end.ranking[0].lives === 1);
    t('classement : ordre inverse des éliminations', end.ranking.slice(1).map((r) => r.id).join() === elimines.map((e) => e.id).reverse().join());
    const ends = await Promise.all(cs.map((c) => c.wait((m) => m.type === 'end', 2000, 0)));
    t('les 16 reçoivent le même classement', ends.every((e) => e && JSON.stringify(e.ranking) === JSON.stringify(end.ranking)));
    t('les éliminés sont restés connectés jusqu à la fin', cs.every((c) => c.ws.readyState === 1));
  }
  const ecarts = cs.flatMap((c) => O.inspecterFil(c.msgs).map((e) => `${c.nom} ${e}`));
  const total = cs.reduce((n, c) => n + c.msgs.length, 0);
  t(`le fil : ${total} messages chez 16 clients, aucun champ hors liste`, !ecarts.length, ecarts.slice(0, 3).join(' | '));

  cs.forEach((c) => c.ws.terminate());
  const { ok, ko } = t.bilan();
  console.log(`\n${ok} OK, ${ko} KO`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.log('KO   exception : ' + (e.stack || e.message)); process.exit(1); });
