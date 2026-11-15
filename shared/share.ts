/**
 * CE QUE L'ON PARTAGE, et où (11 novembre : « la notification doit être notre arme de
 * viralité »). La même phrase et les mêmes liens depuis la notification (`server/notifications/
 * popup.ts`) et depuis la console (`ShareDialog`). La phrase vient du fil d'actualité
 * (`server/local-feed.ts`) : rien de privé. LinkedIn, X et WhatsApp ne prennent que du TEXTE
 * dans un lien ; la carte (l'image) est copiée à part, et la personne la colle dans son post.
 */
export type ShareNetwork = "linkedin" | "x" | "whatsapp";

export const SHARE_NETWORKS: readonly ShareNetwork[] = ["linkedin", "x", "whatsapp"];

/** Le texte du post : la phrase, puis Oathrion. */
export function shareText(sentence: string): string {
  return `${sentence}\n\nOathrion, the guard for AI agents: npx oathrion #Oathrion`;
}

/** Le lien qui ouvre un post prêt, avec ce texte. */
export function shareUrl(network: ShareNetwork, sentence: string): string {
  const text = encodeURIComponent(shareText(sentence));
  if (network === "linkedin") return `https://www.linkedin.com/feed/?shareActive=true&text=${text}`;
  if (network === "x") return `https://x.com/intent/post?text=${text}`;
  return `https://wa.me/?text=${text}`;
}
