import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import {
  Bell, Plus, Pencil, Trash2, Loader2, Search, ExternalLink, ImageIcon, Users, Calendar, RefreshCw,
} from "lucide-react";

interface Popup {
  id: number;
  title: string;
  content: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkText: string | null;
  targetAudience: string;
  targetAgentIds: number[];
  frequency: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentUser {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

function toastApiError(toast: ReturnType<typeof useToast>["toast"], err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    if (err.status === 401) return;
    const data = err.data as { error?: string; message?: string } | null;
    toast({ title: fallback, description: data?.error || data?.message || err.message, variant: "destructive" });
    return;
  }
  if (err instanceof Error) {
    toast({ title: fallback, description: err.message, variant: "destructive" });
    return;
  }
  toast({ title: fallback, variant: "destructive" });
}

const AUDIENCE_COLORS: Record<string, string> = {
  all_users:       "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30",
  all_agents:      "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  specific_agents: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  inactive: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30",
};

const FREQ_COLORS: Record<string, string> = {
  every_session: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  every_login:   "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
  once_per_user: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30",
};

export default function PopupsPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Popup | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Popup | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["popups"],
    queryFn: () => customFetch<{ data: Popup[] }>("/api/popups"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => customFetch(`/api/popups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("popups.deleted") });
      queryClient.invalidateQueries({ queryKey: ["popups"] });
    },
    onError: (err) => toastApiError(toast, err, t("popups.deleteFailed")),
  });

  const items: Popup[] = data?.data || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(p =>
      p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
    );
  }, [items, search]);

  function openCreate() {
    setEditing(null);
    setShowDialog(true);
  }

  function openEdit(p: Popup) {
    setEditing(p);
    setShowDialog(true);
  }

  function confirmDelete(p: Popup) {
    setDeleteTarget(p);
  }

  async function doDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id);
    setDeleteTarget(null);
  }

  function formatDate(d: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" });
  }

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto" data-testid="page-popups">
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Bell className="w-6 h-6 text-primary" />
            {t("popups.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("popups.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => refetch()} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button onClick={openCreate} data-testid="button-new-popup">
            <Plus className="w-4 h-4 mr-1.5" />
            {t("popups.newPopup")}
          </Button>
        </div>
      </div>

      <div className="mb-4 relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("popups.searchPlaceholder")}
          className="pl-9"
          data-testid="input-search"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Bell className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-medium">{t("popups.none")}</p>
            <Button className="mt-4" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-1.5" /> {t("popups.createFirst")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Title / Content</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground hidden md:table-cell">Audience</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground hidden md:table-cell">Frequency</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground hidden lg:table-cell">Status</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground hidden lg:table-cell">Date Range</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground hidden xl:table-cell">Created</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr
                  key={p.id}
                  className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${i % 2 === 0 ? "" : "bg-muted/5"}`}
                  data-testid={`popup-row-${p.id}`}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium truncate max-w-[200px]">{p.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{p.content}</p>
                    {p.imageUrl && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                        <ImageIcon className="w-3 h-3" /> Image
                      </span>
                    )}
                    {p.linkUrl && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mt-0.5 ml-2">
                        <ExternalLink className="w-3 h-3" /> Link
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <Badge variant="outline" className={`text-[10px] ${AUDIENCE_COLORS[p.targetAudience] || ""}`}>
                      {t(`popups.audience.${p.targetAudience}`)}
                    </Badge>
                    {p.targetAudience === "specific_agents" && p.targetAgentIds.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <Users className="w-3 h-3" /> {p.targetAgentIds.length}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <Badge variant="outline" className={`text-[10px] ${FREQ_COLORS[p.frequency] || ""}`}>
                      {t(`popups.frequency.${p.frequency}`)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[p.status] || ""}`}>
                      {t(`popups.status.${p.status}`)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                    {p.startsAt || p.expiresAt ? (
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatDate(p.startsAt)} → {formatDate(p.expiresAt)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">Always</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell text-xs text-muted-foreground">
                    {formatDate(p.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => openEdit(p)}
                        data-testid={`button-edit-${p.id}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => confirmDelete(p)}
                        data-testid={`button-delete-${p.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showDialog && (
        <PopupDialog
          existing={editing}
          onClose={() => setShowDialog(false)}
          onSaved={() => {
            setShowDialog(false);
            queryClient.invalidateQueries({ queryKey: ["popups"] });
          }}
        />
      )}

      {deleteTarget && (
        <Dialog open={true} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
          <DialogContent className="max-w-sm" data-testid="dialog-delete-confirm">
            <DialogHeader>
              <DialogTitle>Delete Pop-up</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("popups.deleteConfirm")}</p>
            <p className="text-sm font-medium mt-1">{deleteTarget.title}</p>
            <DialogFooter className="mt-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={doDelete}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete"
              >
                {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PopupDialog({
  existing,
  onClose,
  onSaved,
}: {
  existing: Popup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [title, setTitle] = useState(existing?.title || "");
  const [content, setContent] = useState(existing?.content || "");
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl || "");
  const [linkUrl, setLinkUrl] = useState(existing?.linkUrl || "");
  const [linkText, setLinkText] = useState(existing?.linkText || "");
  const [targetAudience, setTargetAudience] = useState(existing?.targetAudience || "all_agents");
  const [targetAgentIds, setTargetAgentIds] = useState<Set<number>>(new Set(existing?.targetAgentIds || []));
  const [frequency, setFrequency] = useState(existing?.frequency || "every_session");
  const [status, setStatus] = useState(existing?.status || "active");
  const [startsAt, setStartsAt] = useState(existing?.startsAt ? toDatetimeLocal(existing.startsAt) : "");
  const [expiresAt, setExpiresAt] = useState(existing?.expiresAt ? toDatetimeLocal(existing.expiresAt) : "");
  const [saving, setSaving] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: agentsData } = useQuery({
    queryKey: ["users", "agent"],
    queryFn: () => customFetch<{ data: AgentUser[]; users?: AgentUser[] }>("/api/users?role=agent&limit=500"),
    enabled: targetAudience === "specific_agents",
    staleTime: 60_000,
  });

  const agentList: AgentUser[] = agentsData?.data ?? agentsData?.users ?? [];

  const filteredAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    if (!q) return agentList;
    return agentList.filter(a => {
      const name = `${a.firstName || ""} ${a.lastName || ""}`.toLowerCase();
      const email = (a.email || "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [agentList, agentSearch]);

  function toggleAgent(id: number) {
    const next = new Set(targetAgentIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setTargetAgentIds(next);
  }

  async function handleImageUpload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await customFetch<{ url: string }>("/api/uploads/content", { method: "POST", body: form });
      setImageUrl(res.url || "");
    } catch (err) {
      toastApiError(toast, err, "Image upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!title.trim()) { toast({ title: t("popups.errors.titleRequired"), variant: "destructive" }); return; }
    if (!content.trim()) { toast({ title: t("popups.errors.contentRequired"), variant: "destructive" }); return; }

    const payload = {
      title: title.trim(),
      content: content.trim(),
      imageUrl: imageUrl.trim() || null,
      linkUrl: linkUrl.trim() || null,
      linkText: linkText.trim() || null,
      targetAudience,
      targetAgentIds: Array.from(targetAgentIds),
      frequency,
      status,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };

    setSaving(true);
    try {
      if (existing) {
        await customFetch(`/api/popups/${existing.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("popups.updated") });
      } else {
        await customFetch("/api/popups", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("popups.created") });
      }
      onSaved();
    } catch (err) {
      toastApiError(toast, err, existing ? t("popups.updateFailed") : t("popups.createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-popup">
        <DialogHeader>
          <DialogTitle>{existing ? t("popups.editTitle") : t("popups.createTitle")}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
          <div className="md:col-span-2">
            <Label htmlFor="pf-title">{t("popups.fields.title")} *</Label>
            <Input
              id="pf-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t("popups.fields.titlePlaceholder")}
              data-testid="input-title"
            />
          </div>

          <div className="md:col-span-2">
            <Label htmlFor="pf-content">{t("popups.fields.content")} *</Label>
            <Textarea
              id="pf-content"
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={4}
              placeholder={t("popups.fields.contentPlaceholder")}
              data-testid="input-content"
            />
          </div>

          <div className="md:col-span-2">
            <Label>{t("popups.fields.imageUrl")}</Label>
            <div className="flex gap-2">
              <Input
                value={imageUrl}
                onChange={e => setImageUrl(e.target.value)}
                placeholder={t("popups.fields.imageUrlPlaceholder")}
                data-testid="input-image-url"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = ""; }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
              </Button>
            </div>
            {imageUrl && (
              <img
                src={imageUrl}
                alt="Preview"
                className="mt-2 rounded-lg max-h-32 object-cover border"
                onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            )}
          </div>

          <div>
            <Label htmlFor="pf-link-url">{t("popups.fields.linkUrl")}</Label>
            <Input
              id="pf-link-url"
              value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              placeholder={t("popups.fields.linkUrlPlaceholder")}
              data-testid="input-link-url"
            />
          </div>

          <div>
            <Label htmlFor="pf-link-text">{t("popups.fields.linkText")}</Label>
            <Input
              id="pf-link-text"
              value={linkText}
              onChange={e => setLinkText(e.target.value)}
              placeholder={t("popups.fields.linkTextPlaceholder")}
              data-testid="input-link-text"
            />
          </div>

          <div>
            <Label>{t("popups.fields.targetAudience")}</Label>
            <Select value={targetAudience} onValueChange={setTargetAudience}>
              <SelectTrigger data-testid="select-audience"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all_users">{t("popups.audience.all_users")}</SelectItem>
                <SelectItem value="all_agents">{t("popups.audience.all_agents")}</SelectItem>
                <SelectItem value="specific_agents">{t("popups.audience.specific_agents")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t("popups.fields.frequency")}</Label>
            <Select value={frequency} onValueChange={setFrequency}>
              <SelectTrigger data-testid="select-frequency"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="every_session">{t("popups.frequency.every_session")}</SelectItem>
                <SelectItem value="every_login">{t("popups.frequency.every_login")}</SelectItem>
                <SelectItem value="once_per_user">{t("popups.frequency.once_per_user")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {targetAudience === "specific_agents" && (
            <div className="md:col-span-2">
              <Label>{t("popups.fields.agents")}</Label>
              <div className="border rounded-lg mt-1">
                <div className="p-2 border-b">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={agentSearch}
                      onChange={e => setAgentSearch(e.target.value)}
                      placeholder={t("popups.agentSearchPlaceholder")}
                      className="pl-9 h-8"
                    />
                  </div>
                </div>
                <ScrollArea className="h-48">
                  <div className="p-2 space-y-1">
                    {filteredAgents.length === 0 ? (
                      <p className="text-sm text-muted-foreground p-2">{t("popups.noAgents")}</p>
                    ) : filteredAgents.map(a => (
                      <label key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer">
                        <Checkbox
                          checked={targetAgentIds.has(a.id)}
                          onCheckedChange={() => toggleAgent(a.id)}
                          data-testid={`agent-checkbox-${a.id}`}
                        />
                        <span className="text-sm flex-1 truncate">
                          {a.firstName} {a.lastName}
                          {a.email && <span className="text-muted-foreground ml-1">({a.email})</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
              </div>
              {targetAgentIds.size > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t("popups.selectedAgents", { count: targetAgentIds.size })}
                </p>
              )}
            </div>
          )}

          <div>
            <Label>{t("popups.fields.status")}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger data-testid="select-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t("popups.status.active")}</SelectItem>
                <SelectItem value="inactive">{t("popups.status.inactive")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="pf-starts">{t("popups.fields.startsAt")}</Label>
            <Input
              id="pf-starts"
              type="datetime-local"
              value={startsAt}
              onChange={e => setStartsAt(e.target.value)}
              data-testid="input-starts-at"
            />
          </div>

          <div>
            <Label htmlFor="pf-expires">{t("popups.fields.expiresAt")}</Label>
            <Input
              id="pf-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={e => setExpiresAt(e.target.value)}
              data-testid="input-expires-at"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} data-testid="button-save">
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toDatetimeLocal(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}
