import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Mail, Phone, MessageSquare, Send, Loader2, Instagram, AlertTriangle } from "lucide-react";
import { useLocation } from "wouter";
import { WhatsAppTemplatePicker } from "@/components/inbox/WhatsAppTemplatePicker";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

type Channel = "email" | "whatsapp" | "instagram" | "internal";

const CHANNELS: { key: Channel; labelKey: string; icon: typeof Mail; color: string }[] = [
  { key: "internal", labelKey: "quickContact.internal", icon: MessageSquare, color: "bg-blue-500/10 text-blue-600 border-blue-200 hover:bg-blue-500/20" },
  { key: "email", labelKey: "common.email", icon: Mail, color: "bg-purple-500/10 text-purple-600 border-purple-200 hover:bg-purple-500/20" },
  { key: "whatsapp", labelKey: "quickContact.whatsapp", icon: Phone, color: "bg-green-500/10 text-green-600 border-green-200 hover:bg-green-500/20" },
  { key: "instagram", labelKey: "quickContact.instagram", icon: Instagram, color: "bg-pink-500/10 text-pink-600 border-pink-200 hover:bg-pink-500/20" },
];

interface QuickContactProps {
  name: string;
  email?: string | null;
  phone?: string | null;
  entityType: "lead" | "student" | "agent" | "application";
  entityId: number;
  hideEmail?: boolean;
  hideWhatsApp?: boolean;
}

