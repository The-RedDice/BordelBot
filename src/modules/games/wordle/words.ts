/**
 * Mots à deviner : 5 lettres, courants, sans accents (é → e). La liste peut être
 * complétée librement ; l'ordre détermine le mot de chaque jour, donc en ajouter
 * change les mots à venir (pas ceux déjà joués, gardés en base sous forme d'essais).
 * Les propositions, elles, ne sont pas limitées à cette liste.
 */
export const ANSWERS: readonly string[] = [
  'aimer', 'arbre', 'avion', 'balle', 'bague', 'barbe', 'blanc', 'bocal', 'boire', 'bombe',
  'botte', 'boule', 'bulle', 'cadre', 'calme', 'canal', 'canne', 'carte', 'cause', 'chaud',
  'chant', 'chair', 'chaos', 'chien', 'choix', 'chose', 'cible', 'cidre', 'clair', 'clown',
  'coeur', 'colle', 'conte', 'corde', 'corps', 'coton', 'coude', 'coupe', 'cours', 'court',
  'crabe', 'craie', 'crane', 'creme', 'crise', 'croix', 'cuire', 'cycle', 'danse', 'dette',
  'doigt', 'douce', 'doute', 'drame', 'droit', 'drole', 'ecole', 'ecran', 'effet', 'envie',
  'epice', 'epine', 'etage', 'faire', 'farce', 'faute', 'femme', 'ferme', 'fibre', 'fiche',
  'fille', 'final', 'fleur', 'flute', 'foire', 'folie', 'force', 'forme', 'fosse', 'fouet',
  'foule', 'frein', 'frere', 'froid', 'fruit', 'fumee', 'garde', 'geant', 'genie', 'genou',
  'givre', 'glace', 'globe', 'gomme', 'gorge', 'grace', 'grain', 'grand', 'grave', 'guide',
  'haine', 'halte', 'harpe', 'herbe', 'heros', 'hiver', 'homme', 'honte', 'hotel', 'houle',
  'huile', 'hutte', 'idole', 'image', 'jambe', 'jaune', 'jeter', 'jeune', 'jouer', 'jouet',
  'juger', 'jupon', 'juste', 'kayak', 'koala', 'lacet', 'laine', 'lampe', 'lance', 'lapin',
  'large', 'larme', 'laver', 'lever', 'levre', 'libre', 'ligne', 'linge', 'liste', 'litre',
  'livre', 'local', 'loger', 'loupe', 'lourd', 'loyal', 'lueur', 'lundi', 'lutin', 'lycee',
  'magie', 'maire', 'maman', 'manie', 'mardi', 'marge', 'marin', 'masse', 'match', 'matin',
  'mauve', 'melon', 'merci', 'merle', 'metal', 'metre', 'metro', 'mince', 'moine', 'moins',
  'moral', 'morse', 'motif', 'moule', 'moyen', 'musee', 'nager', 'nappe', 'natte', 'neige',
  'niche', 'noble', 'noire', 'noyau', 'nuage', 'oasis', 'obeir', 'ocean', 'odeur', 'offre',
  'olive', 'ombre', 'oncle', 'ongle', 'opera', 'orage', 'ordre', 'orgue', 'otage', 'outil',
  'paire', 'panda', 'panne', 'parmi', 'patte', 'pause', 'payer', 'peche', 'peine', 'pelle',
  'perle', 'perte', 'peser', 'petit', 'phare', 'piano', 'piece', 'piege', 'pince', 'piste',
  'place', 'plage', 'plaie', 'plomb', 'pluie', 'plume', 'poche', 'poele', 'poeme', 'poire',
  'pomme', 'pompe', 'porte', 'poste', 'poule', 'pouce', 'prise', 'prune', 'puits', 'queue',
  'radar', 'radio', 'raide', 'rampe', 'rayon', 'recit', 'regle', 'reine', 'renne', 'repas',
  'reste', 'rever', 'rhume', 'riche', 'rival', 'robot', 'roche', 'roman', 'ronde', 'rouge',
  'route', 'ruche', 'rugby', 'ruine', 'sable', 'sabot', 'sabre', 'salle', 'salon', 'salut',
  'sauce', 'saule', 'scene', 'score', 'seize', 'selle', 'semer', 'serre', 'seuil', 'signe',
  'singe', 'sirop', 'soeur', 'solde', 'somme', 'sonde', 'songe', 'sorte', 'souci', 'soupe',
  'sourd', 'sport', 'stade', 'style', 'sucre', 'suite', 'sujet', 'table', 'tache', 'taire',
  'talon', 'tante', 'tapis', 'tarte', 'taupe', 'teint', 'temps', 'tenir', 'tente', 'terre',
  'texte', 'tigre', 'tirer', 'titre', 'toile', 'tombe', 'tonne', 'torse', 'total', 'totem',
  'trace', 'train', 'trait', 'treve', 'trois', 'tronc', 'trone', 'tuile', 'tuyau', 'union',
  'usine', 'utile', 'vache', 'vague', 'valse', 'venin', 'venir', 'vente', 'verbe', 'verre',
  'vertu', 'veste', 'video', 'vider', 'vieux', 'ville', 'vigne', 'viser', 'vitre', 'vivre',
  'voile', 'voler', 'volet', 'voter', 'wagon', 'zebre', 'zeste',
];
