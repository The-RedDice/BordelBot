# BordelBot

Bot Discord modulaire en TypeScript (discord.js v14, SQLite) : jeux, économie et modération.

## Fonctionnalités

Les commandes sont regroupées par thème : 21 commandes au lieu d'une trentaine.

| Commande | Sous-commandes |
|---|---|
| `/jeu` | `taupe` · `mot-du-jour` · `morpion` · `puissance4` · `blackjack` · `roulette` · `pile-ou-face` · `machine-a-sous` · `duel` |
| `/eco` | `solde` · `daily` · `virer` · `historique` · `braquer` · `loterie acheter|voir` |
| `/boutique` | `voir` · `acheter` · `inventaire` |
| `/bourse` | `cours` · `graphique` · `acheter` · `vendre` · `portefeuille` |
| `/profil` | `general` · `succes` · `niveau` |
| `/top` | `fortune` · `niveaux` · `victoires` · `daily` · `bourse` · `saison` |
| **Modération** | `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` |
| `/sanctions` | `voir` · `revoquer` |
| `/note` | `ajouter` · `voir` · `supprimer` |
| `/ticket` | `panneau` · `ajouter` · `retirer` · `fermer` |
| `/anniversaire` | `definir` · `supprimer` · `voir` · `prochains` |
| `/salon` | `verrouiller` · `deverrouiller` · `mode-lent` |
| `/admin` | `solde …` · `boutique ajouter|role|retirer` · `xp …` · `export` (« Gérer le serveur ») |
| `/config` | tableau de bord : économie, rôles et braquage, loterie et saisons, modération, automod, tickets, niveaux, rôles de niveau, anniversaires |
| `/info` | version, latence, uptime |

- **La Taupe** : tous les agents connaissent un mot secret sauf la taupe, qui doit se fondre dans la masse. Les gagnants
  des parties sont crédités automatiquement (avec un bonus pour le camp minoritaire).
- **Niveaux** : de l'XP en discutant (15 à 25 XP, une fois par minute au plus) et en vocal (5 XP par minute, à deux
  minimum, hors AFK et sourdine casque). Montées de niveau annoncées dans le salon du message, dans un salon dédié ou
  pas du tout. **Rôles de niveau** attribués automatiquement, cumulés ou non. Tout se règle dans `/config`.
