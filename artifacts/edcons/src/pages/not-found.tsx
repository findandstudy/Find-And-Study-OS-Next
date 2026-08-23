import { Link } from "wouter";
import { useI18n } from "@/hooks/use-i18n";
import { useSeo } from "@/hooks/use-seo";
import { Button } from "@/components/ui/button";
import { BookOpen, Globe2, Home, Phone, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

const NAV_LINKS = [
  {
    icon: Home,
    labelKey: "nav.home" as const,
    path: "/",
    color: "text-primary",
    bg: "bg-primary/10 hover:bg-primary/20",
  },
  {
    icon: BookOpen,
    labelKey: "nav.programs" as const,
    path: "/programs",
    color: "text-violet-500",
    bg: "bg-violet-500/10 hover:bg-violet-500/20",
  },
  {
    icon: Globe2,
    labelKey: "nav.countries" as const,
    path: "/countries",
    color: "text-blue-500",
    bg: "bg-blue-500/10 hover:bg-blue-500/20",
  },
  {
    icon: Phone,
    labelKey: "nav.contact" as const,
    path: "/contact",
    color: "text-green-500",
    bg: "bg-green-500/10 hover:bg-green-500/20",
  },
];

export default function NotFound() {
  const { t, lang, localePath, isRTL } = useI18n();
  useSeo({ title: t("notFound.title"), noindex: true, lang });

  return (
    <div
      dir={isRTL ? "rtl" : "ltr"}
      className="flex flex-col items-center justify-center px-4 py-24 text-center"
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-lg"
      >
        <div className="mb-6 select-none">
          <span className="text-[7rem] md:text-[9rem] font-display font-extrabold leading-none bg-gradient-to-br from-primary via-primary/70 to-primary/30 bg-clip-text text-transparent">
            404
          </span>
        </div>

        <h1 className="text-2xl md:text-3xl font-bold text-foreground mb-3">
          {t("notFound.title")}
        </h1>
        <p className="text-muted-foreground mb-10 max-w-sm mx-auto leading-relaxed">
          {t("notFound.description")}
        </p>

        <div className="grid grid-cols-2 gap-3 mb-8">
          {NAV_LINKS.map(({ icon: Icon, labelKey, path, color, bg }) => (
            <Link key={path} href={localePath(path)}>
              <div
                className={`flex items-center gap-3 rounded-xl px-4 py-3 cursor-pointer transition-all duration-200 ${bg} border border-transparent hover:border-border/50 group`}
              >
                <div className={`shrink-0 ${color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <span className="font-medium text-sm text-foreground">
                  {t(labelKey)}
                </span>
                <ArrowRight
                  className={`w-3.5 h-3.5 ms-auto opacity-0 group-hover:opacity-100 transition-opacity ${color}`}
                />
              </div>
            </Link>
          ))}
        </div>

        <Button size="lg" className="rounded-full px-8 h-12 shadow-lg shadow-primary/20" asChild>
          <Link href={localePath("/")}>{t("notFound.goHome")}</Link>
        </Button>
      </motion.div>
    </div>
  );
}
