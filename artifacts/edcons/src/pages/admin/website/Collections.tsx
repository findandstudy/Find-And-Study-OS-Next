import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Layers, Building2, Users, HelpCircle, MessageSquareQuote, Plus, Edit, Trash2,
} from "lucide-react";

interface CollectionItem {
  id: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Office extends CollectionItem {
  name: string;
  city: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  mapEmbedUrl: string | null;
  imageUrl: string | null;
}

interface TeamMember extends CollectionItem {
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  email: string | null;
  linkedinUrl: string | null;
}

interface Faq extends CollectionItem {
  question: string;
  answer: string;
  category: string | null;
}

interface Testimonial extends CollectionItem {
  name: string;
  role: string | null;
  company: string | null;
  content: string;
  photoUrl: string | null;
  rating: number | null;
}

function CollectionTable<T extends CollectionItem>({ items, columns, onEdit, onDelete }: {
  items: T[];
  columns: { key: string; label: string; render?: (item: T) => React.ReactNode }[];
  onEdit: (item: T) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b bg-muted/30">
            {columns.map(c => <th key={c.key} className="py-3 px-4 text-left font-semibold text-muted-foreground">{c.label}</th>)}
            <th className="py-3 px-4 text-right font-semibold text-muted-foreground">Actions</th>
          </tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="py-12 text-center text-muted-foreground">No items yet</td></tr>
            ) : items.map(item => (
              <tr key={item.id} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                {columns.map(c => (
                  <td key={c.key} className="py-3 px-4">
                    {c.render ? c.render(item) : (item as Record<string, unknown>)[c.key] as string || "-"}
                  </td>
                ))}
                <td className="py-3 px-4 text-right">
                  <div className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => onEdit(item)}><Edit className="w-3.5 h-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="w-7 h-7 text-destructive" onClick={() => { if (confirm("Delete this item?")) onDelete(item.id); }}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function useCollectionCrud<T extends CollectionItem>(endpoint: string, queryKey: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: items = [] } = useQuery<T[]>({ queryKey: [queryKey], queryFn: () => customFetch(endpoint) });

  const saveMut = useMutation({
    mutationFn: ({ id, data }: { id?: number; data: Record<string, unknown> }) => {
      if (id) return customFetch(`${endpoint}/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return customFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [queryKey] }); toast({ title: "Saved" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => customFetch(`${endpoint}/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [queryKey] }); toast({ title: "Deleted" }); },
  });

  return { items, saveMut, deleteMut };
}

interface OfficeForm {
  name: string; city: string; country: string; address: string;
  phone: string; email: string; mapEmbedUrl: string; imageUrl: string;
  sortOrder: string; isActive: boolean;
}

function OfficesTab() {
  const { items, saveMut, deleteMut } = useCollectionCrud<Office>("/api/website/collections/offices", "col-offices");
  const [dialog, setDialog] = useState(false);
  const [editItem, setEditItem] = useState<Office | null>(null);
  const [form, setForm] = useState<OfficeForm>({ name: "", city: "", country: "", address: "", phone: "", email: "", mapEmbedUrl: "", imageUrl: "", sortOrder: "0", isActive: true });

  function openNew() { setEditItem(null); setForm({ name: "", city: "", country: "", address: "", phone: "", email: "", mapEmbedUrl: "", imageUrl: "", sortOrder: "0", isActive: true }); setDialog(true); }
  function openEdit(item: Office) {
    setEditItem(item);
    setForm({ name: item.name, city: item.city ?? "", country: item.country ?? "", address: item.address ?? "", phone: item.phone ?? "", email: item.email ?? "", mapEmbedUrl: item.mapEmbedUrl ?? "", imageUrl: item.imageUrl ?? "", sortOrder: String(item.sortOrder), isActive: item.isActive });
    setDialog(true);
  }

  function save() {
    if (!form.name.trim()) return;
    saveMut.mutate({ id: editItem?.id, data: { ...form, sortOrder: parseInt(form.sortOrder) || 0 } }, { onSuccess: () => setDialog(false) });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-muted-foreground text-sm">Physical office locations displayed on your website.</p>
        <Button onClick={openNew} className="rounded-xl gap-2"><Plus className="w-4 h-4" /> Add Office</Button>
      </div>
      <CollectionTable items={items} onEdit={openEdit} onDelete={id => deleteMut.mutate(id)} columns={[
        { key: "name", label: "Name", render: (i: Office) => <span className="font-medium">{i.name}</span> },
        { key: "city", label: "City" },
        { key: "country", label: "Country" },
        { key: "phone", label: "Phone" },
        { key: "sortOrder", label: "Order" },
        { key: "isActive", label: "Status", render: (i: Office) => <Badge variant={i.isActive ? "default" : "secondary"} className="text-xs">{i.isActive ? "Active" : "Hidden"}</Badge> },
      ]} />
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editItem ? "Edit Office" : "New Office"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>City</Label><Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Country</Label><Input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Sort Order</Label><Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="space-y-1.5"><Label>Address</Label><Textarea value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className="rounded-xl" rows={2} /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Phone</Label><Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="space-y-1.5"><Label>Map Embed URL</Label><Input value={form.mapEmbedUrl} onChange={e => setForm(f => ({ ...f, mapEmbedUrl: e.target.value }))} className="rounded-xl" placeholder="Google Maps embed link" /></div>
            <div className="space-y-1.5"><Label>Image URL</Label><Input value={form.imageUrl} onChange={e => setForm(f => ({ ...f, imageUrl: e.target.value }))} className="rounded-xl" /></div>
            <div className="flex items-center gap-3"><Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} /><Label>Active</Label></div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDialog(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={save} disabled={saveMut.isPending} className="rounded-xl">{editItem ? "Update" : "Create"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TeamForm {
  name: string; title: string; bio: string; photoUrl: string;
  email: string; linkedinUrl: string; sortOrder: string; isActive: boolean;
}

function TeamTab() {
  const { items, saveMut, deleteMut } = useCollectionCrud<TeamMember>("/api/website/collections/team-members", "col-team");
  const [dialog, setDialog] = useState(false);
  const [editItem, setEditItem] = useState<TeamMember | null>(null);
  const [form, setForm] = useState<TeamForm>({ name: "", title: "", bio: "", photoUrl: "", email: "", linkedinUrl: "", sortOrder: "0", isActive: true });

  function openNew() { setEditItem(null); setForm({ name: "", title: "", bio: "", photoUrl: "", email: "", linkedinUrl: "", sortOrder: "0", isActive: true }); setDialog(true); }
  function openEdit(item: TeamMember) {
    setEditItem(item);
    setForm({ name: item.name, title: item.title ?? "", bio: item.bio ?? "", photoUrl: item.photoUrl ?? "", email: item.email ?? "", linkedinUrl: item.linkedinUrl ?? "", sortOrder: String(item.sortOrder), isActive: item.isActive });
    setDialog(true);
  }

  function save() {
    if (!form.name.trim()) return;
    saveMut.mutate({ id: editItem?.id, data: { ...form, sortOrder: parseInt(form.sortOrder) || 0 } }, { onSuccess: () => setDialog(false) });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-muted-foreground text-sm">Team members displayed on your website's About page.</p>
        <Button onClick={openNew} className="rounded-xl gap-2"><Plus className="w-4 h-4" /> Add Member</Button>
      </div>
      <CollectionTable items={items} onEdit={openEdit} onDelete={id => deleteMut.mutate(id)} columns={[
        { key: "name", label: "Name", render: (i: TeamMember) => (
          <div className="flex items-center gap-3">
            {i.photoUrl ? <img src={i.photoUrl} className="w-8 h-8 rounded-full object-cover" alt={i.name} /> : <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">{i.name[0]}</div>}
            <div><p className="font-medium">{i.name}</p>{i.title && <p className="text-xs text-muted-foreground">{i.title}</p>}</div>
          </div>
        )},
        { key: "email", label: "Email" },
        { key: "sortOrder", label: "Order" },
        { key: "isActive", label: "Status", render: (i: TeamMember) => <Badge variant={i.isActive ? "default" : "secondary"} className="text-xs">{i.isActive ? "Active" : "Hidden"}</Badge> },
      ]} />
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editItem ? "Edit Team Member" : "New Team Member"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Title / Role</Label><Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="rounded-xl" placeholder="e.g. Marketing Director" /></div>
            </div>
            <div className="space-y-1.5"><Label>Bio</Label><Textarea value={form.bio} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} className="rounded-xl" rows={3} /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Photo URL</Label><Input value={form.photoUrl} onChange={e => setForm(f => ({ ...f, photoUrl: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>LinkedIn URL</Label><Input value={form.linkedinUrl} onChange={e => setForm(f => ({ ...f, linkedinUrl: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Sort Order</Label><Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="flex items-center gap-3"><Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} /><Label>Active</Label></div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDialog(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={save} disabled={saveMut.isPending} className="rounded-xl">{editItem ? "Update" : "Create"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface FaqForm {
  question: string; answer: string; category: string;
  sortOrder: string; isActive: boolean;
}

function FaqsTab() {
  const { items, saveMut, deleteMut } = useCollectionCrud<Faq>("/api/website/collections/faqs", "col-faqs");
  const [dialog, setDialog] = useState(false);
  const [editItem, setEditItem] = useState<Faq | null>(null);
  const [form, setForm] = useState<FaqForm>({ question: "", answer: "", category: "", sortOrder: "0", isActive: true });

  function openNew() { setEditItem(null); setForm({ question: "", answer: "", category: "", sortOrder: "0", isActive: true }); setDialog(true); }
  function openEdit(item: Faq) {
    setEditItem(item);
    setForm({ question: item.question, answer: item.answer, category: item.category ?? "", sortOrder: String(item.sortOrder), isActive: item.isActive });
    setDialog(true);
  }

  function save() {
    if (!form.question.trim() || !form.answer.trim()) return;
    saveMut.mutate({ id: editItem?.id, data: { question: form.question, answer: form.answer, sortOrder: parseInt(form.sortOrder) || 0, isActive: form.isActive, category: form.category || null } }, { onSuccess: () => setDialog(false) });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-muted-foreground text-sm">Frequently asked questions for your website.</p>
        <Button onClick={openNew} className="rounded-xl gap-2"><Plus className="w-4 h-4" /> Add FAQ</Button>
      </div>
      <CollectionTable items={items} onEdit={openEdit} onDelete={id => deleteMut.mutate(id)} columns={[
        { key: "question", label: "Question", render: (i: Faq) => <span className="font-medium line-clamp-1">{i.question}</span> },
        { key: "category", label: "Category", render: (i: Faq) => i.category ? <Badge variant="outline" className="text-xs">{i.category}</Badge> : <span className="text-muted-foreground">-</span> },
        { key: "sortOrder", label: "Order" },
        { key: "isActive", label: "Status", render: (i: Faq) => <Badge variant={i.isActive ? "default" : "secondary"} className="text-xs">{i.isActive ? "Active" : "Hidden"}</Badge> },
      ]} />
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editItem ? "Edit FAQ" : "New FAQ"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label>Question *</Label><Input value={form.question} onChange={e => setForm(f => ({ ...f, question: e.target.value }))} className="rounded-xl" /></div>
            <div className="space-y-1.5"><Label>Answer *</Label><Textarea value={form.answer} onChange={e => setForm(f => ({ ...f, answer: e.target.value }))} className="rounded-xl" rows={4} /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Category</Label><Input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} className="rounded-xl" placeholder="e.g. Admissions" /></div>
              <div className="space-y-1.5"><Label>Sort Order</Label><Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="flex items-center gap-3"><Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} /><Label>Active</Label></div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDialog(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={save} disabled={saveMut.isPending} className="rounded-xl">{editItem ? "Update" : "Create"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface TestimonialForm {
  name: string; role: string; company: string; content: string;
  photoUrl: string; rating: string; sortOrder: string; isActive: boolean;
}

function TestimonialsTab() {
  const { items, saveMut, deleteMut } = useCollectionCrud<Testimonial>("/api/website/collections/testimonials", "col-testimonials");
  const [dialog, setDialog] = useState(false);
  const [editItem, setEditItem] = useState<Testimonial | null>(null);
  const [form, setForm] = useState<TestimonialForm>({ name: "", role: "", company: "", content: "", photoUrl: "", rating: "5", sortOrder: "0", isActive: true });

  function openNew() { setEditItem(null); setForm({ name: "", role: "", company: "", content: "", photoUrl: "", rating: "5", sortOrder: "0", isActive: true }); setDialog(true); }
  function openEdit(item: Testimonial) {
    setEditItem(item);
    setForm({ name: item.name, role: item.role ?? "", company: item.company ?? "", content: item.content, photoUrl: item.photoUrl ?? "", rating: String(item.rating ?? 5), sortOrder: String(item.sortOrder), isActive: item.isActive });
    setDialog(true);
  }

  function save() {
    if (!form.name.trim() || !form.content.trim()) return;
    const ratingVal = Math.min(5, Math.max(1, parseInt(form.rating) || 5));
    saveMut.mutate({
      id: editItem?.id,
      data: { name: form.name, role: form.role || null, company: form.company || null, content: form.content, photoUrl: form.photoUrl || null, rating: ratingVal, sortOrder: parseInt(form.sortOrder) || 0, isActive: form.isActive },
    }, { onSuccess: () => setDialog(false) });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-muted-foreground text-sm">Student testimonials and reviews for your website.</p>
        <Button onClick={openNew} className="rounded-xl gap-2"><Plus className="w-4 h-4" /> Add Testimonial</Button>
      </div>
      <CollectionTable items={items} onEdit={openEdit} onDelete={id => deleteMut.mutate(id)} columns={[
        { key: "name", label: "Name", render: (i: Testimonial) => (
          <div className="flex items-center gap-3">
            {i.photoUrl ? <img src={i.photoUrl} className="w-8 h-8 rounded-full object-cover" alt={i.name} /> : <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center text-xs font-bold text-amber-600">{i.name[0]}</div>}
            <div><p className="font-medium">{i.name}</p>{i.role && <p className="text-xs text-muted-foreground">{i.role}{i.company ? ` at ${i.company}` : ""}</p>}</div>
          </div>
        )},
        { key: "content", label: "Quote", render: (i: Testimonial) => <span className="line-clamp-1 text-muted-foreground text-xs max-w-[200px]">&ldquo;{i.content}&rdquo;</span> },
        { key: "rating", label: "Rating", render: (i: Testimonial) => <span className="text-amber-500">{Array.from({ length: i.rating ?? 0 }).map((_, j) => "\u2605").join("")}</span> },
        { key: "sortOrder", label: "Order" },
        { key: "isActive", label: "Status", render: (i: Testimonial) => <Badge variant={i.isActive ? "default" : "secondary"} className="text-xs">{i.isActive ? "Active" : "Hidden"}</Badge> },
      ]} />
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editItem ? "Edit Testimonial" : "New Testimonial"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Role / Title</Label><Input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="rounded-xl" placeholder="e.g. Student" /></div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Company / University</Label><Input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Rating (1-5)</Label><Input type="number" min={1} max={5} value={form.rating} onChange={e => setForm(f => ({ ...f, rating: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="space-y-1.5"><Label>Quote / Content *</Label><Textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} className="rounded-xl" rows={4} /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5"><Label>Photo URL</Label><Input value={form.photoUrl} onChange={e => setForm(f => ({ ...f, photoUrl: e.target.value }))} className="rounded-xl" /></div>
              <div className="space-y-1.5"><Label>Sort Order</Label><Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="rounded-xl" /></div>
            </div>
            <div className="flex items-center gap-3"><Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} /><Label>Active</Label></div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setDialog(false)} className="rounded-xl">Cancel</Button>
              <Button onClick={save} disabled={saveMut.isPending} className="rounded-xl">{editItem ? "Update" : "Create"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function WebsiteCollections() {
  const [tab, setTab] = useState("offices");

  return (
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Layers className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Collections</h1>
            <p className="text-sm text-muted-foreground">Manage structured content displayed on your website.</p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="rounded-xl bg-secondary/50 p-1">
            <TabsTrigger value="offices" className="rounded-lg gap-2"><Building2 className="w-4 h-4" /> Offices</TabsTrigger>
            <TabsTrigger value="team" className="rounded-lg gap-2"><Users className="w-4 h-4" /> Team</TabsTrigger>
            <TabsTrigger value="faqs" className="rounded-lg gap-2"><HelpCircle className="w-4 h-4" /> FAQs</TabsTrigger>
            <TabsTrigger value="testimonials" className="rounded-lg gap-2"><MessageSquareQuote className="w-4 h-4" /> Testimonials</TabsTrigger>
          </TabsList>

          <TabsContent value="offices" className="mt-6"><OfficesTab /></TabsContent>
          <TabsContent value="team" className="mt-6"><TeamTab /></TabsContent>
          <TabsContent value="faqs" className="mt-6"><FaqsTab /></TabsContent>
          <TabsContent value="testimonials" className="mt-6"><TestimonialsTab /></TabsContent>
        </Tabs>
      </div>
  );
}
