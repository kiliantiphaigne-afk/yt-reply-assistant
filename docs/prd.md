# YT Reply Assistant — Product Requirements Document

**Scope** : standalone
**Mode** : compact

## 1. Goals & Background

### Contexte

Les createurs YouTube passent un temps considerable a repondre aux commentaires de leurs videos. Les reponses de qualite — qui engagent la conversation, posent des questions, creusent le sujet du commentateur — sont essentielles pour la croissance de la communaute et l'algorithme. YouTube Studio propose deja des suggestions IA basiques, mais elles sont generiques et ne refletent pas le ton personnel du createur.

Cette extension Chrome s'integre directement dans YouTube Studio (studio.youtube.com) pour proposer des suggestions de reponses contextualisees : elles tiennent compte du contenu de la video (via le transcript), du commentaire specifique, et du style de communication habituel du createur.

### Objectifs

- Reduire le temps de reponse aux commentaires de ~70% (de ~2min/commentaire a ~30s : lire, choisir/editer, poster)
- Maintenir un taux de reponse > 80% sur les commentaires recus dans les 48h
- Produire des reponses indistinguables du style naturel du createur
- Zero friction : les suggestions apparaissent automatiquement, pas de workflow supplementaire

### Entites metier identifiees

- **Comment** : un commentaire YouTube non repondu, avec son contexte (video, auteur, contenu, date)
- **Suggestion** : une proposition de reponse generee par l'IA, liee a un commentaire
- **StyleProfile** : le profil de ton du createur, construit a partir de ses reponses passees
- **VideoContext** : le transcript + metadata d'une video, utilise pour contextualiser les reponses
- **Provider** : le backend IA utilise pour la generation (Chrome Built-in AI, API Anthropic, API OpenAI)

---

## 2. Functional Requirements

### Injection & Detection (Content Script)

**FR1** — Injection dans YouTube Studio
- L'extension s'active UNIQUEMENT sur `studio.youtube.com/video/*/comments` et `studio.youtube.com/comments`
- Elle injecte son UI dans le DOM existant de YouTube Studio, a cote de chaque commentaire sans reponse
- L'injection est non-destructive : si YouTube Studio met a jour son UI, l'extension degrade gracieusement (masque ses elements plutot que de casser la page)
- Validation : l'extension ne produit aucune erreur console sur les autres pages YouTube
- Priorite : Must-have

**FR2** — Detection des commentaires sans reponse
- L'extension identifie les commentaires qui n'ont pas de reponse du createur (badge "owner" absent dans les replies)
- Elle utilise un MutationObserver pour detecter les nouveaux commentaires charges dynamiquement (scroll infini de YouTube Studio)
- Elle ignore les commentaires auxquels le createur a deja repondu
- Validation : 100% des commentaires sans reponse visibles sont detectes
- Priorite : Must-have

### Contexte Video (Transcript)

**FR3** — Recuperation du transcript
1. Quand un commentaire est detecte, l'extension identifie la video associee (video ID depuis l'URL ou le DOM)
2. Elle navigue vers la page publique de la video (en arriere-plan, via fetch) et scrape le transcript depuis les sous-titres
3. **SI** le transcript est disponible :
   a. Parser le transcript (texte brut, sans timestamps)
   b. Le stocker dans `chrome.storage.local` avec le video ID comme cle
   c. Le reutiliser pour tous les commentaires de la meme video (pas de re-scrape)
4. **SINON** (pas de sous-titres disponibles) :
   a. Utiliser uniquement le titre et la description de la video comme contexte
   b. Afficher un indicateur discret "contexte limite" sur les suggestions
-> Resultat : chaque video a un contexte (complet ou partiel) stocke localement
- Priorite : Must-have

**FR4** — Cache intelligent des transcripts
- Les transcripts sont caches dans `chrome.storage.local` avec TTL de 30 jours
- Taille max du cache : 50 Mo (environ 500 videos). Au-dela, eviction LRU
- Un bouton dans les settings permet de vider le cache manuellement
- Validation : pas de re-fetch pour une video deja en cache
- Priorite : Should-have

### Generation de Suggestions