- **Anniversaires** : chaque membre enregistre sa date (sans l'année). Le jour J, à l'heure choisie (fuseau
  réglable, Europe/Paris par défaut), le bot le souhaite dans un salon, lui donne un rôle pour la journée et lui
  offre un bonus, une fois par an au plus. Un 29 février est fêté le 28 les autres années. `/config` → Anniversaires.
- **Succès** : 11 succès (victoires, séries de daily, jackpot, duels, bourse…) versent une récompense au déblocage.
- **Mot du jour** : un mot de 5 lettres par jour, le même pour tout le serveur, 6 essais. Les essais restent privés, le
  résultat est publié sans les lettres. Une victoire rapporte la récompense habituelle des parties ; séries de jours
  réussis comme pour le daily.
- **Morpion et puissance 4** : défi entre deux membres, plateau à boutons, mise facultative (le gagnant remporte
  celle de l'autre, un match nul rembourse). 2 minutes par coup, sinon défaite.
- **Jeux d'argent** : pile ou face (quitte ou double), machine à sous (≈ 95 % redistribués), duels entre membres,
  **blackjack** contre la banque (sabot de 6 jeux, blackjack payé 3 pour 2, doubler possible) et **roulette**
  européenne à plusieurs (30 s de mises après le premier pari, chances simples, douzaines, numéro plein).
  Mise maximale réglable dans `/config` (0 = désactivés). Les mises des parties en cours sont gardées en base : si le
  bot redémarre en pleine partie, elles sont remboursées.
- **Rôles en boutique** : `/admin boutique role` met un rôle en vente, permanent ou pour une durée (`7j`…). Racheter
  un rôle temporaire le prolonge ; il est retiré automatiquement à l'échéance. Si Discord refuse de l'attribuer,
  l'achat est remboursé. Visible dans `/boutique inventaire`.
- **Rôle du plus riche** : donné au n° 1 de `/top fortune` (vérifié toutes les heures), avec annonce facultative.
- **Braquages** : `/eco braquer`, 30 à 60 % de réussite (plus facile sur une cible plus riche que soi), butin de 5 à
  15 % de son solde (plafond réglable) ; raté, 10 % de son propre solde va à la cible. Un braquage toutes les 4 h,
  une même cible au plus une fois toutes les 12 h. Désactivable dans `/config`.
- **Loterie** : `/eco loterie acheter`, ticket à prix fixe (100 par défaut), tirage le dimanche à 20 h (heure de Paris).
  La cagnotte reçoit 90 % du prix des tickets et revient à un seul gagnant, tiré au sort parmi les tickets.
- **Saisons** : `/top saison` classe les gains du mois (hors virements, ajustements et achats) et les victoires du
  mois. Le 1er, le podium des gains est archivé et annoncé, le top 3 reçoit un bonus (1 000 / 500 / 250 par défaut)
  et le 1er le rôle « Champion du mois ». Les soldes, eux, ne sont jamais remis à zéro.
- **Bourse** : 5 actifs fictifs dont le cours évolue toutes les 5 minutes (marche aléatoire avec rappel vers un prix
  de référence et actualités qui font bondir ou chuter un cours). Cours communs à tous les serveurs, portefeuilles
  propres à chaque serveur, 1 % de frais par ordre. `/bourse graphique` trace la courbe en image (1 h à 30 jours).
  **Dividendes** : CRS, l'actif stable, verse chaque jour à midi (heure de Paris) 0,2 % de la valeur détenue.
- **Sanctions automatiques** : par exemple `3 = timeout 1h`, `5 = kick`, `7 = ban 7j` ; appliquées par le bot dès qu'un
  membre atteint ce nombre d'avertissements actifs.
- **Bans temporaires** : `/ban duree:3j` ; le ban est levé automatiquement, même après un redémarrage du bot.
- **Automod** : en complément de l'AutoMod de Discord (à utiliser pour les mots interdits, les invitations et les
  mentions de masse, bloqués avant publication), le bot détecte le **flood** (ex. 6 messages en 5 s) et les
  **messages répétés**. Il supprime la rafale, avertit le membre (ce qui alimente les paliers) et peut l'exclure
  quelques minutes. En option, chaque infraction à l'AutoMod de Discord vaut aussi un avertissement. Désactivé par
  défaut, à régler dans `/config` → Automod. Les membres qui peuvent gérer les messages ne sont pas concernés.
- **Logs de messages** : messages modifiés (avant/après) et supprimés dans un salon dédié, et transcription en
  fichier pour les suppressions en masse. Le contenu n'est connu que pour les messages envoyés depuis le démarrage
  du bot (cache mémoire, rien n'est stocké en base).
- **Notes** : `/note ajouter|voir|supprimer`, notes internes sur un membre, visibles des modérateurs seulement et
  sans effet sur les avertissements. `/sanctions voir` signale leur présence.
- **Tickets** : `/ticket panneau` publie un bouton « Ouvrir un ticket ». Après un court formulaire (sujet), le membre
  obtient un salon privé avec le rôle du staff ; un ticket ouvert à la fois. Boutons « Prendre en charge » et
  « Fermer » ; `/ticket ajouter|retirer` pour inviter quelqu'un. À la fermeture, la transcription est archivée dans
  un salon du staff et envoyée en MP au membre, puis le salon est supprimé. `/config` → Tickets.
- `/admin export` fournit le journal des opérations en CSV.

## Installation

Prérequis : Node.js ≥ 22.12 (exigé par better-sqlite3 13 et Vitest 5 ; avec Node 20, better-sqlite3 plante
au chargement avec une « Segmentation fault »).

```bash
npm install
cp .env.example .env     # renseigner DISCORD_TOKEN et DISCORD_CLIENT_ID
npm run deploy:commands  # enregistre les slash commands (instantané avec DISCORD_DEV_GUILD_ID)
npm run dev              # démarrage avec rechargement automatique
```

Production : `npm run build && npm start`.

Permissions du bot à l'invitation : Voir les salons, Envoyer des messages, Intégrer des liens, Joindre des fichiers,
Lire l'historique, Gérer les messages, Gérer les salons et Gérer les rôles (pour `/lock` et `/slowmode`), Exclure
temporairement, Expulser et Bannir des membres. Gérer le serveur en plus si les infractions à l'AutoMod de Discord
doivent compter comme avertissements (Discord n'envoie ces événements qu'avec cette permission).
Pour modérer un membre ou lui donner un rôle de niveau, le rôle du bot doit être placé au-dessus.

**Intent privilégié obligatoire : Message Content.** À activer dans le Developer Portal (Bot → Privileged Gateway
Intents → Message Content Intent) **avant** de démarrer le bot, sinon Discord refuse la connexion (« Used disallowed
intents »). Il sert aux logs de messages (contenu avant modification ou suppression) et à la détection des messages
répétés. Les niveaux, eux, ne lisent jamais le contenu.

Graphiques de la bourse : ils sont rendus en PNG sur le serveur. Sous Linux, installer une police pour les
libellés des axes : `sudo apt install fonts-dejavu-core` (sans police, la courbe s'affiche quand même, sans texte).

Sauvegardes : la base est copiée à chaud une fois par jour et juste avant chaque migration, dans `data/backups/`
(`BACKUP_DIR` pour changer de dossier). Les 7 dernières de chaque sorte sont gardées (`BACKUP_KEEP`, 0 pour
désactiver). Pour restaurer : arrêter le bot, remplacer `data/bot.sqlite` par la copie choisie, supprimer
`bot.sqlite-wal` et `bot.sqlite-shm`, puis redémarrer. Ces copies restent sur la même machine : pour survivre à la
perte de la VM, les copier ailleurs de temps en temps (`scp`).

Logs : `LOG_FORMAT=json` écrit une ligne JSON par événement (filtrable avec `jq`), `text` (défaut) reste lisible.

## Architecture

```
src/
├─ core/                 client, EventBus typé, planificateur, routeur d'interactions, SQLite + migrations, /config
└─ modules/
   ├─ games/
   │  ├─ engine/         FSM génériques et sessions, sans discord.js
   │  ├─ mole/           règles de La Taupe (fonctions pures) + adaptateur Discord
   │  └─ GameService.ts  une partie par salon, persistance, émission de game:finished
   ├─ levels/            XP, courbe de niveaux, rôles de récompense, suivi des messages et du vocal
   ├─ economy/           EconomyService (transactions SQLite, journal) + commandes
   │  ├─ gambling/       pile ou face, machine à sous, duels
   │  ├─ market/         bourse : modèle de prix, ordres, graphique (resvg)
   │  └─ progress/       statistiques et succès
   └─ moderation/        ModerationService (journal, paliers, bans temporaires) + commandes
```

- **Commandes partagées** : `/jeu`, `/top`, `/profil` et `/admin` sont déclarées dans `core/commands/parents.ts` ;
  chaque module y ajoute ses sous-commandes (`BotModule.subcommands`) et le registre les assemble.
- **Découplage** : les modules ne s'importent pas entre eux. Les jeux émettent `game:finished` sur l'EventBus,
  l'économie s'y abonne.
- **Tâches planifiées** : `ctx.scheduler` (`core/scheduler/JobScheduler.ts`) exécute une action à une date donnée
  (rappel, clôture de sondage, tirage…). Les échéances sont en base et survivent aux redémarrages. Un module ajoute
  son type de tâche dans `core/jobs.ts`, déclare son gestionnaire dans `init`
  (`ctx.scheduler.register('reminder', async (job, client) => …)`), puis planifie avec
  `ctx.scheduler.schedule('reminder', date, contenu)`.
- **Testabilité** : la logique (FSM, économie, durées, hiérarchie) ne dépend pas de discord.js ; le hasard,
  l'horloge et les timers sont injectés.
- **Intégrité** : toute opération économique est une transaction SQLite journalisée ; une récompense ne peut pas
  être versée deux fois pour une même partie.

## Scripts

| Script | Rôle |
|---|---|
| `npm run dev` | Lance le bot avec rechargement |
| `npm test` | Tests (Vitest) |
| `npm run typecheck` | Vérification TypeScript |
| `npm run migrate` | Applique les migrations sans lancer le bot (après une sauvegarde) |
| `npm run backup` | Sauvegarde manuelle de la base, utilisable bot allumé |
| `npm run deploy:commands` | Enregistre les slash commands |
