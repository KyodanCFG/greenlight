# CLAUDE.md

## Project

Greenlight

This repository is a fixed three-day build: turn a short creative brief into a working game-jam asset workflow on the Meshy API.

## Product Intent

The project should help a small game-jam team turn a game-jam theme and short creative brief into a reviewable asset plan and a small, cohesive collection of generated 3D assets.

The application should demonstrate why developers would integrate the Meshy API into a custom workflow instead of manually generating assets one at a time through the Meshy web interface.

## Primary Audience

Small game-jam teams, especially:

- teams without a dedicated 3D artist
- teams that need placeholder assets quickly
- developers trying to begin gameplay prototyping during the first hours of a jam

## Current Proposed Inputs

- game-jam theme
- game concept or core mechanic
- setting or genre
- tone
- visual style
- optional image references
- asset plan and counts

Potential asset categories include:

- player character
- NPCs
- enemies
- props
- buildings
- environment pieces

## Proposed Workflow

1. User enters a game-jam brief.
2. Application produces a structured asset manifest.
3. User reviews and edits the manifest before any API credits are spent.
4. User chooses which assets to generate.
5. Application submits generation tasks through the Meshy API.
6. Application tracks task progress and handles failures.
7. User previews completed models.
8. User downloads an organized starter kit with models, prompts, and metadata.

## Project Priorities

In order:

1. A polished, understandable end-user experience.
2. A clear developer use case.
3. Ready-to-publish developer content.
4. A measurable distribution and growth strategy.
5. Technical implementation quality sufficient to make the demo reliable.

The brief explicitly prioritizes quality over scope.

## Constraints

- Total project duration is three days.
- Keep the MVP small.
- Do not build authentication.
- Do not build user accounts.
- Do not add a database unless specifically approved.
- Do not build collaboration or team features.
- Do not build billing.
- Do not expose the Meshy API key in client-side code.
- Do not commit secrets.
- Do not make unsupported claims about Meshy API capabilities.
- Verify all API behavior against official Meshy documentation.
- Prefer reliable polling over unnecessary infrastructure.
- Prefer a polished vertical slice over broad feature coverage.
- Do not begin application implementation until the discovery documents are reviewed and approved.

## Development Rules

- Explain significant architectural decisions before implementing them.
- Record major decisions in `docs/DECISIONS.md`.
- Keep `README.md` accurate to the implemented state.
- Do not claim unfinished features.
- Use small, reviewable implementation steps.
- Validate each vertical slice before continuing.
- Add clear error states and user-facing recovery guidance.
- Keep generated assets outside Git by default.
- Use environment variables for all secrets.
- Avoid unnecessary dependencies.
- Prefer readable code over clever abstractions.

## Current Phase

Phase 1: repository initialization and discovery preparation.

During this phase:

- create and organize documentation
- inspect the brief
- identify questions requiring verification
- do not build application code