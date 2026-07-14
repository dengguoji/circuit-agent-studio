# Security Policy

## Supported versions

Until the first stable release, security fixes are applied only to the latest commit on the default branch and the newest tagged release.

## Reporting a vulnerability

Do not disclose vulnerabilities, leaked credentials, private prompts, or user data in a public issue. Use GitHub private vulnerability reporting when it is available for this repository. If it is unavailable, contact the maintainer privately through the GitHub profile associated with the repository.

Include reproduction steps, affected versions, impact, and any suggested mitigation. Do not include real API keys or third-party user data.

## Deployment boundary

Circuit Agent Studio is a local development application, not a hardened multi-tenant service. By default it listens only on `127.0.0.1`. Before exposing it to a network, add authentication, TLS, origin controls, request limits, upload isolation, and a production-grade application server.

## Sensitive local data

The following locations can contain sensitive material and are ignored by Git:

- `backend/.env`
- `backend/tmp/`
- `backend/context_history/`
- `tmp/`
- `output/`

Full context history and LangSmith tracing are disabled by default. Enabling either feature can record prompts, tool results, model responses, and image data.
