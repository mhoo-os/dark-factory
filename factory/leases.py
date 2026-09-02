"""Strongly serialized repository and collision-group lease coordinator."""
from __future__ import annotations

from dataclasses import dataclass
import sqlite3
from typing import Mapping, Iterable


class LeaseDenied(RuntimeError):
    pass


class LeaseFenced(RuntimeError):
    pass


@dataclass(frozen=True)
class LeaseGrant:
    owner: str
    dispatch_id: str
    fences: Mapping[str, int]
    expires_at: int


def lease_keys(repository: str, collision_groups: Iterable[str]) -> tuple[str, ...]:
    keys = {f"repository:{repository}"}
    keys.update(f"collision:{group}" for group in collision_groups)
    return tuple(sorted(keys))


class LeaseCoordinator:
    """Use one SQLite/D1 transaction as the serialized coordinator boundary."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def _rows(self, keys: tuple[str, ...]) -> list[sqlite3.Row]:
        placeholders = ",".join("?" for _ in keys)
        self.connection.row_factory = sqlite3.Row
        return list(self.connection.execute(
            f"SELECT * FROM factory_leases WHERE lease_key IN ({placeholders})", keys
        ))

    def acquire(
        self,
        keys: Iterable[str],
        *,
        owner: str,
        dispatch_id: str,
        now: int,
        ttl_seconds: int,
    ) -> LeaseGrant:
        ordered = tuple(sorted(set(keys)))
        if not ordered or not owner or not dispatch_id or ttl_seconds < 1:
            raise LeaseDenied("lease_request_invalid")
        expires_at = now + ttl_seconds
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            rows = {row["lease_key"]: row for row in self._rows(ordered)}
            active = [row for row in rows.values() if row["expires_at"] > now]
            if any(row["owner"] != owner or row["dispatch_id"] != dispatch_id for row in active):
                raise LeaseDenied("lease_already_held")
            fences: dict[str, int] = {}
            for key in ordered:
                row = rows.get(key)
                if row is not None and row["expires_at"] > now:
                    fences[key] = row["fence"]
                    continue
                fence = (row["fence"] if row is not None else 0) + 1
                self.connection.execute(
                    "INSERT INTO factory_leases(lease_key, owner, dispatch_id, fence, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(lease_key) DO UPDATE SET owner=excluded.owner, dispatch_id=excluded.dispatch_id, fence=excluded.fence, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at",
                    (key, owner, dispatch_id, fence, now, expires_at),
                )
                fences[key] = fence
            self.connection.commit()
            return LeaseGrant(owner, dispatch_id, fences, expires_at)
        except Exception:
            self.connection.rollback()
            raise

    def renew(self, grant: LeaseGrant, *, now: int, ttl_seconds: int) -> LeaseGrant:
        if ttl_seconds < 1:
            raise LeaseFenced("lease_ttl_invalid")
        expires_at = now + ttl_seconds
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            for key, fence in grant.fences.items():
                updated = self.connection.execute(
                    "UPDATE factory_leases SET expires_at = ? WHERE lease_key = ? AND owner = ? AND dispatch_id = ? AND fence = ? AND expires_at > ?",
                    (expires_at, key, grant.owner, grant.dispatch_id, fence, now),
                ).rowcount
                if updated != 1:
                    raise LeaseFenced("lease_fenced")
            self.connection.commit()
            return LeaseGrant(grant.owner, grant.dispatch_id, dict(grant.fences), expires_at)
        except Exception:
            self.connection.rollback()
            raise

    def assert_current(self, grant: LeaseGrant, *, now: int) -> None:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            rows = {row["lease_key"]: row for row in self._rows(tuple(grant.fences))}
            if any(
                rows.get(key) is None
                or rows[key]["owner"] != grant.owner
                or rows[key]["dispatch_id"] != grant.dispatch_id
                or rows[key]["fence"] != fence
                or rows[key]["expires_at"] <= now
                for key, fence in grant.fences.items()
            ):
                raise LeaseFenced("lease_fenced")
            self.connection.rollback()
        except Exception:
            self.connection.rollback()
            raise

    def release(self, grant: LeaseGrant, *, now: int) -> None:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            for key, fence in grant.fences.items():
                deleted = self.connection.execute(
                    "DELETE FROM factory_leases WHERE lease_key = ? AND owner = ? AND dispatch_id = ? AND fence = ?",
                    (key, grant.owner, grant.dispatch_id, fence),
                ).rowcount
                if deleted != 1:
                    raise LeaseFenced("lease_fenced")
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
