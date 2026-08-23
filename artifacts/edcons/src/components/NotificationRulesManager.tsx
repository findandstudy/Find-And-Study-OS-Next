import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n";
import {
  Bell, Mail, MessageCircle, Send, Smartphone, Check, X,
  Loader2, ChevronDown, ChevronRight, Settings2, Pencil, Eye, Save,
  FileText, AlertCircle
} from "lucide-react";

interface NotificationRule {
  id: number;
  event: string;
  name: string;
  description?: string;
  category: string;
  channels: string[];
  recipientType: string;
  recipientRoles: string[];
  isActive: boolean;
  template?: NotifTemplate;
}

interface LangTemplate { subject?: string; body?: string; }
interface NotifTemplate extends LangTemplate { translations?: Record<string, LangTemplate>; }

// Email/notification template languages are derived from the canonical
// system language list (Settings → Language & Region) so the editor always
// exposes every supported locale instead of a hardcoded subset. "tr" and
// "en" are surfaced first to match the org's primary content languages; the
// backend dispatcher resolves any language key with fallback (lang → en → tr).
const TEMPLATE_LANG_ORDER = ["tr", "en"] as const;
const TEMPLATE_LANGS: { code: string; label: string }[] = [
  ...TEMPLATE_LANG_ORDER,
  ...SUPPORTED_LANGUAGES.filter(c => !TEMPLATE_LANG_ORDER.includes(c as any)),
].map(code => ({ code, label: code.toUpperCase() }));

const PASSIVE_CHANNELS = new Set(["telegram", "sms"]);

// Events whose card title is localized via i18n. Older rules render the
// English DB name verbatim; newly introduced events should register a key
// here so the Settings card follows the user's language.
const EVENT_LABEL_KEYS: Record<string, string> = {
  "inbox.message_unmatched": "notificationRules.event_inbox_message_unmatched",
};

function hasTemplateContent(tpl?: NotifTemplate): boolean {
  if (!tpl) return false;
  if (tpl.subject || tpl.body) return true;
  const tr = tpl.translations || {};
  return Object.values(tr).some(v => v && (v.subject || v.body));
}

function emptyTranslations(): Record<string, LangTemplate> {
  const out: Record<string, LangTemplate> = {};
  for (const l of TEMPLATE_LANGS) out[l.code] = { subject: "", body: "" };
  return out;
}

const CHANNEL_META: Record<string, { label: string; icon: any; color: string }> = {
  in_app: { label: "In-App", icon: Bell, color: "bg-blue-500/10 text-blue-600 border-blue-200" },
  email: { label: "Email", icon: Mail, color: "bg-green-500/10 text-green-600 border-green-200" },
  whatsapp: { label: "WhatsApp", icon: MessageCircle, color: "bg-emerald-500/10 text-emerald-600 border-emerald-200" },
  telegram: { label: "Telegram", icon: Send, color: "bg-sky-500/10 text-sky-600 border-sky-200" },
  sms: { label: "SMS", icon: Smartphone, color: "bg-purple-500/10 text-purple-600 border-purple-200" },
};

const CATEGORY_LABELS: Record<string, string> = {
  leads: "Leads", applications: "Applications", students: "Students",
  finance: "Finance", agents: "Agents", system: "System", messages: "Messages",
  contracts: "Contracts",
};

const CATEGORY_ICONS: Record<string, string> = {
  leads: "UserPlus", applications: "FileText", students: "GraduationCap",
  finance: "DollarSign", agents: "Building", system: "Settings", messages: "MessageSquare",
  contracts: "FileText",
};

const RECIPIENT_LABELS: Record<string, string> = {
  role: "By Role", assigned: "Assigned Staff", owner: "Record Owner",
  specific: "Specific User", all: "All Users",
};

