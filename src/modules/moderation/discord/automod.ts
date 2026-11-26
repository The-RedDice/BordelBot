import {
  AutoModerationRuleTriggerType,
  Events,
  PermissionFlagsBits,
  type AutoModerationActionExecution,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
} from 'discord.js';
import { CooldownLimiter, SpamDetector, type SpamInfraction } from '../automod/detector.js';
import type { AutomodSettings } from '../automod/settings.js';
import { autoTimeout, autoWarn } from './autoWarn.js';
import { botMember, type Deps } from './helpers.js';

/** Au plus un avertissement automatique par membre sur cette durée. */
export const AUTOMOD_WARN_COOLDOWN_MS = 60_000;

const SPAM_LABELS: Record<SpamInfraction['kind'], string> = {
  flood: 'flood',
  duplicate: 'messages répétés',
};

const TRIGGER_LABELS: Record<AutoModerationRuleTriggerType, string> = {
  [AutoModerationRuleTriggerType.Keyword]: 'mot interdit',
  [AutoModerationRuleTriggerType.Spam]: 'contenu suspect',
  [AutoModerationRuleTriggerType.KeywordPreset]: 'liste de mots prédéfinie',
  [AutoModerationRuleTriggerType.MentionSpam]: 'mentions de masse',
  [AutoModerationRuleTriggerType.MemberProfile]: 'profil du membre',
};

/**
 * Automod du bot, en complément de l'AutoMod intégré à Discord :
 * - Discord bloque déjà, avant publication, les mots interdits, les invitations
 *   (règle de mots-clés) et les mentions de masse ; le bot ne le refait pas.
 * - Le bot détecte ce que Discord ne sait pas faire : le flood (trop de messages
 *   en peu de temps) et les messages répétés. Il supprime la rafale, avertit le
 *   membre (paliers de sanctions) et peut l'exclure quelques minutes.
 * - Option : chaque infraction à l'AutoMod de Discord vaut un avertissement, pour
 *   que les paliers tiennent compte des deux.
 * Les membres qui peuvent gérer les messages du salon ne sont jamais concernés.
 */
export class AutomodListener {
  private readonly detector = new SpamDetector();
  private readonly warns = new CooldownLimiter(AUTOMOD_WARN_COOLDOWN_MS);

  constructor(
    private readonly client: Client<true>,
    private readonly deps: Deps,
  ) {}

  start(): void {
    this.client.on(Events.MessageCreate, this.onMessage);
    this.client.on(Events.AutoModerationActionExecution, this.onDiscordAutomod);
  }

  stop(): void {
    this.client.off(Events.MessageCreate, this.onMessage);
    this.client.off(Events.AutoModerationActionExecution, this.onDiscordAutomod);
  }

  private readonly onMessage = async (message: Message): Promise<void> => {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system) return;
    try {
      const settings = this.deps.getAutomod().get(message.guildId);
      if (settings.floodMessages <= 0 && settings.duplicateCount <= 0) return;
      const member = message.member;
      if (!member || member.id === message.guild.ownerId) return;
      if (member.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) return;

      const infraction = this.detector.record(
        {
          guildId: message.guildId,
          userId: member.id,
          channelId: message.channelId,
          messageId: message.id,
          content: message.content,
          at: message.createdTimestamp,
        },
        settings,
      );
      if (infraction) await this.punish(message.guild, member, infraction, settings);
    } catch (err) {
      this.deps.logger().error(`Automod : échec du traitement du message ${message.id}`, err);
    }
  };

  private async punish(guild: Guild, member: GuildMember, infraction: SpamInfraction, settings: AutomodSettings) {
    await this.deleteMessages(guild, infraction);
    if (!this.warns.take(`${guild.id}:${member.id}`, Date.now())) return;

    const me = await botMember(guild);
    const reason = `Automod : ${SPAM_LABELS[infraction.kind]} (${infraction.detail})`;
    const metadata = { automod: infraction.kind };
    const { thresholdReached } = await autoWarn(this.deps, guild, me, member, reason, metadata);
    // Un palier atteint a déjà sa propre sanction : pas d'exclusion en plus.
    if (!thresholdReached && settings.timeoutMs > 0) {
      await autoTimeout(this.deps, guild, me, member, settings.timeoutMs, reason, metadata);
    }
  }

  /** Supprime la rafale, salon par salon. Les échecs (permission, message déjà supprimé) sont ignorés. */
  private async deleteMessages(guild: Guild, infraction: SpamInfraction): Promise<void> {
    const byChannel = new Map<string, string[]>();
    for (const m of infraction.messages) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m.messageId]);
    for (const [channelId, ids] of byChannel) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isTextBased()) continue;
      try {
        if (ids.length === 1) await channel.messages.delete(ids[0]!);
        else await channel.bulkDelete(ids, true);
      } catch (err) {
        this.deps.logger().warn(`Automod : suppression impossible dans ${channelId} sur ${guild.id}`, err);
      }
    }
  }

  private readonly onDiscordAutomod = async (execution: AutoModerationActionExecution): Promise<void> => {
    const { guild } = execution;
    try {
      if (!this.deps.getAutomod().get(guild.id).discordWarns) return;
      // Une même infraction déclenche une exécution par action (blocage, alerte, exclusion) :
      // le délai entre deux avertissements les regroupe en un seul.
      if (!this.warns.take(`${guild.id}:${execution.userId}`, Date.now())) return;

      const member = execution.member ?? (await guild.members.fetch(execution.userId).catch(() => null));
      if (!member || member.user.bot) return;
      const rule = execution.autoModerationRule ?? (await guild.autoModerationRules.fetch(execution.ruleId).catch(() => null));
      const what = rule ? `règle « ${rule.name} »` : TRIGGER_LABELS[execution.ruleTriggerType];
      const keyword = execution.matchedKeyword ? ` (${execution.matchedKeyword})` : '';
      const me = await botMember(guild);
      await autoWarn(this.deps, guild, me, member, `AutoMod Discord : ${what}${keyword}`, {
        automod: 'discord',
        ruleId: execution.ruleId,
        trigger: execution.ruleTriggerType,
      });
    } catch (err) {
      this.deps.logger().error(`Automod : échec du traitement d'une action AutoMod Discord sur ${guild.id}`, err);
    }
  };
}
