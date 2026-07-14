# Architecture

## Responsibility boundaries

Circuit Agent Studio separates editable state, agent orchestration, provider compatibility, and persistence.

### Browser

The React application owns the live canvas and executes structured canvas tools. It renders components and wires as SVG, validates geometry, manages manual editing, and sends revisioned snapshots to the backend.

### Backend API

The Python HTTP server provides conversation, turn, asset, model, component, and canvas endpoints. Turn responses can be streamed as Server-Sent Events. SQLite stores conversations, event timelines, turn status, usage, provider response IDs, and canvas snapshots.

### Agent step

LangGraph wraps one model step. The application loop remains explicit: the model requests tools, the browser executes them, the backend receives results, and the next step continues from the updated canvas. Run budgets and no-progress detection stop unproductive repair loops.

### Provider adapter

The adapter uses the OpenAI Responses request shape as the internal protocol. Provider-specific handling is limited to documented compatibility differences, reasoning controls, asset upload, response parsing, and usage normalization.

### Component registry

The backend parses Circuit Diagram XML assets into a searchable catalog and detailed rendering metadata. The registry preserves source-declared properties, configurations, orientation rules, labels, and connection points.

## Data flow

```text
User instruction
      |
      v
Conversation turn ------> SQLite event timeline
      |
      v
Provider request <------ previous response ID / compact history
      |
      v
Tool calls -------------> Browser tool executor
                              |
                              v
                         Editable SVG canvas
                              |
                              +----> revisioned canvas snapshot
                              `----> structured tool results
                                         |
                                         `----> next provider step
```

## Coordinate model

- Component origins: 10 px grid.
- Wire endpoints and junctions: 5 px grid.
- Visible minor grid: 10 px.
- Wires: one horizontal or vertical segment per object.
- Connection preference: exact component port, junction, wire endpoint, wire midpoint, then 5 px grid.

## Persistence and privacy

The regular event store sanitizes data intended for durable application history. An independent context observer can capture complete logical messages, exact provider requests, raw responses, and errors. It is disabled by default because its output is intentionally unabridged.

## Cancellation and side effects

Every turn has a client-generated identifier and an abort path. Cancellation stops pending provider work, ignores late responses, and preserves tools already applied to the canvas. The user can restore the pre-turn snapshot with one action.

Protocol fallback is allowed only before a turn has executed canvas tools, preventing duplicate side effects.
