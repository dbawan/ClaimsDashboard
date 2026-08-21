#!/usr/bin/env python3
"""Export the exact raw MySQL rows used by the claim dashboard.

Usage:
    python3 export_claim_mysql_data.py 78820
    python3 export_claim_mysql_data.py 78820A --output claim_78820.txt

The script loads the same .env variables as the dashboard, resolves aliases in
the same order, and queries the same three MySQL sources:

* unidata.FlattenTransctions2
* uniCoin.ClaimStatus
* RCM.edi_835

The output is a private, human-readable text file containing the unmodified
database rows as formatted JSON. Salesforce comments and Gemini classifications
are intentionally excluded because they are not MySQL data.

Install either supported MySQL driver before running:
    python3 -m pip install mysql-connector-python
or:
    python3 -m pip install PyMySQL
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence


MAX_CANDIDATES = 30
MAX_ROWS_PER_SOURCE = 25_000
SELECT_ONLY = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")
VALID_CLAIM_SEARCH = re.compile(r"^[A-Za-z0-9._| -]+$")


class ClaimNotFoundError(RuntimeError):
    pass


class AmbiguousClaimError(RuntimeError):
    def __init__(self, claim_ids: Sequence[str]) -> None:
        self.claim_ids = list(claim_ids)
        super().__init__(
            "The identifier matched multiple encounter IDs: "
            + ", ".join(self.claim_ids)
        )


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    user: str
    password: str
    database: Optional[str]
    ssl: bool


@dataclass(frozen=True)
class SourceConfig:
    transactions_schema: str
    transactions_table: str
    claim_status_schema: str
    claim_status_table: str
    edi_schema: str
    edi_table: str


def eprint(*values: Any) -> None:
    print(*values, file=sys.stderr)


def load_env_file(path: Path) -> None:
    """Load a simple dotenv file while preserving already-exported values."""
    if not path.exists():
        return

    with path.open("r", encoding="utf-8") as env_file:
        for line_number, raw_line in enumerate(env_file, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                raise RuntimeError(f"Invalid .env entry at {path}:{line_number}")

            key, value = line.split("=", 1)
            key = key.strip()
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise RuntimeError(f"Invalid .env variable at {path}:{line_number}")

            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            else:
                value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            os.environ.setdefault(key, value)


def env_value(*names: str, default: Optional[str] = None) -> Optional[str]:
    for name in names:
        value = os.getenv(name)
        if value not in {None, ""}:
            return value
    return default


def boolean_value(value: Optional[str], default: bool = False) -> bool:
    if value in {None, ""}:
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on", "required", "require"}:
        return True
    if normalized in {"0", "false", "no", "off", "disabled", "disable"}:
        return False
    raise ValueError(f"Expected a boolean value, received {value!r}")


def database_config() -> DatabaseConfig:
    user = env_value("DB_USER", "MYSQL_USER")
    if not user:
        raise RuntimeError("DB_USER (or MYSQL_USER) is required in .env or the shell")

    raw_port = env_value("DB_PORT", "MYSQL_PORT", default="3306")
    try:
        port = int(raw_port or "3306")
    except ValueError as exc:
        raise RuntimeError("DB_PORT must be an integer") from exc

    return DatabaseConfig(
        host=env_value("DB_HOST", "MYSQL_HOST", default="127.0.0.1") or "127.0.0.1",
        port=port,
        user=user,
        password=env_value("DB_PASSWORD", "MYSQL_PASSWORD", default="") or "",
        database=env_value("DB_NAME", "MYSQL_DATABASE"),
        ssl=boolean_value(env_value("DB_SSL", "MYSQL_SSL"), False),
    )


def safe_identifier(value: Optional[str], fallback: str) -> str:
    candidate = value or fallback
    if not SAFE_IDENTIFIER.fullmatch(candidate):
        raise RuntimeError(f"Invalid database identifier: {candidate}")
    return candidate


def source_config() -> SourceConfig:
    return SourceConfig(
        transactions_schema=safe_identifier(os.getenv("UNIDATA_SCHEMA"), "unidata"),
        transactions_table=safe_identifier(
            os.getenv("TRANSACTIONS_TABLE"), "FlattenTransctions2"
        ),
        claim_status_schema=safe_identifier(os.getenv("UNICOIN_SCHEMA"), "uniCoin"),
        claim_status_table=safe_identifier(os.getenv("CLAIM_STATUS_TABLE"), "ClaimStatus"),
        edi_schema=safe_identifier(os.getenv("RCM_SCHEMA"), "RCM"),
        edi_table=safe_identifier(os.getenv("EDI_835_TABLE"), "edi_835"),
    )


def qualified_table(schema: str, table: str) -> str:
    return f"`{schema}`.`{table}`"


def normalize_identifier(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def assert_valid_claim_search(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Enter a claim ID")
    if len(raw) > 80 or not VALID_CLAIM_SEARCH.fullmatch(raw):
        raise ValueError("Use a valid claim ID containing letters and numbers")
    return raw


def encounter_candidate_from_era_reference(value: Any) -> str:
    normalized = normalize_identifier(value)
    match = re.fullmatch(r"(\d{4,})[A-Z]+", normalized)
    return match.group(1) if match else ""


def submission_suffix(encounter_id: Any, era_reference: Any) -> Optional[str]:
    encounter = normalize_identifier(encounter_id)
    reference = normalize_identifier(era_reference)
    if not encounter or not reference or not reference.startswith(encounter):
        return None
    suffix = reference[len(encounter):]
    return suffix if re.fullmatch(r"[A-Z]*", suffix) else None


def unique(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_identifier(value)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def unique_raw(values: Iterable[Any]) -> list[Any]:
    """Match the repository's raw alias de-duplication before normalization."""
    result: list[Any] = []
    seen: set[Any] = set()
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def begin_read_only_transaction(connection: Any) -> None:
    cursor = connection.cursor()
    try:
        cursor.execute("SET SESSION TRANSACTION READ ONLY")
        cursor.execute("START TRANSACTION READ ONLY")

        verified = False
        for variable in ("transaction_read_only", "tx_read_only"):
            try:
                cursor.execute(f"SELECT @@session.{variable}")
                row = cursor.fetchone()
                value = row[0] if not isinstance(row, Mapping) else next(iter(row.values()))
                if int(value) != 1:
                    raise RuntimeError("MySQL session did not enter read-only mode")
                verified = True
                break
            except Exception as exc:
                if "unknown system variable" not in str(exc).lower():
                    raise

        if not verified:
            raise RuntimeError("Could not verify MySQL read-only session mode")
    finally:
        cursor.close()