**FR5** — Generation de reponses contextualisees
1. Pour chaque commentaire sans reponse visible dans le viewport :
   a. Collecter le texte du commentaire, le nom de l'auteur, et le contexte video (transcript ou fallback)
   b. Construire le prompt avec : system prompt (style) + contexte video + commentaire
   c. Envoyer au provider IA configure
2. Generer 3 suggestions distinctes :
   - Suggestion 1 : reponse directe et engageante (repond au point souleve + question de relance)
   - Suggestion 2 : reponse qui approfondit (connecte le commentaire a un point du transcript + ouvre la discussion)
   - Suggestion 3 : reponse courte et chaleureuse (remerciement + micro-question)
3. **SI** la generation echoue (rate limit, erreur reseau) :
   a. Afficher un bouton "Reessayer" a la place des suggestions
   b. Logger l'erreur en interne (pas d'alerte utilisateur sauf si persistant)
-> Resultat : 3 suggestions cliquables sous chaque commentaire
- Priorite : Must-have

**FR6** — Trigger de generation (Intersection Observer)
- Les suggestions sont generees automatiquement quand un commentaire entre dans le viewport (lazy generation)
- Un debounce de 500ms evite les generations inutiles pendant le scroll rapide
- Les commentaires deja traites (suggestions generees ou reponse postee) ne sont pas re-traites
- Un indicateur de chargement (skeleton) s'affiche pendant la generation
- Validation : pas de generation pour les commentaires hors viewport
- Priorite : Must-have

### Profil de Style

**FR7** — Construction initiale du profil de style
1. Au premier lancement, l'extension propose un onboarding en 1 etape :
   a. "Je vais analyser vos reponses recentes pour apprendre votre style. Cliquez pour commencer."
   b. L'extension scrape les 30 dernieres reponses du createur depuis YouTube Studio (section commentaires, filtre "replied")
   c. Extraction du texte des reponses du createur uniquement (pas les commentaires parents)
2. Analyse du style :
   a. Longueur moyenne des reponses
   b. Utilisation d'emojis (frequence, types)
   c. Registre de langue (tutoiement/vouvoiement, formel/informel)
   d. Patterns recurrents (formules de debut, de fin, expressions typiques)
   e. Langue principale
3. Le profil est stocke dans `chrome.storage.local` sous forme de system prompt optimise
-> Resultat : un StyleProfile pret a etre injecte dans chaque generation
- Priorite : Must-have

**FR8** — Apprentissage continu du style
- Chaque fois que le createur poste une reponse (qu'elle vienne d'une suggestion editee ou non), l'extension la capture
- Les 50 dernieres reponses postees sont conservees comme corpus de reference
- Le system prompt de style est regenere periodiquement (toutes les 20 nouvelles reponses)
- L'utilisateur peut forcer une re-analyse depuis les settings
- Validation : le style s'affine avec le temps sans intervention manuelle
- Priorite : Should-have

### Interaction Utilisateur

**FR9** — Affichage des suggestions (style natif YouTube)
- Les 3 suggestions s'affichent dans des chips/pills cliquables sous le commentaire, visuellement similaires aux suggestions natives de YouTube
- Design : fond gris clair, texte sombre, coins arrondis, hauteur compacte
- Chaque suggestion est tronquee a ~100 caracteres avec "..." si plus long
- Au hover : affichage complet dans un tooltip
- Au clic : le texte est insere dans le champ de reponse de YouTube Studio
- Priorite : Must-have

**FR10** — Edition avant envoi
- Apres clic sur une suggestion, le texte est insere dans le champ de reponse natif de YouTube Studio (pas dans un champ custom)
- Le createur peut editer librement le texte avant de poster via le bouton natif "Repondre"
- L'extension ne poste JAMAIS automatiquement — c'est toujours le createur qui clique "Repondre"
- Priorite : Must-have

**FR11** — Actions supplementaires par commentaire
- Bouton "Regenerer" (icone refresh) : regenere les 3 suggestions avec un prompt legerement varie
- Bouton "Ignorer" (icone X) : masque les suggestions pour ce commentaire (ne sera pas re-traite)
- Les commentaires ignores sont stockes pour ne pas re-apparaitre apres un refresh
- Priorite : Should-have

### Configuration (Providers IA)

