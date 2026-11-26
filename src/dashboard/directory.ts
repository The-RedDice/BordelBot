import type { Client, Guild } from 'discord.js';
import type { Directory, GuildRef, UserRef } from './data.js';

/** Durée pendant laquelle une appartenance ou un pseudo sont tenus pour vrais. */
export const DIRECTORY_TTL_MS = 5 * 60_000;

/** Avatar par défaut de Discord (nouveau système de pseudos). */
export function defaultAvatar(userId: string): string {
  const index = Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function avatarUrl(userId: string, hash: string | null): string {
  return hash ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64` : defaultAvatar(userId);
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

/**
 * Accès à Discord pour le tableau de bord, par le client du bot (aucun jeton du
 * visiteur n'est gardé). Les réponses sont mises en cache quelques minutes pour
 * ne pas solliciter l'API à chaque rafraîchissement de page.
 */
export class DiscordDirectory implements Directory {
  private readonly members = new Map<string, Cached<boolean>>();
  private readonly names = new Map<string, Cached<UserRef>>();

  constructor(
    private readonly client: Client<true>,
    private readonly clock: () => number = Date.now,
  ) {}

  guild(guildId: string): GuildRef | null {
    const g = this.client.guilds.cache.get(guildId);
    return g ? toRef(g) : null;
  }

  async isMember(guildId: string, userId: string): Promise<boolean> {
    const key = `${guildId}:${userId}`;
    const hit = this.members.get(key);
    if (hit && this.clock() - hit.at < DIRECTORY_TTL_MS) return hit.value;
    const guild = this.client.guilds.cache.get(guildId);
    const member = guild ? (guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null))) : null;
    this.members.set(key, { value: member !== null, at: this.clock() });
    return member !== null;
  }

  async guildsOf(userId: string): Promise<GuildRef[]> {
    const guilds = [...this.client.guilds.cache.values()];
    const checks = await Promise.all(guilds.map(async (g) => ((await this.isMember(g.id, userId)) ? toRef(g) : null)));
    return checks.filter((g): g is GuildRef => g !== null).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async users(guildId: string, userIds: readonly string[]): Promise<Record<string, UserRef>> {
    const guild = this.client.guilds.cache.get(guildId);
    const out: Record<string, UserRef> = {};
    await Promise.all(
      userIds.map(async (id) => {
        const key = `${guildId}:${id}`;
        const hit = this.names.get(key);
        if (hit && this.clock() - hit.at < DIRECTORY_TTL_MS) {
          out[id] = hit.value;
          return;
        }
        const member = guild ? (guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null))) : null;
        let ref: UserRef;
        if (member) {
          ref = { name: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64, extension: 'png' }) };
        } else {
          const user = await this.client.users.fetch(id).catch(() => null);
          ref = user
            ? { name: `${user.displayName} (parti)`, avatarUrl: user.displayAvatarURL({ size: 64, extension: 'png' }) }
            : { name: 'Membre inconnu', avatarUrl: defaultAvatar(id) };
        }
        this.names.set(key, { value: ref, at: this.clock() });
        out[id] = ref;
      }),
    );
    return out;
  }
}

function toRef(g: Guild): GuildRef {
  return { id: g.id, name: g.name, iconUrl: g.iconURL({ size: 64, extension: 'png' }), memberCount: g.memberCount };
}