const TEMPLATE_VARS: Record<string, string[]> = {
  "lead.created": ["firstName", "lastName", "email", "phone"],
  "lead.assigned": ["firstName", "lastName"],
  "lead.stage_changed": ["firstName", "lastName", "oldStage", "newStage"],
  "lead.follow_up_due": ["firstName", "lastName"],
  "application.created": ["studentName", "universityName", "programName"],
  "application.stage_changed": ["studentName", "universityName", "programName", "newStage"],
  "application.offer_received": ["studentName", "universityName", "programName"],
  "application.offer_letter_expiring": ["studentName", "universityName", "programName", "validUntil", "daysLeft", "stageLabel"],
  "application.visa_update": ["studentName", "universityName"],
  "student.created": ["firstName", "lastName", "email", "nationality"],
  "student.document_uploaded": ["documentName", "documentType"],
  "student.status_changed": ["firstName", "lastName"],
  "finance.commission_confirmed": ["studentName", "universityName", "programName"],
  "finance.payment_received": ["studentName", "amount"],
  "finance.payment_due": ["studentName", "amount", "dueDate"],
  "finance.agent_payout": ["agentName", "amount"],
  "agent.new_registration": ["firstName", "lastName", "companyName", "email"],
  "agent.sub_agent_added": ["firstName", "lastName", "email"],
  "agent.contract_expiring": ["agentName", "businessName", "contractEndDate", "daysLeft", "threshold"],
  "system.user_activated": ["firstName", "lastName"],
  "system.broadcast": ["message"],
  "system.announcement": ["title", "message"],
  "message.new": ["senderName"],
  "message.mention": ["senderName", "channel"],
  "contract.sent": ["signerName", "signerEmail", "contractName", "contractLink"],
  "contract.verification_code": ["verificationCode", "contractName", "signerName", "signerEmail", "contractLink"],
  "contract.signed": ["signerName", "signerEmail", "contractName", "contractLink"],
};

interface Props {
  isAdmin: boolean;
  notifications: Record<string, boolean>;
  setNotifications: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}

