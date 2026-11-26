# BordelBot

Bot Discord modulaire en TypeScript (discord.js v14, SQLite) : jeux, économie et modération.

## Fonctionnalités

| Module | Commandes |
|---|---|
| **Jeux** | `/taupe` — La Taupe : tous les agents connaissent un mot secret sauf la taupe, qui doit se fondre dans la masse. |
| **Économie** | `/solde` `/daily` `/virer` `/classement` `/historique` `/boutique` `/acheter` `/inventaire` `/eco-admin` |
| **Modération** | `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/sanctions` `/delwarn` `/modlogs` |

Les gagnants des parties sont crédités automatiquement (avec un bonus pour le camp minoritaire).

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

Permissions du bot à l'invitation : Voir les salons, Envoyer des messages, Intégrer des liens, Lire l'historique,
Gérer les messages, Exclure temporairement, Expulser et Bannir des membres. Aucun intent privilégié n'est requis.
Pour modérer un membre, le rôle du bot doit être placé au-dessus du sien.

## Architecture

```
src/
├─ core/                 client, EventBus typé, routeur d'interactions, SQLite + migrations
└─ modules/
   ├─ games/
   │  ├─ engine/         FSM génériques et sessions, sans discord.js
   │  ├─ mole/           règles de La Taupe (fonctions pures) + adaptateur Discord
   │  └─ GameService.ts  une partie par salon, persistance, émission de game:finished
   ├─ economy/           EconomyService (transactions SQLite, journal) + commandes
   └─ moderation/        ModerationService (journal des sanctions) + commandes
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
