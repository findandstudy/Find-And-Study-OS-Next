import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, UserPlus, ArrowRightLeft, MessageCircle } from "lucide-react";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface StageOption {
  key: string;
  label: string;
}

interface StaffOption {
  id: number;
  name: string;
}

interface BulkActionBarProps {
  selectedCount: number;
  onDelete?: () => void;
  onAssign: (userId: number) => void;
  onMove: (stageKey: string) => void;
  onSendMessage?: () => void;
  stages: StageOption[];
  staffUsers: StaffOption[];
  entityLabel?: string;
  moveLabel?: string;
}

export function BulkActionBar({
  selectedCount,
  onDelete,
  onAssign,
  onMove,
  onSendMessage,
  stages,
  staffUsers,
  entityLabel = "items",
  moveLabel = "Move Stage",
}: BulkActionBarProps) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  if (selectedCount === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-muted-foreground mr-1">
        {selectedCount} selected
      </span>

      {onDelete && (
        <Button variant="destructive" size="sm" className="rounded-full h-8 gap-1.5" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </Button>
      )}

      {onSendMessage && (
        <Button
          variant="outline"
          size="sm"
          className="rounded-full h-8 gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
          onClick={onSendMessage}
        >
          <MessageCircle className="w-3.5 h-3.5" /> Send Template
        </Button>
      )}

      {staffUsers.length > 0 && (
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-50">
              <UserPlus className="w-3.5 h-3.5" /> Assign
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="end">
            <p className="text-xs text-muted-foreground mb-2 px-1">Assign {selectedCount} {entityLabel} to:</p>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {staffUsers.map(u => (
                <button
                  key={u.id}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted transition-colors"
                  onClick={() => { onAssign(u.id); setAssignOpen(false); }}
                >
                  {u.name}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {stages.length > 0 && (
        <Popover open={moveOpen} onOpenChange={setMoveOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50">
              <ArrowRightLeft className="w-3.5 h-3.5" /> {moveLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="end">
            <p className="text-xs text-muted-foreground mb-2 px-1">{moveLabel} for {selectedCount} {entityLabel}:</p>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {stages.map(s => (
                <button
                  key={s.key}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-muted transition-colors capitalize"
                  onClick={() => { onMove(s.key); setMoveOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
