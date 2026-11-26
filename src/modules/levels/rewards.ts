/** Un rôle attribué en atteignant un niveau. */
export interface RoleReward {
  readonly level: number;
  readonly roleId: string;
}

export const MAX_ROLE_REWARDS = 25;
export const MAX_REWARD_LEVEL = 500;

export interface RoleRef {
  readonly id: string;
  readonly name: string;
}

export type ParseResult = { ok: true; value: RoleReward[] } | { ok: false; message: string };

/**
 * Lit les règles de la modale `/config`, une par ligne : `5 = @Habitué`,
 * `10 = <@&123…>` ou `20 = 123…`. Le rôle est cherché par mention, ID ou nom
 * exact (sans tenir compte de la casse, « @ » facultatif).
 */
export function parseRoleRewards(text: string, roles: readonly RoleRef[]): ParseResult {
  const rewards: RoleReward[] = [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = /^(\d{1,4})\s*[=:]\s*(.+)$/.exec(line);
    if (!m) return { ok: false, message: `Ligne invalide : « ${line} ». Format attendu : \`5 = @Rôle\`.` };
    const level = Number(m[1]);
    if (level < 1 || level > MAX_REWARD_LEVEL) {
      return { ok: false, message: `Niveau invalide : ${level} (de 1 à ${MAX_REWARD_LEVEL}).` };
    }
    if (rewards.some((r) => r.level === level)) return { ok: false, message: `Le niveau ${level} a plusieurs rôles : un seul par niveau.` };

    const ref = (m[2] ?? '').trim();
    const id = /^<@&(\d+)>$/.exec(ref)?.[1] ?? (/^\d{15,22}$/.test(ref) ? ref : null);
    let role: RoleRef | undefined;
    if (id) {
      role = roles.find((r) => r.id === id);
    } else {
      const name = ref.replace(/^@/, '').trim().toLowerCase();
      const matches = roles.filter((r) => r.name.toLowerCase() === name);
      if (matches.length > 1) return { ok: false, message: `Plusieurs rôles s’appellent « ${ref} » : utilise son ID.` };
      role = matches[0];
    }
    if (!role) return { ok: false, message: `Rôle introuvable : « ${ref} ».` };
    if (rewards.some((r) => r.roleId === role.id)) return { ok: false, message: `Le rôle « ${role.name} » est attribué à deux niveaux.` };
    rewards.push({ level, roleId: role.id });
  }
  if (rewards.length > MAX_ROLE_REWARDS) return { ok: false, message: `${MAX_ROLE_REWARDS} règles au maximum.` };
  return { ok: true, value: rewards.sort((a, b) => a.level - b.level) };
}

/** Inverse de `parseRoleRewards` : pré-remplit la modale (`@Nom`, ou l'ID d'un rôle supprimé). */
export function formatRoleRewards(rewards: readonly RoleReward[], roles: readonly RoleRef[]): string {
  return rewards
    .map((r) => {
      const role = roles.find((x) => x.id === r.roleId);
      return `${r.level} = ${role ? `@${role.name}` : r.roleId}`;
    })
    .join('\n');
}

/**
 * Rôles de récompense qu'un membre de ce niveau doit avoir et ceux qu'il ne doit pas avoir.
 * `stack` : il garde les rôles des paliers précédents ; sinon seul le plus haut palier atteint reste.
 */
export function rewardRoles(rewards: readonly RoleReward[], level: number, stack: boolean): { keep: string[]; drop: string[] } {
  const reached = rewards.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  const keep = stack ? reached.map((r) => r.roleId) : reached.slice(-1).map((r) => r.roleId);
  const drop = rewards.map((r) => r.roleId).filter((id) => !keep.includes(id));
  return { keep, drop };
}
