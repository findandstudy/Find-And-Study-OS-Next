import { useCallback, useEffect, useMemo, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { GitBranch, Loader2, Plus, Save, Smartphone } from "lucide-react";

type ChannelAccount = {
  id: number;
  displayName: string;
  provider: string;
  status: string;
  isActive: boolean;
  isDefault: boolean;
  lastSeenAt?: string | null;
};

type PipelineAccount = {
  pipelineId: number;
  channelAccountId: number;
  canSend: boolean;
  canReceive: boolean;
  priority: number | null;
  displayName: string;
  channel: string;
  isActive: boolean;
};

type Pipeline = {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  aiBotId: number;
  isDefault: boolean;
  isActive: boolean;
  accounts: PipelineAccount[];
};

type SlotDraft = {
  channelAccountId: string;
  canSend: boolean;
  canReceive: boolean;
  priority: 1 | 2;
};

const EMPTY_SLOTS: SlotDraft[] = [
  { channelAccountId: "none", canSend: true, canReceive: true, priority: 1 },
  { channelAccountId: "none", canSend: true, canReceive: false, priority: 2 },
];

function toSlug(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function slotsFromPipeline(pipeline: Pipeline): SlotDraft[] {
  const slots = EMPTY_SLOTS.map((slot) => ({ ...slot }));
  const sorted = [...pipeline.accounts].sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
  );
  for (const account of sorted) {
    const preferredIndex = account.priority === 2 ? 1 : account.priority === 1 ? 0 : -1;
    const index = preferredIndex >= 0 && slots[preferredIndex].channelAccountId === "none"
      ? preferredIndex
      : slots.findIndex((slot) => slot.channelAccountId === "none");
    if (index < 0) continue;
    slots[index] = {
      channelAccountId: String(account.channelAccountId),
      canSend: account.canSend,
      canReceive: account.canReceive,
      priority: index === 0 ? 1 : 2,
    };
  }
  return slots;
}

export default function CommunicationPipelineManager({ aiBotId }: { aiBotId: number }) {
  const { toast } = useToast();
  const { t } = useI18n();
  const tx = (key: string) => t(`communicationRouting.${key}`);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [drafts, setDrafts] = useState<Record<number, SlotDraft[]>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ accounts: accountRows }, { pipelines: pipelineRows }] = await Promise.all([
        customFetch<{ accounts: ChannelAccount[] }>("/api/ai-bots/channel-accounts"),
        customFetch<{ pipelines: Pipeline[] }>("/api/communication-pipelines"),
      ]);
      setAccounts(accountRows);
      setPipelines(pipelineRows);
      setDrafts(Object.fromEntries(pipelineRows.map((pipeline) => [pipeline.id, slotsFromPipeline(pipeline)])));
    } catch (error) {
      toast({
        title: tx("loadFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const botPipelines = useMemo(
    () => pipelines.filter((pipeline) => pipeline.aiBotId === aiBotId),
    [aiBotId, pipelines],
  );

  const updateSlot = (pipelineId: number, index: number, patch: Partial<SlotDraft>) => {
    setDrafts((current) => ({
      ...current,
      [pipelineId]: (current[pipelineId] ?? EMPTY_SLOTS).map((slot, slotIndex) =>
        slotIndex === index ? { ...slot, ...patch } : slot,
      ),
    }));
  };

  const createPipeline = async () => {
    if (newName.trim().length < 2 || newSlug.trim().length < 2) return;
    setCreating(true);
    try {
      await customFetch("/api/communication-pipelines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), slug: newSlug.trim(), aiBotId }),
      });
      setNewName("");
      setNewSlug("");
      await load();
      toast({ title: tx("created") });
    } catch (error) {
      toast({
        title: tx("createFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const saveAssignments = async (pipeline: Pipeline) => {
    const slots = drafts[pipeline.id] ?? EMPTY_SLOTS;
    const selected = slots.filter((slot) => slot.channelAccountId !== "none");
    if (new Set(selected.map((slot) => slot.channelAccountId)).size !== selected.length) {
      toast({ title: tx("duplicateLine"), variant: "destructive" });
      return;
    }
    if (selected.some((slot) => !slot.canSend && !slot.canReceive)) {
      toast({ title: tx("lineNeedsPurpose"), variant: "destructive" });
      return;
    }
    if (selected.some((slot) => slot.priority === 2 && slot.canSend)
      && !selected.some((slot) => slot.priority === 1 && slot.canSend)) {
      toast({ title: tx("primaryRequired"), variant: "destructive" });
      return;
    }
    setSavingId(pipeline.id);
    try {
      await customFetch(`/api/communication-pipelines/${pipeline.id}/accounts`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accounts: selected.map((slot) => ({
            channelAccountId: Number(slot.channelAccountId),
            canSend: slot.canSend,
            canReceive: slot.canReceive,
            priority: slot.canSend ? slot.priority : null,
          })),
        }),
      });
      await load();
      toast({ title: t("communicationRouting.saved", { name: pipeline.name }) });
    } catch (error) {
      toast({
        title: tx("saveFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSavingId(null);
    }
  };

  const patchPipeline = async (pipeline: Pipeline, patch: Partial<Pick<Pipeline, "isActive" | "isDefault">>) => {
    setSavingId(pipeline.id);
    try {
      await customFetch(`/api/communication-pipelines/${pipeline.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await load();
    } catch (error) {
      toast({
        title: tx("updateFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex min-h-28 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <GitBranch className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">{tx("title")}</CardTitle>
            <CardDescription>
              {tx("description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1.5">
            <Label>{tx("newRouting")}</Label>
            <Input
              value={newName}
              onChange={(event) => {
                const value = event.target.value;
                setNewName(value);
                setNewSlug(toSlug(value));
              }}
              placeholder={tx("namePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tx("technicalKey")}</Label>
            <Input value={newSlug} onChange={(event) => setNewSlug(toSlug(event.target.value))} placeholder="dorm-booking" />
          </div>
          <Button className="self-end" onClick={createPipeline} disabled={creating || newName.trim().length < 2 || newSlug.length < 2}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            {tx("create")}
          </Button>
        </div>

        {botPipelines.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {tx("empty")}
          </div>
        ) : botPipelines.map((pipeline) => {
          const slots = drafts[pipeline.id] ?? EMPTY_SLOTS;
          return (
            <div key={pipeline.id} className="rounded-xl border p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{pipeline.name}</p>
                    {pipeline.isDefault && <Badge>{tx("default")}</Badge>}
                    <Badge variant={pipeline.isActive ? "outline" : "secondary"}>
                      {pipeline.isActive ? tx("active") : tx("inactive")}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{pipeline.slug}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!pipeline.isDefault && (
                    <Button size="sm" variant="outline" onClick={() => patchPipeline(pipeline, { isDefault: true })} disabled={savingId === pipeline.id}>
                      {tx("makeDefault")}
                    </Button>
                  )}
                  <Label htmlFor={`pipeline-active-${pipeline.id}`} className="text-xs">{tx("active")}</Label>
                  <Switch
                    id={`pipeline-active-${pipeline.id}`}
                    checked={pipeline.isActive}
                    onCheckedChange={(isActive) => patchPipeline(pipeline, { isActive })}
                    disabled={savingId === pipeline.id}
                  />
                </div>
              </div>
              <Separator />
              <div className="grid gap-4 lg:grid-cols-2">
                {slots.map((slot, index) => (
                  <div key={slot.priority} className="space-y-3 rounded-lg bg-muted/30 p-3">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-primary" />
                      <p className="text-sm font-medium">{index === 0 ? tx("primaryLine") : tx("secondaryLine")}</p>
                    </div>
                    <Select
                      value={slot.channelAccountId}
                      onValueChange={(channelAccountId) => updateSlot(pipeline.id, index, { channelAccountId })}
                    >
                      <SelectTrigger><SelectValue placeholder={tx("selectLine")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{tx("noLine")}</SelectItem>
                        {accounts.filter((account) => account.isActive).map((account) => (
                          <SelectItem key={account.id} value={String(account.id)}>
                            {account.displayName} · {account.provider}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex flex-wrap items-center gap-5">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={slot.canSend}
                          onCheckedChange={(canSend) => updateSlot(pipeline.id, index, { canSend })}
                          disabled={slot.channelAccountId === "none"}
                        />
                        <Label className="text-xs">{tx("sender")}</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={slot.canReceive}
                          onCheckedChange={(canReceive) => updateSlot(pipeline.id, index, { canReceive })}
                          disabled={slot.channelAccountId === "none"}
                        />
                        <Label className="text-xs">{tx("receiver")}</Label>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => saveAssignments(pipeline)} disabled={savingId === pipeline.id}>
                  {savingId === pipeline.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {tx("saveLines")}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
