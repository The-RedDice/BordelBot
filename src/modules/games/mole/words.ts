export interface WordCategory {
  readonly name: string;
  readonly words: readonly string[];
}

export type WordBank = readonly WordCategory[];

export const DEFAULT_WORD_BANK: WordBank = [
  {
    name: 'Animaux',
    words: ['Pingouin', 'Girafe', 'Hérisson', 'Pieuvre', 'Kangourou', 'Chauve-souris', 'Escargot', 'Flamant', 'Loup', 'Tortue'],
  },
  {
    name: 'Cuisine',
    words: ['Raclette', 'Croissant', 'Ratatouille', 'Crêpe', 'Sushi', 'Couscous', 'Fondue', 'Tiramisu', 'Pizza', 'Quiche'],
  },
  {
    name: 'Métiers',
    words: ['Pompier', 'Boulanger', 'Astronaute', 'Plombier', 'Chirurgien', 'Facteur', 'Magicien', 'Journaliste', 'Pilote', 'Vétérinaire'],
  },
  {
    name: 'Sports',
    words: ['Escrime', 'Surf', 'Rugby', 'Escalade', 'Judo', 'Tennis', 'Curling', 'Natation', 'Biathlon', 'Pétanque'],
  },
  {
    name: 'Lieux',
    words: ['Bibliothèque', 'Aéroport', 'Hôpital', 'Plage', 'Cinéma', 'Prison', 'Château', 'Désert', 'Musée', 'Gare'],
  },
  {
    name: 'Objets du quotidien',
    words: ['Parapluie', 'Brosse à dents', 'Réveil', 'Ciseaux', 'Lunettes', 'Aspirateur', 'Bougie', 'Miroir', 'Clé', 'Oreiller'],
  },
  {
    name: 'Transports',
    words: ['Montgolfière', 'Trottinette', 'Sous-marin', 'Téléphérique', 'Tramway', 'Hélicoptère', 'Péniche', 'Tracteur', 'Fusée', 'Vélo'],
  },
  {
    name: 'Musique',
    words: ['Accordéon', 'Batterie', 'Violon', 'Harpe', 'Saxophone', 'Chorale', 'Piano', 'Trompette', 'Ukulélé', 'Orgue'],
  },
];