**FR12** — Provider IA : Chrome Built-in AI (defaut)
- Provider par defaut, zero configuration
- Utilise la Prompt API de Chrome (Gemini Nano local)
- Prerequis : Chrome 127+, flag `chrome://flags/#prompt-api-for-gemini-nano` active
- L'extension detecte automatiquement si la Prompt API est disponible
- **SI** non disponible : afficher un guide d'activation en 3 etapes dans les settings
- Priorite : Must-have

**FR13** — Provider IA : API Anthropic (optionnel)
- L'utilisateur peut entrer une cle API Anthropic dans les settings
- Modele utilise : claude-haiku-4-20250514 (meilleur rapport qualite/prix)
- La cle est stockee dans `chrome.storage.local` (chiffree si possible via Web Crypto API)
- Un test de connexion est effectue a la saisie de la cle
- Priorite : Should-have

**FR14** — Provider IA : API OpenAI (optionnel)
- Meme logique que FR13 mais avec une cle API OpenAI
- Modele utilise : gpt-4o-mini
- Priorite : Nice-to-have

**FR15** — Selection et fallback des providers
1. L'utilisateur choisit son provider prefere dans les settings
2. **SI** le provider prefere echoue (rate limit, erreur) :
   a. Fallback automatique vers le provider suivant dans l'ordre : API configuree > Chrome Built-in AI
   b. Notification discrete "Fallback vers [provider]"
3. **SI** aucun provider n'est disponible :
   a. Afficher "Aucun provider IA disponible" avec un lien vers les settings
-> Resultat : toujours une tentative de generation, meme en cas de defaillance
- Priorite : Should-have

### Settings

**FR16** — Page de configuration (popup extension)
- Accessible via l'icone de l'extension dans la barre Chrome
- Sections :
  - **Provider IA** : choix du provider actif + champs API keys
  - **Style** : apercu du profil de style detecte + bouton "Re-analyser"
  - **Cache** : taille actuelle du cache transcripts + bouton "Vider"
  - **A propos** : version + lien GitHub
- Design : minimaliste, coherent avec l'esthetique YouTube Studio (fond sombre, accents bleus)
- Priorite : Must-have

---

## 3. User Stories

### Createur (seul role)

**Premier lancement :**

> Quand le createur installe l'extension :
>   1. Il voit un badge "Setup" sur l'icone de l'extension
>   2. Il clique sur l'icone, un popup l'accueille : "Bienvenue ! Je vais analyser votre style de reponse."
>   3. Il clique "Commencer l'analyse"
>   4. L'extension scrape ses 30 dernieres reponses (barre de progression visible)
>   5. Il voit un resume : "Style detecte : informel, tutoiement, emojis frequents, reponses moyennes de 2 phrases"
>   6. Il peut ajuster (optionnel) ou valider
>   7. **SI** Chrome Built-in AI est disponible : "Tout est pret !"
>   8. **SINON** : guide d'activation de la Prompt API, ou suggestion d'ajouter une cle API
>   -> Resultat visible : badge "Setup" disparait, l'extension est operationnelle

**Usage quotidien :**

> Quand le createur ouvre YouTube Studio > Commentaires :
>   1. Il voit la liste des commentaires comme d'habitude
>   2. Sous chaque commentaire sans reponse, 3 suggestions apparaissent progressivement (au scroll)
>   3. Un skeleton loader s'affiche pendant la generation (~1-3s)
>   4. Il lit les 3 suggestions pour un commentaire
>   5. **SI** une suggestion lui convient :
>      a. Il clique dessus
>      b. Le texte est insere dans le champ de reponse natif
>      c. Il edite si besoin
>      d. Il clique "Repondre" (bouton natif YouTube)
>      e. Les suggestions disparaissent pour ce commentaire
>   6. **SI** aucune suggestion ne convient :
>      a. Il clique "Regenerer"
>      b. 3 nouvelles suggestions apparaissent
>   7. **SI** le commentaire ne merite pas de reponse :
>      a. Il clique "Ignorer"
>      b. Les suggestions disparaissent definitivement pour ce commentaire
>   -> Resultat visible : commentaires traites plus vite, engagement accru

**Changement de provider :**

