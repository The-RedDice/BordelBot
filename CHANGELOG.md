# Journal des modifications

## Planificateur de tâches

Base technique pour les rappels, sondages, anniversaires, la loterie, les rôles temporaires et les saisons. Rien de
visible pour les membres pour l'instant.

- **`ctx.scheduler`** (`core/scheduler/JobScheduler.ts`) : planifie une tâche à une date (`schedule`), l'annule
  (`cancel`, `cancelByKey`), liste les tâches en attente (`list`, `get`, `getByKey`).
- **Persistant** : les tâches sont en base (table `scheduled_jobs`). Une échéance passée pendant un arrêt du bot
  est exécutée au redémarrage.
- **Précis** : une seule minuterie, réglée sur la prochaine échéance (vérification au moins toutes les 60 s).
- **Typé** : chaque type de tâche et son contenu sont déclarés dans `core/jobs.ts`, comme les événements dans
  `core/events.ts`.
- **Clé unique facultative** : planifier de nouveau avec la même clé remplace la tâche (ex. `lottery:<serveur>`).
- **Tâches récurrentes** : le gestionnaire renvoie `{ rescheduleAt }` pour reprogrammer la tâche.
- **Erreurs** : nouvel essai après 1 min, 5 min, 30 min, 2 h puis 12 h, puis abandon (la tâche reste en base avec
  `failed_at` et `last_error`).
- **Au moins une fois** : une tâche n'est supprimée qu'une fois son gestionnaire terminé. Si le bot s'arrête en
  plein milieu, elle est rejouée.
- **Démarrage et arrêt** : il démarre après les `ready` des modules et s'arrête avant leur `dispose`, en attendant
  au plus 5 s la tâche en cours.
- **Migration 005** : table `scheduled_jobs`.
- **Tests** : 193 au total, dont 10 nouveaux.

## Sauvegardes automatiques de la base

- **Chaque jour** : copie à chaud de la base (API de sauvegarde de SQLite), sans arrêter le bot. La vérification se
  fait toutes les heures : une sauvegarde manquée pendant un arrêt est rattrapée au démarrage.
- **Avant chaque migration** (`pre-vN`), au démarrage du bot comme avec `npm run migrate`. Si cette sauvegarde
  échoue, la migration n'est pas appliquée. Une base vierge n'est pas sauvegardée.
- **`npm run backup`** : sauvegarde manuelle (`manual`), utilisable bot allumé.
- **Vérification** : chaque copie est vérifiée (`quick_check`), écrite sous un nom temporaire puis renommée. Elle est
  autonome : un seul fichier, sans `-wal`.
- **Rotation** : les 7 dernières de chaque sorte sont gardées dans `data/backups/`. Réglable avec `BACKUP_DIR` et
  `BACKUP_KEEP` (0 désactive les sauvegardes).
- **Restauration** : voir le README.
- **Tests** : 183 au total, dont 7 nouveaux (noms, rotation, copie, planification, sauvegarde avant migration).
- **Corrigé** : `cryptoRng` levait `ERR_OUT_OF_RANGE` (`randomInt` refuse un écart de 2⁴⁸), ce qui faisait planter le
  démarrage.

## Niveaux, `/top` et regroupement des commandes

### 🗂️ Commandes regroupées (31 → 18)

| Avant | Maintenant |
|---|---|
| `/taupe` `/pile-ou-face` `/machine-a-sous` `/duel` | `/jeu taupe` · `pile-ou-face` · `machine-a-sous` · `duel` |
| `/solde` `/daily` `/virer` `/historique` | `/eco solde` · `daily` · `virer` · `historique` |
| `/boutique` `/acheter` `/inventaire` | `/boutique voir` · `acheter` · `inventaire` |
| `/profil` `/succes` | `/profil general` · `succes` · `niveau` (nouveau) |
| `/classement` | `/top fortune` (+ `niveaux`, `victoires`, `daily`, `bourse`) |
| `/eco-admin solde…` `boutique…` `export` | `/admin solde…` · `boutique…` · `export` · `xp…` (nouveau) |
| `/sanctions` `/delwarn` | `/sanctions voir` · `revoquer` |
| `/lock` `/unlock` `/slowmode` | `/salon verrouiller` · `deverrouiller` · `mode-lent` |
| `/ping` | supprimé : `/info` affiche déjà la latence |

- Restent seules : `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge`. Elles n'ont pas toutes la même
  permission par défaut, et une sous-commande hérite forcément de celle de sa commande.
- Options et comportements inchangés.

### ✨ XP et niveaux

- **Messages** : de 15 à 25 XP (tirage aléatoire), au plus une fois par minute. Les messages plus rapprochés sont
  comptés sans rapporter d'XP. Le contenu des messages n'est jamais lu.
