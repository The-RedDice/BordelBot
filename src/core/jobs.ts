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
}