class ReadOnlyMySQL:
    def __init__(self, connection: Any, driver: str) -> None:
        self.connection = connection
        self.driver = driver

    def select(self, sql: str, parameters: Sequence[Any] = ()) -> list[dict[str, Any]]:
        trimmed = sql.strip()
        if not SELECT_ONLY.match(trimmed):
            raise RuntimeError("Blocked non-SELECT database statement")
        if ";" in trimmed.rstrip(";"):
            raise RuntimeError("Blocked multi-statement database query")

        if self.driver == "mysql.connector":
            cursor = self.connection.cursor(dictionary=True)
        else:
            cursor = self.connection.cursor()
        try:
            cursor.execute(sql, tuple(parameters))
            return [dict(row) for row in cursor.fetchall()]
        finally:
            cursor.close()

    def close(self) -> None:
        try:
            self.connection.rollback()
        finally:
            self.connection.close()


def connect_mysql(config: DatabaseConfig) -> ReadOnlyMySQL:
    try:
        import mysql.connector  # type: ignore

        options: dict[str, Any] = {
            "host": config.host,
            "port": config.port,
            "user": config.user,
            "password": config.password,
            "connection_timeout": 15,
            "autocommit": False,
            "ssl_disabled": not config.ssl,
            "charset": "utf8mb4",
            "use_unicode": True,
        }
        if config.database:
            options["database"] = config.database
        connection = mysql.connector.connect(**options)
        begin_read_only_transaction(connection)
        return ReadOnlyMySQL(connection, "mysql.connector")
    except ImportError:
        pass

    try:
        import pymysql  # type: ignore

        options = {
            "host": config.host,
            "port": config.port,
            "user": config.user,
            "password": config.password,
            "connect_timeout": 15,
            "read_timeout": 120,
            "write_timeout": 30,
            "autocommit": False,
            "charset": "utf8mb4",
            "cursorclass": pymysql.cursors.DictCursor,
        }
        if config.ssl:
            options["ssl"] = {}
        if config.database:
            options["database"] = config.database
        connection = pymysql.connect(**options)
        begin_read_only_transaction(connection)
        return ReadOnlyMySQL(connection, "pymysql")
    except ImportError as exc:
        raise RuntimeError(
            "Install mysql-connector-python or PyMySQL before running this script"
        ) from exc