- **Vocal** : 5 XP par minute, pour les membres d'un salon qui sont au moins deux, hors salon AFK et hors sourdine casque.
- **Courbe** : passer du niveau L au niveau L+1 coûte 5L² + 50L + 100 XP. Le niveau 10 demande environ 4 h de discussion.
- **Annonces** de montée de niveau : dans le salon du message, dans un salon dédié, ou désactivées.
- **Rôles de niveau** : une règle par ligne (`5 = @Habitué`, mention, ID ou nom exact). Les rôles se cumulent, ou seul
  celui du plus haut palier est gardé. Le rôle du bot doit être placé au-dessus de ces rôles, ce qui est vérifié à
  l'enregistrement.
- **`/profil niveau [membre]`** : niveau, barre de progression, XP, rang, messages, temps en vocal, prochaine récompense.
- **`/admin xp ajouter|retirer|definir`** : les rôles sont resynchronisés (y compris à la baisse), sans annonce.
- **`/config`** : deux nouvelles sections, « Niveaux » (gains, délai, vocal, annonces) et « Rôles de niveau ».

### 🏆 `/top`

`fortune` (solde), `niveaux` (XP), `victoires` (parties gagnées), `daily` (record de série) et `bourse` (plus-values
réalisées) : top 10, et ta position si tu n'y figures pas.

### 🔧 Technique

- **Commandes parentes** (`core/commands/parents.ts`) : plusieurs modules alimentent une même commande via
  `BotModule.subcommands`. Le registre assemble chaque commande, route les appels et refuse les doublons.
- **`BotModule.intents`** : chaque module déclare ses intents. Les niveaux ajoutent GuildMessages et GuildVoiceStates,
  qui ne sont pas privilégiés.
- **Migration 004** : tables `level_members`, `level_settings` et `level_roles`, et index `idx_user_stats_rank` pour
  les classements.
- **Embed de classement** commun (`core/leaderboard.ts`).
- **Tests** : 174 au total, dont 20 nouveaux (courbe, rôles, XP par message et vocal, réglages, classements, commandes
  parentes).

### 🚀 Déploiement

```bash
git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot
```

- **`deploy:commands` est indispensable** : il remplace l'ancienne liste de commandes, et les anciens noms (`/taupe`,
  `/daily`…) disparaissent.
- Si des rôles de niveau sont configurés, placer le rôle du bot au-dessus d'eux (il a déjà « Gérer les rôles »).

## Commit 2937c04 — Bourse, jeux d'argent, succès, paliers de sanctions et `/config`

### 📈 Bourse (`/bourse`)

| Sous-commande | Rôle |
|---|---|
| `cours` | Cours de tous les actifs, variation sur 1 h et 24 h, dernières actualités |
| `graphique actif [periode]` | Image de la courbe du cours (1 h, 6 h, 24 h, 7 j, 30 j) |
| `acheter actif quantite` | Achète des titres au cours actuel |
| `vendre actif [quantite]` | Vend des titres (tous si la quantité est omise) |
| `portefeuille [membre]` | Titres détenus, valeur, plus-values latentes |

- **5 actifs fictifs** : 🪙 BordelCoin (BDL), 🐀 TaupeCoin (TPC), 🥐 Croissant & Cie (CRS), 🍕 PizzaCorp (PIZ),
  🚀 MemeStonk (MEME). Leur volatilité va de faible (CRS) à extrême (MEME).
- **Évolution du cours** : nouveau prix toutes les 5 minutes. C'est une marche aléatoire qui revient peu à peu vers un
  prix de référence, avec des bornes à ÷50 et ×50.
- **Actualités** : de temps en temps, une nouvelle fait bondir ou chuter un cours de 8 à 35 %.
- **Frais** : 1 % par ordre (minimum 1).
- **Prix de revient** : il est suivi pour chaque position, ce qui permet de calculer la plus-value réalisée à la vente.
- **Cours et portefeuilles** : les cours sont communs à tous les serveurs ; l'argent et les portefeuilles restent
  propres à chaque serveur.