export function QuickContactButtons({ name, email, phone, entityType, entityId, hideEmail, hideWhatsApp }: QuickContactProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>("internal");

  function openDialog(ch: Channel) {
    setChannel(ch);
    setDialogOpen(true);
  }

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          onClick={() => openDialog("internal")}
          title={t("quickContact.messageTitle")}
          className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-blue-600 hover:bg-blue-500/10 transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5" />
        </button>
        {email && !hideEmail && (
          <button
            onClick={() => openDialog("email")}
            title={t("common.email")}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-purple-600 hover:bg-purple-500/10 transition-colors"
          >
            <Mail className="w-3.5 h-3.5" />
          </button>
        )}
        {phone && !hideWhatsApp && (
          <button
            onClick={() => openDialog("whatsapp")}
            title={t("quickContact.whatsapp")}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
          >
            <Phone className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <QuickContactDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        channel={channel}
        setChannel={setChannel}
        name={name}
        email={email}
        phone={phone}
        entityType={entityType}
        entityId={entityId}
        hideEmail={hideEmail}
        hideWhatsApp={hideWhatsApp}
      />
    </>
  );
}

export function QuickContactDialog({
  open,
  onClose,
  channel,
  setChannel,
  name,
  email,
  phone,
  entityType,
  entityId,
  hideEmail,
  hideWhatsApp,
}: {
  open: boolean;
  onClose: () => void;
  channel: Channel;
  setChannel: (ch: Channel) => void;
  name: string;
  email?: string | null;
  phone?: string | null;
  entityType: string;
  entityId: number;
  hideEmail?: boolean;
  hideWhatsApp?: boolean;
}) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [message, setMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);

  // 24h window state for WhatsApp channel
  const [windowStatus, setWindowStatus] = useState<{
    hasConversation: boolean;
    isWithin24h: boolean;
    conversationId?: number;
  } | null>(null);
  const [windowLoading, setWindowLoading] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplSending, setTplSending] = useState(false);

  // Load window status when WhatsApp channel is active and dialog is open
  useEffect(() => {
    if (!open || channel !== "whatsapp" || !phone) {
      setWindowStatus(null);
      return;
    }
    setWindowLoading(true);
    setWindowStatus(null);
    fetch(`${BASE}/api/quick-contact/window?entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, {
      credentials: "include",
    })
      .then(r => r.json())
      .then(data => setWindowStatus(data))
      .catch(() => setWindowStatus({ hasConversation: false, isWithin24h: false }))
      .finally(() => setWindowLoading(false));
  }, [open, channel, entityType, entityId, phone]);

  const channelMeta = CHANNELS.find(c => c.key === channel)!;
  const channelLabel = t(channelMeta.labelKey);

  function translateErrorCode(code: string | undefined, detail?: string | null): string {
    switch (code) {
      case "no_zernio_conversation":
        return t("quickContact.errNoConversation", { channel: channelLabel });
      case "outside_24h_window":
        return t("quickContact.errOutside24h");
      case "zernio_send_failed":
        return detail
          ? `${t("quickContact.errSendFailed")} (${detail})`
          : t("quickContact.errSendFailed");
      default:
        return code || t("quickContact.failedToSend");
    }
  }

  async function handleSend() {
    if (!message.trim()) return;
    setSending(true);
    try {
      const resp = await fetch(`${BASE}/api/quick-contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channel,
          recipientName: name,
          recipientEmail: email,
          recipientPhone: phone,
          subject: subject.trim() || undefined,
          message: message.trim(),
          entityType,
          entityId,
        }),
      });
      const body: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(translateErrorCode(body?.error, body?.detail));
      }
      const conversationId: number | undefined = body?.conversationId;
      if (body?.dispatched && conversationId) {
        toast({
          title: t("quickContact.dispatchedTitle"),
          description: t("quickContact.dispatchedDesc", { channel: channelLabel, name }),
          action: (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/staff/messages?conversation=${conversationId}`)}
            >
              {t("quickContact.openConversation")}
            </Button>
          ) as any,
        });
      } else {
        toast({ title: t("quickContact.messageSent"), description: t("quickContact.messageSentDesc", { channel: channelLabel, name }) });
      }
      setMessage("");
      setSubject("");
      onClose();
    } catch (err: any) {
      toast({ title: t("quickContact.error"), description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  async function handleTemplateSend(templateId: number, parameters: string[]) {
    setTplSending(true);
    try {
      const resp = await fetch(`${BASE}/api/inbox/conversations/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ entityType, entityId, templateId, parameters }),
      });
      const body: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw Object.assign(new Error(body?.error || "send_failed"), { body });
      }
      toast({ title: t("quickContact.templateSent") });
      setTplOpen(false);
      onClose();
      if (body?.conversationId) {
        navigate(`/staff/messages?conversation=${body.conversationId}`);
      }
    } finally {
      setTplSending(false);
    }
  }

  const isWa = channel === "whatsapp";
  const waOutside = isWa && windowStatus !== null && !windowStatus.isWithin24h;

  return (
    <>
      <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5" />
              {t("quickContact.sendMessageTo", { name })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">{t("quickContact.channel")}</Label>
              <div className="flex gap-2">
                {CHANNELS.filter(ch => !(ch.key === "email" && hideEmail) && !(ch.key === "whatsapp" && hideWhatsApp)).map(ch => {
                  const disabled = (ch.key === "email" && !email) || (ch.key === "whatsapp" && !phone);
                  return (
                    <Badge
                      key={ch.key}
                      variant="outline"
                      className={`cursor-pointer px-3 py-1.5 text-xs transition-all ${
                        channel === ch.key
                          ? ch.color + " ring-1 ring-offset-1"
                          : disabled
                          ? "opacity-30 cursor-not-allowed"
                          : "hover:bg-muted"
                      }`}
                      onClick={() => { if (!disabled) setChannel(ch.key); }}
                    >
                      <ch.icon className="w-3.5 h-3.5 mr-1" />
                      {t(ch.labelKey)}
                    </Badge>
                  );
                })}
              </div>
            </div>

            <div className="text-xs text-muted-foreground flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
              {channel === "email" && email && (
                <><Mail className="w-3.5 h-3.5" /> {t("quickContact.to", { value: email })}</>
              )}
              {channel === "whatsapp" && phone && (
                <><Phone className="w-3.5 h-3.5" /> {t("quickContact.to", { value: phone })}</>
              )}
              {channel === "instagram" && (
                <><Instagram className="w-3.5 h-3.5" /> {t("quickContact.instagramTo", { name })}</>
              )}
              {channel === "internal" && (
                <><MessageSquare className="w-3.5 h-3.5" /> {t("quickContact.internalMessageTo", { name })}</>
              )}
            </div>

            {/* WhatsApp 24h window banner */}
            {isWa && windowLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("quickContact.checkingWindow")}
              </div>
            )}
            {isWa && waOutside && !windowLoading && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 text-xs text-amber-800">
                  <p className="font-medium">{t("quickContact.wa24hWindowOutside")}</p>
                  <p className="mt-0.5 text-amber-700">{t("quickContact.wa24hUseTemplate")}</p>
                </div>
              </div>
            )}

            {channel === "email" && (
              <div>
                <Label>{t("quickContact.subject")}</Label>
                <Input
                  className="mt-1"
                  placeholder={t("quickContact.subjectPlaceholder")}
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                />
              </div>
            )}

            {/* Show textarea only if NOT in WA-outside-24h mode */}
            {!waOutside && (
              <div>
                <Label>{t("quickContact.message")}</Label>
                <Textarea
                  className="mt-1 min-h-[120px]"
                  placeholder={t("quickContact.messagePlaceholder", { channel: channelLabel.toLowerCase() })}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSend(); }}
                />
                <p className="text-[10px] text-muted-foreground mt-1">{t("quickContact.ctrlEnterToSend")}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            {waOutside ? (
              <Button
                onClick={() => setTplOpen(true)}
                className="gap-1 bg-green-600 hover:bg-green-700"
              >
                <Phone className="w-4 h-4" />
                {t("quickContact.selectTemplate")}
              </Button>
            ) : (
              <Button onClick={handleSend} disabled={sending || !message.trim()}>
                {sending
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t("common.sending")}</>
                  : <><Send className="w-4 h-4 mr-2" /> {t("common.send")}</>
                }
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WhatsAppTemplatePicker
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        conversationId={windowStatus?.conversationId ?? null}
        entityType={entityType === "lead" || entityType === "student" || entityType === "application" ? entityType : undefined}
        entityId={entityType === "lead" || entityType === "student" || entityType === "application" ? entityId : null}
        onSend={handleTemplateSend}
        sending={tplSending}
      />
    </>
  );
}
