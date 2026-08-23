import { useState } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MoreHorizontal, Pencil, Trash2, UserPlus, Building2, Unlink, LogIn, Loader2, Search, Eye, KeyRound, EyeOff,
} from "lucide-react";
import { Label } from "@/components/ui/label";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface RowActionsMenuProps {
  entityType: "lead" | "student" | "application";
  entityId: number;
  entityName: string;
  currentAgentId?: number | null;
  currentAgentName?: string | null;
  currentAssignedToId?: number | null;
  staffUsersMap?: Record<number, string>;
  staffUsersList?: { id: number; name: string }[];
  currentUserId?: number;
  isAdmin?: boolean;
  canAssign?: boolean;
  canReassign?: boolean;
  userId?: number | null;
  onEdit: () => void;
  onDelete?: () => void;
  onAssign?: (userId: number) => void;
  onRefresh?: () => void;
}

export function RowActionsMenu({
  entityType, entityId, entityName,
  currentAgentId, currentAgentName,
  currentAssignedToId, staffUsersMap, staffUsersList,
  currentUserId, isAdmin,
  canAssign, canReassign,
  userId,
  onEdit, onDelete, onAssign, onRefresh,
}: RowActionsMenuProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [linkAgentOpen, setLinkAgentOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const [setPasswordOpen, setSetPasswordOpen] = useState(false);

  const assignedName = currentAssignedToId && staffUsersMap ? staffUsersMap[currentAssignedToId] : null;

  async function handleUnlinkAgent() {
    try {
      const url = entityType === "lead" ? `${BASE}/api/leads/${entityId}`
        : entityType === "student" ? `${BASE}/api/students/${entityId}`
        : `${BASE}/api/applications/${entityId}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentId: null }),
      });
      if (!res.ok) throw new Error("Failed to unlink agent");
      toast({ title: "Agent unlinked", description: `Removed agent from ${entityName}` });
      onRefresh?.();
      qc.invalidateQueries({ queryKey: [entityType === "lead" ? "/api/leads" : entityType === "student" ? "/api/students" : "applications"] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleImpersonate() {
    if (!userId) return;
    setImpersonating(true);
    try {
      const res = await fetch(`${BASE}/api/users/${userId}/impersonate`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to impersonate");
      }
      const data = await res.json();
      window.location.href = data.redirectTo || "/student";
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setImpersonating(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
          </DropdownMenuItem>

          {onAssign && staffUsersList && (currentAssignedToId ? (canReassign || currentAssignedToId === currentUserId) : canAssign) && (
            <DropdownMenuItem onClick={() => setAssignOpen(true)}>
              <UserPlus className="w-3.5 h-3.5 mr-2" />
              {assignedName ? `Reassign (${assignedName})` : "Assign Staff"}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          {!currentAgentId ? (
            <DropdownMenuItem onClick={() => setLinkAgentOpen(true)}>
              <Building2 className="w-3.5 h-3.5 mr-2" /> Link to Agent
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onClick={() => setLinkAgentOpen(true)}>
                <Building2 className="w-3.5 h-3.5 mr-2" /> Change Agent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleUnlinkAgent} className="text-amber-600 focus:text-amber-600">
                <Unlink className="w-3.5 h-3.5 mr-2" /> Unlink Agent
                {currentAgentName && <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[80px]">{currentAgentName}</span>}
              </DropdownMenuItem>
            </>
          )}

          {entityType === "student" && isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSetPasswordOpen(true)}>
                <KeyRound className="w-3.5 h-3.5 mr-2" /> Set Password
              </DropdownMenuItem>
              {userId && (
                <DropdownMenuItem onClick={handleImpersonate} disabled={impersonating}>
                  <LogIn className="w-3.5 h-3.5 mr-2" /> Login as Student
                </DropdownMenuItem>
              )}
            </>
          )}

          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <LinkAgentDialog
        open={linkAgentOpen}
        onClose={() => setLinkAgentOpen(false)}
        entityType={entityType}
        entityId={entityId}
        entityName={entityName}
        onRefresh={onRefresh}
      />

      {onAssign && staffUsersList && (
        <AssignStaffDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          staffUsersList={staffUsersList}
          currentAssignedToId={currentAssignedToId}
          currentUserId={currentUserId}
          onAssign={(uid) => { onAssign(uid); setAssignOpen(false); }}
        />
      )}

      {entityType === "student" && (
        <SetPasswordDialog
          open={setPasswordOpen}
          onClose={() => setSetPasswordOpen(false)}
          studentId={entityId}
          entityName={entityName}
        />
      )}
    </>
  );
}

function LinkAgentDialog({ open, onClose, entityType, entityId, entityName, onRefresh }: {
  open: boolean;
  onClose: () => void;
  entityType: string;
  entityId: number;
  entityName: string;
  onRefresh?: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [linking, setLinking] = useState(false);

  const { data: agentsData, isLoading } = useQuery<any>({
    queryKey: ["agents-list-for-link", search],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/agents?limit=20&status=active${search ? `&search=${encodeURIComponent(search)}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });

  const agents = agentsData?.data || [];

  async function handleLink(agentId: number) {
    setLinking(true);
    try {
      const url = entityType === "lead" ? `${BASE}/api/leads/${entityId}`
        : entityType === "student" ? `${BASE}/api/students/${entityId}`
        : `${BASE}/api/applications/${entityId}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) throw new Error("Failed to link agent");
      toast({ title: "Agent linked", description: `Agent linked to ${entityName}` });
      onRefresh?.();
      qc.invalidateQueries({ queryKey: [entityType === "lead" ? "/api/leads" : entityType === "student" ? "/api/students" : "applications"] });
      setSearch("");
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLinking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); setSearch(""); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" /> Link Agent to {entityName}
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search agents..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : agents.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No agents found</p>
          ) : (
            agents.map((agent: any) => (
              <button
                key={agent.id}
                disabled={linking}
                onClick={() => handleLink(agent.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                  <Building2 className="w-4 h-4 text-amber-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{agent.companyName || `${agent.firstName} ${agent.lastName}`}</p>
                  <p className="text-xs text-muted-foreground truncate">{agent.email}{agent.country ? ` · ${agent.country}` : ""}</p>
                </div>
                {agent.status && (
                  <Badge variant="outline" className="text-[10px] shrink-0">{agent.status}</Badge>
                )}
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setSearch(""); }}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignStaffDialog({ open, onClose, staffUsersList, currentAssignedToId, currentUserId, onAssign }: {
  open: boolean;
  onClose: () => void;
  staffUsersList: { id: number; name: string }[];
  currentAssignedToId?: number | null;
  currentUserId?: number;
  onAssign: (userId: number) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = staffUsersList.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); setSearch(""); } }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5" /> Assign Staff
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search staff..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto space-y-1">
          {filtered.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No staff found</p>
          ) : (
            filtered.map(u => (
              <button
                key={u.id}
                onClick={() => onAssign(u.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted transition-colors text-left ${currentAssignedToId === u.id ? "bg-primary/5 ring-1 ring-primary/20" : ""}`}
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-medium text-primary">
                  {u.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm font-medium">{u.name}</span>
                {currentAssignedToId === u.id && <Badge variant="outline" className="ml-auto text-[10px]">Current</Badge>}
                {u.id === currentUserId && currentAssignedToId !== u.id && <span className="ml-auto text-[10px] text-muted-foreground">Me</span>}
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setSearch(""); }}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordDialog({ open, onClose, studentId, entityName }: {
  open: boolean;
  onClose: () => void;
  studentId: number;
  entityName: string;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleClose() {
    onClose();
    setPassword("");
    setConfirmPassword("");
    setShowPw(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || password.length < 6) {
      toast({ title: "Error", description: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/students/${studentId}/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to set password");
      }
      toast({ title: "Password updated", description: `Password has been set for ${entityName}` });
      handleClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) handleClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5" /> Set Password
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Set a new password for <strong>{entityName}</strong></p>
        <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">New Password *</Label>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min 6 characters"
                className="h-9 pr-10"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Confirm Password *</Label>
            <Input
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              className="h-9"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Set Password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
