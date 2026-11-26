/**
 * Fichiers servis par le tableau de bord, embarqués dans le code (rien à copier
 * dans dist/ au build). Phase 1 : page provisoire ; l'interface complète suit.
 */
export interface Asset {
  readonly type: string;
  readonly body: string;
}

const INDEX = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BordelBot · tableau de bord</title>
</head>
<body>
<h1>BordelBot</h1>
<p>Tableau de bord en construction. <a href="/auth/login">Se connecter avec Discord</a></p>
</body>
</html>`;

export const ASSETS: Readonly<Record<string, Asset>> = {
  '/': { type: 'text/html; charset=utf-8', body: INDEX },
};
