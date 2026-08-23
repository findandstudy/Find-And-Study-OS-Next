import { pgTable, text, serial, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const websitePagesTable = pgTable("website_pages", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("draft"),
  template: text("template").notNull().default("default"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  ogImageUrl: text("og_image_url"),
  canonicalUrl: text("canonical_url"),
  robotsIndex: boolean("robots_index").notNull().default(true),
  robotsFollow: boolean("robots_follow").notNull().default(true),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  twitterTitle: text("twitter_title"),
  twitterDescription: text("twitter_description"),
  twitterImageUrl: text("twitter_image_url"),
  translationsJson: jsonb("translations_json").default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  parentId: integer("parent_id"),
  locale: text("locale").notNull().default("en"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("website_pages_status_idx").on(table.status),
  index("website_pages_slug_idx").on(table.slug),
]);

export const websitePageVersionsTable = pgTable("website_page_versions", {
  id: serial("id").primaryKey(),
  pageId: integer("page_id").notNull().references(() => websitePagesTable.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull().default(1),
  blocksSnapshot: jsonb("blocks_snapshot").notNull().default([]),
  metaSnapshot: jsonb("meta_snapshot").default({}),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("website_page_versions_page_idx").on(table.pageId),
  uniqueIndex("website_page_versions_page_version_idx").on(table.pageId, table.versionNumber),
]);

export const websitePageBlocksTable = pgTable("website_page_blocks", {
  id: serial("id").primaryKey(),
  pageId: integer("page_id").notNull().references(() => websitePagesTable.id, { onDelete: "cascade" }),
  blockType: text("block_type").notNull(),
  content: jsonb("content").notNull().default({}),
  settings: jsonb("settings").default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  isVisible: boolean("is_visible").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("website_page_blocks_page_idx").on(table.pageId),
  index("website_page_blocks_sort_idx").on(table.pageId, table.sortOrder),
]);

export const websiteNavigationMenusTable = pgTable("website_navigation_menus", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  location: text("location").notNull().default("header"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteNavigationItemsTable = pgTable("website_navigation_items", {
  id: serial("id").primaryKey(),
  menuId: integer("menu_id").notNull().references(() => websiteNavigationMenusTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  url: text("url"),
  pageId: integer("page_id").references(() => websitePagesTable.id, { onDelete: "set null" }),
  parentId: integer("parent_id"),
  target: text("target").notNull().default("_self"),
  iconClass: text("icon_class"),
  sortOrder: integer("sort_order").notNull().default(0),
  isVisible: boolean("is_visible").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("website_nav_items_menu_idx").on(table.menuId),
]);

export const websiteThemeTokensTable = pgTable("website_theme_tokens", {
  id: serial("id").primaryKey(),
  tokenGroup: text("token_group").notNull(),
  tokenKey: text("token_key").notNull(),
  tokenValue: text("token_value").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("website_theme_tokens_group_key_idx").on(table.tokenGroup, table.tokenKey),
]);

export const websiteGlobalComponentsTable = pgTable("website_global_components", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  componentType: text("component_type").notNull(),
  content: jsonb("content").notNull().default({}),
  settings: jsonb("settings").default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteFormsTable = pgTable("website_forms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  submitAction: text("submit_action").notNull().default("email"),
  submitEmail: text("submit_email"),
  submitWebhookUrl: text("submit_webhook_url"),
  successMessage: text("success_message"),
  errorMessage: text("error_message"),
  crmSource: text("crm_source"),
  crmPipelineStage: text("crm_pipeline_stage"),
  pageSourceTag: text("page_source_tag"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteFormFieldsTable = pgTable("website_form_fields", {
  id: serial("id").primaryKey(),
  formId: integer("form_id").notNull().references(() => websiteFormsTable.id, { onDelete: "cascade" }),
  fieldType: text("field_type").notNull(),
  label: text("label").notNull(),
  name: text("name").notNull(),
  placeholder: text("placeholder"),
  isRequired: boolean("is_required").notNull().default(false),
  validationRules: jsonb("validation_rules").default({}),
  options: jsonb("options").default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("website_form_fields_form_idx").on(table.formId),
]);

export const websiteFormSubmissionsTable = pgTable("website_form_submissions", {
  id: serial("id").primaryKey(),
  formId: integer("form_id").notNull().references(() => websiteFormsTable.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull().default({}),
  sourceUrl: text("source_url"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  leadId: integer("lead_id"),
  status: text("status").notNull().default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("website_form_submissions_form_idx").on(table.formId),
  index("website_form_submissions_created_idx").on(table.createdAt),
]);

export const websiteBlogPostsTable = pgTable("website_blog_posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  excerpt: text("excerpt"),
  content: jsonb("content").notNull().default({}),
  featuredImageUrl: text("featured_image_url"),
  status: text("status").notNull().default("draft"),
  authorId: integer("author_id"),
  categoryId: integer("category_id"),
  locale: text("locale").notNull().default("en"),
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  translationsJson: jsonb("translations_json").default({}),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("website_blog_posts_status_idx").on(table.status),
  index("website_blog_posts_category_idx").on(table.categoryId),
]);

export const websiteBlogCategoriesTable = pgTable("website_blog_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteBlogTagsTable = pgTable("website_blog_tags", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const websiteBlogPostTagsTable = pgTable("website_blog_post_tags", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => websiteBlogPostsTable.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => websiteBlogTagsTable.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("website_blog_post_tags_unique").on(table.postId, table.tagId),
]);

export const websiteCollectionsOfficesTable = pgTable("website_collections_offices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  city: text("city"),
  country: text("country"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  mapEmbedUrl: text("map_embed_url"),
  imageUrl: text("image_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  translationsJson: jsonb("translations_json").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteCollectionsTeamMembersTable = pgTable("website_collections_team_members", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title"),
  bio: text("bio"),
  photoUrl: text("photo_url"),
  email: text("email"),
  linkedinUrl: text("linkedin_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  translationsJson: jsonb("translations_json").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteCollectionsFaqsTable = pgTable("website_collections_faqs", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  category: text("category"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const websiteCollectionsTestimonialsTable = pgTable("website_collections_testimonials", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role"),
  company: text("company"),
  content: text("content").notNull(),
  photoUrl: text("photo_url"),
  rating: integer("rating"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertWebsitePageSchema = createInsertSchema(websitePagesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsitePage = z.infer<typeof insertWebsitePageSchema>;
export type WebsitePage = typeof websitePagesTable.$inferSelect;

export const insertWebsitePageBlockSchema = createInsertSchema(websitePageBlocksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsitePageBlock = z.infer<typeof insertWebsitePageBlockSchema>;
export type WebsitePageBlock = typeof websitePageBlocksTable.$inferSelect;

export const insertWebsiteNavigationMenuSchema = createInsertSchema(websiteNavigationMenusTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteNavigationMenu = z.infer<typeof insertWebsiteNavigationMenuSchema>;
export type WebsiteNavigationMenu = typeof websiteNavigationMenusTable.$inferSelect;

export const insertWebsiteNavigationItemSchema = createInsertSchema(websiteNavigationItemsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteNavigationItem = z.infer<typeof insertWebsiteNavigationItemSchema>;
export type WebsiteNavigationItem = typeof websiteNavigationItemsTable.$inferSelect;

export const insertWebsiteThemeTokenSchema = createInsertSchema(websiteThemeTokensTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteThemeToken = z.infer<typeof insertWebsiteThemeTokenSchema>;
export type WebsiteThemeToken = typeof websiteThemeTokensTable.$inferSelect;

export const insertWebsiteGlobalComponentSchema = createInsertSchema(websiteGlobalComponentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteGlobalComponent = z.infer<typeof insertWebsiteGlobalComponentSchema>;
export type WebsiteGlobalComponent = typeof websiteGlobalComponentsTable.$inferSelect;

export const insertWebsiteFormSchema = createInsertSchema(websiteFormsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteForm = z.infer<typeof insertWebsiteFormSchema>;
export type WebsiteForm = typeof websiteFormsTable.$inferSelect;

export const insertWebsiteFormFieldSchema = createInsertSchema(websiteFormFieldsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteFormField = z.infer<typeof insertWebsiteFormFieldSchema>;
export type WebsiteFormField = typeof websiteFormFieldsTable.$inferSelect;

export const insertWebsiteFormSubmissionSchema = createInsertSchema(websiteFormSubmissionsTable).omit({ id: true, createdAt: true });
export type InsertWebsiteFormSubmission = z.infer<typeof insertWebsiteFormSubmissionSchema>;
export type WebsiteFormSubmission = typeof websiteFormSubmissionsTable.$inferSelect;

export const insertWebsiteBlogPostSchema = createInsertSchema(websiteBlogPostsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteBlogPost = z.infer<typeof insertWebsiteBlogPostSchema>;
export type WebsiteBlogPost = typeof websiteBlogPostsTable.$inferSelect;

export const insertWebsiteBlogCategorySchema = createInsertSchema(websiteBlogCategoriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteBlogCategory = z.infer<typeof insertWebsiteBlogCategorySchema>;
export type WebsiteBlogCategory = typeof websiteBlogCategoriesTable.$inferSelect;

export const insertWebsiteBlogTagSchema = createInsertSchema(websiteBlogTagsTable).omit({ id: true, createdAt: true });
export type InsertWebsiteBlogTag = z.infer<typeof insertWebsiteBlogTagSchema>;
export type WebsiteBlogTag = typeof websiteBlogTagsTable.$inferSelect;

export const insertWebsiteCollectionOfficeSchema = createInsertSchema(websiteCollectionsOfficesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteCollectionOffice = z.infer<typeof insertWebsiteCollectionOfficeSchema>;
export type WebsiteCollectionOffice = typeof websiteCollectionsOfficesTable.$inferSelect;

export const insertWebsiteCollectionTeamMemberSchema = createInsertSchema(websiteCollectionsTeamMembersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteCollectionTeamMember = z.infer<typeof insertWebsiteCollectionTeamMemberSchema>;
export type WebsiteCollectionTeamMember = typeof websiteCollectionsTeamMembersTable.$inferSelect;

export const insertWebsiteCollectionFaqSchema = createInsertSchema(websiteCollectionsFaqsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteCollectionFaq = z.infer<typeof insertWebsiteCollectionFaqSchema>;
export type WebsiteCollectionFaq = typeof websiteCollectionsFaqsTable.$inferSelect;

export const insertWebsiteCollectionTestimonialSchema = createInsertSchema(websiteCollectionsTestimonialsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebsiteCollectionTestimonial = z.infer<typeof insertWebsiteCollectionTestimonialSchema>;
export type WebsiteCollectionTestimonial = typeof websiteCollectionsTestimonialsTable.$inferSelect;
