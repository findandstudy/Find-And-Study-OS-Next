import { useState } from "react";
import { useI18n } from "@/hooks/use-i18n";
import { useSeo } from "@/hooks/use-seo";
import { useJsonLd, SITE_URL, SITE_NAME } from "@/hooks/use-json-ld";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useListBlogPosts } from "@workspace/api-client-react";
import { Search, BookOpen, Calendar, Clock, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

export default function Blog() {
  const { t, lang } = useI18n();
  useSeo({ title: t("seo.blogTitle"), description: t("seo.blogDesc"), lang });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const { data: postsResp, isLoading } = useListBlogPosts(undefined, { query: { queryKey: ['blog-posts'] } as any });
  const posts = (postsResp as any)?.data || postsResp || [];

  const categories = [
    { key: "All", label: t("blog.all") },
    { key: "University Guide", label: t("blog.universityGuide") },
    { key: "Visa Tips", label: t("blog.visaTips") },
    { key: "Scholarships", label: t("blog.scholarships") },
    { key: "Student Life", label: t("blog.studentLife") },
    { key: "Career Advice", label: t("blog.careerAdvice") },
  ];

  const filtered = (Array.isArray(posts) ? posts : []).filter((p: any) => {
    const matchSearch = !search || p.title.toLowerCase().includes(search.toLowerCase());
    const matchCat = category === "All" || p.category === category;
    return matchSearch && matchCat && (p.status === 'published' || p.published === true);
  });

  const allPublished = (Array.isArray(posts) ? posts : []).filter(
    (p: any) => p.status === 'published' || p.published === true
  );

  useJsonLd([
    {
      "@context": "https://schema.org",
      "@type": "Blog",
      "@id": `${SITE_URL}/en/blog#blog`,
      name: `${SITE_NAME} Blog`,
      url: `${SITE_URL}/en/blog`,
      description: "Expert advice on studying abroad, university applications, scholarships, visa tips, and student life.",
      publisher: {
        "@type": "EducationalOrganization",
        "@id": `${SITE_URL}/#organization`,
        name: SITE_NAME,
      },
      breadcrumb: {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/en/blog` },
        ],
      },
    },
    ...(allPublished.slice(0, 10).map((p: any) => ({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "@id": `${SITE_URL}/en/blog/${p.slug || p.id}#blogposting`,
      headline: p.title,
      url: `${SITE_URL}/en/blog/${p.slug || p.id}`,
      description: p.excerpt || p.summary || undefined,
      datePublished: p.publishedAt || p.createdAt || undefined,
      dateModified: p.updatedAt || p.publishedAt || undefined,
      author: {
        "@type": "Organization",
        name: SITE_NAME,
        url: SITE_URL,
      },
      publisher: {
        "@type": "EducationalOrganization",
        "@id": `${SITE_URL}/#organization`,
        name: SITE_NAME,
      },
      isPartOf: { "@id": `${SITE_URL}/en/blog#blog` },
      ...(p.category ? { articleSection: p.category } : {}),
      ...(p.coverImageUrl || p.imageUrl
        ? { image: { "@type": "ImageObject", url: p.coverImageUrl || p.imageUrl } }
        : {}),
    }))),
  ]);

  return (
    <>
      <section className="pt-24 pb-16 bg-gradient-to-br from-accent/5 via-background to-primary/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <span className="inline-flex items-center gap-2 bg-accent/10 text-accent text-sm font-semibold px-4 py-2 rounded-full mb-6">
              <BookOpen className="w-4 h-4" /> {t("blog.badge")}
            </span>
            <h1 className="text-4xl md:text-6xl font-display font-bold text-foreground mb-6">
              {t("blog.title")} <span className="text-accent">{t("blog.titleHighlight")}</span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
              {t("blog.subtitle")}
            </p>
            <div className="max-w-lg mx-auto relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" aria-hidden="true" />
              <Input
                id="blog-search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t("blog.searchPlaceholder")}
                aria-label={t("blog.searchPlaceholder")}
                className="pl-12 py-5 rounded-full shadow-md" />
            </div>
          </motion.div>
        </div>
      </section>

      <section className="py-8 border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex gap-3 flex-wrap justify-center" role="group" aria-label={t("blog.filterByCategory")}>
            {categories.map(c => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                aria-pressed={category === c.key}
                className={`px-5 py-2 rounded-full text-sm font-medium transition-all
                  ${category === c.key ? 'bg-accent text-white shadow-md shadow-accent/25' : 'bg-secondary hover:bg-accent/10 text-muted-foreground hover:text-accent'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {isLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[...Array(6)].map((_, i) => <div key={i} className="h-80 rounded-2xl bg-secondary animate-pulse" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-24">
              <BookOpen className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">{t("blog.noArticles")}</h3>
              <p className="text-muted-foreground">{t("blog.tryAdjusting")}</p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {filtered.map((post: any, i: number) => (
                <motion.article key={post.id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                  className="group bg-card rounded-2xl overflow-hidden shadow-lg shadow-black/5 hover:-translate-y-2 transition-all duration-300 hover:shadow-xl border border-border/40 flex flex-col">
                  <div className="h-48 bg-gradient-to-br from-accent/20 via-primary/10 to-accent/5 relative overflow-hidden">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <BookOpen className="w-16 h-16 text-accent/30" />
                    </div>
                    {post.category && (
                      <Badge className="absolute top-4 left-4 bg-accent text-white">{post.category}</Badge>
                    )}
                  </div>
                  <div className="p-6 flex flex-col flex-1">
                    <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
                      {post.publishedAt && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {new Date(post.publishedAt).toLocaleDateString(lang, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> 5 {t("blog.minRead")}</span>
                    </div>
                    <h2 className="font-display font-bold text-foreground text-xl mb-3 group-hover:text-accent transition-colors leading-snug flex-1">
                      {post.title}
                    </h2>
                    {post.excerpt && (
                      <p className="text-muted-foreground text-sm line-clamp-3 mb-4">{post.excerpt}</p>
                    )}
                    <button
                      type="button"
                      aria-label={`${t("blog.readMore")} — ${post.title}`}
                      className="flex items-center gap-2 text-accent font-semibold text-sm mt-auto hover:gap-4 transition-all">
                      {t("blog.readMore")} <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </motion.article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
