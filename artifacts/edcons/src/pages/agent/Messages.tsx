import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Send, ArrowLeft, Loader2, Plus, Paperclip, FileText, X, Download, Search, User } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/hooks/use-i18n";
import { formatDate, formatTime } from "@/lib/i18n";

function getInitials(first?: string | null, last?: string | null) {
  return `${(first || "")[0] || ""}${(last || "")[0] || ""}`.toUpperCase() || "?";
}

export default function AgentMessages() {
  const { t, lang } = useI18n();
  const { user } = useAuth(true);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showNewChat, setShowNewChat] = useState(false);
  const [staffSearch, setStaffSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: conversationsResp } = useQuery<any>({
    queryKey: ["agent-conversations"],
    queryFn: () => customFetch("/api/agent/conversations"),
    enabled: !!user,
  });

  const allConversations: any[] = conversationsResp?.data || [];

  useEffect(() => {
    if (allConversations.length > 0 && !conversationId) {
      setConversationId(allConversations[0].id);
    }
  }, [allConversations, conversationId]);

  const { data: messagesResp, isLoading: msgsLoading } = useQuery<any>({
    queryKey: ["agent-messages", conversationId],
    queryFn: () => customFetch(`/api/agent/conversations/${conversationId}/messages`),
    enabled: !!conversationId,
    refetchInterval: 5000,
  });

  const msgs: any[] = messagesResp?.data || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  const { data: staffResp } = useQuery<any>({
    queryKey: ["agent-staff-contacts"],
    queryFn: () => customFetch("/api/agent/staff-contacts"),
    enabled: showNewChat,
  });

  const staffContacts: any[] = staffResp?.data || [];
  const filteredStaff = staffContacts.filter((s: any) =>
    `${s.firstName} ${s.lastName}`.toLowerCase().includes(staffSearch.toLowerCase())
  );

  const uploadFile = async (file: File) => {
    try {
      setUploading(true);
      const urlRes = await customFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      const { uploadURL, objectPath } = urlRes as any;
      const uploadResp = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!uploadResp.ok) throw new Error(t("agentMessages.uploadFailed"));
      return { fileName: file.name, fileUrl: `/api/storage${objectPath}`, fileType: file.type, fileSize: file.size };
    } catch (err: any) {
      toast({ title: t("agentMessages.uploadFailed"), description: err.message, variant: "destructive" });
      return null;
    } finally {
      setUploading(false);
    }
  };

  const sendMutation = useMutation({
    mutationFn: (payload: { content: string; metadata?: any }) =>
      customFetch(`/api/agent/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setMessage("");
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["agent-messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["agent-conversations"] });
    },
    onError: (err: any) => {
      toast({ title: t("agentMessages.failedToSend"), description: err.message, variant: "destructive" });
    },
  });

  async function startConversation(targetUserId: number) {
    try {
      const conv = await customFetch("/api/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId }),
      });
      setConversationId((conv as any).id);
      setShowNewChat(false);
      setStaffSearch("");
      await qc.invalidateQueries({ queryKey: ["agent-conversations"] });
    } catch (err: any) {
      toast({ title: t("agentMessages.couldNotStart"), description: err.message, variant: "destructive" });
    }
  }

  async function handleSend() {
    if ((!message.trim() && !pendingFile) || !conversationId) return;
    let metadata: any;
    if (pendingFile) {
      const att = await uploadFile(pendingFile);
      if (!att) return;
      metadata = { attachment: att };
    }
    sendMutation.mutate({ content: message.trim() || "", metadata });
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: t("agentMessages.fileTooLarge"), description: t("agentMessages.maxFileSize"), variant: "destructive" });
      return;
    }
    setPendingFile(file);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isImageType = (type: string) => type.startsWith("image/");

  const handleDownload = async (fileUrl: string, fileName: string) => {
    try {
      const downloadUrl = new URL(fileUrl, window.location.origin);
      downloadUrl.searchParams.set("download", fileName);
      const res = await fetch(downloadUrl.toString(), { credentials: "include" });
      if (!res.ok) throw new Error(t("agentMessages.downloadFailed"));
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast({ title: t("agentMessages.downloadFailed"), description: t("agentMessages.couldNotDownload"), variant: "destructive" });
    }
  };

  const activeConv = allConversations.find((c: any) => c.id === conversationId);
  const otherParticipant = activeConv?.participants?.find((p: any) => p.userId !== user?.id);

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-2xl">{t("agentMessages.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("agentMessages.subtitle")}</p>
          </div>
          <Button
            className="rounded-xl gap-2 bg-gradient-to-r from-primary to-accent hover:opacity-90"
            onClick={() => setShowNewChat(true)}
          >
            <Plus className="w-4 h-4" />
            {t("agentMessages.newConversation")}
          </Button>
        </div>

        <div className="flex gap-4" style={{ height: "calc(100vh - 220px)" }}>
          <Card className="w-80 shrink-0 border-none shadow-lg shadow-black/5 flex flex-col overflow-hidden">
            <div className="p-3 border-b">
              <p className="font-semibold text-sm text-muted-foreground px-1">{t("agentMessages.conversations")}</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {allConversations.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p>{t("agentMessages.noConversations")}</p>
                  <p className="text-xs mt-1">{t("agentMessages.startNewConv")}</p>
                </div>
              ) : (
                allConversations.map((conv: any) => {
                  const other = conv.participants?.find((p: any) => p.userId !== user?.id);
                  const isActive = conv.id === conversationId;
                  return (
                    <button
                      key={conv.id}
                      onClick={() => setConversationId(conv.id)}
                      className={`w-full flex items-center gap-3 p-3 text-left transition-colors ${
                        isActive ? "bg-primary/10" : "hover:bg-secondary/50"
                      }`}
                    >
                      {other?.avatarUrl ? (
                        <img src={other.avatarUrl} alt="" className="w-10 h-10 rounded-xl object-cover shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-bold text-sm shrink-0">
                          {getInitials(other?.firstName, other?.lastName)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-sm truncate">
                            {other ? `${other.firstName} ${other.lastName}` : t("agentMessages.unknown")}
                          </p>
                          {conv.unreadCount > 0 && (
                            <span className="shrink-0 ml-1 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                              {conv.unreadCount}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{conv.lastMessagePreview || t("agentMessages.noMessagesPreview")}</p>
                        {conv.lastMessageAt && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {formatDate(lang, conv.lastMessageAt, { month: "short", day: "numeric" })}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </Card>

          <Card className="flex-1 border-none shadow-lg shadow-black/5 flex flex-col overflow-hidden">
            {!conversationId ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
                <MessageSquare className="w-16 h-16 mb-4 opacity-20" />
                <p className="font-display font-bold text-lg text-foreground">{t("agentMessages.selectConv")}</p>
                <p className="text-sm mt-1">{t("agentMessages.selectConvDesc")}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 p-4 border-b">
                  {otherParticipant?.avatarUrl ? (
                    <img src={otherParticipant.avatarUrl} alt="" className="w-10 h-10 rounded-xl object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-bold text-sm">
                      {getInitials(otherParticipant?.firstName, otherParticipant?.lastName)}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold text-sm">
                      {otherParticipant ? `${otherParticipant.firstName} ${otherParticipant.lastName}` : t("agentMessages.unknown")}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">{otherParticipant?.role?.replace(/_/g, " ")}</p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {msgsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    </div>
                  ) : msgs.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">{t("agentMessages.noMessagesYet")}</p>
                    </div>
                  ) : (
                    msgs.map((msg: any) => {
                      const isMe = msg.senderId === user?.id;
                      const att = msg.metadata?.attachment;
                      const hasTextContent = msg.content && !msg.content.startsWith("\u{1F4CE}");
                      return (
                        <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                            isMe
                              ? "bg-primary text-primary-foreground rounded-br-md"
                              : "bg-secondary text-foreground rounded-bl-md"
                          }`}>
                            {att && isImageType(att.fileType) && (
                              <div className="mb-1 group/att relative">
                                <img src={att.fileUrl} alt={att.fileName} className="max-w-full max-h-48 rounded-lg object-cover" />
                                <button
                                  onClick={() => handleDownload(att.fileUrl, att.fileName)}
                                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity hover:bg-black/70"
                                  title={t("common.download")}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                            {att && !isImageType(att.fileType) && (
                              <button
                                onClick={() => handleDownload(att.fileUrl, att.fileName)}
                                className={`flex items-center gap-2 p-2 rounded-lg mb-1 w-full text-left ${isMe ? "bg-white/10 hover:bg-white/20" : "bg-background hover:bg-background/80"} transition-colors`}
                              >
                                <FileText className="w-5 h-5 shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium truncate">{att.fileName}</p>
                                  <p className={`text-[10px] ${isMe ? "text-primary-foreground/60" : "text-muted-foreground"}`}>{formatFileSize(att.fileSize)}</p>
                                </div>
                                <Download className={`w-4 h-4 shrink-0 ${isMe ? "text-primary-foreground/60" : "text-muted-foreground"}`} />
                              </button>
                            )}
                            {hasTextContent && <p className="whitespace-pre-wrap break-words">{msg.content}</p>}
                            <p className={`text-[10px] mt-1 ${isMe ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                              {formatTime(lang, msg.createdAt, { hour: "2-digit", minute: "2-digit" })}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div className="p-4 border-t">
                  {pendingFile && (
                    <div className="flex items-center gap-2 mb-2 p-2 rounded-lg bg-secondary/50 text-sm">
                      <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{pendingFile.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(pendingFile.size)}</span>
                      <button onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }} className="text-muted-foreground hover:text-foreground">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <form
                    className="flex gap-2"
                    onSubmit={e => { e.preventDefault(); handleSend(); }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleFileSelect}
                      accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="rounded-xl shrink-0"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sendMutation.isPending || uploading}
                    >
                      <Paperclip className="w-4 h-4" />
                    </Button>
                    <Input
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      placeholder={t("agentMessages.typeMessage")}
                      className="flex-1 rounded-xl"
                      disabled={sendMutation.isPending || uploading}
                    />
                    <Button
                      type="submit"
                      size="icon"
                      className="rounded-xl shrink-0"
                      disabled={(!message.trim() && !pendingFile) || sendMutation.isPending || uploading}
                    >
                      {(sendMutation.isPending || uploading) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </Button>
                  </form>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      <Dialog open={showNewChat} onOpenChange={setShowNewChat}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("agentMessages.newConversation")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={staffSearch}
                onChange={e => setStaffSearch(e.target.value)}
                placeholder={t("agentMessages.searchContacts")}
                className="pl-9 rounded-xl"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filteredStaff.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">{t("agentMessages.noContactsFound")}</p>
              ) : (
                filteredStaff.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => startConversation(s.id)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-secondary/50 transition-colors text-left"
                  >
                    {s.avatarUrl ? (
                      <img src={s.avatarUrl} alt="" className="w-9 h-9 rounded-xl object-cover" />
                    ) : (
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-bold text-xs">
                        {getInitials(s.firstName, s.lastName)}
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-sm">{s.firstName} {s.lastName}</p>
                      <p className="text-xs text-muted-foreground capitalize">{s.role?.replace(/_/g, " ")}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