- **Bot éteint** : au redémarrage, les ticks manqués sont simulés (jusqu'à 30 jours), donc la courbe reste continue.
- **Historique** : il est conservé 30 jours.
- **Graphique** : rendu en PNG avec `@resvg/resvg-js`. La courbe est verte en hausse et rouge en baisse ; le prix de
  début est en pointillés ; les heures sont affichées en heure de Paris.

### 🎰 Jeux d'argent

| Commande | Règle |
|---|---|
| `/pile-ou-face mise choix` | Quitte ou double (gain ×2) |
| `/machine-a-sous mise` | 3 rouleaux, jusqu'à ×200 (💎💎💎) ; environ 95 % des mises redistribuées |
| `/duel membre mise` | Défi à accepter sous 60 s ; pile ou face, le gagnant prend la mise de l'autre |

- **Mise maximale** : réglable dans `/config` (10 000 par défaut ; 0 désactive les jeux d'argent).
- **Atomicité** : chaque partie est une seule transaction ; la mise est vérifiée avant le tirage.

### 🏅 Statistiques et succès

- **`/profil [membre]`** : fortune (solde, bourse, total, rang), parties jouées et gagnées, série de daily, jeux
  d'argent, bourse, succès.
- **`/succes [membre]`** : succès débloqués, et progression vers les autres.
- **11 succès**, chacun récompensé une seule fois, au déblocage :

| Succès | Condition | Récompense |
|---|---|---|
| 🏆 Première victoire | Gagner 1 partie | 50 |
| 🎲 Habitué | Jouer 25 parties | 250 |
| 👑 Champion | Gagner 25 parties | 500 |
| 📅 Régulier | Série de 7 daily | 200 |
| 🔥 Inébranlable | Série de 30 daily | 1 000 |
| 🤝 Généreux | Donner 1 000 au total | 100 |
| 🎰 Flambeur | Miser 10 000 au total | 250 |
| 💎 Jackpot | Gagner 20× sa mise d'un coup | 500 |
| ⚔️ Duelliste | Gagner 5 duels | 200 |
| 📈 Investisseur | Premier ordre en bourse | 50 |
| 🐺 Loup de Wall Street | 5 000 de plus-values cumulées | 1 000 |

- **Annonces** : les succès débloqués en fin de partie sont annoncés dans le salon de la partie.
- **Historique repris** : les parties déjà jouées et les séries de daily existantes sont comptées dans les statistiques.

### 💰 Autres changements de l'économie

- **`/eco-admin export [membre]`** : journal des opérations en CSV, au plus les 20 000 dernières. Le fichier est en
  UTF-8 avec BOM, pour qu'Excel lise les accents ; les cellules qui ressemblent à des formules sont neutralisées.
- **`/eco-admin config` est supprimé** : ses réglages sont dans `/config`.
- **Nouveaux types d'opérations dans le journal** : jeu d'argent, duel, achat/vente en bourse, succès.

### 🛡️ Modération

- **Sanctions automatiques par paliers**, définies dans `/config`, une règle par ligne. Exemple :
  ```
  3 = timeout 1h
  5 = kick
  7 = ban 7j
  9 = ban
  ```
  - Elles sont appliquées par le bot dès qu'un membre atteint ce nombre d'avertissements actifs.
  - Si c'est impossible (rôle trop haut, permission manquante), le modérateur en est prévenu.
- **Bans temporaires** : nouvelle option `/ban duree:` (par exemple `3j`, `2sem`).
  - Le ban est levé automatiquement, même si l'échéance tombe pendant un arrêt du bot.
  - Un `/unban` manuel annule la levée prévue.
- **`/lock [salon]`** : retire l'écriture à @everyone. **`/unlock [salon]`** : restaure exactement les permissions
  d'origine.
- **`/slowmode duree [salon]`** : mode lent de 1 s à 6 h ; `0` ou `off` le désactive.
- **Expiration des avertissements** après N jours (dans `/config`). Les avertissements expirés ne comptent plus pour
  les paliers, et `/sanctions` les affiche barrés.
- **Journal des sanctions** : verrouillages, mode lent et sanctions automatiques y sont enregistrés et publiés dans le
  salon de logs.
- **`/modlogs` est supprimé** : le salon de logs se choisit dans `/config`.

### ⚙️ Divers

- **`/config`** : tableau de bord unique des réglages (réservé à « Gérer le serveur »).
  - **Économie** : monnaie, daily, récompense de victoire, mise maximale.
  - **Modération** : salon de logs, expiration des avertissements, sanctions automatiques.
- **`/info`** affiche la version du schéma de la base.
- **`LOG_FORMAT=json`** (option) : une ligne JSON par événement dans les logs ; `text` reste le format par défaut.

### 🔧 Technique

- **Migration 003** :
  - nouvelles tables : `user_stats`, `achievements`, `market_prices`, `market_holdings`, `market_news`,
    `moderation_thresholds` ;
  - nouvelles colonnes : `guild_settings.max_bet`, `guild_settings.warn_expiry_days`,
    `moderation_cases.resolved_at` ;
  - `economy_transactions` et `moderation_cases` sont reconstruites (contraintes CHECK élargies), données conservées.
- **`EconomyService.transact()`** : les opérations composées (bourse, jeux, succès) sont atomiques, et un appel
  imbriqué est détecté.
- **Hook `BotModule.ready(client)`** : sert aux tâches qui agissent sur Discord sans interaction (levée des bans,
  annonces).
- **Contrat `SettingsSection`** : chaque module déclare ses sections de `/config` sans que le core le connaisse.
- **`game:finished`** transporte désormais le `channelId` de la partie.
- **Fichiers déplacés** :
  - `rng.ts` passe dans `src/core/` (il est partagé entre les jeux et l'économie) ;
  - les helpers de modération passent dans `discord/helpers.ts`.
- **Nouvelle dépendance** : `@resvg/resvg-js`.
- **Tests** : 154 au total, dont 34 nouveaux (bourse, jeux d'argent, succès, CSV, paliers, bans temporaires, verrous,
  migration).

### 🚀 Déploiement

```bash
git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot
sudo apt install fonts-dejavu-core   # texte des axes sur les graphiques
```

- Donner au rôle du bot **Gérer les salons** et **Gérer les rôles** (pour `/lock` et `/slowmode`).
- Le salon de logs déjà configuré est conservé.