def transaction_candidates(
    database: ReadOnlyMySQL,
    sources: SourceConfig,
    identifier: Any,
) -> list[str]:
    table = qualified_table(sources.transactions_schema, sources.transactions_table)
    rows = database.select(
        f"""
        SELECT DISTINCT CAST(ENCOUNTERID AS CHAR) AS encounterId
          FROM {table}
         WHERE ENCOUNTERID = %s
            OR Claim835ID = %s
            OR CLAIMID = %s
            OR ENCOUNTERGUID = %s
         LIMIT {MAX_CANDIDATES + 1}
        """,
        (identifier, identifier, identifier, identifier),
    )
    return unique(row.get("encounterId") for row in rows)


def era_aliases(
    database: ReadOnlyMySQL,
    sources: SourceConfig,
    identifier: str,
) -> list[Any]:
    claim_status_table = qualified_table(
        sources.claim_status_schema, sources.claim_status_table
    )
    edi_table = qualified_table(sources.edi_schema, sources.edi_table)
    claim_status_rows = database.select(
        f"""
        SELECT DISTINCT PatientControlNumber
          FROM {claim_status_table}
         WHERE ClaimNumber = %s OR PatientControlNumber = %s
         LIMIT {MAX_CANDIDATES + 1}
        """,
        (identifier, identifier),
    )
    edi_rows = database.select(
        f"""
        SELECT DISTINCT patient_control_number
          FROM {edi_table}
         WHERE payer_claim_control = %s OR patient_control_number = %s
         LIMIT {MAX_CANDIDATES + 1}
        """,
        (identifier, identifier),
    )
    return unique_raw(
        [row.get("PatientControlNumber") for row in claim_status_rows]
        + [row.get("patient_control_number") for row in edi_rows]
    )


def resolve_transaction_claim_id(
    database: ReadOnlyMySQL,
    sources: SourceConfig,
    search_id: str,
) -> str:
    candidates = transaction_candidates(database, sources, search_id)

    if not candidates:
        aliases = era_aliases(database, sources, search_id)
        for alias in aliases[:MAX_CANDIDATES]:
            family_candidate = encounter_candidate_from_era_reference(alias)
            candidates = unique(
                [
                    *candidates,
                    *transaction_candidates(database, sources, alias),
                    *(
                        transaction_candidates(database, sources, family_candidate)
                        if family_candidate
                        else []
                    ),
                ]
            )

    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise AmbiguousClaimError(candidates[:10])
    raise ClaimNotFoundError(f"No claim was found for {search_id}")


def ensure_complete(rows: list[dict[str, Any]], source_name: str, claim_id: str) -> list[dict[str, Any]]:
    if len(rows) > MAX_ROWS_PER_SOURCE:
        raise RuntimeError(
            f"{source_name} returned more than {MAX_ROWS_PER_SOURCE:,} rows for "
            f"claim {claim_id}; refusing to write a silently truncated extract"
        )
    return rows


