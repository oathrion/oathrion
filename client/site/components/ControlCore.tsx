/**
 * Le noyau de contrôle — l'objet du Hero, en WebGL.
 *
 * ## Pourquoi de la 3D ICI, et nulle part ailleurs
 *
 * La consigne était : « Ne mets pas Three.js partout. Une animation SVG extrêmement bien
 * faite est préférable à une 3D lourde inutile. » Elle est suivie à la lettre — c'est la
 * seule scène WebGL du site, et la séquence des contrôles reste en SVG, parce qu'une
 * séquence se raconte mieux par un tracé que par un volume.
 *
 * Ce que la 3D apporte ici que le SVG ne peut pas : **une présence**. Le sujet est une
 * infrastructure invisible qui s'interpose, et un volume qui tourne lentement en
 * occupant l'espace dit cela d'une façon qu'un diagramme plat ne dit pas. C'est aussi ce
 * que montre la référence — des objets géométriques rendus, pas des photographies.
 *
 * ## Ce que l'objet représente, et pourquoi il a cette forme
 *
 * Une enceinte — un icosaèdre en fil de fer — et un noyau lumineux à l'intérieur. Autour,
 * des satellites : les agents. Rien ne traverse l'enceinte : chaque satellite s'approche,
 * **touche la surface**, et repart. C'est littéralement le produit : on n'entre pas, on
 * demande, et quelque chose décide à la frontière.
 *
 * ## Ce qu'il ne fait jamais
 *
 * Il ne bloque pas le texte. Le module est chargé **dynamiquement**, donc Three.js vit
 * dans son propre fragment et ne pèse rien sur le premier affichage. S'il n'arrive pas —
 * WebGL absent, mouvement réduit, écran étroit, chargement en échec — la scène SVG reste
 * affichée et personne ne voit un trou.
 */

import { useEffect, useRef, useState } from "react";

