# roquette-server (nom provisoire)

Serveur arbitre d'un **jeu de mots à la roquette**, un des jeux web du
portfolio de Mathys Langiny. Le client vivra dans le dépôt du portfolio, sous
`games/<jeu>/`, servi par GitHub Pages. Ici, il n'y a que l'arbitre.

Même séparation que pour les autres jeux du portfolio (`passeur-server`,
`qui-ment-server`, `ban-server`…) : **le front est statique, le serveur est la
seule autorité.**

## Le jeu

Une menace centrale (une roquette) vise le joueur dont c'est le tour. Un
**prompt** de 2 ou 3 lettres est affiché (`ION`) : il faut taper un mot qui le
contient (*passion*, *camion*, *ionisation*).

- Mot valide → la roquette vise le joueur suivant, nouveau prompt.
- Temps écoulé → elle explose sur le joueur visé : **−1 vie**. Le même prompt
  passe au suivant ; il est remplacé après 2 explosions.
- À 0 vie, on est éliminé (on reste spectateur). Le dernier vivant gagne.

Le temps est **caché** : une menace neuve dure entre 2× et 4× le plancher, tiré
au hasard ; après chaque mot validé, le joueur suivant a **au moins** le
plancher (Détendu 8 s, Normal 6 s, Nerveux 4 s), sinon il hérite du reste.
Personne ne sait quand elle part — et le serveur ne l'envoie jamais.

Réglages de l'hôte : rythme (`detendu` / `normal` / `nerveux`) et vies (1 à 5,
3 par défaut). 2 à 16 joueurs.

## Ce qui est du ressort du serveur

- **`engine.js`, le moteur pur** : tours, prompts, temps, vies, éliminations,
  classement. Horloge et hasard injectés, aucun réseau. `server.js` ne fait que
  l'orchestrer : une seule minuterie par room, posée sur `nextDeadline()`.
- **Le temps ne sort jamais** : aucun message ne porte l'instant de
  l'explosion, le temps restant, la durée tirée ni aucun horodatage.
