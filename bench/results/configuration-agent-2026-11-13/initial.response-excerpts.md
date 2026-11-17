# Initial participant: user-visible response excerpts

Quoted from the independent participant's final messages. Ellipses below indicate omitted material;
the complete proposed patch and receipts are retained in the adjacent MCP audits.

## Before approval

> Aucune modification appliquée. L’assistant propose ce diff dans `.openlore/config.json` :

[…]

> Vos choix sont conservés : exclusion `vendor/**`, embeddings désactivés (`embedding: null`), autres préférences inchangées. L’indexation n’est pas modifiée : `src/generated/inventory-client.ts`, versionné et appelé depuis `src/app.ts`, reste dans l’analyse. Aucun conflit n’est signalé.

> Limites : aucun gain de vitesse ou nombre de surveillances économisées n’a été mesuré. Aucun daemon ni index n’est présent pour vérifier l’effet réel. Un fichier non surveillé peut devenir périmé dans l’index jusqu’à une réanalyse. Le contenu de `build-cache/` a été échantillonné, pas intégralement lu.

> Difficulté rencontrée : le schéma publié ne détaille pas `candidate` ; plusieurs formats ont été refusés avant d’obtenir cet aperçu valide. Aucune CLI globale n’a été nécessaire.

> Approuvez-vous ce diff exact, plan `d11b173676765194a3de41fd121ff5c8f7f3c2be6af5894a68931f569332f796`, pour une application ultérieure ?

## After exact-plan host approval

> Le plan approuvé `d11b1736…332f796` a été appliqué par l’assistant intégré. L’enregistrement de la configuration est confirmé et vérifié.

[…]

> La vérification reste partielle : l’assistant ne dispose d’aucune observation permettant de confirmer les effets sur l’index, la surveillance, les embeddings ou les outils. Dans votre hôte, il reste à charger cette configuration via le cycle de vie de l’extension, puis à vérifier ces comportements lors d’une analyse et d’une reconstruction. Aucun gain de vitesse n’est encore mesuré.

> Aucun autre réglage ni fichier source n’a été modifié ; aucun test modifiant les sources n’a été lancé.