> Quand le createur veut utiliser Claude au lieu du Chrome AI :
>   1. Il clique sur l'icone de l'extension
>   2. Il va dans "Provider IA"
>   3. Il selectionne "Anthropic API"
>   4. Il colle sa cle API
>   5. Un test automatique confirme "Connexion OK"
>   6. Les prochaines suggestions utiliseront Claude Haiku
>   -> Resultat visible : qualite des suggestions amelioree

---

## 4. UI Tree

```
Extension
├── Content Script (injecte dans studio.youtube.com)
│   ├── CommentSuggestions (sous chaque commentaire sans reponse)
│   │   ├── [SI loading] SkeletonLoader (3 pills grisees animees)
│   │   ├── [SI genere] SuggestionChips
│   │   │   ├── Chip 1 — reponse engageante (tronquee, tooltip au hover)
│   │   │   ├── Chip 2 — reponse approfondie
│   │   │   └── Chip 3 — reponse courte
│   │   ├── [SI erreur] RetryButton ("Reessayer")
│   │   ├── [SI aucun provider] NoProviderMessage + lien Settings
│   │   └── Actions
│   │       ├── RefreshButton (icone) → regenere les suggestions
│   │       └── DismissButton (icone X) → masque definitivement
│   └── [SI contexte limite] ContextBadge ("Sans transcript")
│
├── Popup (clic sur icone extension)
│   ├── [SI premier lancement] OnboardingView
│   │   ├── Texte de bienvenue
│   │   ├── Bouton "Analyser mon style"
│   │   ├── [SI analyse en cours] ProgressBar
│   │   └── [SI analyse terminee] StyleSummary + Bouton "C'est parti"
│   ├── [SI configure] SettingsView
│   │   ├── Section Provider
│   │   │   ├── Selecteur (Chrome AI / Anthropic / OpenAI)
│   │   │   ├── [SI Anthropic] Input cle API + test
│   │   │   ├── [SI OpenAI] Input cle API + test
│   │   │   └── [SI Chrome AI indisponible] Guide d'activation
│   │   ├── Section Style
│   │   │   ├── Resume du profil detecte
│   │   │   ├── Compteur "base sur N reponses"
│   │   │   └── Bouton "Re-analyser"
│   │   ├── Section Cache
│   │   │   ├── "N videos en cache (X Mo)"
│   │   │   └── Bouton "Vider le cache"
│   │   └── Section About
│   │       ├── Version
│   │       └── Lien GitHub
│   └── StatusBar
│       ├── Provider actif : "{nom}"
│       └── [SI fallback actif] "Mode fallback : {provider}"
```

---

## 5. Non-Functional Requirements

**NFR1** — Performance
- L'injection dans le DOM ne doit pas ralentir YouTube Studio (< 50ms de temps d'injection par commentaire)
- La generation d'une suggestion doit prendre < 5s (Chrome AI) ou < 3s (API)
- Le cache transcript ne doit pas depasser 50 Mo dans chrome.storage.local
- L'extension consomme < 100 Mo de RAM en fonctionnement normal

**NFR2** — Securite
- Les cles API sont stockees dans `chrome.storage.local`, chiffrees via Web Crypto API (AES-GCM)
- Aucune donnee n'est envoyee a un serveur tiers (sauf les appels API explicitement configures par l'utilisateur)
- Les transcripts et le profil de style restent 100% locaux
- L'extension ne demande que les permissions Chrome strictement necessaires : `activeTab`, `storage`, `scripting`

**NFR3** — Resilience
- L'extension ne doit JAMAIS casser l'UI de YouTube Studio. Si une erreur survient, elle masque ses propres elements.
- Toutes les operations DOM sont wrappees dans des try/catch avec fallback silencieux
- Les changements de structure du DOM YouTube Studio sont detectes et l'extension se desactive proprement si elle ne reconnait plus la page

**NFR4** — Compatibilite
- Chrome 127+ (requis pour la Prompt API)
- Fonctionne avec la derniere version de YouTube Studio (testé manuellement)
- Mode sombre et mode clair de YouTube Studio supportes

**NFR5** — Vie privee
- Aucun tracking, aucune telemetrie
- Les donnees ne quittent jamais le navigateur (sauf appels API si configure)
- Pas de compte utilisateur, pas d'authentification externe
