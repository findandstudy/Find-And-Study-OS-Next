import { pgTable, text, serial, timestamp, boolean, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const destinationsTable = pgTable("destinations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  country: text("country").notNull(),
  flagEmoji: text("flag_emoji"),
  heroImageUrl: text("hero_image_url"),
  thumbnailUrl: text("thumbnail_url"),
  shortDescription: text("short_description"),
  description: text("description"),
  whyStudyHere: text("why_study_here"),
  livingCost: text("living_cost"),
  climate: text("climate"),
  language: text("language"),
  currency: text("currency"),
  visaInfo: text("visa_info"),
  workPermit: text("work_permit"),
  popularCities: text("popular_cities"),
  universityCount: integer("university_count").default(0),
  programCount: integer("program_count").default(0),
  averageTuition: real("average_tuition"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").notNull().default(true),
  isFeatured: boolean("is_featured").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDestinationSchema = createInsertSchema(destinationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDestination = z.infer<typeof insertDestinationSchema>;
export type Destination = typeof destinationsTable.$inferSelect;
