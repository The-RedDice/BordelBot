import { Events, type Client, type Message } from 'discord.js';
import { activeVoiceUsers } from '../voice.js';
import { applyLevelChange, type LevelDeps } from './effects.js';

/** Fréquence de l'XP vocal. */
export const VOICE_TICK_MS = 60_000;

/**
 * Écoute l'activité : chaque message (intent GuildMessages, sans lire le contenu)
 * et, toutes les minutes, les salons vocaux (intent GuildVoiceStates).
 */
export class LevelTracker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: Client<true>,
    private readonly deps: LevelDeps,
  ) {}

  start(): void {
    this.client.on(Events.MessageCreate, this.onMessage);
    this.timer = setInterval(() => void this.voiceTick(), VOICE_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    this.client.off(Events.MessageCreate, this.onMessage);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private readonly onMessage = async (message: Message): Promise<void> => {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
    try {
      const change = this.deps.getService().onMessage(message.guildId, message.author.id);
      if (change) {
        await applyLevelChange(this.deps, message.guild, change, {
          member: message.member,
          channel: message.channel.isSendable() ? message.channel : null,
        });
      }
    } catch (err) {
      this.deps.logger().error(`Échec du gain d'XP pour le message ${message.id}`, err);
    }
  };

  private async voiceTick(): Promise<void> {
    const service = this.deps.getService();
    for (const guild of this.client.guilds.cache.values()) {
      try {
        if (guild.voiceStates.cache.size < 2 || service.getSettings(guild.id).voiceXpPerMinute <= 0) continue;
        const states = [...guild.voiceStates.cache.values()].map((s) => ({
          userId: s.id,
          channelId: s.channelId,
          bot: s.member?.user.bot ?? false,
          deaf: s.deaf ?? false,
        }));
        const users = activeVoiceUsers(states, guild.afkChannelId);
        for (const change of service.onVoice(guild.id, users, VOICE_TICK_MS / 1000)) {
          // Pas de salon textuel associé : annonce seulement si un salon dédié est configuré.
          await applyLevelChange(this.deps, guild, change, { member: guild.voiceStates.cache.get(change.userId)?.member ?? null });
        }
      } catch (err) {
        this.deps.logger().error(`Échec de l'XP vocal sur ${guild.id}`, err);
      }
    }
  }
}
