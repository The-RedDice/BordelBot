# Journal des modifications

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
