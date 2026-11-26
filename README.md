# BordelBot

Bot Discord modulaire en TypeScript (discord.js v14, SQLite) : jeux, économie et modération.

## Fonctionnalités

Les commandes sont regroupées par thème : 18 commandes au lieu d'une trentaine.

| Commande | Sous-commandes |
|---|---|
| `/jeu` | `taupe` · `pile-ou-face` · `machine-a-sous` · `duel` |
| `/eco` | `solde` · `daily` · `virer` · `historique` |
| `/boutique` | `voir` · `acheter` · `inventaire` |
| `/bourse` | `cours` · `graphique` · `acheter` · `vendre` · `portefeuille` |
| `/profil` | `general` · `succes` · `niveau` |
| `/top` | `fortune` · `niveaux` · `victoires` · `daily` · `bourse` |
| **Modération** | `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` |
| `/sanctions` | `voir` · `revoquer` |
| `/salon` | `verrouiller` · `deverrouiller` · `mode-lent` |
| `/admin` | `solde …` · `boutique …` · `xp …` · `export` (« Gérer le serveur ») |
| `/config` | tableau de bord : économie, modération, niveaux, rôles de niveau |
| `/info` | version, latence, uptime |

- **La Taupe** : tous les agents connaissent un mot secret sauf la taupe, qui doit se fondre dans la masse. Les gagnants
  des parties sont crédités automatiquement (avec un bonus pour le camp minoritaire).
- **Niveaux** : de l'XP en discutant (15 à 25 XP, une fois par minute au plus) et en vocal (5 XP par minute, à deux
  minimum, hors AFK et sourdine casque). Montées de niveau annoncées dans le salon du message, dans un salon dédié ou
  pas du tout. **Rôles de niveau** attribués automatiquement, cumulés ou non. Tout se règle dans `/config`.
- **Succès** : 11 succès (victoires, séries de daily, jackpot, duels, bourse…) versent une récompense au déblocage.
- **Jeux d'argent** : pile ou face (quitte ou double), machine à sous (≈ 95 % redistribués), duels entre membres.
  Mise maximale réglable dans `/config` (0 = désactivés).
- **Bourse** : 5 actifs fictifs dont le cours évolue toutes les 5 minutes (marche aléatoire avec rappel vers un prix
  de référence et actualités qui font bondir ou chuter un cours). Cours communs à tous les serveurs, portefeuilles
  propres à chaque serveur, 1 % de frais par ordre. `/bourse graphique` trace la courbe en image (1 h à 30 jours).
- **Sanctions automatiques** : par exemple `3 = timeout 1h`, `5 = kick`, `7 = ban 7j` ; appliquées par le bot dès qu'un
  membre atteint ce nombre d'avertissements actifs.
- **Bans temporaires** : `/ban duree:3j` ; le ban est levé automatiquement, même après un redémarrage du bot.
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
temporairement, Expulser et Bannir des membres. Aucun intent privilégié n'est requis (les niveaux utilisent
GuildMessages et GuildVoiceStates sans lire le contenu des messages).
Pour modérer un membre ou lui donner un rôle de niveau, le rôle du bot doit être placé au-dessus.

Graphiques de la bourse : ils sont rendus en PNG sur le serveur. Sous Linux, installer une police pour les
libellés des axes : `sudo apt install fonts-dejavu-core` (sans police, la courbe s'affiche quand même, sans texte).

Logs : `LOG_FORMAT=json` écrit une ligne JSON par événement (filtrable avec `jq`), `text` (défaut) reste lisible.

## Architecture

```
src/
├─ core/                 client, EventBus typé, routeur d'interactions, SQLite + migrations, /config
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
| `npm run migrate` | Applique les migrations sans lancer le bot |
| `npm run deploy:commands` | Enregistre les slash commands |
