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
npm start
```

## Checks

```powershell
npm run check
```
