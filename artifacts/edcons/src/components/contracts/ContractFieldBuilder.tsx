import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export type ContractIntakeField = {
  key: string;
  label: string;
  type: "text" | "email" | "date" | "textarea" | "select" | "tel" | "country" | "city";
  required?: boolean;
  maps_to?: string;
  dependsOn?: string;
  options?: string[];
};

const FIELD_TYPES: ContractIntakeField["type"][] = ["text", "email", "tel", "date", "textarea", "select", "country", "city"];

function makeKey(label: string) {
  const words = label.trim().replace(/[^a-zA-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  return words.map((word, index) => index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase()}${word.slice(1).toLowerCase()}`).join("");
}

type Props = {
  value: ContractIntakeField[];
  onChange: (value: ContractIntakeField[]) => void;
  disabled?: boolean;
};

export function ContractFieldBuilder({ value, onChange, disabled = false }: Props) {
  const { toast } = useToast();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState(() => JSON.stringify(value, null, 2));

  useEffect(() => setJsonDraft(JSON.stringify(value, null, 2)), [value]);

  function update(index: number, patch: Partial<ContractIntakeField>) {
    onChange(value.map((field, current) => current === index ? { ...field, ...patch } : field));
  }

  function add() {
    const suffix = value.length + 1;
    onChange([...value, { key: `field${suffix}`, label: `New field ${suffix}`, type: "text", required: false }]);
  }

  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function applyJson() {
    try {
      const parsed = JSON.parse(jsonDraft);
      if (!Array.isArray(parsed)) throw new Error("Schema must be an array");
      onChange(parsed);
      toast({ title: "Advanced JSON applied" });
    } catch (error: any) {
      toast({ title: "Invalid JSON", description: error.message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {value.map((field, index) => (
          <div key={`${field.key}-${index}`} className="rounded-lg border bg-card p-3">
            <div className="grid grid-cols-[auto_minmax(0,1.4fr)_minmax(120px,.7fr)_auto] gap-2 items-end">
              <GripVertical className="h-4 w-4 text-muted-foreground self-center" />
              <div>
                <Label className="text-xs">Field label</Label>
                <Input value={field.label} disabled={disabled} onChange={event => {
                  const label = event.target.value;
                  const oldGeneratedKey = makeKey(field.label);
                  update(index, { label, ...(field.key === oldGeneratedKey || field.key.startsWith("field") ? { key: makeKey(label) || field.key } : {}) });
                }} />
              </div>
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={field.type} disabled={disabled} onValueChange={type => update(index, { type: type as ContractIntakeField["type"] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{FIELD_TYPES.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex gap-1">
                <Button type="button" size="icon" variant="ghost" disabled={disabled || index === 0} onClick={() => move(index, -1)}><ChevronUp className="h-4 w-4" /></Button>
                <Button type="button" size="icon" variant="ghost" disabled={disabled || index === value.length - 1} onClick={() => move(index, 1)}><ChevronDown className="h-4 w-4" /></Button>
                <Button type="button" size="icon" variant="ghost" disabled={disabled} onClick={() => onChange(value.filter((_, current) => current !== index))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">Field key</Label>
                <Input value={field.key} disabled={disabled} className="font-mono text-xs" onChange={event => update(index, { key: event.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} />
              </div>
              <div>
                <Label className="text-xs">Contract placeholder (optional)</Label>
                <Input value={field.maps_to || ""} disabled={disabled} className="font-mono text-xs" placeholder={field.key} onChange={event => update(index, { maps_to: event.target.value || undefined })} />
              </div>
              <div>
                <Label className="text-xs">Depends on (optional)</Label>
                <Select value={field.dependsOn || "none"} disabled={disabled} onValueChange={dependsOn => update(index, { dependsOn: dependsOn === "none" ? undefined : dependsOn })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No dependency</SelectItem>
                    {value.filter((_, current) => current !== index).map(candidate => <SelectItem key={candidate.key} value={candidate.key}>{candidate.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {field.type === "select" && (
              <div className="mt-2">
                <Label className="text-xs">Options (one per line)</Label>
                <Textarea rows={3} disabled={disabled} value={(field.options || []).join("\n")} onChange={event => update(index, { options: event.target.value.split("\n").map(item => item.trim()).filter(Boolean) })} />
              </div>
            )}
            <label className="mt-3 inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(field.required)} disabled={disabled} onChange={event => update(index, { required: event.target.checked })} />
              Required field
            </label>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" onClick={add} disabled={disabled}><Plus className="h-4 w-4 mr-2" /> Add field</Button>
      <div className="rounded-lg border overflow-hidden">
        <button type="button" className="w-full flex items-center justify-between px-3 py-2 text-sm bg-muted/30" onClick={() => setAdvancedOpen(open => !open)}>
          <span className="inline-flex items-center gap-2"><Copy className="h-4 w-4" /> Advanced JSON</span>
          {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {advancedOpen && (
          <div className="p-3 space-y-2">
            <Textarea rows={10} value={jsonDraft} disabled={disabled} onChange={event => setJsonDraft(event.target.value)} className="font-mono text-xs" />
            <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={applyJson}>Validate and apply JSON</Button>
          </div>
        )}
      </div>
    </div>
  );
}
