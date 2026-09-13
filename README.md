# Akatsuki Group Monitor

Personal project focused on building a practical dashboard for a SteamGifts giveaway group. The goal was to turn messy operational data into a clear, usable system for tracking activity, winners, progress, and event scoring without relying on a heavy framework.

## What I built

- Group dashboard for member activity, giveaway history, and status overview
- Cycle tracking and monthly progress reporting
- Summer event scoring with creator and entrant point calculations
- Admin workflow for manual corrections while preserving synced data integrity
- Automated refresh jobs for Steam library and progress data
- Static site export for GitHub Pages deployment

## Stack

- Python for the backend, automation jobs, data processing, and API serving
- JavaScript for the frontend rendering and client-side state management
- JSON as the app’s persistent data layer
- GitHub Pages for public deployment of the static dashboard
- Node + ESLint + tests for validation and code quality

## Architecture

The project follows a simple but effective pattern: the Python backend ingests and normalizes external data, the frontend renders dashboards from that state, and the JSON files under data/ act as the source of truth. This makes the app easy to run locally while still supporting a publishable static version.

## Why this project matters

This project reflects a real-world workflow problem: managing a community-driven giveaway group requires data cleanup, tracking, rules enforcement, and reporting. I built it to solve that with a clean and maintainable approach that combines data processing, automation, and user-facing reporting.

It also gave me experience with:

- data modeling and normalization
- API-driven and file-based persistence patterns
- frontend state handling in vanilla JavaScript
- operational automation and validation workflows
- building a project that can be deployed as a lightweight static site

## Run locally

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
npm install
python server.py
```

Then open: http://127.0.0.1:4173

## Notes

This is a personal project with a clear focus on real-world utility, maintainability, and automation. The goal was not only to build a dashboard, but to create a structured system that could support ongoing operational decisions over time.