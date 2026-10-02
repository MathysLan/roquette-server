// Test bout en bout du serveur : de vrais clients WebSocket, un vrai serveur
// (dans ce processus), de vraies minuteries — raccourcies.
//
//   node test.js
//
// 1. salon et lancement ; 2. une partie complète à trois, jusqu'au classement ;
// 3. la validation (tous les refus, qui les voit) ; 4. la minuterie (explosion
// réelle, pause, reprise, plancher, mot arrivé trop tard) ; 5. la saisie
// relayée ; 6. LE FIL : tout ce que chaque client a reçu, relu champ par champ
// — aucun message ne doit trahir le temps de la menace.
process.env.PORT = process.env.PORT || '8794';
process.env.TEST_PLANCHER_MS = '400';     // menace neuve : 800 à 1 600 ms
process.env.TEST_COUNTDOWN_MS = '150';
process.env.TEST_BOOM_MS = '200';
const { rooms } = require('./server.js');
const O = require('./test-outils.js');

const URL = `ws://127.0.0.1:${process.env.PORT}`;
const PLANCHER = 400, BOOM = 200;
const t = O.compteur();
const tous = [];
// Les temps secrets relevés CÔTÉ SERVEUR à chaque tour : aucun ne doit
// apparaître dans un message, à 40 ms près.
const secrets = [];

function nouveau(nom) {
  const c = O.client(URL, nom);
  tous.push(c);
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'turn' && c.code) {
      const r = rooms.get(c.code);
      if (r && r.game && r.game.explodeAt) secrets.push(r.game.explodeAt, r.game.explodeAt - Date.now());
    }
  });
  return c;
}

// Une table de n joueurs dans une nouvelle room, l'hôte en premier.
async function table(n, prefixe) {
  const cs = [];
  const h = nouveau(prefixe + '0');
  const you = await O.joindre(h, prefixe + '0');
  h.code = you.code; cs.push(h);
  for (let i = 1; i < n; i++) {
    const c = nouveau(prefixe + i);
    await O.joindre(c, prefixe + i, you.code);
    c.code = you.code; cs.push(c);
  }
  await O.attendre(() => h.dernier('lobby') && h.dernier('lobby').players.length === n);
  const parId = Object.fromEntries(cs.map((c) => [c.id, c]));
  return { cs, h, code: you.code, parId };
}
const suivant = (order, de, out) => {
  const i = order.indexOf(de);
  for (let k = 1; k <= order.length; k++) { const id = order[(i + k) % order.length]; if (!out.has(id)) return id; }
  return null;
};
const fermer = (cs) => cs.forEach((c) => { try { c.ws.terminate(); } catch (_) {} });

