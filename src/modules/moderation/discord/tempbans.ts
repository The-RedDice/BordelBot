import { RESTJSONErrorCodes, type Client } from 'discord.js';
import { isApiError, postModLog, type Deps } from './helpers.js';

/** Fréquence de vérification des bans arrivés à échéance. */
export const TEMPBAN_SWEEP_MS = 60_000;

/**
 * Lève les bans temporaires échus. Les échéances sont en base : un ban dont la
 * fin tombe pendant un arrêt du bot est levé au redémarrage.
 */
export class TempbanSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Cas en échec déjà signalés : on réessaie à chaque passage sans inonder les logs. */
  private readonly reported = new Set<number>();

  constructor(
    private readonly client: Client<true>,
    private readonly deps: Deps,
  ) {}

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), TEMPBAN_SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Renvoie le nombre de bans levés. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let lifted = 0;
    try {
      const service = this.deps.getService();
      for (const ban of service.dueTempbans()) {
        const guild = this.client.guilds.cache.get(ban.guildId);
        if (!guild) {
          // Le bot a quitté le serveur : il ne pourra plus jamais lever ce ban.
          service.resolveCase(ban.id);
          continue;
        }
        const reason = `Fin du bannissement temporaire (cas #${ban.caseNumber})`;
        try {
          await guild.bans.remove(ban.targetId, `${this.client.user.tag} : ${reason}`);
        } catch (err) {
          if (isApiError(err, RESTJSONErrorCodes.UnknownBan)) {
            service.resolveCase(ban.id); // déjà levé à la main depuis Discord
            continue;
          }
          if (!this.reported.has(ban.id)) {
            this.reported.add(ban.id);
            this.deps.logger().warn(`Impossible de lever le ban temporaire #${ban.caseNumber} sur ${guild.id}`, err);
          }
          continue;
        }
        service.resolveCase(ban.id);
        this.reported.delete(ban.id);
        const c = service.createCase({
          guildId: guild.id,
          action: 'unban',
          targetId: ban.targetId,
          moderatorId: this.client.user.id,
          reason,
          metadata: { auto: true, banCase: ban.caseNumber },
        });
        await postModLog(this.deps, guild, c);
        lifted++;
      }
    } catch (err) {
      this.deps.logger().error('Échec de la levée des bans temporaires', err);
    } finally {
      this.running = false;
    }
    return lifted;
  }
}
