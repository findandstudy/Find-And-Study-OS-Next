import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { programsTable } from "./universities";

export const wishlistsTable = pgTable("wishlists", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  programId: integer("program_id").notNull().references(() => programsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("wishlists_user_program").on(t.userId, t.programId),
]);
