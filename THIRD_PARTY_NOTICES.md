# Third-Party Notices

This file records third-party material distributed with Circuit Agent Studio. Package-manager dependencies retain the notices and license files included in their respective packages.

## Circuit Diagram Components

- Project: Circuit Diagram Components
- Source: <https://github.com/circuitdiagram/components>
- Reference commit: `9ae354ef30f52310f3c78ece8573847e03a2d5aa`
- License: GNU General Public License, version 2
- Bundled path: `backend/assets/components-master`
- Local catalog derived from the bundled definitions: `backend/assets/component_list.json`
- Copyright: the respective Circuit Diagram component contributors

The bundle contains a selected set of upstream XML component definitions. Original `author` metadata is preserved in the XML files. The upstream README and complete GPL v2 license text are retained at:

- `backend/assets/components-master/README.md`
- `backend/assets/components-master/LICENSE.txt`

The selected bundle was compared with the reference commit on 2026-07-14. All selected XML files matched except the following documented changes:

| File | Change |
|---|---|
| `common/source/source.xml` | Default `Type` changed from `Rail2` to `Ground`. |
| `common/switch/switch.xml` | Default `Type` changed from `Push` to `Changeover Switch`. |

Both modified XML files carry an inline modification notice. Circuit Agent Studio's parser, editor, renderer, and agent implementation are separate project code; the bundled component definitions remain attributed to their original contributors.

## Direct application dependencies

The application also uses these package-manager dependencies:

| Project | License | Source |
|---|---|---|
| React / React DOM | MIT | <https://github.com/facebook/react> |
| Lucide React | ISC | <https://github.com/lucide-icons/lucide> |
| Vite | MIT | <https://github.com/vitejs/vite> |
| TypeScript | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| LangGraph | MIT | <https://github.com/langchain-ai/langgraph> |
| LangSmith Python SDK | MIT | <https://github.com/langchain-ai/langsmith-sdk> |
| OpenAI Python SDK | Apache-2.0 | <https://github.com/openai/openai-python> |
| PyYAML | MIT | <https://github.com/yaml/pyyaml> |

This summary is provided for convenience and does not replace the license text distributed by each dependency. Release maintainers should regenerate dependency-license reports before publishing a release.
