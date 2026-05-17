# Project: cdl-lonboard-05-2026

Exploring [Lonboard](https://developmentseed.org/lonboard/)'s new client-side COG rendering with USDA Cropland Data Layer (CDL) data from the Microsoft Planetary Computer.

## Stack
- [lonboard](https://developmentseed.org/lonboard/) — GPU map rendering in Jupyter
- [async-geotiff](https://developmentseed.org/async-geotiff/) — async COG reader
- [obstore](https://developmentseed.org/obstore/) — Rust-backed object store client (S3, Azure, GCS)
- [pystac-client](https://pystac-client.readthedocs.io/) — STAC search
- SAS signing handled by obstore's built-in [`PlanetaryComputerCredentialProvider`](https://developmentseed.org/obstore/latest/api/auth/planetary-computer/) — no Azure creds, auto-refresh
- Notebooks run via `uvx juv run <notebook>.ipynb` (inline PEP 723 deps)

## Notebooks
- `raster-cog-nlcd-server.ipynb` — original NLCD-on-S3 example (upstream from Lonboard examples)
- `raster-cog-cdl-pc.ipynb` — CDL via Microsoft Planetary Computer (Azure blob + SAS)

## Working agreements
- No tile server / proxy — everything is client-side (notebook process fetches COG byte ranges directly from Azure with a SAS token, renders RGBA in-process, hands PNG to deck.gl).
- Optional `PC_SDK_SUBSCRIPTION_KEY` env var avoids anonymous rate limits (free signup).
- Memory lives in `.claude/memory/` (gitignored), per global rules.
