import { parseHTML } from "npm:linkedom@0.18.12";

import { selectArchiveSourceSpecificContent } from "./archive_source_heuristics.ts";
import { collectMetadata, extractArchiveSnapshot } from "./normalize.ts";

type Document = any;

function documentFromHtml(html: string): Document {
  return (parseHTML(html) as unknown as { document: Document }).document;
}

function assertEquals<T>(actual: T, expected: T): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertEquals failed\nactual: ${actualJson}\nexpected: ${expectedJson}`,
    );
  }
}

Deno.test("selectArchiveSourceSpecificContent delegates Bloomberg archive pages to Bloomberg heuristics", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>AI Perfected Chess. Humans Made It Unpredictable Again - Bloomberg</title>
      </head>
      <body>
        <input
          type="text"
          name="q"
          value="https://www.bloomberg.com/news/articles/2026-03-27/ai-changed-chess-grandmasters-now-win-with-unpredictable-moves"
        />
        <div id="that-jump-content--default"></div>
        <main>
          <article>
            <div>Weekend Essay</div>
            <div>
              <header>
                <h1>AI Perfected Chess. Humans Made It Unpredictable Again</h1>
                <div>
                  Artificial intelligence drove chess toward perfect play, leading to more draws at top tournaments.
                  Now grandmasters are winning by making less optimal moves.
                </div>
              </header>
            </div>
            <div>
              <figure>
                <button type="button">
                  <img
                    currentSourceUrl="https://assets.bwbx.io/images/chess-hero.webp"
                    src="/o69yu/chess-hero.webp"
                    alt="Magnus Carlsen at the board"
                  />
                </button>
              </figure>
            </div>
            <div>
              By
              <a rel="author" href="https://www.bloomberg.com/authors/example">Kevin Lincoln</a>
            </div>
            <time datetime="2026-03-27T08:00:00Z"></time>
            <div>
              <div>
                At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger
                Fabiano Caruana in a best-of-12 format.
              </div>
              <div>Gift this article</div>
              <div>Contact us: Provide news feedback or report an error</div>
              <div>
                The next generation of grandmasters responded by searching for moves that were not strictly optimal
                but were difficult for other humans to solve.
              </div>
            </div>
            <section>
              <h3>More From Bloomberg</h3>
              <article>
                <h1>Unrelated Story</h1>
                <div>Should never leak into the parsed article body.</div>
              </article>
            </section>
          </article>
        </main>
      </body>
    </html>
  `);

  const snapshot = extractArchiveSnapshot(
    document,
    "https://archive.ph/example",
    null,
  );
  const selected = selectArchiveSourceSpecificContent({
    sourceDocument: document,
    snapshot,
    metadata: collectMetadata(document),
    resolvedUrl: "https://archive.ph/example",
  });

  assertEquals(selected?.strategyId, "bloomberg-archive-source:dom");
  assertEquals(selected?.siteName, "Bloomberg");
  assertEquals(selected?.author, "Kevin Lincoln");
  assertEquals(selected?.blocks, [
    {
      type: "paragraph",
      text:
        "At the biannual 2018 World Chess Championship, Magnus Carlsen defended his title against challenger Fabiano Caruana in a best-of-12 format.",
    },
    {
      type: "paragraph",
      text:
        "The next generation of grandmasters responded by searching for moves that were not strictly optimal but were difficult for other humans to solve.",
    },
  ]);
});