/** Les couleurs viennent des tokens du site, lues une fois — pas de valeurs en double. */
function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function ControlCore({ onReady }: { onReady?: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = host.current;
    if (!mount) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        /*
         * Import dynamique : Three.js n'entre pas dans le fragment initial. Un visiteur
         * sur un réseau lent lit le titre et le texte pendant que la scène arrive — et si
         * elle n'arrive jamais, il ne manque rien de ce qu'il était venu lire.
         */
        const THREE = await import("three");
        if (disposed || !mount) return;

        const width = mount.clientWidth;
        const height = mount.clientHeight;
        if (width < 2 || height < 2) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        /*
         * Plafonné à 2. Sur un écran à forte densité, un `devicePixelRatio` de 3 triple la
         * surface à peindre pour un gain que personne ne voit sur un objet en fil de fer.
         */
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height, false);
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
        camera.position.set(0, 0, 7.2);

        const flow = new THREE.Color(readToken("--flow", "#4D8DFF"));
        const bright = new THREE.Color(readToken("--flow-bright", "#7FB0FF"));
        const hold = new THREE.Color(readToken("--hold", "#F5B544"));

        /* ------------------------------------------------- l'enceinte */

        const shellGeometry = new THREE.IcosahedronGeometry(2.25, 1);
        const shell = new THREE.LineSegments(
          new THREE.WireframeGeometry(shellGeometry),
          new THREE.LineBasicMaterial({ color: flow, transparent: true, opacity: 0.32 }),
        );
        scene.add(shell);

        /*
         * Une seconde enceinte, légèrement plus grande et plus pâle, tournant en sens
         * inverse. Deux couches qui se croisent créent une profondeur qu'un seul maillage
         * n'a pas — et c'est moins coûteux qu'un effet de post-traitement.
         */
        const halo = new THREE.LineSegments(
          new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.62, 1)),
          new THREE.LineBasicMaterial({ color: flow, transparent: true, opacity: 0.1 }),
        );
        scene.add(halo);

        /* --------------------------------------------------- le noyau */

        const core = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.62, 2),
          new THREE.MeshBasicMaterial({ color: bright, transparent: true, opacity: 0.92 }),
        );
        scene.add(core);

        // La lueur : des coquilles additives, de plus en plus larges et faibles.
        for (const [radius, opacity] of [[0.95, 0.16], [1.45, 0.07], [2.0, 0.035]] as const) {
          scene.add(
            new THREE.Mesh(
              new THREE.SphereGeometry(radius, 24, 24),
              new THREE.MeshBasicMaterial({
                color: flow, transparent: true, opacity,
                blending: THREE.AdditiveBlending, depthWrite: false,
              }),
            ),
          );
        }

        /* ------------------------------------------------ les agents */

        /*
         * Huit satellites. Chacun s'approche de l'enceinte, la touche, et repart — jamais
         * il ne la traverse. C'est la seule chose que cette scène doit faire comprendre.
         */
        const AGENTS = 8;
        const agents: { mesh: THREE.Mesh; axis: THREE.Vector3; phase: number; speed: number; held: boolean }[] = [];
        for (let index = 0; index < AGENTS; index += 1) {
          const held = index === 2 || index === 6;
          const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.075, 14, 14),
            new THREE.MeshBasicMaterial({ color: held ? hold : bright, transparent: true, opacity: 0.95 }),
          );
          scene.add(mesh);
          agents.push({
            mesh,
            axis: new THREE.Vector3(
              Math.sin(index * 2.1) * 0.9,
              Math.cos(index * 1.7),
              Math.sin(index * 0.9) * 0.6,
            ).normalize(),
            phase: (index / AGENTS) * Math.PI * 2,
            speed: 0.22 + (index % 3) * 0.05,
            held,
          });
        }

        /* -------------------------------------------------- la boucle */

        const clock = new THREE.Clock();
        let frame = 0;
        let visible = true;

        // La scène s'arrête quand elle sort du champ : une animation qui tourne derrière
        // un écran déroulé ne fait que chauffer la batterie.
        const observer = new IntersectionObserver(
          ([entry]) => { visible = entry?.isIntersecting ?? true; },
          { threshold: 0.01 },
        );
        observer.observe(mount);

        const render = () => {
          frame = requestAnimationFrame(render);
          if (!visible) return;
          const t = clock.getElapsedTime();

          shell.rotation.y = t * 0.085;
          shell.rotation.x = Math.sin(t * 0.21) * 0.14;
          halo.rotation.y = -t * 0.055;
          halo.rotation.z = Math.cos(t * 0.17) * 0.1;

          const pulse = 1 + Math.sin(t * 1.25) * 0.06;
          core.scale.setScalar(pulse);

          for (const agent of agents) {
            /*
             * Une distance qui oscille entre loin et la surface exacte de l'enceinte.
             * Les satellites « retenus » s'arrêtent plus loin et y restent plus longtemps :
             * une action en attente n'avance pas.
             */
            const cycle = (Math.sin(t * agent.speed + agent.phase) + 1) / 2;
            const eased = agent.held ? 0.52 + cycle * 0.12 : cycle;
            const distance = 4.6 - eased * 2.3;
            agent.mesh.position.copy(agent.axis).multiplyScalar(distance);
            agent.mesh.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), t * 0.11);
            const material = agent.mesh.material as THREE.MeshBasicMaterial;
            material.opacity = 0.35 + eased * 0.6;
          }

          renderer.render(scene, camera);
        };
        render();
        onReady?.();

        const onResize = () => {
          if (!mount) return;
          const w = mount.clientWidth;
          const h = mount.clientHeight;
          if (w < 2 || h < 2) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        };
        window.addEventListener("resize", onResize, { passive: true });

        cleanup = () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          window.removeEventListener("resize", onResize);
          /*
           * Chaque géométrie et chaque matériau est libéré explicitement : le ramasse-
           * miettes de JavaScript ne connaît rien aux ressources du GPU, et une scène
           * remontée plusieurs fois les accumulerait jusqu'à la perte du contexte.
           */
          scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            mesh.geometry?.dispose?.();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material?.dispose?.();
          });
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch {
        // WebGL absent, contexte refusé, fragment non chargé : on le dit à l'appelant,
        // qui garde la scène SVG. Un échec silencieux laisserait un trou noir.
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [onReady]);

  return <div ref={host} className="core" data-failed={failed ? "yes" : "no"} aria-hidden="true" />;
}
