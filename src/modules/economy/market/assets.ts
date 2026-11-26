/**
 * Actifs fictifs de la bourse. Les paramètres décrivent un tick (5 min) :
 * - volatility : écart-type du rendement logarithmique ;
 * - reversion : force de rappel vers le prix de référence (évite la dérive à 0 ou à l'infini) ;
 * - newsChance : probabilité d'une actualité qui fait bondir ou chuter le cours.
 * Un symbole ne doit jamais changer : il est stocké dans les portefeuilles.
 */
export interface MarketAsset {
  readonly symbol: string;
  readonly name: string;
  readonly emoji: string;
  readonly basePrice: number;
  readonly volatility: number;
  readonly reversion: number;
  readonly newsChance: number;
  /** Dividende versé chaque jour aux détenteurs, en part de la valeur détenue (0,002 = 0,2 %). */
  readonly dividendRate?: number;
}

export const MARKET_ASSETS: readonly MarketAsset[] = [
  { symbol: 'BDL', name: 'BordelCoin', emoji: '🪙', basePrice: 250, volatility: 0.012, reversion: 0.002, newsChance: 0.003 },
  { symbol: 'TPC', name: 'TaupeCoin', emoji: '🐀', basePrice: 40, volatility: 0.022, reversion: 0.002, newsChance: 0.004 },
  // Actif stable : verse un dividende quotidien (rentabilisé en ~10 jours, frais d'achat et de vente compris).
  { symbol: 'CRS', name: 'Croissant & Cie', emoji: '🥐', basePrice: 120, volatility: 0.005, reversion: 0.003, newsChance: 0.0015, dividendRate: 0.002 },
  { symbol: 'PIZ', name: 'PizzaCorp', emoji: '🍕', basePrice: 80, volatility: 0.008, reversion: 0.0025, newsChance: 0.002 },
  { symbol: 'MEME', name: 'MemeStonk', emoji: '🚀', basePrice: 15, volatility: 0.035, reversion: 0.0015, newsChance: 0.006 },
];

export const ASSETS_BY_SYMBOL: ReadonlyMap<string, MarketAsset> = new Map(MARKET_ASSETS.map((a) => [a.symbol, a]));

/** `{name}` est remplacé par le nom de l'actif. */
export const GOOD_NEWS: readonly string[] = [
  '{name} annonce un partenariat avec la boulangerie du coin',
  'Un influenceur très suivi affirme que {name} « va aller sur la Lune »',
  '{name} publie des résultats trimestriels bien meilleurs que prévu',
  'Une baleine anonyme achète massivement du {name}',
  '{name} devient le moyen de paiement officiel d’un serveur Minecraft',
  'Le PDG de {name} promet des croissants gratuits aux actionnaires',
];

export const BAD_NEWS: readonly string[] = [
  'Rumeur de piratage chez {name} : les investisseurs paniquent',
  'Le régulateur ouvre une enquête sur {name}',
  'Le stagiaire de {name} a oublié le mot de passe du portefeuille',
  '{name} rate complètement le lancement de son nouveau produit',
  'Un célèbre investisseur revend tout son {name}',
  'Les serveurs de {name} sont en panne depuis ce matin',
];
