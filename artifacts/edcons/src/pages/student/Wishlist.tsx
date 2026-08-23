import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Heart, GraduationCap, MapPin, Clock, Globe, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { useI18n } from "@/hooks/use-i18n";

const BASE_URL = import.meta.env.VITE_API_URL || "";

export default function StudentWishlist() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: programs = [], isLoading } = useQuery<any[]>({
    queryKey: ["wishlist-details"],
    queryFn: () => customFetch(`${BASE_URL}/api/wishlists/details`),
  });

  const removeMutation = useMutation({
    mutationFn: (programId: number) =>
      customFetch(`${BASE_URL}/api/wishlists/${programId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wishlist-details"] });
      queryClient.invalidateQueries({ queryKey: ["wishlists"] });
      toast({ title: t("studentWishlist.removed") });
    },
  });

  const formatFee = (fee: number | null, currency: string) => {
    if (!fee) return null;
    return `${currency === "TRY" ? "₺" : "$"}${fee.toLocaleString()}`;
  };

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t("studentWishlist.title")}</h1>
          <p className="text-muted-foreground mt-1">
            {t(programs.length === 1 ? "studentWishlist.subtitle" : "studentWishlist.subtitlePlural", { count: programs.length })}
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-card rounded-2xl border p-6 animate-pulse">
                <div className="h-5 bg-muted rounded w-3/4 mb-3" />
                <div className="h-4 bg-muted rounded w-1/2 mb-2" />
                <div className="h-4 bg-muted rounded w-1/3" />
              </div>
            ))}
          </div>
        ) : programs.length === 0 ? (
          <div className="bg-card rounded-2xl border p-16 text-center">
            <Heart className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-30" />
            <h3 className="text-lg font-semibold mb-2">{t("studentWishlist.empty")}</h3>
            <p className="text-muted-foreground text-sm mb-6">
              {t("studentWishlist.emptyDesc")}
            </p>
            <Button onClick={() => navigate("/student/course-finder")} variant="outline">
              {t("studentWishlist.browsePrograms")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {programs.map((p: any) => {
              const effectiveFee = p.discountedFee ?? p.tuitionFee;
              const hasDiscount = p.discountedFee && p.tuitionFee && p.discountedFee < p.tuitionFee;
              return (
                <div key={p.id} className="bg-card rounded-2xl border shadow-sm hover:shadow-md transition-all group">
                  <div className="p-5">
                    <div className="flex items-start gap-3 mb-3">
                      {p.universityLogo ? (
                        <img src={p.universityLogo} alt="" className="w-10 h-10 rounded-lg object-contain border bg-white shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <GraduationCap className="w-5 h-5 text-primary" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-muted-foreground">{p.universityName}</p>
                        <h3 className="font-semibold text-sm leading-tight mt-0.5">{p.name}</h3>
                      </div>
                      <button
                        onClick={() => removeMutation.mutate(p.id)}
                        className="shrink-0 p-2 rounded-full hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                        title={t("studentWishlist.removeFromWishlist")}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {p.degree && <Badge variant="secondary" className="text-xs px-2 py-0.5">{p.degree}</Badge>}
                      {p.language && (
                        <Badge variant="outline" className="text-xs px-2 py-0.5">
                          <Globe className="w-3 h-3 mr-1" />{p.language}
                        </Badge>
                      )}
                      {p.duration && (
                        <Badge variant="outline" className="text-xs px-2 py-0.5">
                          <Clock className="w-3 h-3 mr-1" />{p.duration}
                        </Badge>
                      )}
                      {p.universityCountry && (
                        <Badge variant="outline" className="text-xs px-2 py-0.5">
                          <MapPin className="w-3 h-3 mr-1" />{p.universityCountry}
                        </Badge>
                      )}
                      {p.universityCity && (
                        <Badge variant="outline" className="text-xs px-2 py-0.5">{p.universityCity}</Badge>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t">
                      <div>
                        {effectiveFee ? (
                          <div className="flex items-baseline gap-2">
                            {hasDiscount && (
                              <span className="text-xs text-muted-foreground line-through">
                                {formatFee(p.tuitionFee, p.currency || "USD")}
                              </span>
                            )}
                            <span className="font-bold text-primary">
                              {formatFee(effectiveFee, p.currency || "USD")}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("studentWishlist.feeNotSpecified")}</span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => navigate("/student/course-finder")}
                      >
                        <ExternalLink className="w-3 h-3 mr-1" />
                        {t("studentWishlist.viewDetails")}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
  );
}
