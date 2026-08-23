import { sql, inArray, eq, isNull, and, type SQL } from "drizzle-orm";
import type { PgTable, PgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db } from "./index";

type SoftDeletableTable = PgTable & {
  id: PgColumn;
  deletedAt: PgColumn;
  deletedBy?: PgColumn;
};

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SoftDeleteOptions {
  actorUserId?: number | null;
  tx?: DbOrTx;
}

/**
 * Soft-delete one or more rows by setting `deletedAt = now()` (and `deletedBy`
 * if the column exists). Does nothing for empty id arrays.
 *
 * Pass `tx` to participate in an existing transaction.
 */
export async function softDelete<T extends SoftDeletableTable>(
  table: T,
  ids: number | number[],
  opts: SoftDeleteOptions = {},
): Promise<number> {
  const idArr = Array.isArray(ids) ? ids : [ids];
  if (idArr.length === 0) return 0;

  const runner = opts.tx ?? db;
  const updates: PgUpdateSetSource<T> = { deletedAt: sql`now()` } as PgUpdateSetSource<T>;
  if (table.deletedBy && opts.actorUserId != null) {
    (updates as Record<string, unknown>).deletedBy = opts.actorUserId;
  }

  const idWhere = idArr.length === 1
    ? eq(table.id, idArr[0])
    : inArray(table.id, idArr);
  const where = and(idWhere, isNull(table.deletedAt));

  const result = await runner.update(table).set(updates).where(where);
  return result?.rowCount ?? 0;
}

/**
 * Restore soft-deleted rows (clears `deletedAt` and `deletedBy`).
 */
export async function softRestore<T extends SoftDeletableTable>(
  table: T,
  ids: number | number[],
  opts: { tx?: DbOrTx } = {},
): Promise<number> {
  const idArr = Array.isArray(ids) ? ids : [ids];
  if (idArr.length === 0) return 0;

  const runner = opts.tx ?? db;
  const updates: PgUpdateSetSource<T> = { deletedAt: null } as PgUpdateSetSource<T>;
  if (table.deletedBy) (updates as Record<string, unknown>).deletedBy = null;

  const where = idArr.length === 1
    ? eq(table.id, idArr[0])
    : inArray(table.id, idArr);

  const result = await runner.update(table).set(updates).where(where);
  return result?.rowCount ?? idArr.length;
}

export type SoftDeleteFilter = SQL;
