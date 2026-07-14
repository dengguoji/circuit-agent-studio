# Contributing

Thank you for considering a contribution to Circuit Agent Studio.

## Before opening a change

1. Search existing issues and pull requests.
2. Open an issue first for major behavior, protocol, storage, or component-format changes.
3. Do not include API keys, user conversations, uploaded images, provider responses, or local databases.
4. Preserve all third-party copyright and license notices.

## Local setup

Follow the development instructions in [README.md](README.md). Real provider credentials are not required for the test suite.

## Change expectations

- Keep the browser as the authority for the live editable canvas.
- Preserve backward compatibility for saved canvas JSON unless a migration is included.
- Keep component origins on the 10 px grid and connection geometry on the 5 px grid.
- Treat full context observation and external tracing as explicit opt-in features.
- Document provider-specific behavior with a link to current official documentation.
- Do not remove or rewrite author metadata in bundled component XML.
- Add a dated modification notice when changing a GPL-licensed component file.

## Validation

Run the frontend and backend commands documented in the README. Pull requests should explain:

- what changed;
- why the change is needed;
- user-visible impact;
- validation performed;
- any provider behavior that could not be tested without a live API.

## Commit and pull request scope

Keep commits focused. Generated output, dependency directories, local databases, screenshots containing private data, and full context-history files must not be committed.

By contributing, you agree that your contribution may be distributed under the repository's GPL v2 license.