(async () => {
  O.motsPour('on');            // index du dictionnaire construit AVANT toute partie
  // ================================================================ 1. salon
  const A = nouveau('A');
  const you = await O.joindre(A, 'Alice');
  A.code = you.code;
  t('créer une room : code à 4 lettres, le créateur est l hôte', /^[A-Z]{4}$/.test(you.code) && you.host === true);
  const B = nouveau('B'), C = nouveau('C');
  await O.joindre(B, 'Bruno', you.code); B.code = you.code;
  await O.joindre(C, 'Chloé', you.code); C.code = you.code;
  const lobby = await A.wait((m) => m.type === 'lobby' && m.players.length === 3);
  t('salon : 3 joueurs, un seul hôte', !!lobby && lobby.players.filter((p) => p.host).length === 1 && lobby.max === 16);
  const parId = { [A.id]: A, [B.id]: B, [C.id]: C };

  const X = nouveau('X');
  await X.open;
  X.send({ action: 'join', name: 'X', code: 'ZZZZ' });
  t('code inconnu : refusé', /aucune partie/.test((await X.wait((m) => m.type === 'error')).message));
  X.send({ action: 'submit', turnId: 1, text: 'passion' });
  t('joueur absent (pas dans une room) : refusé', /pas encore dans une partie/.test((await X.wait((m) => m.type === 'error')).message));

  B.send({ action: 'start', vies: 2 });
  t('seul l hôte lance', /seul l'hôte/.test((await B.suite((m) => m.type === 'error')).message));
  A.send({ action: 'submit', turnId: 0, text: 'passion' });
  t('au salon, un mot est refusé (NOT_PLAYING)', (await A.suite((m) => m.type === 'rejected')).reason === 'NOT_PLAYING');

  A.send({ action: 'start', rythme: 'normal', vies: 2 });
  const cds = await Promise.all([A, B, C].map((c) => c.wait((m) => m.type === 'countdown')));
  const cd = cds[0];
  t('lancement : countdown chez les trois', cds.every((m) => m && m.order.join() === cd.order.join()));
  t('countdown : ordre = les 3 joueurs, rythme et vies choisis par l hôte',
    new Set(cd.order).size === 3 && cd.order.every((id) => parId[id]) && cd.rythme === 'normal' && cd.vies === 2
    && cd.players.every((p) => p.lives === 2));
  A.send({ action: 'submit', turnId: 0, text: 'passion' });
  t('pendant le décompte : un mot est refusé (NOT_PLAYING)', (await A.suite((m) => m.type === 'rejected')).reason === 'NOT_PLAYING');
  const Y = nouveau('Y');
  await Y.open;
  Y.send({ action: 'join', name: 'Y', code: you.code });
  t('partie lancée : un nouveau venu est refusé', /déjà commencée/.test((await Y.wait((m) => m.type === 'error')).message));

  // ===================================================== 2. partie complète
  const used = new Set();
  let tours = 0, ordreOk = true, prev = null, end = null, booms = 0, accepted = 0, boomsOk = true;
  const vies = {};
  cd.order.forEach((id) => { vies[id] = 2; });
  A.lu = A.msgs.indexOf(cd) + 1;
  for (let garde = 0; garde < 200; garde++) {
    const m = await A.wait((x) => x.type === 'turn' || x.type === 'end' || x.type === 'boom' || x.type === 'accepted', 6000);
    if (!m) { t('partie complète : un événement arrive toujours', false); break; }
    if (m.type === 'end') { end = m; break; }
    if (m.type === 'accepted') { accepted++; continue; }
    if (m.type === 'boom') {
      booms++;
      vies[m.id] -= 1;
      if (m.id !== prev || m.lives !== vies[m.id] || m.out !== (vies[m.id] === 0)) boomsOk = false;
      continue;
    }
    // un tour
    const out = new Set(m.players.filter((p) => p.out).map((p) => p.id));
    if (prev && suivant(cd.order, prev, out) !== m.holder) ordreOk = false;
    if (out.has(m.holder)) ordreOk = false;
    prev = m.holder;
    tours++;
    if (tours % 4 === 0) continue;                       // celui-là, on le laisse exploser
    const w = O.motPour(m.prompt, used);
    used.add(w);
    parId[m.holder].send({ action: 'submit', turnId: m.turnId, text: w });
  }
  t(`partie complète : ${tours} tours, ${accepted} mots, ${booms} explosions, puis la fin`, !!end && accepted > 0 && booms >= 4);
  t('rotation : chaque tour vise le suivant vivant dans l ordre fixe', ordreOk);
  t('explosions : toujours sur le joueur visé, vies décomptées, élimination à 0', boomsOk);
  if (end) {
    t('classement final : rangs 1, 2, 3, triés', end.ranking.map((r) => r.rank).join() === '1,2,3');
    t('classement : le vainqueur a encore des vies, les autres 0', end.ranking[0].lives > 0 && end.ranking.slice(1).every((r) => r.lives === 0));
    t('classement : noms et avatars repris', end.ranking.every((r) => parId[r.id] && ['Alice', 'Bruno', 'Chloé'].includes(r.name) && r.avatar && r.avatar.emoji));
    const ends = await Promise.all([B, C].map((c) => c.wait((m) => m.type === 'end')));
    t('les trois reçoivent le même classement', ends.every((e) => e && JSON.stringify(e) === JSON.stringify(end)));
  }
  B.send({ action: 'start' });
  t('fin : seul l hôte relance', /seul l'hôte/.test((await B.suite((m) => m.type === 'error')).message));
  A.send({ action: 'lobby' });
  const retour = await B.suite((m) => m.type === 'lobby');
  t('fin → salon (hôte) : tout le monde revient au salon', !!retour && retour.phase === 'lobby' && retour.players.length === 3);
  A.send({ action: 'start', vies: 1 });
  t('revanche : une nouvelle partie part depuis le salon', !!(await B.suite((m) => m.type === 'countdown' && m.vies === 1)));
  fermer([A, B, C, X, Y]);

  // ======================================================== 3. validation
  {
    const { cs, parId: P } = await table(3, 'V');
    cs[0].send({ action: 'start', vies: 3 });
    const tour = await cs[0].wait((m) => m.type === 'turn');
    const H = P[tour.holder], Oo = cs.find((c) => c !== H), T3 = cs.find((c) => c !== H && c !== Oo);
    const joues = new Set();
    const n0 = cs.map((c) => c.msgs.length);
    const rej = async (c) => c.suite((m) => m.type === 'rejected', 2000);

    Oo.send({ action: 'submit', turnId: tour.turnId, text: O.motPour(tour.prompt, joues) });
    const r1 = await rej(Oo);
    await O.sleep(60);
    t('mauvais joueur : NOT_YOUR_TURN, à lui seul', r1.reason === 'NOT_YOUR_TURN'
      && !H.depuis(n0[cs.indexOf(H)], (m) => m.type === 'rejected').length && !T3.depuis(n0[cs.indexOf(T3)], (m) => m.type === 'rejected').length);

    const sansPrompt = ['maison', 'arbre', 'soleil', 'chien', 'table'].find((w) => !w.includes(tour.prompt));
    H.send({ action: 'submit', turnId: tour.turnId, text: sansPrompt });
    const r2 = await Promise.all(cs.map(rej));
    t('mauvais prompt : NO_PROMPT, montré à toute la table (avec le mot)', r2.every((r) => r && r.reason === 'NO_PROMPT' && r.id === H.id && r.text === sansPrompt));
    H.send({ action: 'submit', turnId: tour.turnId, text: 'zzq' + tour.prompt + 'xqz' });
    t('mot inexistant : NOT_A_WORD, montré à tous', (await Promise.all(cs.map(rej))).every((r) => r && r.reason === 'NOT_A_WORD'));
    H.send({ action: 'submit', turnId: tour.turnId, text: tour.prompt.toUpperCase() });
    t('le prompt tout seul : TOO_SHORT', (await rej(H)).reason === 'TOO_SHORT');
    H.send({ action: 'submit', turnId: tour.turnId, text: 'ab12' + tour.prompt });
    t('chiffres : BAD_CHARS', (await rej(H)).reason === 'BAD_CHARS');
    H.send({ action: 'submit', turnId: tour.turnId - 1, text: O.motPour(tour.prompt, joues) });
    t('ancien turnId : STALE_TURN', (await rej(H)).reason === 'STALE_TURN');
    H.send({ action: 'submit', turnId: String(tour.turnId), text: O.motPour(tour.prompt, joues) });
    t('turnId en texte : STALE_TURN (aucune conversion de confiance)', (await rej(H)).reason === 'STALE_TURN');
    H.send({ action: 'submit', turnId: tour.turnId, text: 42 });
    t('texte qui n est pas une chaîne : refusé sans planter', (await rej(H)).reason === 'TOO_SHORT');

    const w = O.motPour(tour.prompt, joues);
    joues.add(w);
    const n1 = cs.map((c) => c.msgs.length);
    H.send({ action: 'submit', turnId: tour.turnId, text: w });
    H.send({ action: 'submit', turnId: tour.turnId, text: w });       // double envoi
    const acc = await T3.wait((m) => m.type === 'accepted', 2000, n1[cs.indexOf(T3)]);
    const r3 = (await H.wait((m) => m.type === 'rejected', 2000, n1[cs.indexOf(H)])) || {};
    await O.sleep(60);
    t('mot valide : accepté, montré à tous', !!acc && acc.id === H.id && O.estUnMot(acc.word));
    t('double envoi : un seul accepted, le second refusé à l envoyeur',
      cs.every((c, i) => c.depuis(n1[i], (m) => m.type === 'accepted').length === 1) && ['NOT_YOUR_TURN', 'STALE_TURN'].includes(r3.reason));
    const t2 = await T3.wait((m) => m.type === 'turn', 2000, n1[cs.indexOf(T3)]);
    t('après le mot : la menace vise le suivant, nouveau prompt, nouveau turnId', t2.holder !== H.id && t2.turnId === tour.turnId + 1);

    // Accents : on tape sans, la forme accentuée revient.
    let tc = t2, ok1 = false, ok2 = false;
    for (let i = 0; i < 60 && !(ok1 && ok2); i++) {
      const Hc = P[tc.holder];
      const deja = [...joues].find((k) => k.includes(tc.prompt) && k.length > tc.prompt.length);
      const acce = O.motAccentue(tc.prompt, joues);
      const m0 = cs.map((c) => c.msgs.length);
      if (!ok1 && deja) {
        Hc.send({ action: 'submit', turnId: tc.turnId, text: deja.toUpperCase() });
        const rr = await Promise.all(cs.map(rej));
        t(`doublon (« ${deja} » déjà joué) : ALREADY_USED, montré à tous`, rr.every((r) => r && r.reason === 'ALREADY_USED'),
          rr.map((r) => r && r.reason).join());
        ok1 = true;
      }
      let mot;
      if (!ok2 && acce) { mot = acce.k; ok2 = true; } else {
        mot = (O.motsPour(tc.prompt).filter((x) => x.k.length >= 9 && !joues.has(x.k))[0] || {}).k || O.motPour(tc.prompt, joues);
      }
      Hc.send({ action: 'submit', turnId: tc.turnId, text: mot });
      const a = await T3.wait((m) => m.type === 'accepted' || m.type === 'boom', 2000, m0[cs.indexOf(T3)]);
      if (a && a.type === 'accepted') joues.add(mot);      // joué seulement s'il a été ACCEPTÉ
      if (acce && mot === acce.k) t(`tapé sans accent (« ${acce.k} ») : la forme accentuée revient (« ${a && a.word} »)`, !!a && a.word === acce.forme);
      tc = await T3.wait((m) => m.type === 'turn', 2000, m0[cs.indexOf(T3)]);
    }
    t('doublon et forme accentuée rencontrés', ok1 && ok2);
    fermer(cs);
  }
  {
    // Joueur éliminé.
    const { cs, parId: P } = await table(3, 'E');
    cs[0].send({ action: 'start', vies: 1 });
    const tour = await cs[0].wait((m) => m.type === 'turn');
    const Elim = P[tour.holder];
    const b = await cs[0].wait((m) => m.type === 'boom', 3000);
    t('vies = 1 : la première explosion élimine (rang 3)', !!b && b.id === Elim.id && b.out === true && b.rank === 3);
    const t2 = await cs[0].wait((m) => m.type === 'turn', 2000);
    Elim.send({ action: 'submit', turnId: t2.turnId, text: O.motPour(t2.prompt, new Set()) });
    t('joueur éliminé : son mot est refusé (NOT_YOUR_TURN)', (await Elim.suite((m) => m.type === 'rejected')).reason === 'NOT_YOUR_TURN');
    const n = cs.map((c) => c.msgs.length);
    Elim.send({ action: 'typing', turnId: t2.turnId, text: 'abc' });
    await O.sleep(80);
    t('joueur éliminé : sa saisie n est relayée à personne', cs.every((c, i) => !c.depuis(n[i], (m) => m.type === 'typing').length));
    t('joueur éliminé : il reste connecté et voit la suite', Elim.ws.readyState === 1 && Elim.msgs.some((m) => m.type === 'turn' && m.turnId === t2.turnId));
    fermer(cs);
  }

  // ========================================================= 4. minuterie
  {
    const { cs, parId: P, code } = await table(3, 'T');
    cs[0].send({ action: 'start', vies: 3 });
    const tour = await cs[0].wait((m) => m.type === 'turn');
    const recu = Date.now();
    const b = await cs[0].wait((m) => m.type === 'boom', 3000);
    const dt = Date.now() - recu;
    t(`expiration réelle : explosion après ${dt} ms (menace neuve : 2× à 4× le plancher)`, !!b && dt >= 2 * PLANCHER - 40 && dt <= 4 * PLANCHER + 150);
    t('explosion : sur le joueur visé, une vie de moins', b.id === tour.holder && b.lives === 2 && b.out === false
      && b.players.find((p) => p.id === tour.holder).lives === 2);
    const ordre = cs[0].msgs.find((m) => m.type === 'countdown').order;
    const suiv = P[suivant(ordre, tour.holder, new Set())];
    const n = cs.map((c) => c.msgs.length);
    suiv.send({ action: 'submit', turnId: tour.turnId + 1, text: O.motPour(tour.prompt, new Set()) });
    suiv.send({ action: 'typing', turnId: tour.turnId + 1, text: 'abc' });
    t('pendant la pause : aucun mot accepté (NOT_PLAYING)', (await suiv.suite((m) => m.type === 'rejected')).reason === 'NOT_PLAYING');
    const reprise = await cs[0].wait((m) => m.type === 'turn', 2000);
    const pause = Date.now() - recu - dt;
    t(`pause puis reprise : ${pause} ms (≥ ${BOOM} ms)`, !!reprise && pause >= BOOM - 30);
    t('pendant la pause : aucune saisie relayée', cs.every((c, i) => !c.depuis(n[i], (m) => m.type === 'typing').length));
    t('reprise : le suivant est visé, MÊME prompt, nouveau turnId', reprise.holder === suiv.id && reprise.prompt === tour.prompt && reprise.turnId === tour.turnId + 1);

    // 2e explosion sur le même prompt → nouveau prompt (MaxPromptAge = 2).
    await cs[0].wait((m) => m.type === 'boom', 3000);
    const t3 = await cs[0].wait((m) => m.type === 'turn', 2000);
    t('MaxPromptAge = 2 : après la 2e explosion sur le même prompt, nouveau prompt', !!t3 && t3.prompt !== tour.prompt);

    // Plancher : on répond à 150 ms de l'explosion → le suivant a le plancher.
    const room = rooms.get(code);
    const joues = new Set();
    const prendre = (p) => { const w = O.motPour(p, joues); joues.add(w); return w; };
    await O.attendre(() => room.game.explodeAt - Date.now() < 150, 3000);
    P[t3.holder].send({ action: 'submit', turnId: t3.turnId, text: prendre(t3.prompt) });
    const t4 = await cs[0].wait((m) => m.type === 'turn', 2000);
    const reste = room.game.explodeAt - Date.now();
    t(`plancher : le suivant a ${reste} ms (≈ ${PLANCHER})`, !!t4 && reste >= PLANCHER - 40 && reste <= PLANCHER + 5);

    // Mot arrivé APRÈS l'échéance, minuterie retenue : trop tard quand même.
    clearTimeout(room.timer);
    await O.attendre(() => Date.now() > room.game.explodeAt + 30, 3000);
    const t5 = t4;
    const Hc = P[t5.holder];
    const m0 = cs[0].msgs.length;
    Hc.send({ action: 'submit', turnId: t5.turnId, text: prendre(t5.prompt) });
    const tard = await Hc.suite((m) => m.type === 'rejected');
    t('soumission après l expiration : TOO_LATE, même si la minuterie n a pas encore sonné', tard.reason === 'TOO_LATE');
    t('… et l explosion est diffusée à tous', !!(await cs[0].wait((m) => m.type === 'boom' && m.id === Hc.id, 1000, m0)));
    const neuf = await cs[0].wait((m) => m.type === 'turn', 2000, m0);
    t('… puis la partie reprend seule (minuterie reposée)', !!neuf);
    // Menace NEUVE (800 à 1 600 ms de reste) : un mot tout de suite → le suivant hérite du reste.
    const avant = room.game.explodeAt;
    t('menace neuve : reste > plancher', avant - Date.now() > PLANCHER);
    P[neuf.holder].send({ action: 'submit', turnId: neuf.turnId, text: prendre(neuf.prompt) });
    const t6 = await cs[0].wait((m) => m.type === 'turn', 2000);
    t('reste > plancher : le suivant hérite du reste (échéance inchangée)', !!t6 && t6.turnId === neuf.turnId + 1 && room.game.explodeAt === avant);
    fermer(cs);
  }

  // ===================================================== 5. saisie relayée
  {
    const { cs, parId: P } = await table(3, 'S');
    cs[0].send({ action: 'start', vies: 3 });
    const tour = await cs[0].wait((m) => m.type === 'turn');
    const H = P[tour.holder], autres = cs.filter((c) => c !== H);
    const n = cs.map((c) => c.msgs.length);
    H.send({ action: 'typing', turnId: tour.turnId, text: 'pa' });
    const vus = await Promise.all(autres.map((c) => c.wait((m) => m.type === 'typing', 1000, n[cs.indexOf(c)])));
    t('saisie du joueur visé : relayée aux autres', vus.every((m) => m && m.id === H.id && m.text === 'pa' && m.turnId === tour.turnId));
    await O.sleep(50);
    t('… mais pas renvoyée à lui-même', !H.depuis(n[cs.indexOf(H)], (m) => m.type === 'typing').length);
    const n2 = cs.map((c) => c.msgs.length);
    autres[0].send({ action: 'typing', turnId: tour.turnId, text: 'triche' });
    H.send({ action: 'typing', turnId: tour.turnId - 1, text: 'vieux' });
    H.send({ action: 'typing', turnId: tour.turnId, text: 'a'.repeat(61) });
    await O.sleep(80);
    t('saisie d un autre joueur : relayée à personne', cs.every((c, i) => !c.depuis(n2[i], (m) => m.type === 'typing' && m.text === 'triche').length));
    t('ancien turnId : ignoré', cs.every((c, i) => !c.depuis(n2[i], (m) => m.type === 'typing' && m.text === 'vieux').length));
    t('plus de 60 caractères bruts : ignorée', cs.every((c, i) => !c.depuis(n2[i], (m) => m.type === 'typing').length));
    H.send({ action: 'typing', turnId: tour.turnId, text: 'b'.repeat(45) });
    H.send({ action: 'typing', turnId: tour.turnId, text: 'a1b2🚀c‮é' });
    const lim = await autres[0].wait((m) => m.type === 'typing' && /^b+$/.test(m.text), 1000, n2[cs.indexOf(autres[0])]);
    const sale = await autres[0].wait((m) => m.type === 'typing' && /c/.test(m.text), 1000, n2[cs.indexOf(autres[0])]);
    t('45 caractères : coupés à 30 pour les autres', !!lim && lim.text.length === 30);
    t('caractères non autorisés retirés (chiffres, emoji, inversion du sens)', !!sale && sale.text === 'abcé');
    await O.sleep(1050);                   // nouvelle fenêtre de débit
    const tour2 = await cs[0].suite((m) => m.type === 'turn', 4000);   // un tour FRAIS (pas une pause)
    const Hb = P[tour2.holder], Ob = cs.find((c) => c !== Hb);
    const n4 = Ob.msgs.length;
    for (let i = 0; i < 50; i++) Hb.send({ action: 'typing', turnId: tour2.turnId, text: 'x'.repeat(1 + (i % 20)) });
    await O.sleep(150);
    const relayes = Ob.depuis(n4, (m) => m.type === 'typing' && m.id === Hb.id).length;
    t(`débit : 50 saisies en rafale → ${relayes} relayées (≤ 20 par seconde)`, relayes > 0 && relayes <= 20);
    t('la saisie ne change aucun état (aucun mot accepté par elle)', !Ob.depuis(n4, (m) => m.type === 'accepted').length);
    fermer(cs);
  }

  // ============================================================== 6. le fil
  {
    let total = 0;
    const ecarts = [];
    for (const c of tous) {
      total += c.msgs.length;
      ecarts.push(...O.inspecterFil(c.msgs, secrets).map((e) => `${c.nom} ${e}`));
    }
    t(`le fil : ${total} messages reçus par ${tous.length} clients, ${secrets.length / 2} échéances relevées côté serveur — aucun champ hors liste, aucun temps`,
      ecarts.length === 0, ecarts.slice(0, 5).join(' | '));
    t('le fil : le mot « explodeAt » n apparaît dans aucun message', tous.every((c) => !JSON.stringify(c.msgs).includes('explodeAt')));
    const turns = tous.flatMap((c) => c.msgs.filter((m) => m.type === 'turn'));
    t(`le fil : ${turns.length} messages turn, aucun ne porte autre chose que turnId, holder, prompt, players`,
      turns.length > 30 && turns.every((m) => Object.keys(m).sort().join() === 'holder,players,prompt,turnId,type'));
  }

  const { ok, ko } = t.bilan();
  console.log(`\n${ok} OK, ${ko} KO`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.log('KO   exception : ' + (e.stack || e.message)); process.exit(1); });
