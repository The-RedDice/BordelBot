/** Ce qu'il faut savoir d'un état vocal pour attribuer de l'XP (sans discord.js). */
export interface VoicePresence {
  readonly userId: string;
  readonly channelId: string | null;
  readonly bot: boolean;
  /** Sourdine casque (choisie ou imposée) : le membre n'écoute pas. */
  readonly deaf: boolean;
}

/**
 * Membres qui gagnent de l'XP vocal : dans un salon autre que celui d'AFK, sans
 * sourdine casque, et avec au moins un autre membre actif (on ne farme pas seul).
 */
export function activeVoiceUsers(states: readonly VoicePresence[], afkChannelId: string | null): string[] {
  const byChannel = new Map<string, string[]>();
  for (const s of states) {
    if (!s.channelId || s.channelId === afkChannelId || s.bot || s.deaf) continue;
    byChannel.set(s.channelId, [...(byChannel.get(s.channelId) ?? []), s.userId]);
  }
  return [...byChannel.values()].filter((users) => users.length >= 2).flat();
}
