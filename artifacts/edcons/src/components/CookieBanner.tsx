import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Cookie } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";
import { motion, AnimatePresence } from "framer-motion";

const CONSENT_KEY = "cookie_consent";

type CookieConsent = "all" | "essential" | null;

function getConsent(): CookieConsent {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === "all" || v === "essential") return v;
  } catch {}
  return null;
}

export function CookieBanner() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!getConsent()) setVisible(true);
  }, []);

  function accept(choice: "all" | "essential") {
    try {
      localStorage.setItem(CONSENT_KEY, choice);
    } catch {}
    setVisible(false);
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="cookie-banner"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-t border-border shadow-2xl"
          role="region"
          aria-label="Cookie consent"
        >
          <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Cookie className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground leading-snug">
                  {t("cookie.title")}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {t("cookie.description")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg text-xs h-8 px-3"
                onClick={() => accept("essential")}
              >
                {t("cookie.essentialOnly")}
              </Button>
              <Button
                size="sm"
                className="rounded-lg text-xs h-8 px-4"
                onClick={() => accept("all")}
              >
                {t("cookie.acceptAll")}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
