CREATE TABLE "document_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_type" text NOT NULL,
	"level" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_blog_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_blog_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_blog_post_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"tag_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_blog_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"excerpt" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"featured_image_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_id" integer,
	"category_id" integer,
	"locale" text DEFAULT 'en' NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"translations_json" jsonb DEFAULT '{}'::jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_blog_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_blog_tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_collections_faqs" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"category" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_collections_offices" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"country" text,
	"address" text,
	"phone" text,
	"email" text,
	"map_embed_url" text,
	"image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_collections_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"bio" text,
	"photo_url" text,
	"email" text,
	"linkedin_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_collections_testimonials" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"company" text,
	"content" text NOT NULL,
	"photo_url" text,
	"rating" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_form_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_id" integer NOT NULL,
	"field_type" text NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"placeholder" text,
	"is_required" boolean DEFAULT false NOT NULL,
	"validation_rules" jsonb DEFAULT '{}'::jsonb,
	"options" jsonb DEFAULT '[]'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_id" integer NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text,
	"ip_address" text,
	"user_agent" text,
	"lead_id" integer,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"submit_action" text DEFAULT 'email' NOT NULL,
	"submit_email" text,
	"submit_webhook_url" text,
	"success_message" text,
	"error_message" text,
	"crm_source" text,
	"crm_pipeline_stage" text,
	"page_source_tag" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_forms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_global_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"component_type" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_global_components_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_navigation_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"menu_id" integer NOT NULL,
	"label" text NOT NULL,
	"url" text,
	"page_id" integer,
	"parent_id" integer,
	"target" text DEFAULT '_self' NOT NULL,
	"icon_class" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_navigation_menus" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"location" text DEFAULT 'header' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_navigation_menus_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_page_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"block_type" text NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_page_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"blocks_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta_snapshot" jsonb DEFAULT '{}'::jsonb,
	"published_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"template" text DEFAULT 'default' NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"og_image_url" text,
	"canonical_url" text,
	"robots_index" boolean DEFAULT true NOT NULL,
	"robots_follow" boolean DEFAULT true NOT NULL,
	"og_title" text,
	"og_description" text,
	"twitter_title" text,
	"twitter_description" text,
	"twitter_image_url" text,
	"translations_json" jsonb DEFAULT '{}'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"parent_id" integer,
	"locale" text DEFAULT 'en' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" integer,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "website_theme_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_group" text NOT NULL,
	"token_key" text NOT NULL,
	"token_value" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assigned_to" integer,
	"assigned_to_name" text,
	"due_date" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"task_notes" jsonb,
	"created_by" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"change_type" text DEFAULT 'discount' NOT NULL,
	"change_percent" real NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"university_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"display_name" text NOT NULL,
	"external_account_id" text,
	"config_encrypted" text,
	"webhook_secret" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"phone" text,
	"phone_e164" text,
	"email" text,
	"lead_id" integer,
	"student_id" integer,
	"agent_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"expire" bigint
);
--> statement-breakpoint
DROP INDEX "students_email_uniq";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "first_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_name" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "commissions" ALTER COLUMN "season" SET DEFAULT '2026';--> statement-breakpoint
ALTER TABLE "commissions" ALTER COLUMN "confirmed_at" SET DATA TYPE timestamp with time zone USING "confirmed_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_transactions" ALTER COLUMN "transaction_date" SET DATA TYPE timestamp with time zone USING "transaction_date"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_transactions" ALTER COLUMN "transaction_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "due_date" SET DATA TYPE timestamp with time zone USING "due_date"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "paid_at" SET DATA TYPE timestamp with time zone USING "paid_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_fees" ALTER COLUMN "season" SET DEFAULT '2026';--> statement-breakpoint
ALTER TABLE "service_fees" ALTER COLUMN "first_installment_paid_at" SET DATA TYPE timestamp with time zone USING "first_installment_paid_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_fees" ALTER COLUMN "second_installment_paid_at" SET DATA TYPE timestamp with time zone USING "second_installment_paid_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_queue" ALTER COLUMN "sent_at" SET DATA TYPE timestamp with time zone USING "sent_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_queue" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at"::timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_queue" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "interested_level" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "contract_start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "contract_end_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "contract_last_notified" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "campaign_id" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "campaign_name" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "campaign_type" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "campaign_percent" real;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "min_gpa" real;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "min_language_score" real;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "quota" integer;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "is_internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "is_notes_mandatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "can_attach_file" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "max_files" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "is_file_upload_mandatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "can_go_back" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "is_case_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN "countries" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_account_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_contact_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_thread_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_to_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "unmatched" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_templates" ADD COLUMN "external_template_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "failed_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "website_blog_post_tags" ADD CONSTRAINT "website_blog_post_tags_post_id_website_blog_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."website_blog_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_blog_post_tags" ADD CONSTRAINT "website_blog_post_tags_tag_id_website_blog_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."website_blog_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_form_fields" ADD CONSTRAINT "website_form_fields_form_id_website_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."website_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_form_submissions" ADD CONSTRAINT "website_form_submissions_form_id_website_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."website_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_navigation_items" ADD CONSTRAINT "website_navigation_items_menu_id_website_navigation_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."website_navigation_menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_navigation_items" ADD CONSTRAINT "website_navigation_items_page_id_website_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."website_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page_blocks" ADD CONSTRAINT "website_page_blocks_page_id_website_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."website_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page_versions" ADD CONSTRAINT "website_page_versions_page_id_website_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."website_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_req_type_level_idx" ON "document_requirements" USING btree ("document_type","level");--> statement-breakpoint
CREATE UNIQUE INDEX "website_blog_post_tags_unique" ON "website_blog_post_tags" USING btree ("post_id","tag_id");--> statement-breakpoint
CREATE INDEX "website_blog_posts_status_idx" ON "website_blog_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "website_blog_posts_category_idx" ON "website_blog_posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "website_form_fields_form_idx" ON "website_form_fields" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "website_form_submissions_form_idx" ON "website_form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "website_form_submissions_created_idx" ON "website_form_submissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "website_nav_items_menu_idx" ON "website_navigation_items" USING btree ("menu_id");--> statement-breakpoint
CREATE INDEX "website_page_blocks_page_idx" ON "website_page_blocks" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "website_page_blocks_sort_idx" ON "website_page_blocks" USING btree ("page_id","sort_order");--> statement-breakpoint
CREATE INDEX "website_page_versions_page_idx" ON "website_page_versions" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_page_versions_page_version_idx" ON "website_page_versions" USING btree ("page_id","version_number");--> statement-breakpoint
CREATE INDEX "website_pages_status_idx" ON "website_pages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "website_pages_slug_idx" ON "website_pages" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "website_theme_tokens_group_key_idx" ON "website_theme_tokens" USING btree ("token_group","token_key");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_assigned_to_idx" ON "tasks" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "tasks_archived_at_idx" ON "tasks" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "campaigns_active_dates_idx" ON "campaigns" USING btree ("is_active","start_date","end_date");--> statement-breakpoint
CREATE INDEX "campaigns_archived_idx" ON "campaigns" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "channel_accounts_channel_idx" ON "channel_accounts" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "channel_accounts_status_idx" ON "channel_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "external_contacts_channel_external_idx" ON "external_contacts" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "external_contacts_phone_e164_idx" ON "external_contacts" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "external_contacts_email_idx" ON "external_contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "external_contacts_lead_id_idx" ON "external_contacts" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "external_contacts_student_id_idx" ON "external_contacts" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "external_contacts_agent_id_idx" ON "external_contacts" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_managing_agent_id_idx" ON "users" USING btree ("managing_agent_id");--> statement-breakpoint
CREATE INDEX "users_phone_e164_idx" ON "users" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "follow_ups_created_by_id_idx" ON "follow_ups" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "leads_phone_e164_idx" ON "leads" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "students_email_idx" ON "students" USING btree ("email");--> statement-breakpoint
CREATE INDEX "students_phone_e164_idx" ON "students" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "agents_phone_e164_idx" ON "agents" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "fin_tx_commission_id_idx" ON "financial_transactions" USING btree ("commission_id");--> statement-breakpoint
CREATE INDEX "fin_tx_agent_id_idx" ON "financial_transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "fin_tx_type_idx" ON "financial_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "invoices_student_id_idx" ON "invoices" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "invoices_application_id_idx" ON "invoices" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "IDX_session_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "broadcasts_sent_by_id_idx" ON "broadcasts" USING btree ("sent_by_id");--> statement-breakpoint
CREATE INDEX "conversations_created_by_id_idx" ON "conversations" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "conversations_channel_idx" ON "conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "conversations_assigned_to_id_idx" ON "conversations" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversations_unmatched_idx" ON "conversations" USING btree ("unmatched");--> statement-breakpoint
CREATE INDEX "conversations_external_contact_id_idx" ON "conversations" USING btree ("external_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_thread_idx" ON "conversations" USING btree ("channel_account_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "msg_templates_created_by_id_idx" ON "message_templates" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_direction_idx" ON "messages" USING btree ("direction");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_idx" ON "messages" USING btree ("channel","external_message_id");--> statement-breakpoint
CREATE INDEX "email_queue_status_idx" ON "email_queue" USING btree ("status");
