/**
 * Le titre et la description de chaque page, pour les moteurs de recherche et les aperçus.
 *
 * Le site est une application d'une seule page : sans cette table, les quinze adresses
 * recevaient le même HTML, avec le même titre et `canonical` vers l'accueil, ce qui dit à un
 * moteur « ces pages sont des copies de l'accueil ». `script/build-site.ts` écrit un
 * `index.html` par page à partir d'ici ; `App.tsx` met le titre de l'onglet à jour en navigant.
 */
export interface PageMeta {
  readonly title: string;
  readonly description: string;
}

const NAME = "Oathrion";

export const PAGES: Readonly<Record<string, PageMeta>> = {
  "/": {
    title: `${NAME}: approve what your AI coding agent does`,
    description:
      "Open source. One command, npx oathrion, puts a check between Claude Code or Cursor and the tools they use: reads go through, writes wait for your yes, deletes outside the project are refused, and every action leaves a signed receipt.",
  },
  "/product": {
    title: `Product: a decision, not a suggestion · ${NAME}`,
    description: "Every action an agent routes through Oathrion is allowed, held for a person, or refused before it reaches the tool, and leaves a tamper-evident receipt.",
  },
  "/how-it-works": {
    title: `How it works: one action, from intent to receipt · ${NAME}`,
    description: "Identity, policy, mandate, risk, decision, approval, execution, audit: the eight controls Oathrion runs, in order, on every agent action.",
  },
  "/use-cases": {
    title: `Use cases · ${NAME}`,
    description: "Where an authorization layer for AI agents fits: coding agents, agents with GitHub, Slack, Linear or Stripe access, and agents that pay.",
  },
  "/agent-payments": {
    title: `Agent payments: let your agent pay, prove it was allowed · ${NAME}`,
    description: "Verifiable mandates for AI agents that pay: two people sign, the bank checks, and Oathrion never touches the money.",
  },
  "/developers": {
    title: `Developers: change the endpoint, not your agent · ${NAME}`,
    description: "Put Oathrion in front of any MCP server, call its API from any language, and re-run every published check yourself.",
  },
  "/pricing": {
    title: `Pricing · ${NAME}`,
    description: "The local version is free and open source (Apache-2.0). Teams can join the four-week founding pilot.",
  },
  "/pilot": {
    title: `Founding pilot · ${NAME}`,
    description: "Four weeks with the author: Oathrion on your own agents and tools, approvals by someone else, and signed receipts for your clients or auditors.",
  },
  "/waitlist": {
    title: `Waitlist · ${NAME}`,
    description: "One message when the commercial release opens. No newsletter.",
  },
  "/about": {
    title: `About · ${NAME}`,
    description: "Why Oathrion exists: agents got the ability to act before anyone built the layer that says no.",
  },
  "/roadmap": {
    title: `Roadmap: what is built, what is not · ${NAME}`,
    description: "What Oathrion does today, what it does not do yet, and nothing dated that we cannot keep.",
  },
  "/security": {
    title: `Security: what is guaranteed, and what is not · ${NAME}`,
    description: "What Oathrion guarantees, its known limits, and how to report a vulnerability.",
  },
  "/contact": {
    title: `Contact · ${NAME}`,
    description: "Write to contact@oathrion.com. A person reads every message.",
  },
  "/terms": {
    title: `Terms of use · ${NAME}`,
    description: "Terms of use of the Oathrion website.",
  },
  "/privacy": {
    title: `Privacy · ${NAME}`,
    description: "What the Oathrion website collects, and what it does not.",
  },
};
