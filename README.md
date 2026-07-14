# Circuit Agent Studio

[简体中文](README.zh-CN.md)

Circuit Agent Studio is an experimental, editable circuit-diagram workspace driven by a multi-turn AI agent. It combines a structured SVG canvas, a component library, persistent conversations, explicit tool execution, and OpenAI-compatible model providers.

Created and maintained by **Sumal**.

> [!WARNING]
> This project draws diagrams; it does not simulate, electrically verify, or certify circuits. Review every generated result before using it for education, documentation, or engineering work.

## Demo

![Circuit Agent Studio with the agent timeline and editable circuit canvas](docs/images/agent-workspace.jpg)

This is a real local image-reconstruction run with Alibaba Cloud Model Studio `qwen3.7-plus`: the agent placed 9 components, drew 18 wire segments, created 4 junctions, and completed with a `valid` structured-canvas check. The selected resistor remains directly editable while the conversation preserves tool execution and usage history.

### Handwritten input to editable canvas

<table>
  <tr>
    <th width="42%">Handwritten reference</th>
    <th width="58%">Structured SVG result</th>
  </tr>
  <tr>
    <td><img src="docs/images/handwritten-input.png" alt="Handwritten circuit used as the reconstruction input"></td>
    <td><img src="docs/images/generated-canvas.jpg" alt="Editable circuit reconstructed from the handwritten reference"></td>
  </tr>
</table>

The input contains no electrical values. After generation, the component inspector was used to hide library defaults such as resistance and source voltage rather than presenting unobserved values as facts. The handwritten test image was provided by the project maintainer.

### Inspect and refine

![Component inspector editing a resistor in the generated circuit](docs/images/component-inspector.jpg)

Every generated object remains editable: position, orientation, labels, component-specific properties, wires, and junctions can all be refined after the Agent run.

## Highlights

- Editable circuit canvas with components, wires, junctions, import, and export.
- Multi-turn agent that can create and incrementally edit the current canvas.
- 10 px component grid and 5 px connection grid for accurate terminal alignment.
- Manual cancellation, per-turn undo, clear-canvas protection, and loop circuit breakers.
- Persistent conversations, canvas revisions, usage statistics, and provider response IDs.
- OpenAI Responses-first adapters for Alibaba Cloud Model Studio and Volcano Engine Ark.
- Optional image reconstruction and visual review with provider-native asset channels.
- Optional, unabridged local context observation for debugging model requests.

## Architecture

```text
React + SVG canvas
        |
        | HTTP / SSE + structured tool results
        v
Python API + LangGraph step orchestration
        |
        +-- SQLite conversations, events, canvas snapshots
        +-- Circuit Diagram component registry
        +-- OpenAI-compatible provider adapter
                |-- Alibaba Cloud Model Studio
                `-- Volcano Engine Ark
```

The browser is authoritative for the live, editable canvas. The backend persists revisions and model context, while the model requests explicit canvas tools rather than returning an opaque image.

More detail is available in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Python 3.11 or newer
- Node.js 20.19 or newer, or Node.js 22.12 or newer
- npm
- An API key for at least one configured model provider

## Quick start

1. Configure the backend:

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Add either `BAILIAN_API_KEY` or `DOUBAO_API_KEY` to `backend/.env`.

3. Start both services:

   ```bash
   ./start.sh
   ```

4. Open <http://localhost:5178/>.

The start script creates a local Python virtual environment and installs frontend dependencies when necessary. Environment variables already present in the shell take precedence over values loaded from `backend/.env`.

## Providers

The included configuration supports:

- Alibaba Cloud Model Studio / DashScope
- Volcano Engine Ark

Both adapters use the OpenAI Responses shape as the internal protocol. Provider-specific code only handles documented compatibility differences, file APIs, and usage normalization.

Model identifiers and capabilities are defined in `backend/server.py`. Provider APIs and model availability can change; verify the current provider documentation before changing them.

## Privacy and security

Public-safe defaults are intentional:

- The backend and frontend listen on `127.0.0.1` by default.
- Direct cross-origin API access is limited to `http://localhost:5178` by default.
- LangSmith tracing is disabled by default.
- Full context history is disabled by default.
- Secrets are read from environment variables or the ignored `backend/.env` file.
- Conversations, uploaded assets, and diagnostic output are stored only in ignored runtime directories.

To inspect complete provider requests and responses locally, explicitly set:

```bash
CIRCUIT_CONTEXT_HISTORY_ENABLED=true
CIRCUIT_CONTEXT_HISTORY_DIR=./context_history
```

These files can contain prompts, user content, tool results, errors, and inline image data. Never commit or share them without review.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and deployment considerations.

## Development

Run frontend checks:

```bash
cd frontend
npm ci
npm run build
npx --yes vitest@2.1.8 run
```

Run backend checks:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m py_compile \
  server.py prompt_asset.py component_registry.py persistence.py \
  provider_adapter.py api_contracts.py context_observer.py
PYTHONWARNINGS=error .venv/bin/python -m unittest discover -s tests -v
```

Tests use mocked provider responses and do not require real API keys.

## Project status

Circuit Agent Studio is an early-stage demonstration and research project. Important limitations include:

- no SPICE simulation or electrical-rule checking;
- provider behavior and Responses compatibility can vary by model;
- generated topology and labels can be incorrect;
- uploaded images are sent to the selected external provider;
- the local HTTP server is intended for development, not direct internet exposure.

## Components and attribution

The bundled circuit component definitions are a selected snapshot of [Circuit Diagram Components](https://github.com/circuitdiagram/components), licensed under GNU GPL v2.0. Original author metadata is preserved. Two XML defaults differ from the referenced upstream snapshot and carry modification notices in their files.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source, license, version, and modification details.

Circuit Agent Studio is not affiliated with or endorsed by Circuit Diagram, OpenAI, Alibaba Cloud, ByteDance, or Volcano Engine. Product names are used only to identify compatible services and source projects.

## License

This repository is distributed under the [GNU General Public License v2.0](LICENSE). Bundled third-party material remains subject to its original notices and licenses.

## Citation

If you use this project in research, teaching, or a publication, use the metadata in [CITATION.cff](CITATION.cff). GitHub can render it as APA and BibTeX from the repository sidebar.

## References

- [LangGraph documentation](https://docs.langchain.com/oss/python/langgraph/overview)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [Alibaba Cloud Model Studio OpenAI compatibility](https://help.aliyun.com/zh/model-studio/openai-compatible)
- [Alibaba Cloud Model Studio Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)
- [Volcano Engine Ark Responses API](https://www.volcengine.com/docs/82379/1569618?lang=zh)
- [Circuit Diagram component documentation](https://www.circuit-diagram.org/docs/components/introduction)

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the project [Code of Conduct](CODE_OF_CONDUCT.md).
