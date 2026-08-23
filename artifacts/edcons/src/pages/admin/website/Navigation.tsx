import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Menu, Plus, Edit, Trash2, GripVertical, ExternalLink, Eye, EyeOff, ChevronRight, ArrowUp, ArrowDown, Link2,
} from "lucide-react";

interface NavMenu {
  id: number;
  name: string;
  slug: string;
  location: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface NavItem {
  id: number;
  menuId: number;
  label: string;
  url: string | null;
  pageId: number | null;
  parentId: number | null;
  target: string;
  iconClass: string | null;
  sortOrder: number;
  isVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WebsitePage {
  id: number;
  title: string;
  slug: string;
  status: string;
}

interface NavItemPayload {
  menuId: number;
  label: string;
  url: string | null;
  pageId: number | null;
  target: string;
  iconClass: string | null;
  sortOrder: number;
  isVisible: boolean;
  parentId: number | null;
}

interface ItemFormData {
  label: string;
  linkType: "url" | "page";
  url: string;
  pageId: string;
  target: string;
  iconClass: string;
  sortOrder: string;
  isVisible: boolean;
  parentId: string;
}

const DEFAULT_MENUS = [
  { name: "Header Main Menu", slug: "header-main", location: "header" },
  { name: "Footer Links", slug: "footer-links", location: "footer" },
];

export default function WebsiteNavigation() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [activeMenuId, setActiveMenuId] = useState<string>("");
  const [itemDialog, setItemDialog] = useState(false);
  const [editItem, setEditItem] = useState<NavItem | null>(null);
  const [form, setForm] = useState<ItemFormData>({
    label: "", linkType: "url", url: "", pageId: "", target: "_self",
    iconClass: "", sortOrder: "0", isVisible: true, parentId: "",
  });

  const { data: menus = [], isLoading: menusLoading } = useQuery<NavMenu[]>({
    queryKey: ["nav-menus"],
    queryFn: () => customFetch("/api/website/navigation-menus"),
  });

  const { data: pages = [] } = useQuery<WebsitePage[]>({
    queryKey: ["website-pages"],
    queryFn: () => customFetch("/api/website/pages"),
  });

  const seedMut = useMutation({
    mutationFn: async () => {
      const results: NavMenu[] = [];
      for (const m of DEFAULT_MENUS) {
        const r: NavMenu = await customFetch("/api/website/navigation-menus", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m),
        });
        results.push(r);
      }
      return results;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nav-menus"] }),
  });

  useEffect(() => {
    if (!menusLoading && menus.length === 0) seedMut.mutate();
  }, [menusLoading, menus.length]);

  useEffect(() => {
    if (menus.length > 0 && !activeMenuId) setActiveMenuId(String(menus[0].id));
  }, [menus, activeMenuId]);

  const { data: items = [] } = useQuery<NavItem[]>({
    queryKey: ["nav-items", activeMenuId],
    queryFn: () => customFetch(`/api/website/menus/${activeMenuId}/items`),
    enabled: !!activeMenuId,
  });

