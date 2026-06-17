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

The app expects PostgreSQL on `localhost:5432` by default with:

```text
user: postgres
password: postgres123
database: learn_sql
```

Open Settings in the app and click `Set Up Sample Data`. The server will create or refresh the `learn_sql` database using `seed.sql`.

You can change the connection in Settings before setup. Environment variables also work:

```powershell
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGUSER="postgres"
$env:PGPASSWORD="Angel16989@@"
$env:PGDATABASE="learn_sql"
npm start
```

## Checks

```powershell
npm run check
```