def load_claim_rows(
    database: ReadOnlyMySQL,
    sources: SourceConfig,
    claim_id: str,
) -> dict[str, list[dict[str, Any]]]:
    transactions_table = qualified_table(
        sources.transactions_schema, sources.transactions_table
    )
    claim_status_table = qualified_table(
        sources.claim_status_schema, sources.claim_status_table
    )
    edi_table = qualified_table(sources.edi_schema, sources.edi_table)

    transactions = ensure_complete(
        database.select(
            f"""
            SELECT *
              FROM {transactions_table}
             WHERE ENCOUNTERID = %s
             ORDER BY POSTINGDATE ASC, CLAIMTRANSACTIONID ASC
             LIMIT {MAX_ROWS_PER_SOURCE + 1}
            """,
            (claim_id,),
        ),
        "FlattenTransctions2",
        claim_id,
    )
    if not transactions:
        raise ClaimNotFoundError(f"No transaction rows were found for {claim_id}")

    family_pattern = f"^{claim_id}[A-Za-z]*$"
    claim_status = ensure_complete(
        database.select(
            f"""
            SELECT *
              FROM {claim_status_table}
             WHERE PatientControlNumber LIKE %s
               AND PatientControlNumber REGEXP %s
             ORDER BY CheckEftDate ASC, ImportedAtUtc ASC, ClaimStatusId ASC
             LIMIT {MAX_ROWS_PER_SOURCE + 1}
            """,
            (f"{claim_id}%", family_pattern),
        ),
        "ClaimStatus",
        claim_id,
    )
    claim_status = [
        row
        for row in claim_status
        if submission_suffix(claim_id, row.get("PatientControlNumber")) is not None
    ]

    edi_835 = ensure_complete(
        database.select(
            f"""
            SELECT *
              FROM {edi_table}
             WHERE patient_control_number LIKE %s
               AND patient_control_number REGEXP %s
             ORDER BY payment_date ASC, service_date ASC, id ASC
             LIMIT {MAX_ROWS_PER_SOURCE + 1}
            """,
            (f"{claim_id}%", family_pattern),
        ),
        "edi_835",
        claim_id,
    )
    edi_835 = [
        row
        for row in edi_835
        if submission_suffix(claim_id, row.get("patient_control_number")) is not None
    ]

    return {
        "FlattenTransctions2": transactions,
        "ClaimStatus": claim_status,
        "edi_835": edi_835,
    }


