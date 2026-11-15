# `withOathrion` — un contrôle d'autorisation devant n'importe quel outil

**MOTIF B.** Votre agent garde ses outils, ses prompts et son flot de contrôle. La seule
différence est que l'outil demande à Oathrion avant de s'exécuter.

```ts
import { OathrionClient } from "@oathrion/sdk";
import { withOathrion } from "./with-placet";

const placet = new OathrionClient({ baseUrl: process.env.OATHRION_URL!, apiKey: process.env.OATHRION_API_KEY! });

export const refund = withOathrion(monOutilDeRemboursement, {
  client: placet,
  agentId: "agt_support_bot",
  action: "stripe.refund",
  target: (a) => a.customerId,
  input: (a) => ({ amount: a.amount, currency: a.currency }),
});
```

`refund` **est** `monOutilDeRemboursement` : même type, même nom, même description, même
schéma. Il se glisse là où l'autre était.

## Pourquoi un seul adaptateur, et pas un par framework

Tout framework d'agents a la même forme au fond : un nom, et une fonction qui prend des
arguments et fait quelque chose. Ils diffèrent par la façon dont un outil est **décrit**,
pas par ce qu'un outil **est**.

Un dossier de greffons propriétaires serait un dossier de choses à maintenir, et chacun
serait un endroit où le contrôle d'autorisation peut dériver.

## Où ils diffèrent vraiment : le nom de la méthode

| framework | la méthode qui exécute |
|---|---|
| SDK `ai` (Vercel) | `execute` |
| LangChain, LangGraph | `invoke`, et `func` |
| LlamaIndex | `call` |
| CrewAI (convention Python) | `_run` |
| function calling, n8n, une boucle écrite à la main | une fonction nue |

`withOathrion` accepte **l'une quelconque** de ces formes, et aussi une fonction nue. Il
enrobe la première qu'il trouve dans l'ordre `execute, invoke, call, func, run, _run`.

L'ordre est un choix : on enrobe l'**entrée publique** — celle qui valide les arguments
contre le schéma — plutôt que l'implémentation nue. `_run` vient en dernier, parce qu'un
nom préfixé d'un souligné n'est jamais ce qu'on choisit quand une entrée publique existe.

Si votre framework nomme la sienne autrement, enrobez directement sa fonction :

```ts
withOathrion((args) => outil.saMethode(args), { action: "stripe.refund", /* … */ });
```

## Ce qui est garanti

La fonction n'est **pas appelée** sans un ALLOW d'Oathrion.

- **BLOCK** → `ToolNotAuthorizedError`, l'outil ne tourne pas ;
- **APPROVAL_REQUIRED** → `ToolNotAuthorizedError`, l'outil ne tourne pas. Une action
  retenue attend un humain, et traiter une attente comme un oui est la chose la plus
  dangereuse qu'une intégration puisse faire ;
- **Oathrion injoignable** → le SDK lève, l'outil ne tourne pas. **Injoignable n'est pas une
  permission** ;
- **une décision inconnue** → l'outil ne tourne pas. Le SDK dérive `allowed` de la chaîne
  de décision exhaustivement, jamais comme « pas bloqué ».

Et ce qui est **préservé** : la description, le schéma, les métadonnées, les méthodes du
prototype, le nom d'une fonction nue, et **tous** les arguments — LangChain appelle
`invoke(input, config)`, où le second argument porte les callbacks et le signal
d'annulation.

## Ce qui n'est PAS garanti

**Rien n'arrête un appelant qui choisit de ne pas s'en servir.** C'est la limite honnête de
tout motif en-processus : `withOathrion(outil)` protège l'outil qu'il a enrobé, et rien ne
vous protège d'appeler celui qui ne l'est pas.

Si vous avez besoin qu'Oathrion soit **physiquement inévitable**, mettez-le sur le chemin :
la passerelle MCP (**MOTIF A**), où la seule route de l'agent vers l'outil passe par
Oathrion. Voir [`docs/mcp.md`](../../docs/mcp.md) et
[`examples/mcp-client/`](../mcp-client/).

## Comment l'agnosticisme est prouvé

Trois sortes de preuves, et pas une affirmation :

1. **L'absence de dépendance, vérifiée en lisant le source.** L'adaptateur importe
   exactement un module — le SDK de ce dépôt — et ne nomme aucun framework hors de ses
   commentaires. C'est la seule preuve qui ne se périme pas : énumérer les frameworks qui
   marchent ne dit rien de celui qui sortira le mois prochain.
2. **Chaque forme ci-dessus**, éprouvée : exécutée sur ALLOW, **non** exécutée sur
   APPROVAL_REQUIRED.
3. **Un framework réel**, `@langchain/core` : un `DynamicStructuredTool` authentique,
   enrobé directement. Si le paquet est absent, ces tests **skippent en imprimant
   pourquoi** plutôt que de passer en silence.

**Une forme n'est pas le framework.** Les objets de la partie 2 sont écrits à la main
depuis l'API publiée de chacun : ils prouvent que l'adaptateur enrobe la signature, pas
qu'une version donnée de LlamaIndex se comporte comme sa documentation. Seul LangChain est
chargé comme vrai code tiers, et `docs/limitations.md` le dit en ces termes.

## Deux défauts que cette version corrige

L'adaptateur précédent se déclarait agnostique et ne l'était pas — des deux façons les
plus coûteuses, puisque les deux compilaient :

- **il exigeait une méthode `execute`**, qui est la convention du SDK `ai` de Vercel et de
  personne d'autre. S'en servir avec LangChain demandait d'écrire à la main
  `{ name: lc.name, execute: (a) => lc.invoke(a) }` — une cale, c'est-à-dire le client
  payant l'adaptation que l'adaptateur prétendait fournir ;
- **il reconstruisait `{ name, execute }` et jetait le reste**, donc un outil LangChain
  enrobé perdait son `schema` et LangChain refusait de l'appeler.

## `withPlacet` fonctionne encore

Cet adaptateur est un exemple que vous **copiez dans votre dépôt** : une ligne
`withPlacet(tool, …)` vit chez vous. `withPlacet` reste donc un alias de `withOathrion`, et
disparaîtra à une version majeure annoncée. Même règle pour `PlacetClient`, `PlacetError` et
les autres noms du SDK.