export function NotificationRulesManager({ isAdmin, notifications, setNotifications }: Props) {
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingTemplate, setEditingTemplate] = useState<NotificationRule | null>(null);
  const [templateTranslations, setTemplateTranslations] = useState<Record<string, LangTemplate>>(emptyTranslations());
  const [activeLang, setActiveLang] = useState<string>("tr");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const { toast } = useToast();
  const { t } = useI18n();

  useEffect(() => {
    if (isAdmin) fetchRules();
  }, [isAdmin]);

  async function fetchRules() {
    setLoading(true);
    try {
      const res = await customFetch("/api/notification-rules");
      setRules((res as any)?.data || []);
      const cats = new Set<string>();
      ((res as any)?.data || []).forEach((r: NotificationRule) => cats.add(r.category));
      setExpandedCategories(cats);
    } catch {
      toast({ title: t("notificationRules.failedToLoad"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function toggleChannel(rule: NotificationRule, channel: string) {
    const has = rule.channels.includes(channel);
    const newChannels = has
      ? rule.channels.filter(c => c !== channel)
      : [...rule.channels, channel];

    setSaving(rule.id);
    try {
      await customFetch(`/api/notification-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: newChannels }),
      });
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, channels: newChannels } : r));
    } catch {
      toast({ title: t("notificationRules.failedToUpdate"), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  }

  async function toggleActive(rule: NotificationRule) {
    setSaving(rule.id);
    try {
      await customFetch(`/api/notification-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r));
    } catch {
      toast({ title: t("notificationRules.failedToUpdate"), variant: "destructive" });
    } finally {
      setSaving(null);
    }
  }

  function toggleCategory(cat: string) {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  function openTemplateEditor(rule: NotificationRule) {
    setEditingTemplate(rule);
    const next = emptyTranslations();
    const tpl = rule.template;
    if (tpl?.translations && Object.keys(tpl.translations).length > 0) {
      for (const [k, v] of Object.entries(tpl.translations)) {
        next[k] = { subject: v?.subject || "", body: v?.body || "" };
      }
    } else if (tpl && (tpl.subject || tpl.body)) {
      next["tr"] = { subject: tpl.subject || "", body: tpl.body || "" };
    }
    setTemplateTranslations(next);
    setActiveLang("tr");
    setShowPreview(false);
  }

  function updateActiveField(field: "subject" | "body", value: string) {
    setTemplateTranslations(prev => ({
      ...prev,
      [activeLang]: { ...prev[activeLang], [field]: value },
    }));
  }

  function insertVariable(v: string) {
    const tag = `{{${v}}}`;
    setTemplateTranslations(prev => ({
      ...prev,
      [activeLang]: { ...prev[activeLang], body: (prev[activeLang]?.body || "") + tag },
    }));
  }

  async function saveTemplate() {
    if (!editingTemplate) return;
    setSavingTemplate(true);
    const translations: Record<string, LangTemplate> = {};
    for (const [k, v] of Object.entries(templateTranslations)) {
      const subject = (v.subject || "").trim();
      const body = (v.body || "").trim();
      if (subject || body) translations[k] = { subject, body };
    }
    // Top-level acts as the fallback for recipients whose language has no
    // dedicated translation. Prefer English as the universal fallback, then
    // Turkish (primary admin language), then any authored translation.
    const defaultLang = translations["en"]
      ? "en"
      : translations["tr"]
        ? "tr"
        : Object.keys(translations)[0];
    const top = defaultLang ? translations[defaultLang] : { subject: "", body: "" };
    const template: NotifTemplate = { subject: top.subject || "", body: top.body || "", translations };
    try {
      await customFetch(`/api/notification-rules/${editingTemplate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      setRules(prev => prev.map(r =>
        r.id === editingTemplate.id ? { ...r, template } : r
      ));
      toast({ title: t("notificationRules.templateSaved") });
      setEditingTemplate(null);
    } catch {
      toast({ title: t("notificationRules.failedToSaveTemplate"), variant: "destructive" });
    } finally {
      setSavingTemplate(false);
    }
  }

  function renderPreview(subject: string, body: string) {
    const vars = TEMPLATE_VARS[editingTemplate?.event || ""] || [];
    let previewSubject = subject;
    let previewBody = body;
    const sampleValues: Record<string, string> = {
      firstName: "John", lastName: "Doe", email: "john@example.com", phone: "+1234567890",
      studentName: "John Doe", universityName: "Harvard University", programName: "Computer Science",
      oldStage: "New", newStage: "Contacted", documentName: "Passport", documentType: "Identity",
      amount: "$5,000", dueDate: "2026-04-15", agentName: "ABC Agency", companyName: "ABC Ltd",
      nationality: "Turkish", senderName: "Admin", channel: "General", message: "Important update",
      title: "System Update",
    };
    for (const v of vars) {
      const re = new RegExp(`\\{\\{${v}\\}\\}`, "g");
      previewSubject = previewSubject.replace(re, sampleValues[v] || v);
      previewBody = previewBody.replace(re, sampleValues[v] || v);
    }
    return { previewSubject, previewBody };
  }

  const grouped = rules.reduce<Record<string, NotificationRule[]>>((acc, r) => {
    (acc[r.category] = acc[r.category] || []).push(r);
    return acc;
  }, {});

  const personalPrefs = [
    { key: "newLeads", label: t("notificationRules.prefNewLeads"), desc: t("notificationRules.prefNewLeadsDesc") },
    { key: "applicationUpdates", label: t("notificationRules.prefApplicationUpdates"), desc: t("notificationRules.prefApplicationUpdatesDesc") },
    { key: "documentAlerts", label: t("notificationRules.prefDocumentAlerts"), desc: t("notificationRules.prefDocumentAlertsDesc") },
    { key: "financeAlerts", label: t("notificationRules.prefFinanceAlerts"), desc: t("notificationRules.prefFinanceAlertsDesc") },
  ];

  return (
    <div className="space-y-6">
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <h2 className="font-display font-bold text-lg mb-6">{t("notificationRules.personalPreferences")}</h2>
        <div className="space-y-3">
          {personalPrefs.map(n => (
            <div key={n.key} className="flex items-center justify-between p-4 rounded-xl border border-border/50 hover:border-primary/30 transition-colors">
              <div>
                <p className="font-semibold text-foreground">{n.label}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{n.desc}</p>
              </div>
              <button
                onClick={() => setNotifications(prev => ({ ...prev, [n.key]: !prev[n.key as keyof typeof prev] }))}
                className={`relative w-12 h-6 rounded-full transition-all ${notifications[n.key as keyof typeof notifications] ? "bg-primary" : "bg-secondary border-2 border-border"}`}>
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${notifications[n.key as keyof typeof notifications] ? "translate-x-6" : ""}`} />
              </button>
            </div>
          ))}
        </div>
      </Card>

      {isAdmin && (
        <Card className="border-none shadow-lg shadow-black/5 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="font-display font-bold text-lg flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-primary" />
                {t("notificationRules.systemRules")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t("notificationRules.systemRulesDesc")}
              </p>
            </div>
            <Badge className="bg-primary/10 text-primary border-primary/20">
              {t("notificationRules.rulesCount", { count: rules.length })}
            </Badge>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(grouped).map(([cat, catRules]) => (
                <div key={cat} className="border border-border/50 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleCategory(cat)}
                    className="w-full flex items-center justify-between p-4 bg-secondary/30 hover:bg-secondary/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {expandedCategories.has(cat) ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      )}
                      <span className="font-display font-bold text-sm uppercase tracking-wider text-foreground">
                        {CATEGORY_LABELS[cat] ? t(`notificationRules.cat_${cat}`) : cat}
                      </span>
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      {t("notificationRules.activeCount", { active: catRules.filter(r => r.isActive).length, total: catRules.length })}
                    </Badge>
                  </button>

                  {expandedCategories.has(cat) && (
                    <div className="divide-y divide-border/30">
                      {catRules.map(rule => (
                        <div key={rule.id} className={`p-4 transition-colors ${!rule.isActive ? "opacity-50" : ""}`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="font-semibold text-sm text-foreground">{EVENT_LABEL_KEYS[rule.event] ? t(EVENT_LABEL_KEYS[rule.event]) : rule.name}</p>
                                <Badge variant="outline" className="text-[10px] font-mono px-1.5">
                                  {rule.event}
                                </Badge>
                                {hasTemplateContent(rule.template) && (
                                  <Badge className="bg-green-500/10 text-green-600 border-green-200 text-[10px] px-1.5">
                                    <FileText className="w-2.5 h-2.5 mr-0.5" />
                                    {t("notificationRules.templateBadge")}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mb-3">
                                {t("notificationRules.recipients")} {RECIPIENT_LABELS[rule.recipientType] ? t(`notificationRules.rcp_${rule.recipientType}`) : rule.recipientType}
                                {rule.recipientRoles?.length > 0 && (
                                  <span className="ml-1">
                                    ({rule.recipientRoles.join(", ")})
                                  </span>
                                )}
                              </p>
                              <div className="flex flex-wrap gap-1.5 items-center">
                                {Object.entries(CHANNEL_META).map(([ch, meta]) => {
                                  const Icon = meta.icon;
                                  const active = rule.channels.includes(ch);
                                  if (PASSIVE_CHANNELS.has(ch)) {
                                    return (
                                      <span
                                        key={ch}
                                        title={t("notificationRules.comingSoon")}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-dashed border-border/60 bg-secondary/20 text-muted-foreground/60 cursor-not-allowed"
                                      >
                                        <Icon className="w-3 h-3" />
                                        {t(`notificationRules.ch_${ch}`)}
                                        <Badge variant="secondary" className="text-[9px] px-1 py-0 ml-0.5 font-normal">
                                          {t("notificationRules.comingSoon")}
                                        </Badge>
                                      </span>
                                    );
                                  }
                                  return (
                                    <button
                                      key={ch}
                                      onClick={() => toggleChannel(rule, ch)}
                                      disabled={saving === rule.id || !rule.isActive}
                                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
                                        active
                                          ? meta.color
                                          : "bg-secondary/30 text-muted-foreground border-border/50 hover:border-border"
                                      }`}
                                    >
                                      <Icon className="w-3 h-3" />
                                      {CHANNEL_META[ch] ? t(`notificationRules.ch_${ch}`) : meta.label}
                                      {active && <Check className="w-3 h-3 ml-0.5" />}
                                    </button>
                                  );
                                })}
                                <button
                                  onClick={() => openTemplateEditor(rule)}
                                  disabled={!rule.isActive}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-orange-200 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 transition-all ml-1"
                                >
                                  <Pencil className="w-3 h-3" />
                                  {t("notificationRules.emailTemplate")}
                                </button>
                              </div>
                            </div>
                            <button
                              onClick={() => toggleActive(rule)}
                              disabled={saving === rule.id}
                              className={`relative w-10 h-5 rounded-full transition-all shrink-0 mt-1 ${
                                rule.isActive ? "bg-primary" : "bg-secondary border border-border"
                              }`}
                            >
                              {saving === rule.id ? (
                                <Loader2 className="w-3 h-3 animate-spin absolute top-1 left-3.5" />
                              ) : (
                                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                                  rule.isActive ? "translate-x-5" : ""
                                }`} />
                              )}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {editingTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-background rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-border/50">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display font-bold text-lg">{t("notificationRules.editEmailTemplate")}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {editingTemplate.name} — <span className="font-mono text-xs">{editingTemplate.event}</span>
                  </p>
                </div>
                <button
                  onClick={() => setEditingTemplate(null)}
                  className="p-2 rounded-lg hover:bg-secondary transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-5">
              <div>
                <Label className="text-sm font-medium mb-2 block">{t("notificationRules.templateLanguage")}</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {TEMPLATE_LANGS.map(l => {
                    const hasContent = !!(templateTranslations[l.code]?.subject || templateTranslations[l.code]?.body);
                    return (
                      <button
                        key={l.code}
                        onClick={() => setActiveLang(l.code)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-all ${
                          activeLang === l.code
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-secondary/30 text-muted-foreground border-border/50 hover:border-border"
                        }`}
                      >
                        {l.label}
                        {hasContent && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-green-500 align-middle" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-blue-700 dark:text-blue-400 mb-1">{t("notificationRules.availableVariables")}</p>
                    <div className="flex flex-wrap gap-1">
                      {(TEMPLATE_VARS[editingTemplate.event] || []).map(v => (
                        <code
                          key={v}
                          onClick={() => insertVariable(v)}
                          className="text-[11px] bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded cursor-pointer hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
                        >
                          {`{{${v}}}`}
                        </code>
                      ))}
                    </div>
                    <p className="text-[10px] text-blue-500 mt-1">{t("notificationRules.clickVariableHint")}</p>
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium mb-2 block">{t("notificationRules.emailSubject")}</Label>
                <Input
                  value={templateTranslations[activeLang]?.subject || ""}
                  onChange={e => updateActiveField("subject", e.target.value)}
                  placeholder={t("notificationRules.emailSubjectPlaceholder", { name: editingTemplate.name })}
                  className="bg-secondary/30"
                />
              </div>

              <div>
                <Label className="text-sm font-medium mb-2 block">{t("notificationRules.emailBody")}</Label>
                <Textarea
                  value={templateTranslations[activeLang]?.body || ""}
                  onChange={e => updateActiveField("body", e.target.value)}
                  placeholder={t("notificationRules.emailBodyPlaceholder")}
                  rows={6}
                  className="bg-secondary/30 font-mono text-sm"
                />
                <p className="text-[10px] text-muted-foreground mt-1">{t("notificationRules.htmlSupportedHint")}</p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPreview(!showPreview)}
                  className="gap-1.5"
                >
                  <Eye className="w-4 h-4" />
                  {showPreview ? t("notificationRules.hidePreview") : t("notificationRules.showPreview")}
                </Button>
              </div>

              {showPreview && (templateTranslations[activeLang]?.subject || templateTranslations[activeLang]?.body) && (() => {
                const { previewSubject, previewBody } = renderPreview(templateTranslations[activeLang]?.subject || "", templateTranslations[activeLang]?.body || "");
                return (
                  <div className="border border-border/50 rounded-xl overflow-hidden">
                    <div className="bg-gradient-to-r from-indigo-500 to-purple-600 p-6 text-center">
                      <h3 className="text-white font-bold text-xl">Find And Study OS</h3>
                      <p className="text-white/70 text-sm mt-1">{t("notificationRules.notification")}</p>
                    </div>
                    <div className="p-6 bg-white dark:bg-background">
                      <h4 className="font-bold text-lg mb-3 text-foreground">{previewSubject || t("notificationRules.noSubject")}</h4>
                      <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap mb-4">
                        {previewBody || t("notificationRules.noBody")}
                      </p>
                      <div className="text-center">
                        <span className="inline-block bg-indigo-500 text-white px-6 py-2.5 rounded-lg text-sm font-semibold">
                          {t("notificationRules.viewDetails")}
                        </span>
                      </div>
                      <hr className="my-4 border-border/30" />
                      <p className="text-[11px] text-muted-foreground text-center">
                        {t("notificationRules.automatedFooter")}
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="p-6 border-t border-border/50 flex justify-end gap-3">
              <Button variant="outline" onClick={() => setEditingTemplate(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                onClick={saveTemplate}
                disabled={savingTemplate}
                className="gap-1.5"
              >
                {savingTemplate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t("notificationRules.saveTemplate")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
