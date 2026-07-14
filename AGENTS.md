# Circuit Agent Studio Contributor Guide

Read `README.md`, `CONTRIBUTING.md`, and `THIRD_PARTY_NOTICES.md` before changing the project.

## Repository rules

1. Never commit `.env`, API keys, conversation databases, uploaded images, full context-history files, build output, or dependency directories.
2. Preserve third-party author and license notices. Document changes to files under `backend/assets/components-master` with a dated inline notice and update `THIRD_PARTY_NOTICES.md`.
3. Keep component origins on the 10 px grid and connection geometry on the 5 px grid.
4. Keep full context history, tracing, and non-local network binding opt-in.
5. Do not change provider parameters without checking current official documentation.
6. Do not commit or push unless the user explicitly requests it.

## Verification

- Frontend: `npm run build` and `npx --yes vitest@2.1.8 run` from `frontend/`.
- Backend: compile the Python entry points and run `PYTHONWARNINGS=error python -m unittest discover -s tests -v` from `backend/`.
- Provider tests must use mocks unless the user explicitly authorizes a live API call.
