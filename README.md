# SnowQuery

SnowQuery is a local PostgreSQL learning lab. It gives you a Snowflake-style worksheet UI, sample SQL lessons, query history, CSV export, and a data explorer.

## Start

Double-click `Open_SnowQuery.cmd`, or run:

```powershell
npm start
```

Then open:

```text
http://localhost:3000
```

## Database Setup

The app reads PostgreSQL connection settings from `.env` first, then falls back to safe local defaults:

```text
PORT=3000
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password_here
PGDATABASE=postgres
```

Create a `.env` file next to `server.js`, then open Settings in the app and click `Set Up Sample Data`. The server will create or refresh the `learn_sql` database using `seed.sql`.

You can change the connection in Settings before setup. Environment variables also work:

```powershell
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGUSER="postgres"
$env:PGPASSWORD="your_password_here"
$env:PGDATABASE="postgres"
$env:PORT="3000"
npm start
```

## Load the Global Airports Dataset

Install the Python importer dependencies:

```powershell
python -m pip install -r requirements.txt
```

Make sure `.env` has your PostgreSQL connection settings, then run:

```powershell
python scripts/import_airports.py
```

This downloads the latest Kaggle dataset from `fareselgohary003/global-airports-dataset`,
creates an `airports` database if needed, and loads `public.airports`.

To use a different database name:

```powershell
$env:AIRPORTS_DATABASE="learn_sql"
python scripts/import_airports.py
```

## Checks

```powershell
npm run check
```
