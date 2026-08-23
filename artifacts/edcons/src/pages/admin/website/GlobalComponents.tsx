import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Component, Plus, Pencil, Copy, Trash2, Search,
  Megaphone, BarChart3, MessageSquareQuote, Phone, Grid3X3, Code2, X
} from "lucide-react";

interface GlobalComponent {
  id: number;
  name: string;
  slug: string;
  componentType: string;
  content: Record<string, unknown>;
  settings: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const COMPONENT_TYPES = [
  { value: "cta_banner", label: "CTA Banner", icon: Megaphone, description: "Call-to-action with heading, body, and button" },
  { value: "stats_strip", label: "Stats Strip", icon: BarChart3, description: "Row of statistics with numbers and labels" },
  { value: "testimonials", label: "Testimonials", icon: MessageSquareQuote, description: "Customer quotes with attribution" },
  { value: "contact_strip", label: "Contact Strip", icon: Phone, description: "Contact information with phone, email, address" },
  { value: "logo_grid", label: "Logo Grid", icon: Grid3X3, description: "Grid of partner/client logos" },
  { value: "custom_html", label: "Custom HTML", icon: Code2, description: "Raw HTML/embed content" },
] as const;

function getTypeInfo(type: string) {
  return COMPONENT_TYPES.find(t => t.value === type) || { value: type, label: type, icon: Component, description: "" };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function getDefaultContent(type: string): Record<string, unknown> {
  switch (type) {
    case "cta_banner":
      return { heading: "", body: "", buttonText: "Learn More", buttonUrl: "#", backgroundImage: "", backgroundColor: "#2563eb" };
    case "stats_strip":
      return { items: [{ value: "100+", label: "Students" }, { value: "50+", label: "Universities" }, { value: "10+", label: "Countries" }] };
    case "testimonials":
      return { items: [{ quote: "", author: "", role: "", avatar: "" }] };
    case "contact_strip":
      return { phone: "", email: "", address: "", whatsapp: "", showForm: false };
    case "logo_grid":
      return { items: [{ name: "", imageUrl: "", linkUrl: "" }], columns: 4 };
    case "custom_html":
      return { html: "" };
    default:
      return {};
  }
}

export default function WebsiteGlobalComponents() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editItem, setEditItem] = useState<GlobalComponent | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    componentType: "cta_banner",
    content: {} as Record<string, unknown>,
    isActive: true,
  });
  const [slugManual, setSlugManual] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<GlobalComponent | null>(null);

  const { data: components = [], isLoading } = useQuery<GlobalComponent[]>({
    queryKey: ["website-global-components"],
    queryFn: () => customFetch("/api/website/global-components"),
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return components;
    const q = search.toLowerCase();
    return components.filter(c =>
      c.name.toLowerCase().includes(q) || c.slug.includes(q) || c.componentType.includes(q)
    );
  }, [components, search]);

  const saveMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (editItem) {
        return customFetch(`/api/website/global-components/${editItem.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      return customFetch("/api/website/global-components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-global-components"] });
      setEditOpen(false);
      toast({ title: editItem ? "Component updated" : "Component created" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save component.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      customFetch(`/api/website/global-components/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-global-components"] });
      setDeleteConfirm(null);
      toast({ title: "Component deleted" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (comp: GlobalComponent) =>
      customFetch(`/api/website/global-components/${comp.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !comp.isActive }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["website-global-components"] });
    },
  });

  function openNew() {
    setEditItem(null);
    setSlugManual(false);
    const defType = "cta_banner";
    setForm({
      name: "",
      slug: "",
      componentType: defType,
      content: getDefaultContent(defType),
      isActive: true,
    });
    setEditOpen(true);
  }

  function openEdit(comp: GlobalComponent) {
    setEditItem(comp);
    setSlugManual(true);
    setForm({
      name: comp.name,
      slug: comp.slug,
      componentType: comp.componentType,
      content: (comp.content || {}) as Record<string, unknown>,
      isActive: comp.isActive,
    });
    setEditOpen(true);
  }

  function openDuplicate(comp: GlobalComponent) {
    setEditItem(null);
    setSlugManual(false);
    setForm({
      name: `${comp.name} (Copy)`,
      slug: slugify(`${comp.name} copy`),
      componentType: comp.componentType,
      content: JSON.parse(JSON.stringify(comp.content || {})),
      isActive: true,
    });
    setEditOpen(true);
  }

  function handleSave() {
    if (!form.name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    const slug = form.slug || slugify(form.name);
    saveMutation.mutate({
      name: form.name,
      slug,
      componentType: form.componentType,
      content: form.content,
      settings: {},
      isActive: form.isActive,
    });
  }

  function updateContent(key: string, value: unknown) {
    setForm(f => ({ ...f, content: { ...f.content, [key]: value } }));
  }

  function updateArrayItem(arrayKey: string, index: number, field: string, value: string) {
    setForm(f => {
      const arr = [...((f.content[arrayKey] as Record<string, string>[]) || [])];
      arr[index] = { ...arr[index], [field]: value };
      return { ...f, content: { ...f.content, [arrayKey]: arr } };
    });
  }

  function addArrayItem(arrayKey: string, template: Record<string, string>) {
    setForm(f => {
      const arr = [...((f.content[arrayKey] as Record<string, string>[]) || []), template];
      return { ...f, content: { ...f.content, [arrayKey]: arr } };
    });
  }

  function removeArrayItem(arrayKey: string, index: number) {
    setForm(f => {
      const arr = [...((f.content[arrayKey] as Record<string, string>[]) || [])];
      arr.splice(index, 1);
      return { ...f, content: { ...f.content, [arrayKey]: arr } };
    });
  }

  function renderContentEditor() {
    const c = form.content;
    switch (form.componentType) {
      case "cta_banner":
        return (
          <>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Heading</Label>
              <Input value={(c.heading as string) || ""} onChange={e => updateContent("heading", e.target.value)} placeholder="Ready to start your journey?" />
            </div>
            <div>
              <Label className="text-xs">Body Text</Label>
              <Textarea value={(c.body as string) || ""} onChange={e => updateContent("body", e.target.value)} placeholder="Join thousands of students..." rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Button Text</Label>
                <Input value={(c.buttonText as string) || ""} onChange={e => updateContent("buttonText", e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Button URL</Label>
                <Input value={(c.buttonUrl as string) || ""} onChange={e => updateContent("buttonUrl", e.target.value)} placeholder="/contact" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Background Color</Label>
                <div className="flex items-center gap-2 mt-1">
                  <div className="w-8 h-8 rounded border relative overflow-hidden shrink-0" style={{ backgroundColor: (c.backgroundColor as string) || "#2563eb" }}>
                    <input type="color" value={(c.backgroundColor as string) || "#2563eb"} onChange={e => updateContent("backgroundColor", e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </div>
                  <Input value={(c.backgroundColor as string) || ""} onChange={e => updateContent("backgroundColor", e.target.value)} className="h-8 text-xs font-mono" />
                </div>
              </div>
              <div>
                <Label className="text-xs">Background Image URL</Label>
                <Input value={(c.backgroundImage as string) || ""} onChange={e => updateContent("backgroundImage", e.target.value)} placeholder="https://..." className="mt-1" />
              </div>
            </div>
          </div>
          </>
        );

      case "stats_strip": {
        const items = (c.items as Record<string, string>[]) || [];
        return (
          <>
          <div className="space-y-3">
            {items.map((item, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Value</Label>
                  <Input value={item.value || ""} onChange={e => updateArrayItem("items", i, "value", e.target.value)} placeholder="100+" />
                </div>
                <div className="flex-1">
                  <Label className="text-xs">Label</Label>
                  <Input value={item.label || ""} onChange={e => updateArrayItem("items", i, "label", e.target.value)} placeholder="Students" />
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeArrayItem("items", i)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => addArrayItem("items", { value: "", label: "" })}>
              <Plus className="w-3 h-3 mr-1" /> Add Stat
            </Button>
          </div>
          </>
        );
      }

      case "testimonials": {
        const items = (c.items as Record<string, string>[]) || [];
        return (
          <>
          <div className="space-y-4">
            {items.map((item, i) => (
              <Card key={i} className="p-3">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Testimonial {i + 1}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeArrayItem("items", i)}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
                <div className="space-y-2">
                  <Textarea value={item.quote || ""} onChange={e => updateArrayItem("items", i, "quote", e.target.value)} placeholder="Great experience..." rows={2} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={item.author || ""} onChange={e => updateArrayItem("items", i, "author", e.target.value)} placeholder="Author name" />
                    <Input value={item.role || ""} onChange={e => updateArrayItem("items", i, "role", e.target.value)} placeholder="Role / Company" />
                  </div>
                  <Input value={item.avatar || ""} onChange={e => updateArrayItem("items", i, "avatar", e.target.value)} placeholder="Avatar image URL" />
                </div>
              </Card>
            ))}
            <Button variant="outline" size="sm" onClick={() => addArrayItem("items", { quote: "", author: "", role: "", avatar: "" })}>
              <Plus className="w-3 h-3 mr-1" /> Add Testimonial
            </Button>
          </div>
          </>
        );
      }

      case "contact_strip":
        return (
          <>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Phone</Label>
                <Input value={(c.phone as string) || ""} onChange={e => updateContent("phone", e.target.value)} placeholder="+90 555 123 4567" />
              </div>
              <div>
                <Label className="text-xs">Email</Label>
                <Input value={(c.email as string) || ""} onChange={e => updateContent("email", e.target.value)} placeholder="info@example.com" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Address</Label>
              <Input value={(c.address as string) || ""} onChange={e => updateContent("address", e.target.value)} placeholder="Istanbul, Turkey" />
            </div>
            <div>
              <Label className="text-xs">WhatsApp</Label>
              <Input value={(c.whatsapp as string) || ""} onChange={e => updateContent("whatsapp", e.target.value)} placeholder="+90 555 123 4567" />
            </div>
          </div>
          </>
        );

      case "logo_grid": {
        const items = (c.items as Record<string, string>[]) || [];
        return (
          <>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Columns</Label>
              <Select value={String((c.columns as number) || 4)} onValueChange={v => updateContent("columns", parseInt(v))}>
                <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5, 6].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {items.map((item, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Name</Label>
                  <Input value={item.name || ""} onChange={e => updateArrayItem("items", i, "name", e.target.value)} placeholder="Partner name" />
                </div>
                <div className="flex-1">
                  <Label className="text-xs">Image URL</Label>
                  <Input value={item.imageUrl || ""} onChange={e => updateArrayItem("items", i, "imageUrl", e.target.value)} placeholder="https://..." />
                </div>
                <div className="flex-1">
                  <Label className="text-xs">Link URL</Label>
                  <Input value={item.linkUrl || ""} onChange={e => updateArrayItem("items", i, "linkUrl", e.target.value)} placeholder="https://..." />
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeArrayItem("items", i)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => addArrayItem("items", { name: "", imageUrl: "", linkUrl: "" })}>
              <Plus className="w-3 h-3 mr-1" /> Add Logo
            </Button>
          </div>
          </>
        );
      }

      case "custom_html":
        return (
          <>
          <div>
            <Label className="text-xs">HTML Content</Label>
            <Textarea
              value={(c.html as string) || ""}
              onChange={e => updateContent("html", e.target.value)}
              placeholder="<div>Your HTML here...</div>"
              rows={8}
              className="font-mono text-xs"
            />
          </div>
          </>
        );

      default:
        return <p className="text-sm text-muted-foreground">No editor available for this type.</p>;
    }
  }

  return (
    <>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Component className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Global Components</h1>
              <p className="text-sm text-muted-foreground">
                Reusable blocks that can be embedded in any page via the Page Builder.
              </p>
            </div>
          </div>
          <Button size="sm" onClick={openNew}>
            <Plus className="w-4 h-4 mr-1" /> New Component
          </Button>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search components..."
            className="pl-9 h-9"
          />
        </div>

        {isLoading ? (
          <div className="text-center py-20 text-muted-foreground">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Component className="w-12 h-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-1">
              {search ? "No matching components" : "No global components yet"}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {search ? "Try a different search term." : "Create your first reusable component to embed across pages."}
            </p>
            {!search && (
              <Button size="sm" onClick={openNew}>
                <Plus className="w-4 h-4 mr-1" /> Create Component
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map(comp => {
              const typeInfo = getTypeInfo(comp.componentType);
              const TypeIcon = typeInfo.icon;
              return (
                <Card key={comp.id} className={`transition-opacity ${!comp.isActive ? "opacity-60" : ""}`}>
                  <CardContent className="flex items-center gap-4 py-3 px-4">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <TypeIcon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-sm truncate">{comp.name}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">{typeInfo.label}</Badge>
                        {!comp.isActive && <Badge variant="secondary" className="text-[10px] shrink-0">Inactive</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">/{comp.slug}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        checked={comp.isActive}
                        onCheckedChange={() => toggleMutation.mutate(comp)}
                        className="scale-75"
                      />
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(comp)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDuplicate(comp)}>
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteConfirm(comp)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Component" : "New Global Component"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-medium">Name</Label>
                <Input
                  value={form.name}
                  onChange={e => {
                    const name = e.target.value;
                    setForm(f => ({
                      ...f,
                      name,
                      slug: slugManual ? f.slug : slugify(name),
                    }));
                  }}
                  placeholder="Hero CTA Banner"
                />
              </div>
              <div>
                <Label className="text-xs font-medium">Slug</Label>
                <Input
                  value={form.slug}
                  onChange={e => {
                    setSlugManual(true);
                    setForm(f => ({ ...f, slug: e.target.value }));
                  }}
                  placeholder="hero-cta-banner"
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-medium">Type</Label>
                <Select
                  value={form.componentType}
                  onValueChange={v => {
                    setForm(f => ({
                      ...f,
                      componentType: v,
                      content: editItem ? f.content : getDefaultContent(v),
                    }));
                  }}
                  disabled={!!editItem}
                >
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COMPONENT_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>
                        <span className="flex items-center gap-2">
                          <t.icon className="w-3.5 h-3.5" /> {t.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-0.5">
                <div className="flex items-center gap-2">
                  <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
                  <Label className="text-xs">{form.isActive ? "Active" : "Inactive"}</Label>
                </div>
              </div>
            </div>

            <Separator />

            <div>
              <Label className="text-sm font-medium mb-2 block">Content</Label>
              {renderContentEditor()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : editItem ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Component</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{deleteConfirm?.name}</strong>? Pages referencing this component will show a broken link.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
