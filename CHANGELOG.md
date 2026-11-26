# Journal des modifications

## Tableau de bord web, partie 1 : serveur, connexion Discord, API

L'interface (pages) arrive dans la partie 2 ; cette partie pose tout ce qu'il y a dessous.

- **Facultatif** : il ne démarre que si `DASHBOARD_PORT`, `DASHBOARD_URL` et `DISCORD_CLIENT_SECRET` sont renseignés
  (les trois ensemble). Sinon le bot tourne exactement comme avant. Un port déjà pris n'empêche pas le bot de démarrer.
- **Dans le processus du bot**, `node:http` sans dépendance, à l'écoute sur `127.0.0.1` (le tunnel Cloudflare s'y
  connecte en local). **Lecture seule** : aucune route ne modifie l'économie ni Discord.
- **Connexion Discord (OAuth2)** : scope `identify` seulement, état anti-falsification, jeton d'accès utilisé une fois
  puis oublié. Session de 7 jours en cookie `HttpOnly`/`SameSite=Lax` (`Secure` en HTTPS) ; seule l'empreinte SHA-256
  du jeton est en base.
- **Accès** : on ne voit que les serveurs dont on est membre (vérifié par le bot) ; sinon 404, sans révéler si le bot
  y est présent. La bourse, sans donnée personnelle, est publique.
- **API** : `/api/me` (mes serveurs), `/api/market` et `/api/market/:actif?periode=1h|24h|7j|30j`,
  `/api/guilds/:id` : statistiques (masse monétaire, moyenne, médiane, part des 10 % les plus riches, valeur
  investie en bourse, création monétaire et opérations sur 7 jours), classements (fortune, saison, victoires,
  niveaux), podiums des saisons passées, loterie, activité (parties, mises, braquages, mot du jour, tickets).
- **Sécurité** : CSP stricte (aucun script extérieur), `X-Frame-Options: DENY`, `nosniff`.
- **Technique** : `src/dashboard/` (`auth`, `data`, `directory`, `server`), migration 013 (`dashboard_sessions`).
  308 tests, dont 14 nouveaux (dont un vrai serveur HTTP interrogé de bout en bout avec un faux Discord).

## Tickets d'assistance

- **`/ticket panneau [salon] [texte]`** (« Gérer le serveur ») : publie un message avec un bouton **📩 Ouvrir un
  ticket**.
- **Ouverture** : un formulaire demande le sujet, puis le bot crée un **salon privé** (`ticket-42-pseudo`) visible
  par le membre, le rôle du staff et le bot seulement, avec un message d'accueil qui mentionne le membre et le staff.
  **Un ticket ouvert à la fois** par membre (garanti en base, double clic compris).
- **Dans le ticket** : bouton **🙋 Prendre en charge** (staff), bouton **🔒 Fermer** (le membre ou le staff, avec une
  raison facultative), `/ticket ajouter|retirer membre` (staff), `/ticket fermer [raison]`.
