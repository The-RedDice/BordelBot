/** Règles de détection d'un serveur (sous-ensemble des réglages automod). */
export interface SpamRules {
  /** Plus de `floodMessages` messages en `floodSeconds` secondes (0 = désactivé). */
  readonly floodMessages: number;
  readonly floodSeconds: number;
  /** `duplicateCount` messages identiques dans `DUPLICATE_WINDOW_MS` (0 = désactivé). */
  readonly duplicateCount: number;
}

export interface TrackedMessage {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly messageId: string;
  /** Contenu brut ; vide pour un message sans texte (image seule, sticker…). */
  readonly content: string;
  readonly at: number;
}

export type SpamKind = 'flood' | 'duplicate';

export interface SpamInfraction {
  readonly kind: SpamKind;
  /** Messages en cause, à supprimer (le message courant inclus). */
  readonly messages: readonly { readonly channelId: string; readonly messageId: string }[];
  /** Texte lisible pour la raison de l'avertissement. */
  readonly detail: string;
}

/** Fenêtre de détection des messages répétés. */
export const DUPLICATE_WINDOW_MS = 60_000;
/** Historique gardé par membre : de quoi couvrir la plus grande fenêtre possible. */
const HISTORY_MS = Math.max(DUPLICATE_WINDOW_MS, 60_000);
const HISTORY_MAX = 60;

/** Deux messages sont « identiques » à la casse et aux espaces près. */
export function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Détecte le flood et les messages répétés à partir des derniers messages de
 * chaque membre, gardés en mémoire (rien n'est écrit en base). Après une
 * infraction, l'historique du membre repart de zéro : il faut une nouvelle
 * rafale complète pour en déclencher une autre.
 */
export class SpamDetector {
  private readonly history = new Map<string, TrackedMessage[]>();
  private lastSweep = 0;

  record(message: TrackedMessage, rules: SpamRules): SpamInfraction | null {
    if (rules.floodMessages <= 0 && rules.duplicateCount <= 0) return null;
    this.sweep(message.at);

    const key = `${message.guildId}:${message.userId}`;
    const list = (this.history.get(key) ?? []).filter((m) => message.at - m.at < HISTORY_MS);
    list.push(message);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
    this.history.set(key, list);

    const infraction = this.flood(list, message, rules) ?? this.duplicate(list, message, rules);
    if (infraction) this.history.delete(key);
    return infraction;
  }

  /** Nombre de membres suivis (tests, diagnostic). */
  get size(): number {
    return this.history.size;
  }

  private flood(list: readonly TrackedMessage[], current: TrackedMessage, rules: SpamRules): SpamInfraction | null {
    if (rules.floodMessages <= 0) return null;
    const windowMs = rules.floodSeconds * 1000;
    const recent = list.filter((m) => current.at - m.at < windowMs);
    if (recent.length < rules.floodMessages) return null;
    return {
      kind: 'flood',
      messages: recent.map(ref),
      detail: `${recent.length} messages en ${rules.floodSeconds} s`,
    };
  }

  private duplicate(list: readonly TrackedMessage[], current: TrackedMessage, rules: SpamRules): SpamInfraction | null {
    if (rules.duplicateCount <= 0) return null;
    const text = normalizeContent(current.content);
    if (!text) return null;
    const same = list.filter((m) => current.at - m.at < DUPLICATE_WINDOW_MS && normalizeContent(m.content) === text);
    if (same.length < rules.duplicateCount) return null;
    return {
      kind: 'duplicate',
      messages: same.map(ref),
      detail: `${same.length} messages identiques en moins d'une minute`,
    };
  }

  /** Oublie les membres silencieux (au plus une fois par minute). */
  private sweep(now: number): void {
    if (now - this.lastSweep < HISTORY_MS) return;
    this.lastSweep = now;
    for (const [key, list] of this.history) {
      const last = list[list.length - 1];
      if (!last || now - last.at >= HISTORY_MS) this.history.delete(key);
    }
  }
}

const ref = (m: TrackedMessage) => ({ channelId: m.channelId, messageId: m.messageId });

/**
 * Au plus un avertissement automatique par membre et par période : une rafale
 * qui déclenche plusieurs règles (ou plusieurs actions de l'AutoMod Discord)
 * ne doit pas faire grimper les paliers d'un coup.
 */
export class CooldownLimiter {
  private readonly until = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  /** Vrai si l'action est permise maintenant ; elle ouvre alors une nouvelle période. */
  take(key: string, now: number): boolean {
    const end = this.until.get(key);
    if (end !== undefined && now < end) return false;
    if (this.until.size > 1_000) {
      for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
    }
    this.until.set(key, now + this.cooldownMs);
    return true;
  }
}
