from __future__ import annotations

import csv
import os
import re
from pathlib import Path

import kagglehub
import psycopg2
from psycopg2 import OperationalError
from psycopg2 import sql


DATASET = "fareselgohary003/global-airports-dataset"
TARGET_DATABASE = os.environ.get("AIRPORTS_DATABASE", "airports")
TABLE_NAME = "airports"


def load_dotenv() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        os.environ.setdefault(key, value)


def validate_database_name(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", name):
        raise ValueError(
            "AIRPORTS_DATABASE must start with a letter or underscore and contain "
            "only letters, numbers, and underscores."
        )
    return name


def pg_config(database: str) -> dict[str, object]:
    return {
        "host": os.environ.get("PGHOST", "localhost"),
        "port": int(os.environ.get("PGPORT", "5432")),
        "user": os.environ.get("PGUSER", "postgres"),
        "password": os.environ.get("PGPASSWORD", ""),
        "dbname": database,
    }


def ensure_database(database: str) -> None:
    admin = psycopg2.connect(**pg_config("postgres"))
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database,))
            if cur.fetchone():
                return
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    finally:
        admin.close()


def find_airports_csv(dataset_path: str) -> Path:
    csv_files = sorted(Path(dataset_path).rglob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(f"No CSV files found in downloaded dataset: {dataset_path}")

    for csv_file in csv_files:
        if csv_file.name.lower() == "airports.csv":
            return csv_file
    return csv_files[0]


def create_table(cur) -> None:
    cur.execute(
        sql.SQL(
            """
            DROP TABLE IF EXISTS {table};
            CREATE TABLE {table} (
                id integer,
                ident text,
                type text,
                name text,
                latitude_deg double precision,
                longitude_deg double precision,
                elevation_ft integer,
                continent text,
                iso_country text,
                iso_region text,
                municipality text,
                scheduled_service text,
                icao_code text,
                iata_code text,
                gps_code text,
                local_code text,
                home_link text,
                wikipedia_link text,
                keywords text
            );
            """
        ).format(table=sql.Identifier(TABLE_NAME))
    )


def load_csv(cur, csv_path: Path) -> int:
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        next(reader)
        row_count = sum(1 for _ in reader)

    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        copy_sql = sql.SQL(
            """
            COPY {table} (
                id, ident, type, name, latitude_deg, longitude_deg, elevation_ft,
                continent, iso_country, iso_region, municipality, scheduled_service,
                icao_code, iata_code, gps_code, local_code, home_link,
                wikipedia_link, keywords
            )
            FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')
            """
        ).format(table=sql.Identifier(TABLE_NAME))
        cur.copy_expert(copy_sql.as_string(cur), handle)

    return row_count


def add_practice_indexes(cur) -> None:
    indexes = [
        ("idx_airports_ident", ["ident"]),
        ("idx_airports_type", ["type"]),
        ("idx_airports_iso_country", ["iso_country"]),
        ("idx_airports_iata_code", ["iata_code"]),
        ("idx_airports_location", ["latitude_deg", "longitude_deg"]),
    ]
    for name, columns in indexes:
        cur.execute(
            sql.SQL("CREATE INDEX {index} ON {table} ({columns})").format(
                index=sql.Identifier(name),
                table=sql.Identifier(TABLE_NAME),
                columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
            )
        )


def main() -> None:
    load_dotenv()
    database = validate_database_name(TARGET_DATABASE)

    print(f"Downloading latest Kaggle dataset: {DATASET}")
    dataset_path = kagglehub.dataset_download(DATASET)
    csv_path = find_airports_csv(dataset_path)
    print(f"Using CSV: {csv_path}")

    try:
        print(f"Preparing PostgreSQL database: {database}")
        ensure_database(database)

        conn = psycopg2.connect(**pg_config(database))
    except OperationalError as exc:
        raise SystemExit(
            "Could not connect to PostgreSQL. Add your connection settings to .env "
            "or set PGHOST, PGPORT, PGUSER, and PGPASSWORD before running this script.\n"
            f"PostgreSQL error: {exc}"
        ) from exc

    try:
        with conn:
            with conn.cursor() as cur:
                create_table(cur)
                row_count = load_csv(cur, csv_path)
                add_practice_indexes(cur)
        print(f"Loaded {row_count:,} rows into {database}.public.{TABLE_NAME}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
