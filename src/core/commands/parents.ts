import { PermissionFlagsBits } from 'discord.js';

export interface ParentCommandDef {
  readonly description: string;
  /** Permission requise par défaut (modifiable par les admins dans Intégrations). */
  readonly permissions?: bigint;
}

/**
 * Commandes « parentes » : chacune regroupe des sous-commandes fournies par un ou
 * plusieurs modules (`BotModule.subcommands`). Comme `events.ts`, c'est un contrat
 * partagé : `/jeu` réunit La Taupe (module jeux) et les jeux d'argent (module
 * économie) sans que ces modules se connaissent.
 *
 * Les sous-commandes d'une même parente partagent sa permission par défaut :
 * on ne regroupe que des commandes destinées au même public.
 */
export const PARENT_COMMANDS = {
  jeu: { description: 'Mini-jeux : Taupe, mot du jour, morpion, puissance 4, blackjack, roulette, duels…' },
  eco: { description: 'Ton argent : solde, récompense quotidienne, virements, historique' },
  boutique: { description: 'Boutique du serveur et inventaires' },
  profil: { description: 'Profil, succès et niveau d’un membre' },
  top: { description: 'Classements du serveur' },
  admin: { description: 'Administration : soldes, boutique, XP, export', permissions: PermissionFlagsBits.ManageGuild },
  sanctions: { description: 'Historique et révocation des sanctions', permissions: PermissionFlagsBits.ModerateMembers },
  salon: { description: 'Verrouillage et mode lent des salons', permissions: PermissionFlagsBits.ManageChannels },
} as const satisfies Record<string, ParentCommandDef>;

export type ParentCommandName = keyof typeof PARENT_COMMANDS;
