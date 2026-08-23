import { pgTable, text, serial, timestamp, integer, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const countriesTable = pgTable("countries", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  code: text("code").notNull().unique(),
  flagEmoji: text("flag_emoji"),
  dialCode: text("dial_code"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const citiesTable = pgTable("cities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  countryId: integer("country_id").notNull().references(() => countriesTable.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("cities_country_id_idx").on(table.countryId),
]);

export const insertCountrySchema = createInsertSchema(countriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCountry = z.infer<typeof insertCountrySchema>;
export type Country = typeof countriesTable.$inferSelect;

export const insertCitySchema = createInsertSchema(citiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCity = z.infer<typeof insertCitySchema>;
export type City = typeof citiesTable.$inferSelect;

export const catalogOptionsTable = pgTable("catalog_options", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  value: text("value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("catalog_options_category_idx").on(table.category),
]);

export type CatalogOption = typeof catalogOptionsTable.$inferSelect;