  const saveMut = useMutation({
    mutationFn: (data: NavItemPayload) => {
      if (editItem) return customFetch(`/api/website/navigation-items/${editItem.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return customFetch("/api/website/navigation-items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nav-items", activeMenuId] }); setItemDialog(false); toast({ title: editItem ? "Item updated" : "Item added" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => customFetch(`/api/website/navigation-items/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["nav-items", activeMenuId] }); toast({ title: "Item deleted" }); },
  });

  const reorderMut = useMutation({
    mutationFn: ({ id, newOrder }: { id: number; newOrder: number }) =>
      customFetch(`/api/website/navigation-items/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sortOrder: newOrder }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nav-items", activeMenuId] }),
  });

  const toggleVisMut = useMutation({
    mutationFn: ({ id, isVisible }: { id: number; isVisible: boolean }) =>
      customFetch(`/api/website/navigation-items/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isVisible }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["nav-items", activeMenuId] }),
  });

  function openNew() {
    setEditItem(null);
    setForm({
      label: "", linkType: "url", url: "", pageId: "", target: "_self",
      iconClass: "", sortOrder: String(items.length), isVisible: true, parentId: "",
    });
    setItemDialog(true);
  }

  function openEdit(item: NavItem) {
    setEditItem(item);
    const isPage = !!item.pageId;
    setForm({
      label: item.label,
      linkType: isPage ? "page" : "url",
      url: item.url ?? "",
      pageId: item.pageId ? String(item.pageId) : "",
      target: item.target,
      iconClass: item.iconClass ?? "",
      sortOrder: String(item.sortOrder),
      isVisible: item.isVisible,
      parentId: item.parentId ? String(item.parentId) : "",
    });
    setItemDialog(true);
  }

  function handleSave() {
    if (!form.label.trim()) {
      toast({ title: "Label is required", variant: "destructive" });
      return;
    }

    const urlVal = form.linkType === "url" ? form.url.trim() : null;
    if (urlVal && /^javascript:/i.test(urlVal)) {
      toast({ title: "Invalid URL scheme", variant: "destructive" });
      return;
    }

    const pageIdVal = form.linkType === "page" && form.pageId ? parseInt(form.pageId) : null;

    const payload: NavItemPayload = {
      menuId: parseInt(activeMenuId),
      label: form.label.trim(),
      url: urlVal || null,
      pageId: pageIdVal,
      target: form.target,
      iconClass: form.iconClass.trim() || null,
      sortOrder: parseInt(form.sortOrder) || 0,
      isVisible: form.isVisible,
      parentId: form.parentId ? parseInt(form.parentId) : null,
    };

    saveMut.mutate(payload);
  }

  function moveItem(item: NavItem, direction: "up" | "down") {
    const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = sorted.findIndex(i => i.id === item.id);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    reorderMut.mutate({ id: item.id, newOrder: other.sortOrder });
    reorderMut.mutate({ id: other.id, newOrder: item.sortOrder });
  }

  function getPageTitle(pageId: number | null): string | null {
    if (!pageId) return null;
    const page = pages.find(p => p.id === pageId);
    return page ? page.title : null;
  }

  const topItems = items.filter(i => !i.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
  const childItems = (parentId: number) => items.filter(i => i.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);

  function renderItem(item: NavItem, depth: number = 0) {
    const children = childItems(item.id);
    const pageTitle = getPageTitle(item.pageId);
    return (
      <>
      <div key={item.id}>
        <div className={`flex items-center gap-3 py-2.5 px-4 border-b border-border/30 hover:bg-secondary/30 transition-colors ${depth > 0 ? "pl-12 bg-muted/20" : ""}`}>
          <GripVertical className="w-4 h-4 text-muted-foreground/40 shrink-0" />
          {depth > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{item.label}</span>
              {item.target === "_blank" && <ExternalLink className="w-3 h-3 text-muted-foreground" />}
              {!item.isVisible && <Badge variant="outline" className="text-xs gap-1"><EyeOff className="w-2.5 h-2.5" />Hidden</Badge>}
            </div>
            {pageTitle && <p className="text-xs text-blue-500">Page: {pageTitle}</p>}
            {item.url && <p className="text-xs text-muted-foreground truncate">{item.url}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => moveItem(item, "up")} disabled={reorderMut.isPending}><ArrowUp className="w-3 h-3" /></Button>
            <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => moveItem(item, "down")} disabled={reorderMut.isPending}><ArrowDown className="w-3 h-3" /></Button>
            <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => toggleVisMut.mutate({ id: item.id, isVisible: !item.isVisible })}>
              {item.isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />}
            </Button>
            <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => openEdit(item)}><Edit className="w-3.5 h-3.5" /></Button>
            <Button size="icon" variant="ghost" className="w-7 h-7 text-destructive" onClick={() => { if (confirm("Delete this item?")) deleteMut.mutate(item.id); }}><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
        {children.map(c => renderItem(c, depth + 1))}
      </div>
      </>
    );
  }

  return (
    <>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Menu className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Navigation</h1>
            <p className="text-sm text-muted-foreground">Manage website navigation menus and their items.</p>
          </div>
        </div>

        <Card className="p-4 border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-800">
          <div className="flex items-start gap-3">
            <Link2 className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Quick Links</p>
              <p className="text-xs text-blue-600 dark:text-blue-400">Social media links, phone numbers, and other Quick Links can be managed in Website &gt; Settings &gt; Quick Links section.</p>
            </div>
          </div>
        </Card>

        {menus.length > 0 && (
          <Tabs value={activeMenuId} onValueChange={setActiveMenuId}>
            <div className="flex items-center justify-between">
              <TabsList className="rounded-xl bg-secondary/50 p-1">
                {menus.map(m => (
                  <TabsTrigger key={m.id} value={String(m.id)} className="rounded-lg gap-2">
                    <Menu className="w-4 h-4" />
                    {m.name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {menus.map(m => (
              <TabsContent key={m.id} value={String(m.id)} className="mt-6 space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-muted-foreground text-sm">
                      {m.location === "header" ? "Main navigation links in the website header." : "Links displayed in the website footer."}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Location: <Badge variant="outline" className="text-[10px]">{m.location}</Badge></p>
                  </div>
                  <Button onClick={openNew} className="rounded-xl gap-2"><Plus className="w-4 h-4" /> Add Item</Button>
                </div>

                <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
                  {topItems.length === 0 ? (
                    <div className="py-12 text-center text-muted-foreground">
                      <Menu className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">No items in this menu yet</p>
                    </div>
                  ) : topItems.map(item => renderItem(item))}
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        )}
      </div>

      <Dialog open={itemDialog} onOpenChange={setItemDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editItem ? "Edit Menu Item" : "Add Menu Item"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Label *</Label>
              <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} className="rounded-xl" placeholder="e.g. About Us" />
            </div>

            <div className="space-y-1.5">
              <Label>Link Type</Label>
              <Select value={form.linkType} onValueChange={(v: "url" | "page") => setForm(f => ({ ...f, linkType: v }))}>
                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="url">Custom URL</SelectItem>
                  <SelectItem value="page">Internal Page</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.linkType === "url" ? (
              <div className="space-y-1.5">
                <Label>URL</Label>
                <Input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} className="rounded-xl" placeholder="/about or https://..." />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Page</Label>
                <Select value={form.pageId || "__none__"} onValueChange={v => setForm(f => ({ ...f, pageId: v === "__none__" ? "" : v }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select page" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Select a page</SelectItem>
                    {pages.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.title} (/{p.slug})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Open In</Label>
                <Select value={form.target} onValueChange={v => setForm(f => ({ ...f, target: v }))}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_self">Same Tab</SelectItem>
                    <SelectItem value="_blank">New Tab</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Sort Order</Label>
                <Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="rounded-xl" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Icon Class (optional)</Label>
              <Input value={form.iconClass} onChange={e => setForm(f => ({ ...f, iconClass: e.target.value }))} className="rounded-xl" placeholder="e.g. lucide-globe" />
            </div>
            <div className="space-y-1.5">
              <Label>Parent Item (for dropdown)</Label>
              <Select value={form.parentId || "__none__"} onValueChange={v => setForm(f => ({ ...f, parentId: v === "__none__" ? "" : v }))}>
                <SelectTrigger className="rounded-xl"><SelectValue placeholder="None (top-level)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (top-level)</SelectItem>
                  {items.filter(i => !i.parentId && i.id !== editItem?.id).map(i => (
                    <SelectItem key={i.id} value={String(i.id)}>{i.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={form.isVisible} onCheckedChange={v => setForm(f => ({ ...f, isVisible: v }))} />
              <Label>Visible</Label>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setItemDialog(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={handleSave} disabled={saveMut.isPending} className="rounded-xl">
                {saveMut.isPending ? "Saving..." : editItem ? "Update" : "Add Item"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