Deno.test("selectArchiveSourceSpecificContent falls back to generic article extraction for archived blogs", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>Descartes y dividir problemas - Xataka</title>
      </head>
      <body>
        <input
          type="text"
          name="q"
          value="https://www.xataka.com/magnet/descartes-dividir-problemas"
        />
        <div id="that-jump-content--default"></div>
        <main>
          <article>
            <div>
              <header>
                <h1>Descartes y dividir problemas</h1>
                <div>
                  Una idea filosófica que sigue siendo útil para resolver problemas modernos.
                </div>
              </header>
            </div>
            <div>
              <figure>
                <img
                  currentSourceUrl="https://i.blogs.es/archive-descartes.png"
                  src="/archive-descartes.png"
                  alt="Ilustración del método de Descartes"
                />
              </figure>
            </div>
            <div>
              <div>
                Por <a rel="author" href="https://www.xataka.com/autor/carlos-prego">Carlos Prego</a>
              </div>
              <time datetime="2026-04-05T11:00:56Z"></time>
              <p>
                Sinceridad ante todo. Lo que tenía entre mis manos era una idea vieja con aplicaciones muy actuales.
              </p>
              <p>
                Descartes proponía dividir cada dificultad en tantas partes como fuera necesario para su mejor solución.
              </p>
              <h2>Dudando de todo</h2>
              <p>
                Para salir del atolladero epistemológico, el filósofo utilizó la duda contra la duda misma.
              </p>
              <div>
                <div>Suscríbete a nuestra newsletter</div>
                <form><input type="email" /></form>
              </div>
              <section>
                <h3>Relacionados</h3>
                <article>
                  <h1>Otro artículo</h1>
                  <p>No debe aparecer.</p>
                </article>
              </section>
            </div>
          </article>
        </main>
      </body>
    </html>
  `);

  const snapshot = extractArchiveSnapshot(
    document,
    "https://archive.ph/generic-example",
    null,
  );
  const selected = selectArchiveSourceSpecificContent({
    sourceDocument: document,
    snapshot,
    metadata: collectMetadata(document),
    resolvedUrl: "https://archive.ph/generic-example",
  });

  assertEquals(selected?.strategyId, "generic-archive-source:readability");
  assertEquals(selected?.siteName, "Xataka");
  assertEquals(selected?.author, "Carlos Prego");
  assertEquals(
    selected?.coverImageUrl,
    "https://i.blogs.es/archive-descartes.png",
  );
  assertEquals(selected?.blocks, [
    {
      type: "paragraph",
      text:
        "Descartes proponía dividir cada dificultad en tantas partes como fuera necesario para su mejor solución.",
    },
    {
      type: "heading",
      level: 2,
      text: "Dudando de todo",
    },
    {
      type: "paragraph",
      text:
        "Para salir del atolladero epistemológico, el filósofo utilizó la duda contra la duda misma.",
    },
  ]);
});

Deno.test("selectArchiveSourceSpecificContent can route archived Substack custom domains by HTML markers", () => {
  const document = documentFromHtml(`
    <html>
      <head>
        <title>The Shape of the Thing - One Useful Thing</title>
      </head>
      <body>
        <input
          type="text"
          name="q"
          value="https://www.oneusefulthing.org/p/the-shape-of-the-thing"
        />
        <div id="that-jump-content--default"></div>
        <main>
          <article class="newsletter-post">
            <header>
              <h1>The Shape of the Thing</h1>
            </header>
            <div class="available-content">
              <div class="body markup">
                <p>
                  We have entered a new phase of AI work, where the question is no longer whether these systems are
                  useful but how organizations change when useful systems are cheap and always available.
                </p>
                <p>
                  Starting in late 2025, we entered a new era thanks to AI agents, where hours of work could be
                  delegated in minutes and management became a key part of knowledge work.
                </p>
                <p>
                  That shift matters because it changes not only how individuals work but how companies organize,
                  experiment and respond to sudden new capabilities.
                </p>
                <div class="subscription-widget">
                  <form><input type="email" /></form>
                </div>
              </div>
            </div>
            <div class="meta">
              <a rel="author" href="https://www.oneusefulthing.org/about">Ethan Mollick</a>
              <time datetime="2026-03-30T12:00:00Z"></time>
            </div>
          </article>
        </main>
      </body>
    </html>
  `);

  const snapshot = extractArchiveSnapshot(
    document,
    "https://archive.ph/substack-example",
    null,
  );
  const selected = selectArchiveSourceSpecificContent({
    sourceDocument: document,
    snapshot,
    metadata: collectMetadata(document),
    resolvedUrl: "https://archive.ph/substack-example",
  });

  assertEquals(selected?.strategyId, "substack-archive-source:dom-body-root");
  assertEquals(selected?.siteName, "One Useful Thing");
  assertEquals(selected?.author, "Ethan Mollick");
  assertEquals(selected?.blocks, [
    {
      type: "paragraph",
      text:
        "We have entered a new phase of AI work, where the question is no longer whether these systems are useful but how organizations change when useful systems are cheap and always available.",
    },
    {
      type: "paragraph",
      text:
        "Starting in late 2025, we entered a new era thanks to AI agents, where hours of work could be delegated in minutes and management became a key part of knowledge work.",
    },
    {
      type: "paragraph",
      text:
        "That shift matters because it changes not only how individuals work but how companies organize, experiment and respond to sudden new capabilities.",
    },
  ]);
});