- **Le mot est vérifié ici** : joueur visé, bon `turnId`, bonne phase, temps
  non écoulé (à l'horloge du serveur), longueur, prompt présent, pas déjà joué,
  dans le dictionnaire. Le client reçoit « accepté » ou « refusé + raison ».
- **Le dictionnaire ne quitte jamais le serveur.**
- **Partir = être éliminé**, à l'instant, avec le rang du moment. Si c'était
  son tour, la menace vise le suivant tout de suite (même prompt, au moins le
  plancher). Aucune partie ne reste suspendue à un onglet fermé ; un onglet
  gelé est fermé par `presence.js` et traité de même.

## Le dictionnaire

`dico/mots.txt` et `dico/prompts.txt` sont **dérivés du « Lexique des formes
fléchies du français — Grammalecte v7.7 »** (Dicollecte,
<https://grammalecte.net/>), distribué sous **Mozilla Public License 2.0** —
ces deux fichiers restent sous MPL 2.0 (mention en tête de chacun). Le reste du
dépôt est sous licence MIT.

Ils sont produits par `tools/build-dico.mjs` (déterministe) :

    node tools/build-dico.mjs chemin/vers/lexique-grammalecte-fr-v7.7.txt

- normalisation `cle()` du moteur : casse, accents, œ/æ, traits d'union,
  apostrophes et espaces ignorés (« Aujourd’hui » = « aujourdhui ») ;
- écartés : noms propres, abréviations, symboles et sigles (« etc », « km »),
  élisions (« jusqu’ »), signes et préfixes, formes en majuscules, moins de 3
  ou plus de 30 lettres. Gardés : conjugaisons, pluriels, familier, vulgaire,
  apocopes (« apéro », « appli »), orthographes classique et 1990 ;
- 429 388 mots. Prompts : 987 (258 de 2 lettres, 729 de 3), chacun présent
  dans au moins 200 lemmes courants.

## Lancer en local

    npm install
    npm start          # écoute sur $PORT, 8094 par défaut

`?server=ws://localhost:8094` sur la page du jeu (à venir).

## Le protocole

Un seul WebSocket, du JSON. Les `{ action: 'presence' }` / `{ type: 'presence' }`
sont ceux de `presence.js`, commun aux serveurs du portfolio.

| Client → serveur | |
|---|---|
| `join` | `{ name, avatar, code?, skin? }` — sans `code`, on crée la room et on en devient l'hôte |
| `skin` | `{ skin }` — changer de skin d'arme, **au salon seulement** ; ignoré en silence sinon (voir plus bas) |
| `start` | hôte : `{ rythme?, vies? }` — depuis le salon, ou la fin (revanche) |
| `lobby` | hôte, en fin de partie : retour au salon (les nouveaux peuvent entrer) |
| `submit` | `{ turnId, text }` — le mot du joueur visé |
| `typing` | `{ turnId, text }` — sa saisie en cours, relayée aux autres |

| Serveur → client | |
|---|---|
| `you` | `{ id, code, host }` |
| `lobby` | `{ code, phase, max, players: [{ id, name, avatar, skin, host }] }` |
| `skin` | `{ id, skin }` — un joueur a changé de skin au salon (à toute la room, lui compris) |
| `countdown` | `{ order, rythme, vies, seconds, players }` — l'ordre fixe, et l'identité (nom, avatar, skin) de chacun, **une fois** |
| `turn` | `{ turnId, holder, prompt, players }` — qui est visé ; `players` = l'état seul (`id, lives, out, left, rank, words`) |
| `typing` | `{ id, turnId, text }` — à tous sauf l'auteur, 30 caractères au plus |
| `accepted` | `{ id, word, prompt }` — `word` sous sa forme du dictionnaire (« été ») |
| `rejected` | `{ id, turnId, reason, message, text? }` — à toute la table si c'est le MOT qui est refusé (`NO_PROMPT`, `NOT_A_WORD`, `ALREADY_USED`, `TOO_SHORT`, `TOO_LONG`, `BAD_CHARS`) ; à l'envoyeur seul sinon (`NOT_YOUR_TURN`, `STALE_TURN`, `NOT_PLAYING`, `TOO_LATE`, `TOO_FAST`) |
| `boom` | `{ id, lives, out, rank, prompt, players }` — la menace a explosé sur `id` |
| `left` | `{ id, rank, players }` — un joueur est parti (éliminé, rang fixé) |
| `end` | `{ host, ranking: [{ id, name, avatar, rank, lives, words, left }] }` — 1er = dernier vivant |
| `error` | `{ message }` |

Saisie relayée : au-delà de 60 caractères bruts, ignorée ; sinon seuls lettres,
accents, espace, apostrophes et trait d'union passent, coupés à 30. Seul le
joueur visé, pour le `turnId` courant. Débit : 10 mots, 20 saisies, 60 messages
par seconde et par connexion. Trame de plus de 64 Ko : connexion fermée.

**Skin d'arme** (cosmétique, aucun effet sur la partie) : un id FERMÉ par
joueur, `SKINS` dans `server.js` — aujourd'hui `roquette` (défaut) et
`petoire`. Un id s'y ajoute AVANT que le front sache le dessiner. Dans `join`,
un skin absent, inconnu ou mal formé devient `roquette` (jamais de refus) ;
seul l'id nettoyé est relayé, jamais la valeur reçue. L'action `skin` n'est
prise qu'au salon : hors salon, avant le join, id invalide ou identique, ou
au-delà de 4 changements par seconde, rien ne part (ni erreur, ni diffusion).
Le roster fige les skins au `countdown` pour toute la partie (revanche
comprise) ; `turn`, `boom`, `end`… n'en portent pas. Un ancien client (sans
`skin`) joue en `roquette` et ignore les champs et messages qu'il ne connaît pas.

## Tests

    npm test

| Fichier | Ce qu'il couvre |
|---|---|
| `test-engine.mjs` | le moteur pur, horloge simulée : création, ordre, prompts, plancher, durée initiale, tous les refus, expiration, vies, éliminations, départs, classement, 16 joueurs, déterminisme, aucun temps dans `view()` |
| `test-dico.mjs` | le dictionnaire compilé : mention MPL, volumes, cohérence clé/forme, couverture du lot 0, 987 prompts |
| `test.js` | vrai serveur, vrais clients : salon, partie complète à 3, validation, minuterie réelle (explosion, pause, reprise, plancher, trop tard), saisie relayée, et **tout le fil** relu champ par champ (aucun champ hors liste, aucun temps) |
| `test-16.js` | 16 clients : lancement, ordre, rotation complète, 15 éliminations, classement 1 → 16 |
| `test-depart.js` | départs : inactif, visé, pendant une pause, éliminé, plusieurs, plus assez, plus personne, hôte, onglet gelé en partie |
| `test-avatar.js`, `test-avatar-ws.js` | la photo de profil (`avatar.js`, commun aux serveurs) |
| `test-skin.js` | le skin d'arme : join (absent, inconnu, mal formé, forgé), changement au salon, identique, invalide, hors salon, débit 4/s, entrée tardive, countdown, roster figé, revanche, ancien client, aucune valeur forgée sur le fil |
| `test-presence.js` | la présence (`presence.js`, commun aux serveurs) |

Les tests WebSocket raccourcissent les délais par `TEST_PLANCHER_MS`,
`TEST_COUNTDOWN_MS` et `TEST_BOOM_MS` — **jamais en production**.
