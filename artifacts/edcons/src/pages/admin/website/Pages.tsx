import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Edit, Search, Globe, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

interface WebsitePage {
  id: number;
  title: string;
  slug: string;
  status: string;
  template: string;
  publishedAt: string | null;
  updatedAt: string;
  sortOrder: number;
}

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  published: { label: "Published", variant: "default" },
  draft: { label: "Draft", variant: "secondary" },
  archived: { label: "Archived", variant: "outline" },
};

const TEMPLATE_ICONS: Record<string, string> = {
  home: "🏠", about: "📖", countries: "🌍", programs: "📚", blog: "✍️", contact: "📧",
};

export default function WebsitePages() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: pages = [], isLoading } = useQuery<WebsitePage[]>({
    queryKey: ["website-pages"],
    queryFn: () => customFetch("/api/website/pages"),
  });

  const seedMutation = useMutation({
    mutationFn: () => customFetch("/api/website/pages/seed", { method: "POST", headers: { "Content-Type": "application/json" } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["website-pages"] }),
  });

  useEffect(() => {
    if (!isLoading && pages.length === 0) {
      seedMutation.mutate();
    }
  }, [isLoading, pages.length]);

  const filtered = pages.filter(p => {
    if (searchTerm && !p.title.toLowerCase().includes(searchTerm.toLowerCase()) && !p.slug.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    return true;
  });

  return (
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Pages</h1>
              <p className="text-sm text-muted-foreground">Manage your website pages and their content.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search pages..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="published">Published</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading || seedMutation.isPending ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Globe className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No pages found.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(page => {
              const badge = STATUS_BADGE[page.status] || STATUS_BADGE.draft;
              const icon = TEMPLATE_ICONS[page.template] || "📄";
              return (
                <Card key={page.id} className="hover:border-primary/30 transition-colors">
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center text-xl shrink-0">
                      {icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-foreground">{page.title}</h3>
                        <Badge variant={badge.variant} className="text-xs">
                          {page.status === "published" ? <Eye className="w-3 h-3 mr-1" /> : <EyeOff className="w-3 h-3 mr-1" />}
                          {badge.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                        <span>/{page.slug}</span>
                        <span>·</span>
                        <span>Template: {page.template}</span>
                        {page.publishedAt && (
                          <>
                            <span>·</span>
                            <span>Published: {new Date(page.publishedAt).toLocaleDateString()}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setLocation(`/admin/website/pages/${page.id}/edit`)}
                    >
                      <Edit className="w-4 h-4 mr-1" /> Edit
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
  );
}
