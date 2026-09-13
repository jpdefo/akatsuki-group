# Akatsuki Group Monitor

Live project: https://jpdefo.github.io/akatsuki-group/

Akatsuki Group Monitor is a personal project designed to manage the operational complexity of a SteamGifts giveaway community. The goal was to build a lightweight, data-driven dashboard that helps track member activity, cycle performance, giveaway outcomes, and event scoring in a single place.

## Project overview

This project solves a real operational problem: community group management generates large volumes of data from SteamGifts, member progress, and recurring events. Instead of relying on scattered spreadsheets or manual tracking, I built an application that consolidates that information into a structured, readable system.

## What was implemented

- Dashboard for recent activity, member status, and giveaway history
- Cycle tracking and monthly progress monitoring
- Summer event scoring with creator and entrant point calculations
- Manual override system to correct synced records without destroying source data
- Steam data refresh automation for library and progress insights
- Static export pipeline for GitHub Pages deployment
- Validation and quality checks for frontend and data integrity

## Technical approach

- Python backend for data processing, refresh jobs, and serving local APIs
- Vanilla JavaScript frontend for a lightweight, dependency-free UI
- JSON-based persistence to store synced data, metadata, and overrides
- GitHub Pages deployment for a static public version of the dashboard
- Node-based validation with linting and tests to maintain reliability

## Why this project is interesting

This project combines product thinking, data engineering, and frontend implementation in a single workflow. It required solving problems around:

- data normalization from multiple sources
- maintaining data quality in the presence of manual edits
- designing a UI that turns operational data into useful decisions
- creating automated refresh workflows without adding unnecessary complexity
- building something usable as both a local tool and a public web dashboard

## Skills demonstrated

- Full-stack project design for a small but real-world application
- Backend automation with Python
- Frontend development without frameworks
- Data modeling and state management
- Deployment and static hosting workflows
- Practical problem solving in a domain-specific system

## Run locally

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
npm install
python server.py
```

Open: http://127.0.0.1:4173

## Notes

This project reflects my approach to building maintainable tools: simple architecture, clear data flow, and real utility over unnecessary complexity. It is a focused example of turning messy operational data into a structured system that is understandable, reliable, and easy to extend.