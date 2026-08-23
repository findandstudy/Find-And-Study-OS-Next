CREATE TABLE "email_verification_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"replit_id" text,
	"email" text,
	"first_name" text,
	"last_name" text,
	"role" text DEFAULT 'staff' NOT NULL,
	"avatar_url" text,
	"phone" text,
	"password_hash" text,
	"language" text DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"start_date" text,
	"home_address" text,
	"passport_number" text,
	"contract_url" text,
	"passport_url" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"password_reset_token" text,
	"password_reset_expires" timestamp with time zone,
	"email_verification_token" text,
	"created_from_source" text,
	"managing_agent_id" integer,
	"agent_staff_permissions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_replit_id_unique" UNIQUE("replit_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer,
	"student_id" integer,
	"resource_type" text DEFAULT 'lead' NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"assigned_to_id" integer,
	"notes" text,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"nationality" text,
	"country" text,
	"source" text,
	"status" text DEFAULT 'new' NOT NULL,
	"season" text DEFAULT '2026' NOT NULL,
	"agent_id" integer,
	"assigned_to_id" integer,
	"interested_program" text,
	"interested_country" text,
	"notes" text,
	"estimated_value" numeric(12, 2),
	"converted_student_id" integer,
	"origin_type" text DEFAULT 'direct' NOT NULL,
	"origin_entity_type" text,
	"origin_entity_id" integer,
	"origin_display_name" text,
	"origin_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"date_of_birth" text,
	"nationality" text,
	"passport_number" text,
	"passport_issue_date" text,
	"passport_expiry" text,
	"mother_name" text,
	"father_name" text,
	"address" text,
	"status" text DEFAULT 'active' NOT NULL,
	"agent_id" integer,
	"assigned_to_id" integer,
	"high_school" text,
	"university_bachelor" text,
	"university_master" text,
	"graduation_year" integer,
	"gpa" text,
	"language_score" text,
	"season" text DEFAULT '2026' NOT NULL,
	"photo_url" text,
	"notes" text,
	"next_followup" timestamp with time zone,
	"origin_type" text DEFAULT 'direct' NOT NULL,
	"origin_entity_type" text,
	"origin_entity_id" integer,
	"origin_display_name" text,
	"origin_locked" boolean DEFAULT false NOT NULL,
	"origin_lead_id" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"parent_agent_id" integer,
	"agency_code" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"country" text,
	"state" text,
	"city" text,
	"address" text,
	"company_name" text,
	"business_name" text,
	"category" text,
	"commission_rate" real,
	"sub_agent_commission_rate" real,
	"hide_service_fees" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"logo_url" text,
	"agent_id_proof_url" text,
	"business_cert_url" text,
	"contract_url" text,
	"can_manage_staff" boolean DEFAULT true NOT NULL,
	"branch" text,
	"assigned_staff_id" integer,
	"point_of_contact" text,
	"notes" text,
	"embed_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"program_id" integer,
	"university_id" integer,
	"agent_id" integer,
	"assigned_to_id" integer,
	"season" text DEFAULT '2026' NOT NULL,
	"stage" text DEFAULT 'inquiry' NOT NULL,
	"intake" text,
	"level" text,
	"instruction_language" text,
	"deadline" text,
	"program_name" text,
	"university_name" text,
	"country" text,
	"tuition_fee" real,
	"discounted_fee" real,
	"scholarship" real,
	"commission_rate" real,
	"service_fee_amount" real,
	"application_fee" real,
	"deposit_fee" real,
	"advanced_fee" real,
	"language_fee" real,
	"currency" text DEFAULT 'USD',
	"notes" text,
	"origin_type" text DEFAULT 'direct' NOT NULL,
	"origin_entity_type" text,
	"origin_entity_id" integer,
	"origin_display_name" text,
	"origin_locked" boolean DEFAULT false NOT NULL,
	"origin_student_id" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer,
	"application_id" integer,
	"lead_id" integer,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_key" text,
	"file_url" text,
	"mime_type" text,
	"size_bytes" integer,
	"extracted_data" text,
	"confidence_score" real,
	"reviewed_by" integer,
	"file_data" text,
	"notes" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"university_id" integer NOT NULL,
	"name" text NOT NULL,
	"degree" text,
	"field" text,
	"language" text,
	"duration" text,
	"tuition_fee" real,
	"currency" text DEFAULT 'USD',
	"scholarship" real,
	"intakes" text,
	"requirements" text,
	"commission_rate" real,
	"application_fee" real,
	"advanced_fee" real,
	"deposit_fee" real,
	"service_fee_amount" real,
	"discounted_fee" real,
	"language_fee" real,
	"fee_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"city" text,
	"website" text,
	"logo_url" text,
	"description" text,
	"ranking" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"university_type" text,
	"tax_type" text,
	"tax_percent" real,
	"qs_ranking" integer,
	"times_ranking" integer,
	"shanghai_ranking" integer,
	"cwts_leiden_ranking" integer,
	"address" text,
	"online_payment_url" text,
	"cricos_link" text,
	"documents_link" text,
	"current_fee_list_link" text,
	"initial_deposit_options" text,
	"admission_process" text,
	"contact_person_name" text,
	"contact_person_phone" text,
	"contact_person_email" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer,
	"student_id" integer,
	"agent_id" integer,
	"student_name" text,
	"university_name" text,
	"program_name" text,
	"is_state_university" boolean DEFAULT false,
	"season" text DEFAULT '2025' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"program_fee" numeric(12, 2),
	"university_commission_rate" numeric(5, 2),
	"university_commission_amount" numeric(12, 2),
	"university_collected" numeric(12, 2) DEFAULT '0',
	"agent_commission_rate" numeric(5, 2),
	"agent_commission_amount" numeric(12, 2),
	"agent_paid" numeric(12, 2) DEFAULT '0',
	"sub_agent_id" integer,
	"sub_agent_commission_rate" numeric(5, 2),
	"sub_agent_commission_amount" numeric(12, 2),
	"sub_agent_paid" numeric(12, 2) DEFAULT '0',
	"status" text DEFAULT 'potential' NOT NULL,
	"confirmed_at" text,
	"offset_amount" numeric(12, 2) DEFAULT '0',
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"commission_id" integer,
	"type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"transaction_date" text NOT NULL,
	"reference" text,
	"university_name" text,
	"agent_id" integer,
	"agent_name" text,
	"student_name" text,
	"file_url" text,
	"file_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"student_id" integer NOT NULL,
	"application_id" integer,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"due_date" text,
	"paid_at" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "service_fees" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer,
	"student_id" integer,
	"agent_id" integer,
	"student_name" text,
	"university_name" text,
	"is_state_university" boolean DEFAULT false,
	"payer_type" text DEFAULT 'student' NOT NULL,
	"season" text DEFAULT '2025' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"first_installment_amount" numeric(12, 2),
	"first_installment_paid_at" text,
	"second_installment_amount" numeric(12, 2),
	"second_installment_paid_at" text,
	"finance_status" text DEFAULT 'potential' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"content" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"category" text,
	"published" boolean DEFAULT false NOT NULL,
	"author_id" integer,
	"featured_image_url" text,
	"meta_title" text,
	"meta_description" text,
	"tags" text,
	"published_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text,
	"company_email" text,
	"company_phone" text,
	"company_address" text,
	"company_website" text,
	"default_language" text DEFAULT 'en' NOT NULL,
	"supported_languages" text DEFAULT 'en,tr,ar,fr,ru' NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_user" text,
	"smtp_password" text,
	"smtp_from_email" text,
	"whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"whatsapp_token" text,
	"n8n_webhook_url" text,
	"google_sheets_id" text,
	"meta_lead_enabled" boolean DEFAULT false NOT NULL,
	"logo_url" text,
	"logo_dark_url" text,
	"favicon_url" text,
	"theme_primary" text,
	"theme_button" text,
	"theme_hover" text,
	"seo_default_title" text,
	"seo_default_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"logo_square_url" text,
	"apple_touch_icon_url" text,
	"pwa_icon_url" text,
	"email_logo_url" text,
	"pdf_logo_url" text,
	"theme_secondary" text,
	"theme_accent" text,
	"theme_link_color" text,
	"theme_success" text,
	"theme_warning" text,
	"theme_danger" text,
	"legal_company_name" text,
	"public_brand_name" text,
	"support_email" text,
	"sales_email" text,
	"whatsapp_number" text,
	"company_city" text,
	"company_country" text,
	"working_hours" text,
	"footer_description" text,
	"footer_copyright" text,
	"contact_cta_text" text,
	"social_instagram" text,
	"social_facebook" text,
	"social_linkedin" text,
	"social_twitter" text,
	"social_youtube" text,
	"social_tiktok" text,
	"site_name" text,
	"site_title_template" text,
	"seo_meta_title" text,
	"seo_meta_description" text,
	"canonical_base_url" text,
	"robots_index" boolean DEFAULT true NOT NULL,
	"robots_follow" boolean DEFAULT true NOT NULL,
	"staging_noindex" boolean DEFAULT false NOT NULL,
	"og_title" text,
	"og_description" text,
	"og_image_url" text,
	"twitter_title" text,
	"twitter_description" text,
	"twitter_image_url" text,
	"share_image_url" text,
	"seo_keywords" text,
	"google_search_console_code" text,
	"google_analytics_id" text,
	"meta_pixel_id" text,
	"tiktok_pixel_id" text,
	"org_schema_name" text,
	"org_schema_url" text,
	"org_schema_logo_url" text,
	"org_schema_socials" text,
	"email_sender_name" text,
	"email_sender_email" text,
	"email_reply_to" text,
	"email_footer_text" text,
	"email_signature_block" text,
	"email_button_color" text,
	"email_disclaimer_text" text,
	"pdf_header_text" text,
	"pdf_footer_text" text,
	"pdf_watermark_text" text,
	"pdf_signature_label" text,
	"pdf_seal_image_url" text,
	"pdf_primary_color" text,
	"available_years" jsonb,
	"sitemap_url" text,
	"robots_txt_content" text,
	"custom_head_script" text,
	"custom_body_end_script" text,
	"linkedin_insight_tag" text,
	"clarity_id" text,
	"recaptcha_site_key" text,
	"whatsapp_widget_number" text,
	"live_chat_script" text,
	"feature_flags" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" integer,
	"changes" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"author_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"value" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"flag_emoji" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "countries_name_unique" UNIQUE("name"),
	CONSTRAINT "countries_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"variant" text,
	"icon" text,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wishlists" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"program_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlists_user_program" UNIQUE("user_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"color" text DEFAULT 'blue' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"channel" text DEFAULT 'internal' NOT NULL,
	"target_audience" text DEFAULT 'all' NOT NULL,
	"target_roles" jsonb DEFAULT '[]'::jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_id" integer,
	"recipient_count" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"last_read_at" timestamp with time zone,
	"is_muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text DEFAULT 'direct' NOT NULL,
	"title" text,
	"created_by_id" integer,
	"is_archived" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"channel" text DEFAULT 'all' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"sender_id" integer,
	"content" text NOT NULL,
	"channel" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"reply_to_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"recipient_type" text DEFAULT 'specific' NOT NULL,
	"recipient_roles" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"template" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_event_unique" UNIQUE("event")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"icon" text,
	"action_url" text,
	"data" jsonb DEFAULT '{}'::jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_activity_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" integer,
	"event_type" text NOT NULL,
	"route" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_page_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" integer,
	"route" text NOT NULL,
	"module_name" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"total_duration_seconds" integer DEFAULT 0 NOT NULL,
	"active_duration_seconds" integer DEFAULT 0 NOT NULL,
	"idle_duration_seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_active_at" timestamp with time zone,
	"current_route" text,
	"session_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_duration_seconds" integer DEFAULT 0 NOT NULL,
	"active_duration_seconds" integer DEFAULT 0 NOT NULL,
	"idle_duration_seconds" integer DEFAULT 0 NOT NULL,
	"end_reason" text,
	"user_agent" text,
	"ip_address" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_stage_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"stage" text NOT NULL,
	"file_name" text NOT NULL,
	"file_data" text,
	"file_url" text,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_by" integer NOT NULL,
	"uploaded_by_role" text NOT NULL,
	"uploaded_by_name" text,
	"is_missing_doc_note" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embed_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"widget_id" integer NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"country_code" text,
	"nationality" text,
	"desired_level" text,
	"desired_program" text,
	"preferred_university" text,
	"message" text,
	"program_id" integer,
	"program_name" text,
	"university_name" text,
	"source_website" text,
	"source_page_url" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"lead_id" integer,
	"ai_extracted_data" jsonb,
	"document_count" integer DEFAULT 0,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embed_widgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"mode" text DEFAULT 'combined' NOT NULL,
	"preset_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locked_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visible_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embed_widgets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country" text NOT NULL,
	"flag_emoji" text,
	"hero_image_url" text,
	"thumbnail_url" text,
	"short_description" text,
	"description" text,
	"why_study_here" text,
	"living_cost" text,
	"climate" text,
	"language" text,
	"currency" text,
	"visa_info" text,
	"work_permit" text,
	"popular_cities" text,
	"university_count" integer DEFAULT 0,
	"program_count" integer DEFAULT 0,
	"average_tuition" real,
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quick_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"icon" text,
	"logo_url" text,
	"color" text,
	"target" text DEFAULT 'agent' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_student_id_students_id_fk" FOREIGN KEY ("converted_student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_assigned_staff_id_users_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_university_id_universities_id_fk" FOREIGN KEY ("university_id") REFERENCES "public"."universities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_university_id_universities_id_fk" FOREIGN KEY ("university_id") REFERENCES "public"."universities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_sub_agent_id_agents_id_fk" FOREIGN KEY ("sub_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_commission_id_commissions_id_fk" FOREIGN KEY ("commission_id") REFERENCES "public"."commissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_fees" ADD CONSTRAINT "service_fees_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_fees" ADD CONSTRAINT "service_fees_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_fees" ADD CONSTRAINT "service_fees_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_session_id_user_sessions_activity_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_visits" ADD CONSTRAINT "user_page_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_visits" ADD CONSTRAINT "user_page_visits_session_id_user_sessions_activity_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."user_sessions_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions_activity" ADD CONSTRAINT "user_sessions_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD CONSTRAINT "application_stage_documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD CONSTRAINT "application_stage_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_submissions" ADD CONSTRAINT "embed_submissions_widget_id_embed_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."embed_widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_submissions" ADD CONSTRAINT "embed_submissions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embed_submissions" ADD CONSTRAINT "embed_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_lead_id_idx" ON "follow_ups" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "follow_ups_student_id_idx" ON "follow_ups" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "follow_ups_assigned_to_id_idx" ON "follow_ups" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "leads_agent_id_idx" ON "leads" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "leads_assigned_to_id_idx" ON "leads" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_season_idx" ON "leads" USING btree ("season");--> statement-breakpoint
CREATE INDEX "leads_origin_type_idx" ON "leads" USING btree ("origin_type");--> statement-breakpoint
CREATE UNIQUE INDEX "students_email_uniq" ON "students" USING btree ("email");--> statement-breakpoint
CREATE INDEX "students_agent_id_idx" ON "students" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "students_assigned_to_id_idx" ON "students" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "students_status_idx" ON "students" USING btree ("status");--> statement-breakpoint
CREATE INDEX "students_season_idx" ON "students" USING btree ("season");--> statement-breakpoint
CREATE INDEX "students_user_id_idx" ON "students" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "students_origin_type_idx" ON "students" USING btree ("origin_type");--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agents_parent_agent_id_idx" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_embed_token_idx" ON "agents" USING btree ("embed_token");--> statement-breakpoint
CREATE INDEX "applications_student_id_idx" ON "applications" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "applications_program_id_idx" ON "applications" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "applications_university_id_idx" ON "applications" USING btree ("university_id");--> statement-breakpoint
CREATE INDEX "applications_agent_id_idx" ON "applications" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "applications_assigned_to_id_idx" ON "applications" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "applications_stage_idx" ON "applications" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "applications_season_idx" ON "applications" USING btree ("season");--> statement-breakpoint
CREATE INDEX "applications_origin_type_idx" ON "applications" USING btree ("origin_type");--> statement-breakpoint
CREATE INDEX "documents_student_id_idx" ON "documents" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "documents_application_id_idx" ON "documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "documents_lead_id_idx" ON "documents" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "programs_university_id_idx" ON "programs" USING btree ("university_id");--> statement-breakpoint
CREATE INDEX "programs_degree_idx" ON "programs" USING btree ("degree");--> statement-breakpoint
CREATE INDEX "programs_field_idx" ON "programs" USING btree ("field");--> statement-breakpoint
CREATE INDEX "programs_is_active_idx" ON "programs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "universities_country_idx" ON "universities" USING btree ("country");--> statement-breakpoint
CREATE INDEX "universities_is_active_idx" ON "universities" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "commissions_application_id_idx" ON "commissions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "commissions_agent_id_idx" ON "commissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "commissions_season_idx" ON "commissions" USING btree ("season");--> statement-breakpoint
CREATE INDEX "commissions_status_idx" ON "commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_fees_application_id_idx" ON "service_fees" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "service_fees_agent_id_idx" ON "service_fees" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "service_fees_season_idx" ON "service_fees" USING btree ("season");--> statement-breakpoint
CREATE INDEX "service_fees_status_idx" ON "service_fees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "blog_posts_published_idx" ON "blog_posts" USING btree ("published");--> statement-breakpoint
CREATE INDEX "blog_posts_locale_idx" ON "blog_posts" USING btree ("locale");--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource","resource_id");--> statement-breakpoint
CREATE INDEX "notes_author_id_idx" ON "notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "notes_resource_idx" ON "notes" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "catalog_options_category_idx" ON "catalog_options" USING btree ("category");--> statement-breakpoint
CREATE INDEX "cities_country_id_idx" ON "cities" USING btree ("country_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stages_entity_key_uniq" ON "pipeline_stages" USING btree ("entity_type","key");--> statement-breakpoint
CREATE INDEX "app_stage_docs_application_id_idx" ON "application_stage_documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "app_stage_docs_stage_idx" ON "application_stage_documents" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "embed_submissions_widget_id_idx" ON "embed_submissions" USING btree ("widget_id");--> statement-breakpoint
CREATE INDEX "embed_submissions_created_at_idx" ON "embed_submissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "embed_submissions_lead_id_idx" ON "embed_submissions" USING btree ("lead_id");--> statement-breakpoint
-- Runtime tables that existed outside the original base snapshot. Keeping their
-- additive definitions in the base migration makes a fresh database bootstrap
-- possible; migration 0038 adopts the same structures for established databases.
DO $$ BEGIN
  CREATE TYPE "public"."ai_action_queue_status" AS ENUM('pending_approval', 'approved', 'rejected', 'executed', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_message_role" AS ENUM('user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_provider" AS ENUM('anthropic', 'openai');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_run_status" AS ENUM('success', 'error', 'rate_limited', 'blocked_by_cap');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_run_triggered_by" AS ENUM('manual', 'cron', 'event');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_trigger_mode" AS ENUM('manual', 'scheduled', 'event_driven');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_type" AS ENUM('advisor', 'operator');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_personas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"persona_type" "ai_persona_type" DEFAULT 'advisor' NOT NULL,
	"description" text,
	"avatar_url" text,
	"provider" "ai_persona_provider" DEFAULT 'anthropic' NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"guidelines" text DEFAULT '' NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"temperature" numeric(4, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer DEFAULT 2048 NOT NULL,
	"allowed_data_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_enabled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_mode" "ai_persona_trigger_mode" DEFAULT 'manual' NOT NULL,
	"schedule_cron" text,
	"event_subscriptions" jsonb,
	"output_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_cost_cap_usd" numeric(10, 2),
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_personas_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_action_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"run_id" integer,
	"action_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview" text,
	"status" "ai_action_queue_status" DEFAULT 'pending_approval' NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"entity_type" text DEFAULT 'company' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"intake_schema" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signing_page_config" jsonb,
	"title" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_persona_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "ai_persona_message_role" NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_persona_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"triggered_by" "ai_persona_run_triggered_by" DEFAULT 'manual' NOT NULL,
	"trigger_actor" integer,
	"input_payload" jsonb,
	"output_payload" jsonb,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"status" "ai_persona_run_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"city" text,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"logo_url" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contact_user_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "degree_document_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"catalog_option_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_assignment_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"university_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"staff_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategy" text DEFAULT 'first' NOT NULL,
	"last_assigned_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "object_owners_backfill" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pg_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "popups" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"image_url" text,
	"link_url" text,
	"link_text" text,
	"target_audience" text DEFAULT 'all_agents' NOT NULL,
	"target_agent_ids" integer[] DEFAULT '{}' NOT NULL,
	"frequency" text DEFAULT 'every_session' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "popup_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"popup_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_program_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"university_key" text NOT NULL,
	"level" text DEFAULT '' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "program_document_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signed_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"signing_session_id" integer NOT NULL,
	"agent_id" integer,
	"template_id" integer NOT NULL,
	"pdf_object_key" text,
	"signature_image_object_key" text,
	"evidence_hash" text,
	"signer_email" text NOT NULL,
	"signer_name" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_claimed_at" timestamp with time zone,
	"signature_image_base64" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_program_mapping" (
	"id" serial PRIMARY KEY NOT NULL,
	"university_key" text NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"country_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"member_university_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_view_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" integer,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "object_owners" (
	"object_key" text PRIMARY KEY NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signing_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"agent_id" integer,
	"token_hash" text NOT NULL,
	"mode" text DEFAULT 'admin_driven' NOT NULL,
	"status" text DEFAULT 'review_pending' NOT NULL,
	"intake_data" jsonb,
	"signer_email" text NOT NULL,
	"signer_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" integer,
	"opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_primary_onboarding" boolean DEFAULT false NOT NULL,
	"verified_email" text,
	"expected_email" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"country" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"country" text,
	"year" integer,
	"effective_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"file_object_key" text,
	"file_name" text,
	"file_mime" text,
	"file_size" integer,
	"notes" text,
	"last_warning_30_sent_at" timestamp with time zone,
	"last_warning_14_sent_at" timestamp with time zone,
	"last_warning_7_sent_at" timestamp with time zone,
	"last_warning_1_sent_at" timestamp with time zone,
	"expiry_notice_sent_at" timestamp with time zone,
	"uploaded_by_user_id" integer,
	"assigned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_quality_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"accuracy" integer NOT NULL,
	"completeness" integer NOT NULL,
	"speed" integer NOT NULL,
	"tone" integer NOT NULL,
	"outcome" integer NOT NULL,
	"overall" integer NOT NULL,
	"rationales" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"topic" text,
	"language" text,
	"staff_message_count" integer DEFAULT 0 NOT NULL,
	"avg_reply_seconds" integer,
	"content_hash" text NOT NULL,
	"model" text,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "education_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"level" text NOT NULL,
	"school_name" text,
	"country" text,
	"field_of_study" text,
	"start_month" text,
	"start_year" integer,
	"end_month" text,
	"end_year" integer,
	"gpa" text,
	"gpa_type" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"city" text,
	"language_score" text,
	CONSTRAINT "education_records_student_id_level_key" UNIQUE("student_id","level"),
	CONSTRAINT "education_records_level_check" CHECK (level = ANY (ARRAY['high_school'::text, 'bachelor'::text, 'master'::text])),
	CONSTRAINT "education_records_source_check" CHECK (source = ANY (ARRAY['manual'::text, 'ai_extracted'::text, 'migrated'::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_branches" (
	"agent_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_branches_agent_id_branch_id_pk" PRIMARY KEY("agent_id","branch_id")
);