- **Fermeture** : transcription `.txt` (jusqu'à 1 000 messages) **archivée** dans le salon choisi avec un résumé, et
  **envoyée en MP** au membre ; le salon est supprimé 10 s plus tard. Un salon supprimé à la main ferme le ticket.
- **Staff** = le rôle choisi, ou toute personne qui peut gérer les salons.
- **Après un redémarrage**, les boutons fonctionnent toujours (tickets en base).
- **`/config` → 📩 Tickets** : catégorie des salons, rôle du staff, salon d'archive, message d'accueil.
- **Technique** : module `tickets` (`TicketService`, `TicketDesk`). Migration 012 : `ticket_settings`, `tickets`.
  294 tests, dont 7 nouveaux.

**Déploiement** : `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot`
(`deploy:commands` pour `/ticket`). Le bot a besoin de « Gérer les salons » (et « Gérer les rôles » pour les
permissions des salons), déjà demandées à l'invitation.

## Économie, lot 3 : dividendes de CRS

- **🥐 CRS** (Croissant & Cie, l'actif stable) verse chaque jour **à midi (heure de Paris)** un dividende de **0,2 %**
  de la valeur détenue au cours du moment, arrondi à l'unité inférieure (une petite position peut ne rien toucher).
  Avec 1 % de frais à l'achat et à la vente, une position est rentabilisée en une dizaine de jours.
- Versé sur chaque serveur où le membre détient des parts ; « 💵 Dividende » dans `/eco historique`.
- `/bourse cours` indique le dividende de CRS ; `/bourse portefeuille` estime les dividendes du jour.
- **Une fois par jour au plus** (index unique `uq_tx_dividend`). Après un arrêt de plusieurs jours, un seul versement
  a lieu au redémarrage : les jours manqués ne sont pas rattrapés.
- Seuls les dividendes ont été retenus pour la bourse 2.0 (pas d'ordres limites ni de vente à découvert).
- **Technique** : `dividendRate` facultatif sur chaque actif, `MarketService.payDividends`, tâche quotidienne
  `market:dividends` (clé fixe), `nextDaily`/`dayId` dans `core/time.ts`. Migration 011. 287 tests, dont 4 nouveaux.

**Déploiement** : `git pull && npm ci && npm run build && pm2 restart bordelbot` (pas de nouvelle commande).

## Économie, lot 2 : loterie hebdomadaire et saisons mensuelles

### 🎟️ `/eco loterie acheter [tickets]` · `/eco loterie voir`

- Ticket à **prix fixe** (100 par défaut, 0 = loterie désactivée). Le premier ticket ouvre le tirage, prévu le
  **dimanche suivant à 20 h** (heure de Paris).
- La **cagnotte reçoit 90 %** du prix des tickets ; les 10 % restants sortent de l'économie (contre l'inflation).
- **Un seul gagnant**, tiré au sort parmi les tickets (plus de tickets = plus de chances). 100 tickets au plus par
  joueur et par tirage. `voir` affiche la cagnotte, les tickets vendus, le nombre de joueurs et tes chances.
- Tirage par le planificateur (rattrapé si le bot était arrêté), désignation du gagnant et versement dans **une
  seule transaction** (pas de double gain), annonce dans le salon choisi.
- Pas de report de cagnotte : un tirage n'existe que si quelqu'un a acheté un ticket, il a donc toujours un gagnant.

### 🏁 Saisons : `/top saison [gains|victoires]`

- **Gains du mois** (classement officiel) : calculés à partir du journal, **hors virements, ajustements d'admin et
  achats** (recevoir de l'argent d'un ami ne fait pas monter, dépenser en boutique ne fait pas descendre).
- **Victoires du mois** : compteur à part, remis à zéro chaque mois.
- **Le 1er du mois** (heure de Paris) : podium archivé, **bonus au top 3** (1 000 / 500 / 250 par défaut, réglables),
  **rôle « Champion du mois »** retiré à l'ancien et donné au nouveau, annonce. `/top saison` rappelle le podium
  de la saison précédente.
- **Les soldes ne sont jamais remis à zéro.** Clôture rejouable sans double bonus.
- Pas de « XP du mois » : les niveaux ne gardent pas l'historique de l'XP gagnée, à ajouter plus tard si besoin.

### ⚙️ `/config` → 🎟️ Loterie et saisons

Prix du ticket, bonus du podium (`1000/500/250`), rôle « Champion du mois », salon des annonces.

### 🔧 Technique

- `core/time.ts` : calculs de dates dans un fuseau (prochain dimanche 20 h, bornes d'un mois), changements d'heure
  compris.
- `LotteryService`, `SeasonService`, `EventSettingsStore` ; tâches `lottery:draw` (une par serveur) et
  `seasons:close` (mensuelle, clé fixe).
- **Migration 010** : `economy_events`, `lottery_draws`, `lottery_tickets`, `season_stats`, `season_results`.
- **Tests** : 283 au total, dont 12 nouveaux.

**Déploiement** : `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot`
(`deploy:commands` pour `/eco loterie` et `/top saison`). Pour le rôle de champion, le rôle du bot doit être au-dessus.

## Économie, lot 1 : rôles en boutique, rôle du plus riche, braquages

### 🎭 Rôles en boutique

- **`/admin boutique role cle nom prix role [duree] [description]`** : met un rôle en vente, **permanent** (durée vide)
  ou **temporaire** (`12h`, `7j`, `2sem`…). Le rôle doit être sous celui du bot (vérifié).
- **Achat** avec `/boutique acheter` comme un article ordinaire. Un rôle permanent ne s'achète qu'une fois ; racheter un
  rôle temporaire le **prolonge** à partir de l'échéance en cours.
- **Fiable** : si Discord refuse d'attribuer le rôle, l'achat est **annulé et remboursé**. À l'échéance, le
  planificateur retire le rôle (même après un redémarrage) ; une prolongation entre-temps repousse la tâche.
- `/boutique voir` indique le rôle et sa durée ; `/boutique inventaire` liste les rôles achetés et leur échéance.

### 👑 Rôle du plus riche

- Donné au **n° 1 de `/top fortune`** encore présent sur le serveur, vérifié **toutes les heures** ; retiré à l'ancien
  détenteur. Annonce facultative dans un salon quand il change de main.

### 🦹 `/eco braquer membre`

- **30 à 60 % de réussite** : 45 % à fortune égale, plus facile contre une cible plus riche que soi.
- Réussi : **5 à 15 % du solde de la cible**, plafonné (5 000 par défaut, réglable). Raté : **amende de 10 %** de son
  propre solde, **versée à la cible**.
- **Un braquage toutes les 4 h** ; une cible ne peut être visée qu'**une fois toutes les 12 h**. Il faut au moins 100
  pour tenter (de quoi payer l'amende) et la cible doit avoir au moins 100. Résultat public, la cible est mentionnée.
- **Désactivable**.

### ⚙️ `/config` → 👑 Rôles et braquage

Rôle du plus riche, salon d'annonce, braquages activés ou non, butin maximal.

### 🔧 Technique

- `RoleShop`, `HeistService`, `EconomyExtrasStore` ; tâches `shop:roleExpiry` et `economy:richest`.
- `core/duration.ts` : analyse des durées partagée (déplacée depuis la modération).
- **Migration 009** : `shop_items.role_id` / `role_duration_ms`, tables `role_grants`, `economy_extras`, `heists` ;
  journal économique reconstruit **une seule fois pour les trois lots** (types `heist`, `lottery`, `season_reward`,
  `dividend`).
- **Tests** : 271 au total, dont 16 nouveaux.

**Déploiement** : `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot`
(`deploy:commands` pour `/eco braquer` et `/admin boutique role`). Le bot doit avoir « Gérer les rôles » et un rôle
placé au-dessus des rôles vendus et du rôle du plus riche.

## Mot du jour, morpion, puissance 4, blackjack et roulette

Cinq nouvelles sous-commandes de `/jeu`.

### 📝 `/jeu mot-du-jour [mot]`

- Un mot de 5 lettres par jour, **le même pour tout le serveur** (différent d'un serveur à l'autre), 6 essais,
  couleurs à la Wordle (🟩 🟨 ⬛). Accents ignorés, changement de mot à minuit (heure de Paris).
- Les essais sont **privés** ; à la fin, le résultat est publié **sans les lettres** (comme le partage de Wordle).
- Une victoire verse la **récompense habituelle des parties** et compte dans les statistiques et succès (via
  `game:finished`). **Séries** de jours réussis (actuelle et record).
- ~350 mots à deviner (`games/wordle/words.ts`) ; les propositions ne sont pas limitées à cette liste.

### 🎮 `/jeu morpion` et `/jeu puissance4 adversaire [mise]`

- Défi à accepter (60 s), ordre de jeu tiré au sort, plateau à boutons, bouton « Abandonner ».
- 2 minutes par coup ; au-delà, le joueur perd.
- **Mise facultative** : chacun mise la même somme, le gagnant remporte tout, un match nul rembourse.

### 🃏 `/jeu blackjack mise`

- Contre la banque, sabot de 6 jeux mélangé à chaque partie. Tirer, rester, **doubler** (sur les deux premières
  cartes). Le croupier tire jusqu'à 17 et reste sur un 17 souple. Blackjack payé **3 pour 2**, égalité remboursée.
- Sans action pendant 2 minutes, le joueur reste automatiquement.

### 🎡 `/jeu roulette pari mise [numero]`

- Roulette européenne (un zéro), **une table par salon** : le premier pari l'ouvre, les autres ont **30 s** pour
  miser, puis la bille est lancée pour tous. Rouge/noir, pair/impair, manque/passe (×2), douzaines (×3), numéro
  plein (×36). Jusqu'à 5 paris par joueur et par tour.

### 🔒 Mises en dépôt

- Les mises de ces parties sont **prélevées dès le début et gardées en base** (tables `wagers` et `wager_entries`)
  jusqu'au règlement. Si le bot redémarre en pleine partie, **elles sont remboursées au démarrage** (« remboursement
  … (partie interrompue) » dans l'historique).
- Mise maximale du serveur respectée ; « 0 » dans `/config` désactive blackjack, roulette et les mises des duels
  (morpion et puissance 4 restent jouables sans mise).

### 🔧 Technique

- Règles pures et testées : `economy/gambling/{blackjack,roulette,boards}.ts`, `games/wordle/wordle.ts`.
- `WagerService` (dépôt des mises), `assertStake` partagé avec les jeux d'argent existants.
- **Migration 008** : `wagers`, `wager_entries`, `word_games`.
- **Tests** : 255 au total, dont 29 nouveaux (rendement de la roulette 36/37, règles du blackjack, alignements,
  remboursement des parties interrompues, couleurs des lettres doubles, séries).

**Déploiement** : `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot`
(`deploy:commands` pour les nouvelles sous-commandes de `/jeu`).

## Anniversaires

- **`/anniversaire definir|supprimer|voir|prochains`** : chaque membre enregistre sa date, sans l'année. Les réponses
  personnelles sont privées, `prochains` liste les 10 prochains anniversaires du serveur.
- **Le jour J**, à l'heure choisie dans le fuseau du serveur (Europe/Paris par défaut) :
  - une annonce dans le salon choisi, qui regroupe tous les anniversaires du jour ;
  - un rôle porté pour la journée, retiré le lendemain ;
  - un bonus en monnaie, versé par l'économie (nouveau type d'opération « 🎂 Anniversaire » dans l'historique).
- **Une fois par an au plus** : changer sa date après avoir été fêté ne redonne ni bonus ni annonce.
- **29 février** : fêté le 28 les années non bissextiles.
- **Fiable** : tâche planifiée toutes les heures (premier usage du planificateur). Un arrêt du bot est rattrapé au
  redémarrage, sans double annonce.
- **`/config` → 🎂 Anniversaires** : salon, rôle du jour (vérifié : le bot doit pouvoir l'attribuer), bonus, heure,
  fuseau. Rien n'est fêté tant qu'aucun des trois (salon, rôle, bonus) n'est réglé.
- **Technique** : module `birthdays`, événement `birthday:celebrated`, tâche `birthdays:tick`. Migration 007 :
  tables `birthdays`, `birthday_settings`, `birthday_celebrations` ; journal économique reconstruit pour le type
  `birthday`, avec un index unique (un bonus par membre et par an).
- **Tests** : 226 au total, dont 16 nouveaux.

**Déploiement** : `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot`
(`deploy:commands` pour `/anniversaire`). Si un rôle du jour est choisi, le rôle du bot doit être au-dessus.

## Logs de messages, notes de modération et automod

### 🤖 Automod (complète l'AutoMod de Discord)

- **Ce que le bot ne refait pas** : mots interdits, invitations et mentions de masse. L'AutoMod intégré à Discord
  les bloque *avant* publication, ce que le bot ne peut pas faire. À régler dans Paramètres du serveur → AutoMod.
- **Flood** : plus de N messages en S secondes (ex. `6/5`), tous salons confondus.
- **Messages répétés** : N messages identiques en une minute (casse et espaces ignorés).
- **Sanction** : la rafale est supprimée, le membre reçoit un avertissement (MP, salon de logs, **paliers de
  sanctions**) et, en option, une exclusion immédiate (5 min par défaut). Si l'avertissement déclenche un palier,
  pas d'exclusion en plus. Au plus un avertissement automatique par minute et par membre.
- **Lien avec l'AutoMod de Discord** (option) : chaque infraction vaut un avertissement, avec le nom de la règle.
  Les actions multiples d'une même infraction (blocage + alerte + exclusion) ne comptent qu'une fois.
- **Exemptés** : propriétaire et membres qui peuvent gérer les messages du salon.
- **Désactivé par défaut** : `/config` → 🤖 Automod.

### 📜 Logs de messages

- Messages **modifiés** (avant/après, lien vers le message) et **supprimés** (contenu, pièces jointes), dans un
  salon distinct des logs de sanctions : `/config` → Modération → « Salon des logs de messages ».
- **Suppressions en masse** (`/purge`, automod…) : un seul message, avec la transcription en fichier `.txt`.
- Le contenu n'est connu que pour les messages en cache : envoyés depuis le démarrage du bot, 200 derniers par
  salon. Rien n'est stocké en base. Bots, webhooks et le salon de logs lui-même sont ignorés.
- L'auteur de la suppression n'est pas indiqué : Discord ne le fournit pas dans l'événement.

### 📝 Notes de modération

- `/note ajouter|voir|supprimer` (« Exclure temporairement des membres ») : notes internes, jamais envoyées au membre,
  sans effet sur les avertissements ni les paliers. Suppression par l'auteur ou par « Gérer le serveur ».
- `/sanctions voir` indique combien de notes existent.

### 🔧 Technique

- **Intent privilégié Message Content** (logs, messages répétés) et AutoModerationExecution.
- **`BotModule.partials`** : la modération demande `Partials.Message` (suppressions de messages hors cache).
- Avertissement et exclusion automatiques partagés (`discord/autoWarn.ts`), détection sans discord.js
  (`automod/detector.ts`).
- **Migration 006** : `guild_settings.message_log_channel_id`, tables `moderation_notes` et `automod_settings`.
- **Tests** : 210 au total, dont 17 nouveaux.

### 🚀 Déploiement

1. **Avant tout** : Developer Portal → Bot → Privileged Gateway Intents → activer **Message Content Intent**.
   Sans ça, le bot ne démarre plus (« Used disallowed intents »).
2. `git pull && npm ci && npm run build && npm run deploy:commands && pm2 restart bordelbot` (`deploy:commands`
   pour `/note`).
3. Pour lier l'AutoMod de Discord : donner « Gérer le serveur » au bot.

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