def json_fallback(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return {
            "encoding": "base64",
            "value": base64.b64encode(value).decode("ascii"),
        }
    return str(value)


def default_output_path(claim_id: str) -> Path:
    safe_claim_id = re.sub(r"[^A-Za-z0-9_-]", "_", claim_id) or "claim"
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    return Path.cwd() / f"claim_{safe_claim_id}_mysql_data_{timestamp}.txt"


def write_report(
    output_path: Path,
    overwrite: bool,
    requested_id: str,
    canonical_id: str,
    sources: SourceConfig,
    rows_by_source: Mapping[str, list[dict[str, Any]]],
) -> None:
    output_path = output_path.expanduser().resolve()
    if not output_path.parent.exists():
        raise RuntimeError(f"Output directory does not exist: {output_path.parent}")

    flags = os.O_WRONLY | os.O_CREAT
    flags |= os.O_TRUNC if overwrite else os.O_EXCL
    try:
        file_descriptor = os.open(output_path, flags, 0o600)
    except FileExistsError as exc:
        raise RuntimeError(
            f"Output already exists: {output_path}. Use --overwrite to replace it."
        ) from exc

    source_details = (
        (
            "FlattenTransctions2",
            sources.transactions_schema,
            sources.transactions_table,
            "ENCOUNTERID equals the resolved canonical encounter ID",
        ),
        (
            "ClaimStatus",
            sources.claim_status_schema,
            sources.claim_status_table,
            "PatientControlNumber is the encounter ID plus letters only",
        ),
        (
            "edi_835",
            sources.edi_schema,
            sources.edi_table,
            "patient_control_number is the encounter ID plus letters only",
        ),
    )

    with os.fdopen(file_descriptor, "w", encoding="utf-8") as report:
        report.write("CLAIM DASHBOARD — RAW MYSQL EXTRACT\n")
        report.write("=" * 100 + "\n")
        report.write(f"Generated (UTC): {dt.datetime.now(dt.timezone.utc).isoformat()}\n")
        report.write(f"Requested identifier: {requested_id}\n")
        report.write(f"Canonical ENCOUNTERID: {canonical_id}\n")
        report.write("Database mode: server-verified read-only transaction\n")
        report.write("Excluded: Salesforce comments and Gemini classifications (not MySQL data)\n")
        report.write(
            "Note: Values below are raw database values. This file may contain protected health "
            "information; store and share it accordingly.\n"
        )
        report.write("\nROW COUNTS\n")
        report.write("-" * 100 + "\n")
        for source_name, _, _, _ in source_details:
            report.write(f"{source_name}: {len(rows_by_source[source_name]):,}\n")

        for source_name, schema, table, selection_rule in source_details:
            rows = rows_by_source[source_name]
            report.write("\n\n" + "=" * 100 + "\n")
            report.write(f"SOURCE: {source_name}\n")
            report.write(f"TABLE: `{schema}`.`{table}`\n")
            report.write(f"SELECTION: {selection_rule}\n")
            report.write(f"ROWS: {len(rows):,}\n")
            report.write("=" * 100 + "\n")

            if not rows:
                report.write("(no rows returned)\n")
                continue

            for index, row in enumerate(rows, start=1):
                report.write(f"\n--- ROW {index} OF {len(rows)} ---\n")
                report.write(
                    json.dumps(
                        row,
                        default=json_fallback,
                        ensure_ascii=False,
                        indent=2,
                    )
                )
                report.write("\n")

        report.write("\n" + "=" * 100 + "\n")
        report.write("END OF RAW MYSQL EXTRACT\n")


def build_parser() -> argparse.ArgumentParser:
    script_directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description=(
            "Resolve one claim exactly as the dashboard does and write its raw MySQL rows "
            "to a private text file."
        )
    )
    parser.add_argument(
        "claim_id",
        help="ENCOUNTERID, Claim835ID, payer claim number, or suffixed ERA reference",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=script_directory / ".env",
        help="Path to the dotenv file (default: .env beside this script)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output .txt path (default: a timestamped file in the current directory)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow replacing an existing --output file",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    requested_id = assert_valid_claim_search(args.claim_id)
    load_env_file(args.env_file.expanduser().resolve())
    database_settings = database_config()
    sources = source_config()

    eprint(f"Resolving claim identifier {requested_id!r} in a read-only MySQL session...")
    database = connect_mysql(database_settings)
    try:
        canonical_id = resolve_transaction_claim_id(database, sources, requested_id)
        rows_by_source = load_claim_rows(database, sources, canonical_id)
    finally:
        database.close()

    output_path = (args.output or default_output_path(canonical_id)).expanduser().resolve()
    write_report(
        output_path=output_path,
        overwrite=args.overwrite,
        requested_id=requested_id,
        canonical_id=canonical_id,
        sources=sources,
        rows_by_source=rows_by_source,
    )

    total_rows = sum(len(rows) for rows in rows_by_source.values())
    print(f"Wrote {total_rows:,} raw MySQL row(s) for claim {canonical_id} to:")
    print(output_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        eprint("Interrupted")
        raise SystemExit(130)
    except Exception as exc:
        eprint(f"ERROR: {exc}")
        raise SystemExit(1)
