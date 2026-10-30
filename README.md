# Guess the Inflation

A daily Wordle-style game. Each day one grocery product and two months are picked (the same for everyone).
Players see the two prices, the dollar change and the percentage change, and get 3 tries to name the product.
Each wrong guess reveals a hint. When the game ends, a chart shows the monthly price over that date range.

Data: Statistics Canada, Table 18-10-0245-01 (`prices.csv`).

## Run on Proxmox (LXC or VM with Docker)

```sh
# copy this folder to the host, then:
docker compose up -d --build
```

The game is served on **http://<host>:8080**. To use a different port, change `8080` in `docker-compose.yml`.

The SQLite database is kept in the `game-data` volume (`/data/game.db`), so daily puzzles survive rebuilds and restarts.

## How it works

- `server.js`: a zero-dependency Node 24 server that uses the built-in `node:sqlite`.
- On startup it imports `prices.csv` into SQLite, upserting new months and products. Then it seeds `hints.json`.
  Hints are only inserted where a product has none, so edits you make directly in the DB are kept.
- The day's puzzle is created on the first request of the day and stored in `daily_puzzles`.
  - A product isn't repeated within 90 days.
  - The two months are at least 12 months apart.
- The day rolls over at midnight in the `TZ` set in `docker-compose.yml` (default `America/Toronto`).

### Tables

| table | purpose |
|---|---|
| `products` | product names |
| `prices` | `product_id, month (YYYY-MM), price` |
| `hints` | `product_id, ord, text`. Hint `ord` is shown after wrong guess #`ord` |
| `daily_puzzles` | `date, product_id, start_month, end_month` |

### Updating the data

Download the newer CSV from StatCan and replace `prices.csv`. Then run `docker compose up -d --build`.
Existing puzzles are kept.

### Run locally without Docker

```sh
node server.js   # http://localhost:3000, needs Node 22.13+
```
