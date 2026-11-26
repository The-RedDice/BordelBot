/**
 * Catalogue des tâches planifiées : type de tâche → contenu (`payload`). Comme
 * `BotEvents`, c'est le contrat partagé : chaque module ajoute ici ses types de
 * tâches, puis déclare leur gestionnaire avec `ctx.scheduler.register` dans son `init`.
 *
 * Le contenu est stocké en JSON : uniquement des données sérialisables
 * (chaînes, nombres, booléens, tableaux, objets simples ; pas de Date ni de Map).
 */
export interface BotJobs {
  /** Toutes les heures : annonces d'anniversaire dues et retrait des rôles de la veille. */
  'birthdays:tick': Record<string, never>;
  /** Fin d'un rôle acheté en boutique (replanifiée si le rôle a été prolongé). */
  'shop:roleExpiry': { readonly guildId: string; readonly userId: string; readonly roleId: string };
  /** Toutes les heures : le rôle du plus riche passe au n° 1 du classement. */
  'economy:richest': Record<string, never>;
  /** Tirage de la loterie d'un serveur (dimanche 20 h). */
  'lottery:draw': { readonly guildId: string; readonly drawId: number };
  /** Le 1er du mois : clôture de la saison précédente (podium, bonus, rôle de champion). */
  'seasons:close': Record<string, never>;
}
