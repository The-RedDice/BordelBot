# BordelBot

Bot Discord modulaire en TypeScript (discord.js v14, SQLite) : jeux, économie et modération.

## Fonctionnalités

| Module | Commandes |
|---|---|
| **Jeux** | `/taupe` — La Taupe : tous les agents connaissent un mot secret sauf la taupe, qui doit se fondre dans la masse. |
| **Économie** | `/solde` `/daily` `/virer` `/classement` `/historique` `/boutique` `/acheter` `/inventaire` `/profil` `/succes` `/eco-admin` |
| **Jeux d'argent** | `/pile-ou-face` `/machine-a-sous` `/duel` |
| **Bourse** | `/bourse cours` `/bourse graphique` `/bourse acheter` `/bourse vendre` `/bourse portefeuille` |
| **Modération** | `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/sanctions` `/delwarn` `/lock` `/unlock` `/slowmode` |
| **Réglages** | `/config` — tableau de bord : économie, salon de logs, expiration des avertissements, sanctions automatiques |

- Les gagnants des parties sont crédités automatiquement (avec un bonus pour le camp minoritaire).
- **Succès** : 11 succès (victoires, séries de daily, jackpot, duels, bourse…) versent une récompense au déblocage.
- **Jeux d'argent** : pile ou face (quitte ou double), machine à sous (≈ 95 % redistribués), duels entre membres.
  Mise maximale réglable dans `/config` (0 = désactivés).
- **Bourse** : 5 actifs fictifs dont le cours évolue toutes les 5 minutes (marche aléatoire avec rappel vers un prix
  de référence et actualités qui font bondir ou chuter un cours). Cours communs à tous les serveurs, portefeuilles
  propres à chaque serveur, 1 % de frais par ordre. `/bourse graphique` trace la courbe en image (1 h à 30 jours).
- **Sanctions automatiques** : par exemple `3 = timeout 1h`, `5 = kick`, `7 = ban 7j` ; appliquées par le bot dès qu'un
  membre atteint ce nombre d'avertissements actifs.
- **Bans temporaires** : `/ban duree:3j` ; le ban est levé automatiquement, même après un redémarrage du bot.
- `/eco-admin export` fournit le journal des opérations en CSV.

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
temporairement, Expulser et Bannir des membres. Aucun intent privilégié n'est requis.
Pour modérer un membre, le rôle du bot doit être placé au-dessus du sien.

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
   ├─ economy/           EconomyService (transactions SQLite, journal) + commandes
   │  ├─ gambling/       pile ou face, machine à sous, duels
   │  ├─ market/         bourse : modèle de prix, ordres, graphique (resvg)
   │  └─ progress/       statistiques et succès
   └─ moderation/        ModerationService (journal, paliers, bans temporaires) + commandes
```

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
