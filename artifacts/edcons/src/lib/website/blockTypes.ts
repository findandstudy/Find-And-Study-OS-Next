export interface BlockFieldDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "richtext" | "image" | "url" | "number" | "select" | "toggle" | "color" | "items";
  placeholder?: string;
  options?: { label: string; value: string }[];
  itemFields?: BlockFieldDef[];
  defaultValue?: unknown;
}

export interface BlockTypeDef {
  type: string;
  label: string;
  icon: string;
  category: "content" | "media" | "layout" | "data" | "reference";
  fields: BlockFieldDef[];
  defaultContent: Record<string, unknown>;
}

export const BLOCK_TYPES: BlockTypeDef[] = [
  {
    type: "hero",
    label: "Hero",
    icon: "🏠",
    category: "content",
    fields: [
      { key: "badge", label: "Badge Text", type: "text", placeholder: "e.g. #1 Education Consultancy" },
      { key: "title", label: "Title", type: "text", placeholder: "Your headline" },
      { key: "subtitle", label: "Subtitle", type: "textarea", placeholder: "Supporting text" },
      { key: "ctaLabel", label: "CTA Button Label", type: "text", placeholder: "Get Started" },
      { key: "ctaUrl", label: "CTA Button URL", type: "url", placeholder: "/contact" },
      { key: "secondaryLabel", label: "Secondary Button Label", type: "text" },
      { key: "secondaryUrl", label: "Secondary Button URL", type: "url" },
      { key: "backgroundImage", label: "Background Image", type: "image" },
      { key: "overlay", label: "Show Overlay", type: "toggle" },
    ],
    defaultContent: { badge: "", title: "Welcome", subtitle: "", ctaLabel: "Get Started", ctaUrl: "/contact", secondaryLabel: "", secondaryUrl: "", backgroundImage: "", overlay: true },
  },
  {
    type: "rich_text",
    label: "Rich Text",
    icon: "📝",
    category: "content",
    fields: [
      { key: "content", label: "Content (HTML)", type: "richtext", placeholder: "Enter rich text content..." },
      { key: "maxWidth", label: "Max Width", type: "select", options: [{ label: "Narrow", value: "narrow" }, { label: "Medium", value: "medium" }, { label: "Wide", value: "wide" }, { label: "Full", value: "full" }] },
    ],
    defaultContent: { content: "<p>Enter your content here...</p>", maxWidth: "medium" },
  },
  {
    type: "stats_strip",
    label: "Stats Strip",
    icon: "📊",
    category: "data",
    fields: [
      { key: "bgColor", label: "Background", type: "select", options: [{ label: "Primary", value: "primary" }, { label: "Card", value: "card" }, { label: "Transparent", value: "transparent" }] },
      {
        key: "stats", label: "Stats", type: "items",
        itemFields: [
          { key: "value", label: "Value", type: "text", placeholder: "500+" },
          { key: "label", label: "Label", type: "text", placeholder: "Universities" },
        ],
      },
    ],
    defaultContent: { bgColor: "card", stats: [{ value: "500+", label: "Universities" }, { value: "30+", label: "Countries" }, { value: "98%", label: "Visa Rate" }, { value: "$2M+", label: "Scholarships" }] },
  },
  {
    type: "feature_cards",
    label: "Feature Cards",
    icon: "🃏",
    category: "content",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "columns", label: "Columns", type: "select", options: [{ label: "2", value: "2" }, { label: "3", value: "3" }, { label: "4", value: "4" }] },
      {
        key: "cards", label: "Cards", type: "items",
        itemFields: [
          { key: "icon", label: "Icon Name", type: "text", placeholder: "Globe2" },
          { key: "title", label: "Title", type: "text" },
          { key: "description", label: "Description", type: "textarea" },
          { key: "linkUrl", label: "Link URL", type: "url" },
          { key: "linkLabel", label: "Link Label", type: "text" },
        ],
      },
    ],
    defaultContent: { title: "Our Services", subtitle: "", columns: "3", cards: [{ icon: "Globe2", title: "University Matching", description: "Find your ideal university.", linkUrl: "", linkLabel: "" }] },
  },
  {
    type: "icon_cards",
    label: "Icon Cards",
    icon: "🔲",
    category: "content",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "cards", label: "Cards", type: "items",
        itemFields: [
          { key: "icon", label: "Icon Name", type: "text" },
          { key: "title", label: "Title", type: "text" },
          { key: "description", label: "Description", type: "textarea" },
        ],
      },
    ],
    defaultContent: { title: "Why Choose Us", subtitle: "", cards: [{ icon: "Star", title: "Expert Guidance", description: "Professional consultants." }] },
  },
  {
    type: "cta_banner",
    label: "CTA Banner",
    icon: "📢",
    category: "content",
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "ctaLabel", label: "Button Label", type: "text" },
      { key: "ctaUrl", label: "Button URL", type: "url" },
      { key: "secondaryLabel", label: "Secondary Button", type: "text" },
      { key: "secondaryUrl", label: "Secondary URL", type: "url" },
      { key: "bgStyle", label: "Background Style", type: "select", options: [{ label: "Gradient", value: "gradient" }, { label: "Solid Primary", value: "solid" }, { label: "Image", value: "image" }] },
      { key: "bgImage", label: "Background Image", type: "image" },
    ],
    defaultContent: { title: "Ready to Start?", subtitle: "Get in touch today.", ctaLabel: "Contact Us", ctaUrl: "/contact", secondaryLabel: "", secondaryUrl: "", bgStyle: "gradient", bgImage: "" },
  },
  {
    type: "faq",
    label: "FAQ",
    icon: "❓",
    category: "data",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "source", label: "Source", type: "select", options: [{ label: "Manual", value: "manual" }, { label: "From Collections", value: "collection" }] },
      {
        key: "items", label: "FAQ Items", type: "items",
        itemFields: [
          { key: "question", label: "Question", type: "text" },
          { key: "answer", label: "Answer", type: "textarea" },
        ],
      },
    ],
    defaultContent: { title: "Frequently Asked Questions", subtitle: "", source: "manual", items: [{ question: "How do I apply?", answer: "Contact our team to get started." }] },
  },
  {
    type: "team_grid",
    label: "Team Grid",
    icon: "👥",
    category: "data",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "source", label: "Source", type: "select", options: [{ label: "From Collections", value: "collection" }, { label: "Manual", value: "manual" }] },
      {
        key: "members", label: "Team Members", type: "items",
        itemFields: [
          { key: "name", label: "Name", type: "text" },
          { key: "role", label: "Role", type: "text" },
          { key: "photo", label: "Photo URL", type: "image" },
          { key: "bio", label: "Bio", type: "textarea" },
        ],
      },
    ],
    defaultContent: { title: "Our Team", subtitle: "", source: "collection", members: [] },
  },
  {
    type: "office_list",
    label: "Office List",
    icon: "🏢",
    category: "data",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "source", label: "Source", type: "select", options: [{ label: "From Collections", value: "collection" }, { label: "Manual", value: "manual" }] },
      {
        key: "offices", label: "Offices", type: "items",
        itemFields: [
          { key: "name", label: "Name", type: "text" },
          { key: "city", label: "City", type: "text" },
          { key: "address", label: "Address", type: "textarea" },
          { key: "phone", label: "Phone", type: "text" },
          { key: "email", label: "Email", type: "text" },
        ],
      },
    ],
    defaultContent: { title: "Our Offices", subtitle: "", source: "collection", offices: [] },
  },
  {
    type: "logo_grid",
    label: "Logo Grid",
    icon: "🏷️",
    category: "media",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      {
        key: "logos", label: "Logos", type: "items",
        itemFields: [
          { key: "name", label: "Name", type: "text" },
          { key: "imageUrl", label: "Logo URL", type: "image" },
          { key: "linkUrl", label: "Link URL", type: "url" },
        ],
      },
    ],
    defaultContent: { title: "Partner Universities", subtitle: "", logos: [] },
  },
  {
    type: "testimonials",
    label: "Testimonials",
    icon: "💬",
    category: "data",
    fields: [
      { key: "title", label: "Section Title", type: "text" },
      { key: "subtitle", label: "Section Subtitle", type: "textarea" },
      { key: "source", label: "Source", type: "select", options: [{ label: "From Collections", value: "collection" }, { label: "Manual", value: "manual" }] },
      { key: "layout", label: "Layout", type: "select", options: [{ label: "Carousel", value: "carousel" }, { label: "Grid", value: "grid" }] },
      {
        key: "items", label: "Testimonials", type: "items",
        itemFields: [
          { key: "name", label: "Name", type: "text" },
          { key: "role", label: "Role", type: "text" },
          { key: "content", label: "Content", type: "textarea" },
          { key: "photo", label: "Photo URL", type: "image" },
          { key: "rating", label: "Rating (1-5)", type: "number" },
        ],
      },
    ],
    defaultContent: { title: "What Students Say", subtitle: "", source: "collection", layout: "carousel", items: [] },
  },
  {
    type: "section_title",
    label: "Section Title + Subtitle",
    icon: "📌",
    category: "layout",
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "alignment", label: "Alignment", type: "select", options: [{ label: "Left", value: "left" }, { label: "Center", value: "center" }, { label: "Right", value: "right" }] },
      { key: "size", label: "Size", type: "select", options: [{ label: "Small", value: "sm" }, { label: "Medium", value: "md" }, { label: "Large", value: "lg" }] },
    ],
    defaultContent: { title: "Section Title", subtitle: "", alignment: "center", size: "md" },
  },
  {
    type: "spacer_divider",
    label: "Spacer / Divider",
    icon: "➖",
    category: "layout",
    fields: [
      { key: "height", label: "Height (px)", type: "number", defaultValue: 48 },
      { key: "showDivider", label: "Show Divider Line", type: "toggle" },
      { key: "dividerColor", label: "Divider Color", type: "color" },
    ],
    defaultContent: { height: 48, showDivider: false, dividerColor: "#e5e7eb" },
  },
  {
    type: "global_block",
    label: "Reusable Global Block",
    icon: "🔗",
    category: "reference",
    fields: [
      { key: "globalComponentId", label: "Global Component ID", type: "number" },
      { key: "globalComponentSlug", label: "Component Slug", type: "text" },
    ],
    defaultContent: { globalComponentId: null, globalComponentSlug: "" },
  },
];

export function getBlockTypeDef(type: string): BlockTypeDef | undefined {
  return BLOCK_TYPES.find(bt => bt.type === type);
}

export function getDefaultContent(type: string): Record<string, unknown> {
  const def = getBlockTypeDef(type);
  return def ? { ...def.defaultContent } : {};
}

export interface PageBlock {
  id?: number;
  blockType: string;
  content: Record<string, unknown>;
  settings: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
}
