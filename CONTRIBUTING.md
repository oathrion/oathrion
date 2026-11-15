# Contributing to Oathrion

Thank you for wanting to help. Oathrion is a **preview**. The most useful contributions right
now are:
- installation reports, especially `oathrion wrap` with a client or an MCP server we have not
  tried;
- documentation fixes;
- new connectors.

## Before you start

- **A security flaw?** Do not open it in public: follow [`SECURITY.md`](SECURITY.md).
- **A large change?** Open an issue first to discuss it. It saves work we could not accept as
  it is.

## Setting up

```bash
npm ci
npm run typecheck
npm run lint
npm run build        # the `oathrion wrap` end-to-end tests drive the compiled local server
npm test
```

PostgreSQL is not required for most tests, which run on SQLite. The PostgreSQL suites run
with `OATHRION_TEST_POSTGRES_URL` pointing at a throwaway database, and
`OATHRION_REQUIRE_POSTGRES=true` to turn a skip into a failure.

## What a contribution must respect

- **The tests pass**, and a change of behaviour comes with the test that proves it.
- **A claim is proven.** The repository does not say something works without a test, a bench
  or a measurement that shows it. A known limit is written in `docs/limitations.md`.
- **There is one execution path.** An action must never reach a provider without going
  through Oathrion's decision. Several structural tests check this; when they fail, it is not
  a formality.
- **Nothing of one organization leaks into another.** Every query on an organization's table
  carries `organization_id`.
- **The docs are in English, the console is in French.**

## Signing your commits (DCO)

Every commit must carry the line:

```
Signed-off-by: Your Name <you@example.com>
```

It certifies, under the [Developer Certificate of Origin](https://developercertificate.org/),
that you have the right to submit this code under the project's license. `git commit -s` adds
it for you. There is no contributor license agreement.

## License of contributions

A contribution is published under the license of the directory it changes:
- **Apache-2.0** for the core;
- **MIT** for `sdk/`, `cli/`, `examples/` and `conformance/`.

See [`NOTICE`](NOTICE).

## Conduct

See the [Code of Conduct](CODE_OF_CONDUCT.md).
