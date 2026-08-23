/**
 * ExclusiveRegionsSection.tsx — "Exclusive Bölgeler" (uyruk istisnası) yönetimi
 *
 * Embedded inside PortalUniversitiesTab. Lets admins pick a portal university and
 * manage its nationality exclusions (one rule per university+nationality):
 *   - list rules (enabled switch, delete)
 *   - add rule (nationality autocomplete from student nationalities + free text,
 *     agency, note, enabled)
 *
 * Uses the generated orval hooks (useListUniversityExclusions, etc.) for the
 * exclusion CRUD; the university picker reuses /api/portal-universities (same
 * source as the parent tab).
 */

import { useState, useEffect, useMemo, useId } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  useListUniversityExclusions,
  useListExclusionNationalitySuggestions,
  useCreateUniversityExclusion,
  useUpdateUniversityExclusion,
  useDeleteUniversityExclusion,
  getListUniversityExclusionsQueryKey,
  type UniversityExclusion,
} from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Globe, Plus, Trash2, Loader2 } from "lucide-react";

interface PortalUniversityLite {
  id: number;
  universityKey: string;
  universityName: string;
}

interface UniversityListResponse {
  data: PortalUniversityLite[];
  total: number;
}

export default function ExclusiveRegionsSection() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const datalistId = useId();

  const [universities, setUniversities] = useState<PortalUniversityLite[]>([]);
  const [unisLoading, setUnisLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string>("");

  // Add-form state
  const [nationality, setNationality] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(true);

  const [deleteTarget, setDeleteTarget] = useState<UniversityExclusion | null>(
    null,
  );

  // Load the portal universities for the picker (same source as parent tab).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setUnisLoading(true);
      try {
        const res = await customFetch<UniversityListResponse>(
          "/api/portal-universities?limit=200",
        );
        if (!cancelled) setUniversities(res.data ?? []);
      } catch {
        if (!cancelled) setUniversities([]);
      } finally {
        if (!cancelled) setUnisLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const exclusionsQuery = useListUniversityExclusions(
    { universityKey: selectedKey },
    {
      query: {
        enabled: !!selectedKey,
        queryKey: getListUniversityExclusionsQueryKey({
          universityKey: selectedKey,
        }),
      },
    },
  );
  const suggestionsQuery = useListExclusionNationalitySuggestions();

  const createMut = useCreateUniversityExclusion();
  const updateMut = useUpdateUniversityExclusion();
  const deleteMut = useDeleteUniversityExclusion();

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getListUniversityExclusionsQueryKey({
        universityKey: selectedKey,
      }),
    });
  };

  const rows = exclusionsQuery.data ?? [];
  const suggestions = suggestionsQuery.data ?? [];

  const canAdd = useMemo(
    () => !!selectedKey && nationality.trim().length > 0 && !createMut.isPending,
    [selectedKey, nationality, createMut.isPending],
  );

  const resetForm = () => {
    setNationality("");
    setAgencyName("");
    setNote("");
    setEnabled(true);
  };

  const handleAdd = async () => {
    if (!canAdd) return;
    try {
      await createMut.mutateAsync({
        data: {
          universityKey: selectedKey,
          nationality: nationality.trim(),
          agencyName: agencyName.trim() || undefined,
          note: note.trim() || undefined,
          enabled,
        },
      });
      toast({ title: t("portalExclusion.toastCreated") });
      resetForm();
      invalidate();
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title:
          status === 409
            ? t("portalExclusion.errorDuplicate")
            : t("portalExclusion.errorGeneric"),
        variant: "destructive",
      });
    }
  };

  const handleToggle = async (row: UniversityExclusion, next: boolean) => {
    try {
      await updateMut.mutateAsync({ id: row.id, data: { enabled: next } });
      invalidate();
    } catch {
      toast({
        title: t("portalExclusion.errorGeneric"),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync({ id: deleteTarget.id });
      toast({ title: t("portalExclusion.toastDeleted") });
      setDeleteTarget(null);
      invalidate();
    } catch {
      toast({
        title: t("portalExclusion.errorGeneric"),
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="mt-6">
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-5 h-5 text-orange-600" />
          <h3 className="text-lg font-semibold">
            {t("portalExclusion.title")}
          </h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {t("portalExclusion.description")}
        </p>

        {/* University picker */}
        <div className="max-w-md mb-4">
          <Label className="mb-1.5 block">
            {t("portalExclusion.universityLabel")}
          </Label>
          {unisLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select value={selectedKey} onValueChange={setSelectedKey}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t("portalExclusion.universityPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {universities.map((u) => (
                  <SelectItem key={u.universityKey} value={u.universityKey}>
                    {u.universityName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {!selectedKey ? (
          <p className="text-sm text-muted-foreground">
            {t("portalExclusion.selectUniversityHint")}
          </p>
        ) : (
          <>
            {/* Existing rules */}
            {exclusionsQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground mb-4">
                {t("portalExclusion.empty")}
              </p>
            ) : (
              <div className="border rounded-md divide-y mb-4">
                <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50">
                  <div className="col-span-3">
                    {t("portalExclusion.colNationality")}
                  </div>
                  <div className="col-span-3">
                    {t("portalExclusion.colAgency")}
                  </div>
                  <div className="col-span-3">
                    {t("portalExclusion.colNote")}
                  </div>
                  <div className="col-span-2 text-center">
                    {t("portalExclusion.colEnabled")}
                  </div>
                  <div className="col-span-1" />
                </div>
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-12 gap-2 px-3 py-2.5 items-center text-sm"
                  >
                    <div className="col-span-3 font-medium">
                      {row.nationality}
                    </div>
                    <div className="col-span-3 text-muted-foreground">
                      {row.agencyName || "—"}
                    </div>
                    <div className="col-span-3 text-muted-foreground truncate">
                      {row.note || "—"}
                    </div>
                    <div className="col-span-2 flex justify-center">
                      <Switch
                        checked={row.enabled}
                        onCheckedChange={(v) => void handleToggle(row, v)}
                        disabled={updateMut.isPending}
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(row)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Add form */}
            <div className="border rounded-md p-4 bg-muted/30">
              <h4 className="text-sm font-semibold mb-3">
                {t("portalExclusion.addTitle")}
              </h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="mb-1.5 block">
                    {t("portalExclusion.colNationality")}
                  </Label>
                  <Input
                    list={datalistId}
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                    placeholder={t("portalExclusion.nationalityPlaceholder")}
                  />
                  <datalist id={datalistId}>
                    {suggestions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <Label className="mb-1.5 block">
                    {t("portalExclusion.colAgency")}
                  </Label>
                  <Input
                    value={agencyName}
                    onChange={(e) => setAgencyName(e.target.value)}
                    placeholder={t("portalExclusion.agencyPlaceholder")}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="mb-1.5 block">
                    {t("portalExclusion.colNote")}
                  </Label>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t("portalExclusion.notePlaceholder")}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between mt-4">
                <div className="flex items-center gap-2">
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                  <Label>{t("portalExclusion.colEnabled")}</Label>
                </div>
                <Button onClick={() => void handleAdd()} disabled={!canAdd}>
                  {createMut.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  {t("portalExclusion.addButton")}
                </Button>
              </div>
            </div>
          </>
        )}

        {/* Delete confirm */}
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(o) => {
            if (!o && !deleteMut.isPending) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("portalExclusion.deleteConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("portalExclusion.deleteConfirmDescription", {
                  nationality: deleteTarget?.nationality ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMut.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleDelete();
                }}
                disabled={deleteMut.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteMut.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {t("portalExclusion.deleteConfirmButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
