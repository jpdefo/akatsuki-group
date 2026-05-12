# Possible Improvements

## Purpose Of This Document

This file is the working roadmap for improving Akatsuki Group Monitor. Unlike the README, it is supposed to be forward-looking. It should capture what is outdated, what should be improved next, and how to improve it in a realistic order.

## Current Project Snapshot

The project is already functional and covers the group's real workflows well. The current state is roughly:

- local Python server with JSON-backed APIs and utilities
- vanilla multi-page frontend centered on `app.js`
- three SteamGifts collection paths: userscript, bookmarklet, and Playwright public sync
- static export and validation flow for GitHub Pages
- CI workflow that rebuilds the public site from source on push to `main`
- summer-event accounting, cycle tracking, overrides, and Steam progress refreshes already in use

At the same time, several parts of the codebase still reflect fast iteration rather than long-term maintainability.

## Main Improvement Areas

### 1. Documentation And Setup

What is missing or weak now:

- environment setup is still partly implicit
- there is no `.env.example`
- there is no dedicated Python dependency manifest
- collector workflows are documented, but mostly through scripts and helper pages rather than clear contributor docs

What to improve:

- add `.env.example` with every supported variable
- add `requirements.txt` or `pyproject.toml`
- document the authenticated collector workflow, public sync workflow, and publish flow in one place
- document the important JSON files and what owns them

### 2. Code Organization

What is missing or weak now:

- `app.js` is large and mixes state loading, normalization, rendering, admin actions, and business rules
- collectors still duplicate parsing logic across three implementations
- the project has strong domain rules, but their boundaries are not always explicit

What to improve:

- split `app.js` into smaller feature modules
- extract shared collector parsing helpers where practical
- keep cycle logic, summer-event logic, and sync normalization in narrower units

### 3. Test Coverage And Regression Safety

What is missing or weak now:

- there are syntax checks, but not real automated domain tests
- tricky edge cases are currently protected mostly by memory and manual checking
- Python code is not validated in CI beyond the export workflow itself succeeding

What to improve:

- add unit tests for cycle rules, month overrides, and giveaway classification
- add fixture-based tests for sync normalization and merge behavior
- add regression tests for known problematic real-world giveaways
- add Python-side checks to CI

### 4. Data Contracts And Validation

What is missing or weak now:

- JSON payload structures are defined by code, not by explicit schema documents
- schema evolution is possible, but not guided by versioned migration rules
- malformed data is often handled defensively, but not always surfaced clearly

What to improve:

- document the main JSON payload shapes
- add validation helpers for major persisted files
- introduce small migration helpers when stored structures change

### 5. Operations And Observability

What is missing or weak now:

- long-running refreshes still have limited visibility
- run history and per-user failures are not rich enough
- data safety depends heavily on git and manual care rather than explicit backup conventions

What to improve:

- persist richer refresh metadata
- expose better progress and completion information in the UI
- add clearer logs for collector runs, refresh runs, and export validation
- define a backup strategy for `data/`

### 6. UX And Admin Ergonomics

What is missing or weak now:

- admin diagnostics can still be sparse when data is inconsistent
- sync freshness and cache state are not surfaced as clearly as they could be
- expensive actions can still feel opaque while they are running

What to improve:

- show last successful run times and current in-progress state more clearly
- improve validation and error messages on admin-facing actions
- add a dedicated status view or status panel for sync health and cache freshness

## Improvement Plan

The best path is incremental. The goal should be to improve reliability and maintainability without disrupting the current working flow.

### Phase 1: Project Hygiene

Goal:

- make the repo easier to set up and safer to run on a new machine

Tasks:

- add `.env.example`
- add `requirements.txt` or `pyproject.toml`
- keep the README focused on the project itself
- keep this roadmap current when workflows change

Expected result:

- setup becomes reproducible
- project expectations become clearer
- contributors do not need to infer the environment from scripts alone

### Phase 2: Validation And CI

Goal:

- catch breakage earlier and reduce manual regression risk

Tasks:

- add Python validation in CI
- add initial unit tests for cycle rules and sync normalization
- add a small set of regression fixtures for tricky SteamGifts records

Expected result:

- behavior regressions become easier to catch before deployment
- rule changes can be made with more confidence

### Phase 3: Modularization

Goal:

- reduce the maintenance cost of feature work

Tasks:

- split `app.js` into focused modules
- separate rendering from normalization and state mutation where possible
- reduce duplication between collector implementations

Expected result:

- future changes become smaller and easier to review
- bugs become easier to isolate
- collector fixes can be applied more consistently

### Phase 4: Data Contracts And Admin Reliability

Goal:

- make stored data and admin workflows more explicit and robust

Tasks:

- document payload shapes for sync, progress, library, and overrides
- add validation when loading critical JSON data
- add migration helpers when stored structures change
- improve admin-facing diagnostics for bad or partial data

Expected result:

- corrupted or inconsistent data becomes easier to detect
- storage changes become less risky
- admin workflows become more trustworthy

### Phase 5: Operational Visibility

Goal:

- make long-running work and refresh state easier to understand

Tasks:

- persist richer refresh metadata such as scope, duration, and failures
- show clearer progress in the UI during full refreshes
- improve logging for exports, collectors, and refresh jobs
- define backup and restore conventions for important JSON data

Expected result:

- operators can see what happened, what is still running, and what failed
- recovery from mistakes becomes more straightforward

## Suggested Near-Term Tasks

If the goal is to make the project more professional without slowing current feature work too much, these are the best next concrete tasks:

1. Add `.env.example`.
2. Add a Python dependency manifest.
3. Add Python checks to GitHub Actions.
4. Add initial tests for cycle rules and sync normalization.
5. Start splitting `app.js` by feature area.

## Notes For Future Updates

Keep this document practical. It should be updated when:

- the setup flow changes
- CI coverage changes
- a large refactor is completed
- a previously planned improvement becomes unnecessary
- a new class of operational problem appears
